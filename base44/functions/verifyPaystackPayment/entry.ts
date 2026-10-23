import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// IMPORTANT: This function and base44/functions/paystackWebhook/entry.ts share
// the post-payment booking-update logic (mark paid, notify admin, inline
// referral cash + loyalty bonus). Base44 functions are isolated dirs, so the
// logic is duplicated. Keep them in lockstep when changing either path.

const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify';
const REFERRAL_RATE = 0.05;
const REFERRER_LOYALTY_BONUS = 250;
const GUEST_BOOKING_POINTS = 500;

// Public origin used in outbound email links. Falls back to the prod domain
// so guest emails always have a working link even if APP_BASE_URL isn't set
// (e.g. fresh dev environments).
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

// Sends the guest the property address, host phone, and arrival instructions
// immediately after a payment confirms. Mirrors the same helper in
// paystackWebhook — keep in lockstep when changing.
// Returns { sent, needs_admin } so the caller can decide whether to invoke
// requestHostDetails when host info is missing. Prefers per-booking overrides
// (filled by admin via Telegram for a previous incomplete-property booking)
// over Property defaults. Mirrored in paystackWebhook — keep in lockstep.
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

        // Gate: if either critical field is missing AND we don't have an
        // override yet, escalate to admin via Telegram instead of sending an
        // email with "not provided" in it.
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

// Fire-and-forget push to a user. Swallows all errors so a push outage
// can never block the parent business action. Stable `tag` lets a re-sent
// push for the same event replace the previous notification on-device
// instead of stacking duplicates.
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
    const text = `💰 *PAYMENT RECEIVED*\n\n` +
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

