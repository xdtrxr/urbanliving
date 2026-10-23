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

// ── Stay payment rules ───────────────────────────────────────────────────────
// LOCKSTEP: from this line to "end of stay payment rules" the text is the same
// in verifyPaystackPayment and paystackWebhook. Functions cannot share code;
// scripts/check-stay-payment.mjs fails if the two copies differ.

// An id goes into the URL of the row it fetches ("../RideBooking/abc" would
// fetch a row of another entity), so only a plain id is ever used.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// entity.get() rejects for a row that is not there.
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
    }
}

// May a payment that has arrived confirm this booking by itself?
// Only a booking the admin approved, and that is still waiting, may. Until
// 2026-10-12 any correct payment confirmed any booking: one the admin never
// approved, or one already cancelled whose dates may have gone to someone
// else. That skipped the one decision that stops double bookings. Now such a
// payment is held for a person to decide:
//   held:not_approved   the request was never approved
//   held:expired        it ran out of time to pay and was cancelled for that
//   held:cancelled      it was cancelled, or is otherwise closed
// An approved booking stays payable for as long as it is still 'pending', even
// a little past its deadline: it is still holding its dates, so taking the
// money breaks no promise made to anyone else.
function stayPaymentVerdict(booking: any) {
    if (booking.status === 'confirmed') return 'payable';
    if (booking.status !== 'pending') return booking.cancel_reason === 'payment_expired' ? 'held:expired' : 'held:cancelled';
    return booking.approved_at ? 'payable' : 'held:not_approved';
}

// Reads as "this booking ..." for the guest and "a stay that ..." for the admin.
const HELD_BECAUSE: Record<string, string> = {
    not_approved: 'has not been approved yet',
    expired: 'had run out of time to pay and was cancelled',
    cancelled: 'was cancelled',
    holding: 'already has a payment on hold',
};

function heldSentence(amountNGN: number, why: string, reference: string) {
    return `We received your payment of ₦${amountNGN.toLocaleString()}, but this booking ${HELD_BECAUSE[why] || HELD_BECAUSE.cancelled}, so it is not confirmed. `
        + `Our team has been told and will confirm it or refund you in full. Please do not pay again. Reference: ${reference}.`;
}

