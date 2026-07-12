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
👥 Guests: ${Number(booking.guests) || 1}

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
        await sdk.functions.invoke('sendPushNotification', opts);
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
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const text = `💰 *PAYMENT RECEIVED (webhook)*\n\n` +
        `Booking \`${opts.bookingId}\`\n` +
        `• Guest: ${opts.guestName} (${opts.guestEmail})\n` +
        `• Mobile: ${opts.guestPhone || 'Not provided'}\n` +
        `• Property: \`${opts.propertyId}\`\n` +
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
                await sdk.functions.invoke('requestHostDetails', { booking_id: booking.id });
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

        // Inline referral reward — direct service-role writes, idempotent.
        try {
            const guests = await sdk.asServiceRole.entities.User.filter({ email: booking.guest_email });
            const guest = guests[0];
            if (guest?.referred_by_code) {
                const referrers = await sdk.asServiceRole.entities.User.filter({ referral_code: guest.referred_by_code });
                const referrer = referrers[0];
                if (referrer) {
                    let referrals = await sdk.asServiceRole.entities.Referral.filter({
                        referrer_email: referrer.email,
                        referred_email: guest.email,
                    });
                    let referral = referrals[0];
                    if (!referral) {
                        referral = await sdk.asServiceRole.entities.Referral.create({
                            referrer_email: referrer.email,
                            referred_email: guest.email,
                            status: 'signed_up',
                        });
                    }
                    // Second idempotency guard: even if status check passes
                    // under a race, the booking_id stamp on the referral row
                    // will catch a second writer trying to credit the same
                    // booking.
                    const alreadyCreditedThisBooking = referral.booking_id === booking.id;
                    if (referral.status !== 'booking_completed' && !alreadyCreditedThisBooking) {
                        const amountNGN = Math.round((Number(booking.total_price) || 0) * REFERRAL_RATE);
                        const newBalance = (Number(referrer.referral_balance_ngn) || 0) + amountNGN;
                        const newLoyalty = (Number(referrer.loyalty_points) || 0) + REFERRER_LOYALTY_BONUS;
                        await sdk.asServiceRole.entities.User.update(referrer.id, {
                            referral_balance_ngn: newBalance,
                            loyalty_points: newLoyalty,
                        });
                        try {
                            await sdk.asServiceRole.entities.LoyaltyTransaction.create({
                                user_email: referrer.email,
                                points_earned: REFERRER_LOYALTY_BONUS,
                                transaction_type: 'referral',
                                booking_id: booking.id,
                                description: `REFERRAL_BONUS — Referred ${guest.email} who booked (webhook)`,
                            });
                        } catch (loyaltyErr) {
                            console.warn('Referrer loyalty log failed (non-fatal):', loyaltyErr);
                        }
                        await sdk.asServiceRole.entities.Referral.update(referral.id, {
                            status: 'booking_completed',
                            booking_id: booking.id,
                            amount_earned_ngn: amountNGN,
                        });
                        console.log(`🎁 Referrer ${referrer.email} awarded ₦${amountNGN}`);
                        // Push the referrer. Same tag as the verify path so we
                        // don't double-notify if both paths land for the same
                        // payment in close succession.
                        await tryPush(sdk, {
                            user_email: referrer.email,
                            title: '🎁 Referral payout',
                            body: `₦${amountNGN.toLocaleString()} just landed in your referral balance.`,
                            url: '/Withdrawals',
                            tag: `referral-${referral.id}`,
                        });
                    }
                }
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
