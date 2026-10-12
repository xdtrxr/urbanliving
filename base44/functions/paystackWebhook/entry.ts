import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// IMPORTANT: This function and base44/functions/verifyPaystackPayment/entry.ts
// share the post-payment booking-update logic (mark paid, notify admin, inline
// referral cash + loyalty bonus). Base44 functions are isolated dirs, so the
// logic is duplicated. Keep them in lockstep when changing either path.

const REFERRAL_RATE = 0.05;
const REFERRER_LOYALTY_BONUS = 250;
const GUEST_BOOKING_POINTS = 500;

// Public origin used in outbound email links. Falls back to the prod domain
// so guest emails always have a working link even if APP_BASE_URL isn't set.
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const bookingLink = (bookingId: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(bookingId)}#booking-${encodeURIComponent(bookingId)}`;
const propertyLink = (propertyId: string) => `${APP_BASE_URL}/Property?id=${encodeURIComponent(propertyId)}`;

// Awards the flat 500-point booking bonus to the guest, idempotent on
// (user_email, transaction_type='booking', booking_id). Mirrors the client-side
// awardBookingMilestones flow so guests still get credited if they close their
// tab before PaymentPage finishes. Same dedup key on both sides — re-runs noop.
async function awardGuestBookingPoints(sdk: any, guestEmail: string, bookingId: string) {
    try {
        const guests = await sdk.asServiceRole.entities.User.filter({ email: guestEmail });
        const guest = guests[0];
        if (!guest) {
            console.warn(`awardGuestBookingPoints: no User row for ${guestEmail}`);
            return;
        }
        const existing = await sdk.asServiceRole.entities.LoyaltyTransaction.filter({
            user_email: guestEmail,
            transaction_type: 'booking',
            booking_id: bookingId,
        });
        if (existing.length > 0) {
            console.log(`Guest ${guestEmail} already credited for booking ${bookingId}; skipping.`);
            return;
        }
        const newLoyalty = (Number(guest.loyalty_points) || 0) + GUEST_BOOKING_POINTS;
        await sdk.asServiceRole.entities.User.update(guest.id, { loyalty_points: newLoyalty });
        await sdk.asServiceRole.entities.LoyaltyTransaction.create({
            user_email: guestEmail,
            points_earned: GUEST_BOOKING_POINTS,
            transaction_type: 'booking',
            booking_id: bookingId,
            description: `Earned ${GUEST_BOOKING_POINTS} points from a booking`,
        });
        console.log(`🎁 Guest ${guestEmail} awarded ${GUEST_BOOKING_POINTS} points for booking ${bookingId}`);
    } catch (err) {
        console.warn('awardGuestBookingPoints failed (non-fatal):', err);
    }
}