// Money has arrived for a booking it may not confirm. Nothing a paid booking
// gets happens here: no confirmation, no arrival details (they hand out the
// address and the host's number), no points, no referral reward. The row is
// marked, the admin is told, with the two buttons telegramWebhook answers,
// and the guest is told what happens next.
//
// The row is read again first. The caller read it before asking Paystack, and
// the other path for the same payment (the payment page, or the webhook) may
// have held it in the meantime: the admin must get one alert, not two.
// Answers
//   'held'    this payment is now on hold
//   'second'  the booking already held a different payment; that first
//             reference stays on the row, this one is kept beside it and the
//             admin is told there are two
//   'again'   this payment was already on hold, or already announced as a
//             second one: nothing is written and nobody is told twice
//   'paid'    the booking was confirmed with this very payment while we looked
async function holdStayPayment(sdk: any, booking: any, reference: string, why: string) {
    const db = sdk.asServiceRole.entities;
    booking = (await getOrNull(db.Booking, booking.id).catch(() => null)) || booking;
    if (booking.payment_status === 'paid' && booking.transaction_hash === reference) return 'paid';
    const alreadyHolding = booking.payment_status === 'pending_confirmation' && !!booking.transaction_hash;
    const extras: string[] = Array.isArray(booking.payment_extra_refs) ? booking.payment_extra_refs : [];
    if (alreadyHolding && (booking.transaction_hash === reference || extras.includes(reference))) return 'again';
    if (!alreadyHolding) {
        await db.Booking.update(booking.id, {
            payment_status: 'pending_confirmation',
            payment_method: 'paystack',
            transaction_hash: reference,
        });
    } else {
        await db.Booking.update(booking.id, { payment_extra_refs: [...extras, reference] });
    }

    const amountNGN = Number(booking.total_price) || 0;
    let title = '';
    let phone = '';
    try { title = (await getOrNull(db.Property, booking.property_id))?.title || ''; } catch { /* the id is shown instead */ }
    try { phone = (await db.User.filter({ email: booking.guest_email }, 'created_date', 1))[0]?.phone_number || ''; } catch { /* shown as missing */ }
    const lines = [
        alreadyHolding ? 'SECOND PAYMENT for a booking that already has one on hold' : 'PAYMENT ON HOLD. The booking is NOT confirmed.',
        '',
        `₦${amountNGN.toLocaleString()} arrived for a stay that ${HELD_BECAUSE[why] || HELD_BECAUSE.cancelled}.`,
        `Booking: ${booking.id}`,
        `Property: ${title || booking.property_id}`,
        `Guest: ${booking.guest_name || 'no name'} (${booking.guest_email}), ${phone || 'no phone on file'}`,
        `Stay: ${booking.check_in} to ${booking.check_out}`,
        `Paystack ref: ${reference}`,
        '',
        alreadyHolding
            ? `The first payment (ref ${booking.transaction_hash}) is still on hold. Refund this second one in Paystack.`
            : 'The guest has NOT been sent a confirmation, arrival details or points. Confirm the booking with this payment, or refund it in Paystack and then mark it refunded.',
    ];
    const message: any = { chat_id: Deno.env.get('TELEGRAM_ADMIN_CHAT_ID'), text: lines.join('\n') };
    if (!alreadyHolding) {
        message.reply_markup = { inline_keyboard: [[
            { text: 'Confirm booking', callback_data: `held_confirm_${booking.id}` },
            { text: 'Mark refunded', callback_data: `held_refund_${booking.id}` },
        ]] };
    }
    // Plain text, and the answer is read: Telegram drops a message it cannot
    // parse, and this one is the only word that money is waiting.
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!token || !message.chat_id) {
        console.error(`Payment on hold for booking ${booking.id} and Telegram is not configured: nobody was told.`);
    } else {
        try {
            const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(message),
            });
            const answer = await res.json().catch(() => null);
            if (!answer || !answer.ok) console.error(`Telegram did not take the payment-on-hold alert for booking ${booking.id}:`, answer);
        } catch (err) {
            console.error(`Payment-on-hold alert failed for booking ${booking.id}:`, err);
        }
    }

    try {
        await sdk.integrations.Core.SendEmail({
            to: booking.guest_email,
            subject: 'We have your payment. Your booking is not confirmed yet',
            body: `Hi ${booking.guest_name || 'there'},\n\n${heldSentence(amountNGN, why, reference)}\n\n`
                + `You can follow it here: ${bookingLink(booking.id)}\n\n— Urban Stays`,
            from_name: 'Urban Stays',
        });
    } catch (err) {
        console.warn('Payment-on-hold email to the guest failed (non-fatal):', err);
    }
    await tryPush(sdk, {
        user_email: booking.guest_email,
        title: 'Payment received',
        body: 'Your booking is not confirmed yet. We will confirm it or refund you in full.',
        url: `/Bookings#booking-${booking.id}`,
        tag: `booking-held-${booking.id}`,
    });
    return alreadyHolding ? 'second' : 'held';
}
// ── end of stay payment rules ────────────────────────────────────────────────

// ── Ride payment rules ───────────────────────────────────────────────────────
// LOCKSTEP: from this line to "end of ride payment rules" the text is the same
// in verifyRidePayment and paystackWebhook. Functions cannot share code;
// scripts/check-ride-payment.mjs fails if the two copies differ. It leans on
// isId, getOrNull, tryPush and APP_BASE_URL, which both files define.