// Which booking a Paystack transaction was made for, read from the metadata
// the payment page attached to it: ride_booking_id for a ride, booking_id for
// a stay. Without this a reference that paid for one booking could be handed
// in again to mark another booking of the same price as paid. true: it names
// this booking. false: it names another one. null: it names none, and the
// caller must check the reference has not been used. Lockstep copy in
// verifyRidePayment and verifyPaystackPayment.
function paymentIsFor(metadata: unknown, kind: string, id: string) {
    let meta = metadata;
    if (typeof meta === 'string') {
        try {
            meta = JSON.parse(meta);
        } catch (_err) {
            meta = null;
        }
    }
    const m = meta && typeof meta === 'object' ? meta : {};
    const ride = String(m.ride_booking_id || '');
    const stay = String(m.booking_id || '');
    if (kind === 'ride') {
        if (stay) return false;
        return ride ? ride === id : null;
    }
    if (ride) return false;
    return stay ? stay === id : null;
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

// Everything a stay gets once it is paid for: the admin's card, the guest's
// push and arrival email, the host-details prompt, the guest's points and
// the referral reward. Called once the booking row says paid and confirmed,
// by a payment that confirmed it and by the admin confirming one on hold.
// Answers what became of the arrival email: 'sent', 'waiting_for_host_details'
// (the property has no host phone or instructions; the admin is prompted) or
// 'not_sent'.
async function afterStayPaid(base44: any, booking: any, reference: string) {
    // Best-effort phone lookup — Booking rows don't carry a phone, but the
    // guest's User profile usually does. Never let this block the notify.
    let guestPhone = '';
    try {
        const guestUsers = await base44.asServiceRole.entities.User.filter({ email: booking.guest_email });
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

    // Push the guest — booking is locked in. Tag by booking so a
    // webhook re-fire for the same payment replaces this notification
    // instead of stacking. Deep-links into their bookings list.
    await tryPush(base44, {
        user_email: booking.guest_email,
        title: '✅ Payment confirmed',
        body: `Your stay is locked in. Tap for arrival details.`,
        url: `/Bookings#booking-${booking.id}`,
        tag: `booking-paid-${booking.id}`,
    });

    // Re-read so we see any host_*_override that may have been filled
    // before payment confirmed (rare but possible if admin pre-filled).
    const bookingForEmail = (await getOrNull(base44.asServiceRole.entities.Booking, booking.id).catch(() => null)) || booking;
    const emailResult = await sendArrivalEmail({ sdk: base44, booking: bookingForEmail });
    if (!emailResult.sent && emailResult.needs_admin) {
        try {
            await base44.functions.invoke('requestHostDetails', {
                booking_id: booking.id,
                internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '',
            });
        } catch (reqErr) {
            console.warn('requestHostDetails invoke failed (non-fatal):', reqErr);
        }
    } else if (emailResult.sent) {
        try {
            await base44.asServiceRole.entities.Booking.update(booking.id, {
                host_details_status: 'complete',
            });
        } catch { /* noop */ }
    }

    await awardGuestBookingPoints(base44, booking.guest_email, booking.id);

    // Referral reward. Who is paid, and how often, is decided in
    // payReferralReward, which every writer of the reward shares.
    try {
        const reward: any = await payReferralReward(base44.asServiceRole.entities, bookingForEmail, 'booked');
        if (!reward.skipped) {
            console.log(`🎁 Referrer ${reward.referrer_email} awarded ₦${reward.amount_ngn} + ${REFERRER_LOYALTY_BONUS} loyalty points`);
            // Push the referrer — they care a lot about this and
            // it's a great moment of feedback that the program works.
            await tryPush(base44, {
                user_email: reward.referrer_email,
                title: '🎁 Referral payout',
                body: `₦${reward.amount_ngn.toLocaleString()} just landed in your referral balance.`,
                url: '/Withdrawals',
                tag: `referral-${reward.referral_id}`,
            });
        }
    } catch (refErr) {
        console.warn('Inline referral reward failed (non-fatal):', refErr);
    }

    // What became of the arrival email, for whoever has to tell the admin.
    return { arrival_email: emailResult.sent ? 'sent' : emailResult.needs_admin ? 'waiting_for_host_details' : 'not_sent' };
}

// Paystack's own word on a reference. ok only for a successful charge.
async function askPaystack(secretKey: string, reference: string) {
    const res = await fetch(`${PAYSTACK_VERIFY_URL}/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
    });
    const answer = await res.json().catch(() => null);
    const ok = res.ok && !!answer?.status && answer?.data?.status === 'success';
    if (!ok) console.warn('Paystack verify failed', answer);
    return { ok, data: answer?.data, message: answer?.message || 'Paystack returned non-success' };
}

// Compared without stopping at the first difference, so the time taken says
// nothing about how much of a guess was right.
function sameSecret(given: string, real: string) {
    if (given.length !== real.length) return false;
    let diff = 0;
    for (let i = 0; i < real.length; i++) diff |= given.charCodeAt(i) ^ real.charCodeAt(i);
    return diff === 0;
}

// Two stays overlap when each starts before the other ends. Dates are days;
// a guest may check in on the day another checks out.
function staysOverlap(a: any, b: any) {
    const day = (v: unknown) => String(v || '').slice(0, 10);
    return day(a.check_in) < day(b.check_out) && day(b.check_in) < day(a.check_out);
}

// The admin confirms a booking with the payment it has on hold. This is the
// one way a held payment becomes a confirmed booking, so that the chain above
// is not written out a third time: the Admin screen, the approve button and
// the Telegram buttons all call it.
// Who may: an admin session, or another function carrying
// INTERNAL_FUNCTION_SECRET (telegramWebhook has no session). Unlike the
// functions that only send a message, this one refuses when the secret is not
// configured: it turns money into a booking.
// Before it confirms it asks Paystack again (the admin may have refunded the
// payment since) and looks at the dates again: a cancelled booking stopped
// holding its dates, and they may have gone to someone else.
async function confirmHeldPayment(base44: any, body: any, secretKey: string | undefined, respond: (status: number, payload: Record<string, unknown>) => Response) {
    const secret = Deno.env.get('INTERNAL_FUNCTION_SECRET') || '';
    let allowed = !!secret && typeof body.internal_secret === 'string' && sameSecret(body.internal_secret, secret);
    if (!allowed) {
        try {
            const who = await base44.auth.me().catch(() => null);
            allowed = !!who && who.role === 'admin';
        } catch {
            allowed = false;
        }
    }
    if (!allowed) {
        return respond(403, { success: false, error: 'Only an admin can confirm a payment on hold.', code: 'ADMIN_ONLY' });
    }

    const db = base44.asServiceRole.entities;
    const bookingId = String(body.booking_id || '').trim();
    const booking = isId(bookingId) ? await getOrNull(db.Booking, bookingId) : null;
    if (!booking) return respond(404, { success: false, error: 'Booking not found' });
    if (booking.payment_status === 'paid') {
        return respond(200, { success: true, data: { booking_id: booking.id, confirmed: true, already_paid: true } });
    }
    if (booking.payment_status !== 'pending_confirmation' || !booking.transaction_hash) {
        return respond(409, { success: false, error: 'Nothing is on hold for this booking.', code: 'NOT_HELD' });
    }
    if (!secretKey) {
        console.error('PAYSTACK_SECRET_KEY not configured');
        return respond(500, { success: false, error: 'Payment provider not configured' });
    }

    const reference = booking.transaction_hash;
    const amountNGN = Number(booking.total_price) || 0;
    const paystack = await askPaystack(secretKey, reference);
    if (!paystack.ok) {
        return respond(409, {
            success: false,
            error: 'Paystack no longer reports this payment as successful. It may have been refunded. Nothing was confirmed.',
            code: 'PAYMENT_NOT_VERIFIED',
        });
    }
    const paidKobo = Number(paystack.data?.amount) || 0;
    const currency = paystack.data?.currency;
    if (paymentIsFor(paystack.data?.metadata, 'stay', booking.id) !== true
        || paidKobo !== Math.round(amountNGN * 100)
        || (currency && currency !== 'NGN')) {
        return respond(409, {
            success: false,
            error: `The payment Paystack holds under ${reference} is not ₦${amountNGN.toLocaleString()} for this booking. Nothing was confirmed.`,
            code: 'PAYMENT_NOT_VERIFIED',
        });
    }

    // Another booking that is confirmed, or approved and waiting to be paid,
    // has a promise on its dates. A request nobody has approved does not: the
    // admin is choosing between them by pressing this.
    const others = await db.Booking.filter({
        property_id: booking.property_id,
        status: { $in: ['confirmed', 'pending'] },
    }, '-check_out', 500);
    const taken = others.find((other: any) => other.id !== booking.id
        && (other.status === 'confirmed' || !!other.approved_at)
        && staysOverlap(other, booking));
    if (taken) {
        return respond(409, {
            success: false,
            error: `Another booking now has these dates (${taken.check_in} to ${taken.check_out}, booking ${taken.id}). `
                + 'Refund this payment in Paystack and mark it refunded, or cancel the other booking first.',
            code: 'DATES_TAKEN',
        });
    }

    const nowIso = new Date().toISOString();
    await db.Booking.update(booking.id, {
        payment_status: 'paid',
        status: 'confirmed',
        payment_method: 'paystack',
        transaction_hash: reference,
        paid_at: nowIso,
        approved_at: booking.approved_at || nowIso,
    });

    // The request this booking came from is answered now. Found by the id it
    // carries; rows from before that id existed are matched as they used to
    // be. Failing here must not undo a confirmed, paid booking.
    try {
        let requests = await db.AvailabilityRequest.filter({ booking_id: booking.id }, '-created_date', 5);
        if (requests.length === 0) {
            requests = await db.AvailabilityRequest.filter({
                property_id: booking.property_id,
                user_email: booking.guest_email,
                check_in: booking.check_in,
                check_out: booking.check_out,
                status: 'pending',
            }, '-created_date', 5);
        }
        for (const request of requests) {
            if (request.status !== 'pending') continue;
            await db.AvailabilityRequest.update(request.id, {
                status: 'approved',
                admin_response: 'Confirmed with the payment that was on hold',
            });
        }
    } catch (err) {
        console.warn('confirmHeldPayment: could not mark the request approved (non-fatal):', err);
    }

    // The booking is confirmed from here on, whatever happens below. A
    // failure in the steps that follow must not be answered as "not done":
    // the admin would press again, be told it was already paid, and nobody
    // would know the guest had not been written to.
    let arrivalEmail = 'not_sent';
    try {
        const after = await afterStayPaid(base44, { ...booking, payment_status: 'paid', status: 'confirmed', paid_at: nowIso }, reference);
        arrivalEmail = after.arrival_email;
    } catch (err) {
        console.error(`confirmHeldPayment: booking ${booking.id} is confirmed, but the steps after it failed:`, err);
    }
    return respond(200, { success: true, data: { booking_id: booking.id, confirmed: true, paid_at: nowIso, reference, arrival_email: arrivalEmail } });
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const respond = (status: number, payload: Record<string, unknown>) =>
        new Response(JSON.stringify(payload), { status, headers });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') {
        return respond(405, { success: false, error: 'Method not allowed' });
    }

    try {
        const base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));
        const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');

        // Read before the session: telegramWebhook calls this with none.
        if (body.confirm_held === true) {
            return await confirmHeldPayment(base44, body, secretKey, respond);
        }

        const user = await base44.auth.me().catch(() => null);
        if (!user) {
            return respond(401, { success: false, error: 'Unauthorized' });
        }

        const bookingId = (body.booking_id || '').toString().trim();
        const reference = (body.reference || '').toString().trim();
        if (!bookingId || !reference) {
            return respond(400, { success: false, error: 'booking_id and reference are required' });
        }

        if (!secretKey) {
            console.error('PAYSTACK_SECRET_KEY not configured');
            return respond(500, { success: false, error: 'Payment provider not configured' });
        }

        const booking = isId(bookingId) ? await getOrNull(base44.asServiceRole.entities.Booking, bookingId) : null;
        if (!booking) {
            return respond(404, { success: false, error: 'Booking not found' });
        }

        if (booking.guest_email !== user.email && user.role !== 'admin') {
            return respond(403, { success: false, error: 'Forbidden' });
        }

        // Paid is paid, whatever became of the booking afterwards. This used
        // to ask for "paid and confirmed", so a paid stay the admin later
        // cancelled could be confirmed again by handing in its old reference.
        if (booking.payment_status === 'paid') {
            return respond(200, { success: true, data: { already_paid: true, booking_id: bookingId } });
        }
        if (booking.payment_status === 'refunded' && booking.transaction_hash === reference) {
            return respond(409, { success: false, error: 'This payment was refunded.', code: 'PAYMENT_REFUNDED' });
        }

        // Verify with Paystack (authoritative)
        const paystack = await askPaystack(secretKey, reference);
        if (!paystack.ok) {
            return respond(402, { success: false, error: 'Payment not verified', details: paystack.message });
        }

        // The reference must be the one that paid for THIS booking: its
        // metadata has to name it (the payment page always attaches the id),
        // and it must not already be on another booking. A transaction that
        // names no booking at all could be handed in for a stay and again for
        // a ride of the same price.
        const madeFor = paymentIsFor(paystack.data?.metadata, 'stay', booking.id);
        const reused = madeFor !== true ? [] : (await base44.asServiceRole.entities.Booking.filter({ transaction_hash: reference }, '-created_date', 5))
            .filter((row: any) => row.id !== booking.id);
        if (madeFor !== true || reused.length > 0) {
            console.error(`Reference ${reference} was not paid for stay ${booking.id}`);
            return respond(400, {
                success: false,
                error: madeFor === null ? 'This payment does not say which booking it was for.' : 'This payment was made for a different booking.',
                code: 'REFERENCE_MISMATCH',
            });
        }

        // Amount check (Paystack returns kobo)
        const amountNGN = Number(booking.total_price) || 0;
        const expectedKobo = Math.round(amountNGN * 100);
        const actualKobo = Number(paystack.data?.amount) || 0;
        if (actualKobo !== expectedKobo) {
            console.error(`Amount mismatch: expected ${expectedKobo}, got ${actualKobo}`);
            return respond(400, {
                success: false,
                error: 'Payment amount mismatch',
                expected_kobo: expectedKobo,
                actual_kobo: actualKobo,
            });
        }

        const currency = paystack.data?.currency;
        if (currency && currency !== 'NGN') {
            return respond(400, { success: false, error: `Unsupported currency: ${currency}` });
        }

        // Asking Paystack takes a moment, and Paystack's own webhook for this
        // payment usually lands inside it. So the booking is read again: if
        // it is paid now, the webhook has done everything, and going on would
        // send the admin a second card and the guest a second arrival email.
        // What follows is decided on the row as it is now, not as it was.
        const now = (await getOrNull(base44.asServiceRole.entities.Booking, booking.id).catch(() => null)) || booking;
        if (now.payment_status === 'paid') {
            return respond(200, {
                success: true,
                data: { booking_id: booking.id, paid_at: now.paid_at || null, already_processed_by: 'webhook' },
            });
        }

        // The money is real and it is for this booking. Whether it may
        // confirm the booking is a separate question (stayPaymentVerdict). A
        // booking that already holds a different payment takes no second one.
        const verdict = stayPaymentVerdict(now);
        const holdsAnother = now.payment_status === 'pending_confirmation'
            && !!now.transaction_hash && now.transaction_hash !== reference;
        if (verdict !== 'payable' || holdsAnother) {
            const why = holdsAnother ? 'holding' : verdict.slice('held:'.length);
            const outcome = await holdStayPayment(base44, booking, reference, why);
            if (outcome === 'paid') {
                return respond(200, { success: true, data: { already_paid: true, booking_id: bookingId } });
            }
            return respond(409, {
                success: false,
                error: heldSentence(amountNGN, why, reference),
                code: 'PAYMENT_HELD',
                data: { booking_id: booking.id, reference, amount_ngn: amountNGN, hold_reason: why },
            });
        }

        const nowIso = new Date().toISOString();
        await base44.asServiceRole.entities.Booking.update(booking.id, {
            payment_status: 'paid',
            status: 'confirmed',
            payment_method: 'paystack',
            transaction_hash: reference,
            paid_at: nowIso,
        });

        // Idempotency guard against the verify+webhook race: re-read and
        // confirm transaction_hash matches OUR reference. If another path
        // (typically the Paystack webhook) wrote first, skip notify + referral
        // so we don't double-fire them.
        const after = await base44.asServiceRole.entities.Booking.get(booking.id);
        if (after?.transaction_hash !== reference) {
            console.log(`Lost the race to mark booking ${booking.id} paid (winner ref: ${after?.transaction_hash}). Skipping side-effects.`);
            return respond(200, {
                success: true,
                data: { booking_id: booking.id, paid_at: after?.paid_at || nowIso, already_processed_by: 'webhook' },
            });
        }

        // Confirmed from here on. A failure below is logged, not answered to
        // the guest as a failed payment.
        try {
            await afterStayPaid(base44, booking, reference);
        } catch (err) {
            console.error(`Booking ${booking.id} is paid and confirmed, but the steps after it failed:`, err);
        }

        return respond(200, {
            success: true,
            data: {
                booking_id: booking.id,
                paid_at: nowIso,
                amount_ngn: amountNGN,
                reference,
            },
        });
    } catch (error) {
        console.error('verifyPaystackPayment error:', error);
        return respond(500, {
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        });
    }
});