async function hmacSha512Hex(secret: string, body: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-512' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare so an attacker can't time-out the HMAC check.
function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

// Sends the guest the property address, host phone, and arrival instructions
// immediately after a payment confirms. Mirrors the same helper in
// verifyPaystackPayment — keep in lockstep when changing.
// Returns { sent, needs_admin } so the caller can decide whether to invoke
// requestHostDetails when host info is missing. Prefers per-booking overrides
// (filled by admin via Telegram for a previous incomplete-property booking)
// over Property defaults. Mirrored in verifyPaystackPayment — keep in lockstep.
async function sendArrivalEmail(opts: {
    sdk: any;
    booking: any;
}): Promise<{ sent: boolean; needs_admin: boolean }> {
    const { sdk, booking } = opts;
    try {
        const property = await sdk.asServiceRole.entities.Property.get(booking.property_id);
        if (!property) {
            console.warn(`sendArrivalEmail: property ${booking.property_id} not found`);
            return { sent: false, needs_admin: false };
        }

        const hostPhone = booking.host_phone_override || property.host_phone || '';
        const hostName = booking.host_name_override || property.host_name || '';
        const arrivalInstructions = booking.arrival_instructions_override || property.arrival_instructions || '';

        if (!hostPhone || !arrivalInstructions) {
            console.log(`sendArrivalEmail: missing host details for booking ${booking.id} (phone=${!!hostPhone}, instructions=${!!arrivalInstructions}) — needs admin input`);
            return { sent: false, needs_admin: true };
        }

        const loc = property.location || {};
        const fullAddress = [loc.address, loc.city, loc.country].filter(Boolean).join(', ');
        const mapsLink = loc.coordinates?.lat && loc.coordinates?.lng
            ? `https://www.google.com/maps?q=${loc.coordinates.lat},${loc.coordinates.lng}`
            : (fullAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}` : null);

        const mapsBlock = mapsLink ? `\nMap: ${mapsLink}` : '';

        const body = `Hi ${booking.guest_name || 'there'},

Payment confirmed — your booking at "${property.title}" is locked in. 🎉

🔖 Status: CONFIRMED & PAID
👉 View your booking: ${bookingLink(booking.id)}
🏠 Property page: ${propertyLink(booking.property_id)}

📍 Address: ${fullAddress || 'See app for details'}${mapsBlock}
🗓 Check-in: ${booking.check_in}
🗓 Check-out: ${booking.check_out}
👥 Guests: ${Number(booking.guests) || 1}${Number(booking.bedrooms_booked) > 0 ? `\n🛏 Booked: the ${Number(booking.bedrooms_booked)}-bedroom option` : ''}

📞 Call your host on arrival: ${hostName || 'Host'} — ${hostPhone}

Arrival instructions from the host:
${arrivalInstructions}

Have a smooth trip — see you soon.

— Urban Stays`;

        await sdk.integrations.Core.SendEmail({
            to: booking.guest_email,
            subject: `You're checked in: arrival details for ${property.title}`,
            body,
            from_name: 'Urban Stays',
        });
        console.log(`✅ Arrival email sent to ${booking.guest_email} for booking ${booking.id}`);
        return { sent: true, needs_admin: false };
    } catch (err) {
        console.error('sendArrivalEmail failed (non-fatal):', err);
        return { sent: false, needs_admin: false };
    }
}

// Fire-and-forget push to a user. Errors are swallowed so a push outage
// can never block payment confirmation. Stable `tag` per booking means a
// re-delivered webhook for the same payment replaces the prior push
// instead of stacking duplicates on the user's device.
async function tryPush(sdk: any, opts: {
    user_email: string;
    title: string;
    body?: string;
    url?: string;
    tag?: string;
}) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

async function notifyAdmin(opts: {
    bookingId: string;
    guestName: string;
    guestEmail: string;
    guestPhone?: string;
    propertyId: string;
    amountNGN: number;
    reference: string;
    optionLabel?: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const text = `💰 *PAYMENT RECEIVED (webhook)*\n\n` +
        `Booking \`${opts.bookingId}\`\n` +
        `• Guest: ${opts.guestName} (${opts.guestEmail})\n` +
        `• Mobile: ${opts.guestPhone || 'Not provided'}\n` +
        `• Property: \`${opts.propertyId}\`\n` +
        (opts.optionLabel ? `• Booked: ${opts.optionLabel}\n` : '') +
        `• Amount: ₦${opts.amountNGN.toLocaleString()}\n` +
        `• Paystack ref: \`${opts.reference}\``;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Telegram payment notify failed:', err);
    }
}