// May a payment that has arrived confirm this ride by itself? The stay rule
// (stayPaymentVerdict), plus one thing only rides have: a guest can be blocked
// from rides after a report. Until 2026-10-23 any correct payment confirmed
// any ride: one the admin never approved, one cancelled or expired whose car
// may since have gone to someone else, or one whose guest had been blocked.
// Now such a payment is held for a person to decide:
//   held:not_approved   the request was never approved
//   held:expired        it ran out of time to pay and was cancelled for that
//   held:cancelled      it was cancelled, or is otherwise closed
//   held:blocked        the guest has been blocked from rides since asking
// and, decided by the caller rather than here, 'price_changed': the payment
// is for the price the ride had when the guest started paying, and an admin
// changed it while Paystack was being asked.
// An approved ride stays payable for as long as it is still 'pending', even a
// little past its deadline: it is still holding its car.
function ridePaymentVerdict(ride: any, guestBlocked: boolean) {
    if (ride.status === 'confirmed') return 'payable';
    if (ride.status !== 'pending') return ride.cancel_reason === 'payment_expired' ? 'held:expired' : 'held:cancelled';
    if (!ride.approved_at) return 'held:not_approved';
    return guestBlocked ? 'held:blocked' : 'payable';
}

// Read fresh under the service role, as checkRideAvailability does, so a
// block takes effect at once.
async function rideGuestBlocked(db: any, email: string) {
    if (!email) return false;
    const accounts = await db.User.filter({ email }, 'created_date', 5);
    return accounts.some((account: any) => account && account.ride_blocked === true);
}

// Reads as "this ride ..." for the guest and "a ride that ..." for the admin.
const RIDE_HELD_BECAUSE: Record<string, string> = {
    not_approved: 'has not been approved yet',
    expired: 'had run out of time to pay and was cancelled',
    cancelled: 'was cancelled',
    blocked: 'cannot be confirmed on this account',
    holding: 'already has a payment on hold',
    price_changed: 'had its price changed while you were paying',
};

function rideHeldSentence(amountNGN: number, why: string, reference: string) {
    return `We received your payment of ₦${amountNGN.toLocaleString()}, but this ride ${RIDE_HELD_BECAUSE[why] || RIDE_HELD_BECAUSE.cancelled}, so it is not confirmed. `
        + `Our team has been told and will confirm it or refund you in full. Please do not pay again. Reference: ${reference}.`;
}