// Referral reward. This function is word for word the same in
// processReferralReward, verifyPaystackPayment, verifyRidePayment and
// paystackWebhook: functions cannot share code, and
// scripts/check-referral-reward.mjs fails if the copies drift apart.
//
// What it keeps:
//  - Only a paid stay or ride earns, and the row handed in must say so.
//  - The referrer is whoever the guest's Referral row names. Only
//    attributeReferral writes that row, once per guest and never naming the
//    guest. The codes on the two profiles are not read here: a code is text
//    anyone can copy onto their own profile, and until 2026-10-12 a guest
//    could point their own profile at any code they liked.
//  - One reward per referred guest, for the first stay or ride they pay for.
//    Every row for the guest is looked at, because rewards paid in May 2026
//    left a second row beside the sign-up one.
//  - Never twice for one booking, never to the guest, and never for a
//    booking that was paid for before the guest was referred.
// Two writers reach this for one payment (the payment page and Paystack's
// webhook), and there is nothing to lock. So each first writes a claim, the
// referrer's loyalty row for this booking, then reads all the claims: only the
// oldest goes on to move money, and the others take theirs back. If the money
// then fails to move, what was written here is undone so a retry can pay; if
// it cannot be told whether the money moved, it is left as paid, because a
// reward that needs a person to look is better than one paid twice.
async function payReferralReward(db: any, paid: any, what: string) {
    const oldestFirst = (a: any, b: any) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
        || String(a.id).localeCompare(String(b.id));
    const guestEmail = String(paid.guest_email || '').toLowerCase();
    if (!guestEmail) return { skipped: 'no_referrer' };
    if (paid.payment_status !== 'paid') return { skipped: 'not_paid' };
    // Nothing to pay must not use the guest's one reward up.
    const amountNGN = Math.round((Number(paid.total_price) || 0) * REFERRAL_RATE);
    if (amountNGN <= 0) return { skipped: 'no_amount' };

    const rows = await db.Referral.filter({ referred_email: paid.guest_email }, 'created_date', 50);
    if (rows.length === 0) return { skipped: 'no_referrer' };
    if (rows.some((row: any) => row.booking_id === paid.id || row.status === 'booking_completed')) {
        return { skipped: 'already_awarded' };
    }
    const referral = rows.slice().sort(oldestFirst)[0];
    const referrerEmail = String(referral.referrer_email || '').toLowerCase();
    if (!referrerEmail || referrerEmail === guestEmail) return { skipped: 'self_referral' };
    // Compared to the second: both are UTC, written in different precisions.
    if (paid.paid_at && referral.created_date
        && String(paid.paid_at).slice(0, 19) < String(referral.created_date).slice(0, 19)) {
        return { skipped: 'paid_before_referral' };
    }
    const findReferrer = async () => (await db.User.filter({ email: referral.referrer_email }, 'created_date', 1))[0];
    if (!(await findReferrer())) return { skipped: 'referrer_not_found' };

    const claim = await db.LoyaltyTransaction.create({
        user_email: referral.referrer_email,
        points_earned: REFERRER_LOYALTY_BONUS,
        transaction_type: 'referral',
        booking_id: paid.id,
        description: `REFERRAL_BONUS — Referred ${paid.guest_email} who ${what}`,
    });
    const claims = await db.LoyaltyTransaction.filter({ transaction_type: 'referral', booking_id: paid.id }, 'created_date', 50);
    if (claims.slice().sort(oldestFirst)[0].id !== claim.id) {
        await db.LoyaltyTransaction.delete(claim.id).catch(() => {});
        return { skipped: 'already_awarded' };
    }

    // Read right before the credit: the balance is a number a withdrawal may
    // have changed since the first read.
    let before: any = null;
    try {
        await db.Referral.update(referral.id, {
            status: 'booking_completed',
            booking_id: paid.id,
            amount_earned_ngn: amountNGN,
        });
        before = await findReferrer();
        await db.User.update(before.id, {
            referral_balance_ngn: (Number(before.referral_balance_ngn) || 0) + amountNGN,
            loyalty_points: (Number(before.loyalty_points) || 0) + REFERRER_LOYALTY_BONUS,
        });
    } catch (err) {
        // A write can fail after it has landed. Undo only when the balance
        // reads exactly as it did before the credit was sent.
        let moved = false;
        if (before) {
            try {
                const now = await findReferrer();
                moved = !now || (Number(now.referral_balance_ngn) || 0) !== (Number(before.referral_balance_ngn) || 0);
            } catch {
                moved = true;
            }
        }
        if (!moved) {
            await db.Referral.update(referral.id, {
                status: referral.status || 'signed_up',
                booking_id: null,
                amount_earned_ngn: null,
            }).catch(() => {});
            await db.LoyaltyTransaction.delete(claim.id).catch(() => {});
        }
        throw err;
    }
    return { referrer_email: referral.referrer_email, amount_ngn: amountNGN, referral_id: referral.id };
}

Deno.serve(async (req) => {
    const ack = (extra: Record<string, unknown> = {}) =>
        new Response(JSON.stringify({ ok: true, ...extra }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405 });
    }

    const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secretKey) {
        console.error('PAYSTACK_SECRET_KEY not configured — rejecting webhook');
        return ack({ skipped: 'no_secret' });
    }

    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-paystack-signature') || '';
    const expected = await hmacSha512Hex(secretKey, rawBody);
    if (!safeEqual(expected, signatureHeader)) {
        console.warn('Invalid Paystack signature — ignoring');
        return ack({ skipped: 'invalid_signature' });
    }

    let event: any;
    try { event = JSON.parse(rawBody); } catch { return ack({ skipped: 'bad_json' }); }

    if (event?.event !== 'charge.success') {
        return ack({ skipped: `unhandled_event:${event?.event}` });
    }

    const reference: string = event?.data?.reference;
    const amountKobo: number = Number(event?.data?.amount) || 0;
    const currency: string = event?.data?.currency || '';
    const metadata = event?.data?.metadata || {};
    const bookingId: string | undefined = metadata?.booking_id;

    // Rides carry ride_booking_id instead of booking_id. This must be routed
    // before the stay path below, which would otherwise discard a ride payment
    // as 'missing_fields' and leave it unconfirmed until the guest happened to
    // hit verifyRidePayment.
    const rideBookingId: string | undefined = metadata?.ride_booking_id;
    if (reference && rideBookingId) {
        if (currency && currency !== 'NGN') {
            return ack({ skipped: `bad_currency:${currency}` });
        }
        return await handleRidePayment(createClientFromRequest(req), rideBookingId, reference, amountKobo, ack);
    }

    if (!reference || !bookingId) {
        console.warn('Webhook missing reference or booking_id', { reference, bookingId });
        return ack({ skipped: 'missing_fields' });
    }
    if (currency && currency !== 'NGN') {
        console.warn(`Webhook currency ${currency} != NGN — ignoring`);
        return ack({ skipped: `bad_currency:${currency}` });
    }

    // Base44 supplies the SDK client with service-role access automatically
    // via createClientFromRequest — no env vars needed.
    const sdk = createClientFromRequest(req);

    try {
        const booking = await sdk.asServiceRole.entities.Booking.get(bookingId);
        if (!booking) return ack({ skipped: 'booking_not_found' });

        if (booking.payment_status === 'paid' && booking.status === 'confirmed') {
            return ack({ skipped: 'already_paid' });
        }

        const expectedKobo = Math.round((Number(booking.total_price) || 0) * 100);
        if (amountKobo !== expectedKobo) {
            console.error(`Webhook amount mismatch: expected ${expectedKobo}, got ${amountKobo}`);
            return ack({ skipped: 'amount_mismatch' });
        }

        const nowIso = new Date().toISOString();
        await sdk.asServiceRole.entities.Booking.update(booking.id, {
            payment_status: 'paid',
            status: 'confirmed',
            payment_method: 'paystack',
            transaction_hash: reference,
            paid_at: nowIso,
        });

        // Idempotency guard against the verify+webhook race: re-read and
        // only proceed with notify + referral if transaction_hash is OUR
        // reference. Otherwise verifyPaystackPayment already handled it.
        const after = await sdk.asServiceRole.entities.Booking.get(booking.id);
        if (after?.transaction_hash !== reference) {
            console.log(`Lost race to mark booking ${booking.id} paid (winner ref: ${after?.transaction_hash}). Skipping.`);
            return ack({ skipped: 'lost_race', booking_id: booking.id });
        }

        // Best-effort phone lookup — Booking rows don't carry a phone, but the
        // guest's User profile usually does. Never let this block the notify.
        let guestPhone = '';
        try {
            const guestUsers = await sdk.asServiceRole.entities.User.filter({ email: booking.guest_email });
            guestPhone = guestUsers[0]?.phone_number || '';
        } catch { /* noop — phone shows as "Not provided" */ }

        await notifyAdmin({
            bookingId: booking.id,
            guestName: booking.guest_name,
            guestEmail: booking.guest_email,
            guestPhone,
            propertyId: booking.property_id,
            amountNGN: Number(booking.total_price) || 0,
            reference,
            optionLabel: Number(booking.bedrooms_booked) > 0 ? `${Number(booking.bedrooms_booked)}-bedroom option` : '',
        });

        // Push the guest — booking is locked in. Same tag as the verify
        // path so whichever fires first wins on-device.
        await tryPush(sdk, {
            user_email: booking.guest_email,
            title: '✅ Payment confirmed',
            body: `Your stay is locked in. Tap for arrival details.`,
            url: `/Bookings#booking-${booking.id}`,
            tag: `booking-paid-${booking.id}`,
        });

        // Re-read so we see any host_*_override that may have been filled.
        const bookingForEmail = await sdk.asServiceRole.entities.Booking.get(booking.id);
        const emailResult = await sendArrivalEmail({ sdk, booking: bookingForEmail });
        if (!emailResult.sent && emailResult.needs_admin) {
            try {
                await sdk.functions.invoke('requestHostDetails', {
                    booking_id: booking.id,
                    internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '',
                });
            } catch (reqErr) {
                console.warn('requestHostDetails invoke failed (non-fatal):', reqErr);
            }
        } else if (emailResult.sent) {
            try {
                await sdk.asServiceRole.entities.Booking.update(booking.id, {
                    host_details_status: 'complete',
                });
            } catch { /* noop */ }
        }

        await awardGuestBookingPoints(sdk, booking.guest_email, booking.id);

        // Referral reward. Who is paid, and how often, is decided in
        // payReferralReward, which every writer of the reward shares.
        try {
            const reward: any = await payReferralReward(sdk.asServiceRole.entities, bookingForEmail, 'booked (webhook)');
            if (!reward.skipped) {
                console.log(`🎁 Referrer ${reward.referrer_email} awarded ₦${reward.amount_ngn}`);
                // Push the referrer. Same tag as the verify path so we
                // don't double-notify if both paths land for the same
                // payment in close succession.
                await tryPush(sdk, {
                    user_email: reward.referrer_email,
                    title: '🎁 Referral payout',
                    body: `₦${reward.amount_ngn.toLocaleString()} just landed in your referral balance.`,
                    url: '/Withdrawals',
                    tag: `referral-${reward.referral_id}`,
                });
            }
        } catch (refErr) {
            console.warn('Webhook inline referral reward failed (non-fatal):', refErr);
        }

        return ack({ processed: true, booking_id: booking.id });
    } catch (err) {
        console.error('paystackWebhook error:', err);
        return ack({ error: (err as Error).message });
    }
});