// Money has arrived for a ride it may not confirm. Nothing a paid ride gets
// happens here: no confirmation, no points, no referral reward, and no driver
// can be assigned (assignRideDriver asks for 'paid'). The row is marked, the
// admin is told, with the two buttons telegramWebhook answers, and the guest
// is told what happens next.
//
// The row is read again first: the other path for the same payment (the
// payment page, or the webhook) may have held it in the meantime, and the
// admin must get one alert, not two. Answers, as holdStayPayment's:
//   'held'    this payment is now on hold
//   'second'  the ride already held a different payment; that first reference
//             stays on the row, this one is kept beside it and the admin is
//             told there are two
//   'again'   this payment was already on hold, or already announced as a
//             second one: nothing is written and nobody is told twice
//   'paid'    the ride was confirmed with this very payment while we looked
async function holdRidePayment(sdk: any, ride: any, reference: string, why: string) {
    const db = sdk.asServiceRole.entities;
    ride = (await getOrNull(db.RideBooking, ride.id).catch(() => null)) || ride;
    if (ride.payment_status === 'paid' && ride.transaction_hash === reference) return 'paid';
    const alreadyHolding = ride.payment_status === 'pending_confirmation' && !!ride.transaction_hash;
    const extras: string[] = Array.isArray(ride.payment_extra_refs) ? ride.payment_extra_refs : [];
    if (alreadyHolding && (ride.transaction_hash === reference || extras.includes(reference))) return 'again';
    if (!alreadyHolding) {
        await db.RideBooking.update(ride.id, {
            payment_status: 'pending_confirmation',
            payment_method: 'paystack',
            transaction_hash: reference,
        });
    } else {
        await db.RideBooking.update(ride.id, { payment_extra_refs: [...extras, reference] });
    }

    const amountNGN = Number(ride.total_price) || 0;
    let pickup = String(ride.start_at || 'no pickup time');
    try {
        pickup = new Date(ride.start_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
    } catch { /* the stored value is shown instead */ }
    const lines = [
        alreadyHolding ? 'SECOND PAYMENT for a ride that already has one on hold' : 'RIDE PAYMENT ON HOLD. The ride is NOT confirmed.',
        '',
        `₦${amountNGN.toLocaleString()} arrived for a ride that ${RIDE_HELD_BECAUSE[why] || RIDE_HELD_BECAUSE.cancelled}.`,
        `Ride: ${ride.id}`,
        `Vehicle: ${ride.vehicle_name || ride.vehicle_id || 'unknown'}`,
        `Guest: ${ride.guest_name || 'no name'} (${ride.guest_email}), ${ride.guest_phone || 'no phone on file'}`,
        `Pickup: ${pickup}`,
        `Paystack ref: ${reference}`,
        '',
        alreadyHolding
            ? `The first payment (ref ${ride.transaction_hash}) is still on hold. Refund this second one in Paystack.`
            : 'The guest has NOT been sent a confirmation, and no driver can be assigned. Confirm the ride with this payment, or refund it in Paystack and then mark it refunded.',
    ];
    const message: any = { chat_id: Deno.env.get('TELEGRAM_ADMIN_CHAT_ID'), text: lines.join('\n') };
    if (!alreadyHolding) {
        message.reply_markup = { inline_keyboard: [[
            { text: 'Confirm ride', callback_data: `held_ride_confirm_${ride.id}` },
            { text: 'Mark refunded', callback_data: `held_ride_refund_${ride.id}` },
        ]] };
    }
    // Plain text, and the answer is read: Telegram drops a message it cannot
    // parse, and this one is the only word that money is waiting.
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!token || !message.chat_id) {
        console.error(`Payment on hold for ride ${ride.id} and Telegram is not configured: nobody was told.`);
    } else {
        try {
            const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(message),
            });
            const answer = await res.json().catch(() => null);
            if (!answer || !answer.ok) console.error(`Telegram did not take the payment-on-hold alert for ride ${ride.id}:`, answer);
        } catch (err) {
            console.error(`Payment-on-hold alert failed for ride ${ride.id}:`, err);
        }
    }

    const link = `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(ride.id)}#ride-${encodeURIComponent(ride.id)}`;
    try {
        await sdk.integrations.Core.SendEmail({
            to: ride.guest_email,
            subject: 'We have your payment. Your ride is not confirmed yet',
            body: `Hi ${ride.guest_name || 'there'},\n\n${rideHeldSentence(amountNGN, why, reference)}\n\n`
                + `You can follow it here: ${link}\n\n— Urban Stays`,
            from_name: 'Urban Stays',
        });
    } catch (err) {
        console.warn('Payment-on-hold email to the guest failed (non-fatal):', err);
    }
    await tryPush(sdk, {
        user_email: ride.guest_email,
        title: 'Payment received',
        body: 'Your ride is not confirmed yet. We will confirm it or refund you in full.',
        url: `/Bookings#ride-${ride.id}`,
        tag: `ride-held-${ride.id}`,
    });
    return alreadyHolding ? 'second' : 'held';
}
// ── end of ride payment rules ────────────────────────────────────────────────

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

    // The guest's rows once more, now that the claim is ours. Two bookings
    // of one guest confirmed a moment apart (a stay and a ride, say) each win
    // the claim for their own booking; the one that gets here second finds
    // the first one's stamp, and stands down.
    const rowsNow = await db.Referral.filter({ referred_email: paid.guest_email }, 'created_date', 50);
    if (rowsNow.some((row: any) => row.status === 'booking_completed')) {
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
            // Emptied with '' and 0, not null: what the platform does with a
            // null in a text or number field has not been seen.
            await db.Referral.update(referral.id, {
                status: referral.status || 'signed_up',
                booking_id: '',
                amount_earned_ngn: 0,
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
        const booking = isId(bookingId) ? await getOrNull(sdk.asServiceRole.entities.Booking, bookingId) : null;
        if (!booking) return ack({ skipped: 'booking_not_found' });

        // Paid is paid, whatever became of the booking afterwards. This used
        // to ask for "paid and confirmed", so a paid stay the admin later
        // cancelled was confirmed again when its event was delivered again.
        if (booking.payment_status === 'paid') {
            return ack({ skipped: 'already_paid' });
        }
        if (booking.payment_status === 'refunded' && booking.transaction_hash === reference) {
            return ack({ skipped: 'refunded' });
        }

        const expectedKobo = Math.round((Number(booking.total_price) || 0) * 100);
        if (amountKobo !== expectedKobo) {
            console.error(`Webhook amount mismatch: expected ${expectedKobo}, got ${amountKobo}`);
            return ack({ skipped: 'amount_mismatch' });
        }

        // One reference pays for one booking.
        const reused = (await sdk.asServiceRole.entities.Booking.filter({ transaction_hash: reference }, '-created_date', 5))
            .filter((row: any) => row.id !== booking.id);
        if (reused.length > 0) {
            console.error(`Webhook reference ${reference} is already on booking ${reused[0].id}`);
            return ack({ skipped: 'reference_reused' });
        }

        // The money is real and it is for this booking. Whether it may
        // confirm the booking is a separate question (stayPaymentVerdict). A
        // booking that already holds a different payment takes no second one.
        const verdict = stayPaymentVerdict(booking);
        const holdsAnother = booking.payment_status === 'pending_confirmation'
            && !!booking.transaction_hash && booking.transaction_hash !== reference;
        if (verdict !== 'payable' || holdsAnother) {
            const why = holdsAnother ? 'holding' : verdict.slice('held:'.length);
            const outcome = await holdStayPayment(sdk, booking, reference, why);
            if (outcome === 'paid') return ack({ skipped: 'already_paid' });
            return ack({ held: true, reason: why, outcome, booking_id: booking.id });
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
        const bookingForEmail = (await getOrNull(sdk.asServiceRole.entities.Booking, booking.id).catch(() => null)) || booking;
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
    // get() rejects for a row that is not there, and this runs outside the
    // handler's try: unguarded, Paystack was answered with an error and sent
    // the event again and again.
    const ride = isId(rideId) ? await getOrNull(sdk.asServiceRole.entities.RideBooking, rideId) : null;
    if (!ride) return ack({ skipped: 'ride_not_found' });
    if (rideAlreadyPaid(ride)) {
        return ack({ skipped: 'already_paid' });
    }
    if (ride.payment_status === 'refunded' && ride.transaction_hash === reference) {
        return ack({ skipped: 'refunded' });
    }

    const expectedKobo = Math.round((Number(ride.total_price) || 0) * 100);
    if (amountKobo !== expectedKobo) {
        console.error(`Ride webhook amount mismatch: expected ${expectedKobo}, got ${amountKobo}`);
        return ack({ skipped: 'amount_mismatch' });
    }

    // One reference pays for one ride.
    const reused = (await sdk.asServiceRole.entities.RideBooking.filter({ transaction_hash: reference }, '-created_date', 5))
        .filter((row: any) => row.id !== ride.id);
    if (reused.length > 0) {
        console.error(`Ride webhook reference ${reference} is already on ride ${reused[0].id}`);
        return ack({ skipped: 'reference_reused' });
    }

    // The money is real and it is for this ride. Whether it may confirm the
    // ride is a separate question (ridePaymentVerdict). A ride that already
    // holds a different payment takes no second one.
    const verdict = ridePaymentVerdict(ride, await rideGuestBlocked(sdk.asServiceRole.entities, ride.guest_email));
    const holdsAnother = ride.payment_status === 'pending_confirmation'
        && !!ride.transaction_hash && ride.transaction_hash !== reference;
    if (verdict !== 'payable' || holdsAnother) {
        const why = holdsAnother ? 'holding' : verdict.slice('held:'.length);
        const outcome = await holdRidePayment(sdk, ride, reference, why);
        if (outcome === 'paid') return ack({ skipped: 'already_paid' });
        return ack({ held: true, reason: why, outcome, ride_booking_id: ride.id });
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