// === Ride payment handling ===
// Server-to-server twin of base44/functions/verifyRidePayment/entry.ts, which
// runs the same block when the client reports back from the Paystack popup.
// Base44 function dirs are isolated and cannot share a module, so this is
// duplicated. KEEP THE TWO IN LOCKSTEP — the equivalent stays pair has already
// drifted in the ordering of its referral writes.

const GUEST_RIDE_POINTS = 500;

// A ride that has been paid stays paid, whatever happened to it afterwards.
// The guard used to be "paid AND confirmed", which let an old Paystack
// reference walk straight past it on a ride that had since been completed by
// the sweep or cancelled by admin, and flip that ride back to confirmed.
// Lockstep copy in verifyRidePayment and paystackWebhook.
function rideAlreadyPaid(ride: any) {
    return !!ride && ride.payment_status === 'paid';
}

async function handleRidePayment(
    sdk: any,
    rideId: string,
    reference: string,
    amountKobo: number,
    ack: (extra?: Record<string, unknown>) => Response,
): Promise<Response> {
    const ride = await sdk.asServiceRole.entities.RideBooking.get(rideId);
    if (!ride) return ack({ skipped: 'ride_not_found' });
    if (rideAlreadyPaid(ride)) {
        return ack({ skipped: 'already_paid' });
    }

    const expectedKobo = Math.round((Number(ride.total_price) || 0) * 100);
    if (amountKobo !== expectedKobo) {
        console.error(`Ride webhook amount mismatch: expected ${expectedKobo}, got ${amountKobo}`);
        return ack({ skipped: 'amount_mismatch' });
    }

    const nowIso = new Date().toISOString();
    await sdk.asServiceRole.entities.RideBooking.update(ride.id, {
        payment_status: 'paid',
        status: 'confirmed',
        payment_method: 'paystack',
        transaction_hash: reference,
        paid_at: nowIso,
    });

    // Race arbitration against verifyRidePayment.
    const after = await sdk.asServiceRole.entities.RideBooking.get(ride.id);
    if (after?.transaction_hash !== reference) {
        return ack({ skipped: 'lost_race', ride_booking_id: ride.id });
    }

    const fmtWhen = (iso: string) => {
        try {
            return new Date(iso).toLocaleString('en-GB', {
                timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
            });
        } catch { return iso; }
    };

    // Admin notify
    try {
        const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
        const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
        if (token && chatId) {
            const text = `💰 *RIDE PAID (webhook)*\n\n` +
                `Ride \`${ride.id}\`\n` +
                `• Vehicle: ${ride.vehicle_name}\n` +
                `• Guest: ${ride.guest_name} (${ride.guest_email})\n` +
                `• Mobile: ${ride.guest_phone || 'Not provided'}\n` +
                `• Pickup: ${fmtWhen(ride.start_at)}\n` +
                `• Amount: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n` +
                `• Paystack ref: \`${reference}\`\n\n` +
                `⚠️ *Assign a driver* — the guest cannot see driver details until you do.`;
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
            });
        }
    } catch (err) {
        console.error('Ride payment notify failed (non-fatal):', err);
    }

    // Guest confirmation email
    try {
        const pickup = [ride.pickup_location?.address, ride.pickup_location?.area, ride.pickup_location?.city]
            .filter(Boolean).join(', ');
        await sdk.integrations.Core.SendEmail({
            to: ride.guest_email,
            subject: `Ride confirmed — ${ride.vehicle_name}`,
            body: `Hi ${ride.guest_name || 'there'},\n\n` +
                `Payment received — your ride is confirmed. 🎉\n\n` +
                `🔖 Status: CONFIRMED & PAID\n` +
                `🚗 Vehicle: ${ride.vehicle_name}\n` +
                `🕒 Pickup: ${fmtWhen(ride.start_at)}\n` +
                (pickup ? `📍 From: ${pickup}\n` : '') +
                `💰 Paid: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n\n` +
                `We're assigning your driver now. You'll get their name and number here and in the app as soon as they're confirmed.\n\n` +
                `👉 View your ride: ${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(ride.id)}#ride-${encodeURIComponent(ride.id)}\n\n` +
                `— Urban Stays`,
            from_name: 'Urban Stays',
        });
    } catch (err) {
        console.warn('Ride confirmation email failed (non-fatal):', err);
    }

    await tryPush(sdk, {
        user_email: ride.guest_email,
        title: '✅ Ride confirmed',
        body: `${ride.vehicle_name} is booked. We'll share your driver's details shortly.`,
        url: `/Bookings#ride-${ride.id}`,
        tag: `ride-paid-${ride.id}`,
    });

    // Guest loyalty — dedup key is (email, 'booking', ride.id). Ride and
    // booking ids share a namespace, so the key stays unique.
    try {
        const users = await sdk.asServiceRole.entities.User.filter({ email: ride.guest_email });
        const guest = users[0];
        if (guest) {
            const existing = await sdk.asServiceRole.entities.LoyaltyTransaction.filter({
                user_email: ride.guest_email, transaction_type: 'booking', booking_id: ride.id,
            });
            if (existing.length === 0) {
                await sdk.asServiceRole.entities.User.update(guest.id, {
                    loyalty_points: (Number(guest.loyalty_points) || 0) + GUEST_RIDE_POINTS,
                });
                await sdk.asServiceRole.entities.LoyaltyTransaction.create({
                    user_email: ride.guest_email,
                    points_earned: GUEST_RIDE_POINTS,
                    transaction_type: 'booking',
                    booking_id: ride.id,
                    description: `Earned ${GUEST_RIDE_POINTS} points from a ride booking (webhook)`,
                });
            }
        }
    } catch (err) {
        console.warn('Ride loyalty award failed (non-fatal):', err);
    }

    // Referral reward. Who is paid, and how often, is decided in
    // payReferralReward, which every writer of the reward shares.
    try {
        const reward: any = await payReferralReward(sdk.asServiceRole.entities, after, 'booked a ride (webhook)');
        if (!reward.skipped) {
            await tryPush(sdk, {
                user_email: reward.referrer_email,
                title: '🎁 Referral payout',
                body: `₦${reward.amount_ngn.toLocaleString()} just landed in your referral balance.`,
                url: '/Withdrawals',
                tag: `referral-${reward.referral_id}`,
            });
        }
    } catch (err) {
        console.warn('Ride referral reward failed (non-fatal):', err);
    }

    return ack({ processed: true, ride_booking_id: ride.id });
}
