import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// verifyRidePayment
// ----------------------------------------------------------------------------
// Client-invoked after the Paystack popup returns. Verifies the reference with
// Paystack, marks the ride paid, and fires the side effects.
//
// IMPORTANT: paystackWebhook runs this same post-payment block server-to-server
// for rides carrying ride_booking_id in their metadata. The two are duplicated
// because Base44 function directories are isolated. KEEP THEM IN LOCKSTEP —
// the equivalent stays pair has already drifted in the ordering of its
// referral writes.
//
// Rewards mirror stays, per the approved architecture: guest loyalty +500 and
// a 5% referral payout, because ride revenue is revenue. Both constants sit at
// the top so switching rides off is a one-line change.

const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify';
const REFERRAL_RATE = 0.05;
const REFERRER_LOYALTY_BONUS = 250;
const GUEST_RIDE_POINTS = 500;

// A ride that has been paid stays paid, whatever happened to it afterwards.
// The guard used to be "paid AND confirmed", which let an old Paystack
// reference walk straight past it on a ride that had since been completed by
// the sweep or cancelled by admin, and flip that ride back to confirmed.
// Lockstep copy in verifyRidePayment and paystackWebhook.
function rideAlreadyPaid(ride: any) {
    return !!ride && ride.payment_status === 'paid';
}

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const rideLink = (id: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(id)}#ride-${encodeURIComponent(id)}`;

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

// Flat points award, idempotent on (user_email, transaction_type, booking_id).
// booking_id carries the ride id here — LoyaltyTransaction has no separate
// ride column, and the ids are globally unique, so the dedup key still holds.
async function awardGuestRidePoints(sdk: any, guestEmail: string, rideId: string) {
    try {
        const users = await sdk.asServiceRole.entities.User.filter({ email: guestEmail });
        const guest = users[0];
        if (!guest) return;
        const existing = await sdk.asServiceRole.entities.LoyaltyTransaction.filter({
            user_email: guestEmail, transaction_type: 'booking', booking_id: rideId,
        });
        if (existing.length > 0) return;
        await sdk.asServiceRole.entities.User.update(guest.id, {
            loyalty_points: (Number(guest.loyalty_points) || 0) + GUEST_RIDE_POINTS,
        });
        await sdk.asServiceRole.entities.LoyaltyTransaction.create({
            user_email: guestEmail,
            points_earned: GUEST_RIDE_POINTS,
            transaction_type: 'booking',
            booking_id: rideId,
            description: `Earned ${GUEST_RIDE_POINTS} points from a ride booking`,
        });
    } catch (err) {
        console.warn('awardGuestRidePoints failed (non-fatal):', err);
    }
}

async function notifyAdmin(ride: any, reference: string) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const when = (() => {
        try {
            return new Date(ride.start_at).toLocaleString('en-GB', {
                timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
            });
        } catch { return ride.start_at; }
    })();
    const text = `💰 *RIDE PAID*\n\n` +
        `Ride \`${ride.id}\`\n` +
        `• Vehicle: ${ride.vehicle_name}\n` +
        `• Guest: ${ride.guest_name} (${ride.guest_email})\n` +
        `• Mobile: ${ride.guest_phone || 'Not provided'}\n` +
        `• Pickup: ${when}\n` +
        `• Amount: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n` +
        `• Paystack ref: \`${reference}\`\n\n` +
        `⚠️ *Assign a driver* — the guest cannot see driver details until you do.`;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Ride payment notify failed:', err);
    }
}

// true when the email was handed to the mail service.
async function emailGuest(sdk: any, ride: any) {
    if (!ride.guest_email) return false;
    const when = (() => {
        try {
            return new Date(ride.start_at).toLocaleString('en-GB', {
                timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short',
            });
        } catch { return ride.start_at; }
    })();
    const pickup = [ride.pickup_location?.address, ride.pickup_location?.area, ride.pickup_location?.city]
        .filter(Boolean).join(', ');
    try {
        await sdk.integrations.Core.SendEmail({
            to: ride.guest_email,
            subject: `Ride confirmed — ${ride.vehicle_name}`,
            body: `Hi ${ride.guest_name || 'there'},\n\n` +
                `Payment received — your ride is confirmed. 🎉\n\n` +
                `🔖 Status: CONFIRMED & PAID\n` +
                `🚗 Vehicle: ${ride.vehicle_name}\n` +
                `🕒 Pickup: ${when}\n` +
                (pickup ? `📍 From: ${pickup}\n` : '') +
                `💰 Paid: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n\n` +
                `We're assigning your driver now. You'll get their name and number here and in the app as soon as they're confirmed.\n\n` +
                `👉 View your ride: ${rideLink(ride.id)}\n\n` +
                `— Urban Stays`,
            from_name: 'Urban Stays',
        });
        return true;
    } catch (err) {
        console.warn('Ride confirmation email failed (non-fatal):', err);
        return false;
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

// An id goes into the URL of the row it fetches ("../Booking/abc" would fetch
// a row of another entity, and every check that follows would then be made on
// the wrong kind of row), so only a plain id is ever used. Lockstep copy, see
// createWithdrawalRequest.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// entity.get() rejects for a row that is not there. Unguarded, a stale or
// mistyped id is answered with a 500 instead of "not found".
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
    }
}

// What a paid ride gets, once: the admin's card, the guest's email and push,
// points, the referral reward. Shared by the payment page and by the admin
// confirming a payment that was on hold. Every step is best-effort; the answer
// says whether the guest's email went, so nobody is told it did when it did not.
async function afterRidePaid(base44: any, after: any, reference: string) {
    await notifyAdmin(after, reference);
    const guestEmailed = await emailGuest(base44, after);
    await tryPush(base44, {
        user_email: after.guest_email,
        title: '✅ Ride confirmed',
        body: `${after.vehicle_name} is booked. We'll share your driver's details shortly.`,
        url: `/Bookings#ride-${after.id}`,
        tag: `ride-paid-${after.id}`,
    });
    await awardGuestRidePoints(base44, after.guest_email, after.id);

    // Referral reward. Who is paid, and how often, is decided in
    // payReferralReward, which every writer of the reward shares.
    try {
        const reward: any = await payReferralReward(base44.asServiceRole.entities, after, 'booked a ride');
        if (!reward.skipped) {
            await tryPush(base44, {
                user_email: reward.referrer_email,
                title: '🎁 Referral payout',
                body: `₦${reward.amount_ngn.toLocaleString()} just landed in your referral balance.`,
                url: '/Withdrawals',
                tag: `referral-${reward.referral_id}`,
            });
        }
    } catch (refErr) {
        console.warn('Ride referral reward failed (non-fatal):', refErr);
    }
    return { guest_emailed: guestEmailed };
}

async function askPaystack(secretKey: string, reference: string) {
    const res = await fetch(`${PAYSTACK_VERIFY_URL}/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
    });
    const answer = await res.json().catch(() => null);
    const ok = res.ok && !!answer?.status && answer?.data?.status === 'success';
    if (!ok) console.warn('Paystack ride verify failed', answer);
    return { ok, data: answer?.data, message: answer?.message || 'Paystack returned non-success' };
}

function sameSecret(given: string, real: string) {
    if (given.length !== real.length) return false;
    let diff = 0;
    for (let i = 0; i < real.length; i++) diff |= given.charCodeAt(i) ^ real.charCodeAt(i);
    return diff === 0;
}

// The time a ride holds its car, from the stored start_at and end_at. A
// completed ride holds it only until it was completed, as in
// checkRideAvailability. null when the row has no usable times.
function rideSpan(ride: any) {
    const startMs = Date.parse(ride.start_at || '');
    const endMs = Date.parse(ride.end_at || '');
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
    if (ride.status === 'completed') {
        const doneMs = Date.parse(ride.completed_at || '');
        if (!Number.isNaN(doneMs)) return { startMs, endMs: Math.max(startMs, Math.min(endMs, doneMs)) };
    }
    return { startMs, endMs };
}

// The admin's answer to a payment on hold: confirm the ride with it. The one
// way a held payment becomes a confirmed ride. An admin session, or the
// internal secret that telegramWebhook and decideRideBooking send; with
// neither it is refused, and with no secret set only a session will do.
async function confirmHeldRide(base44: any, body: any, secretKey: string | undefined, json: (b: unknown, s?: number) => Response) {
    const secret = Deno.env.get('INTERNAL_FUNCTION_SECRET') || '';
    let allowed = !!secret && typeof body.internal_secret === 'string' && sameSecret(body.internal_secret, secret);
    if (!allowed) {
        try {
            const who = await base44.auth.me();
            allowed = !!who && who.role === 'admin';
        } catch {
            allowed = false;
        }
    }
    if (!allowed) {
        return json({ success: false, error: 'Only an admin can confirm a payment on hold.', code: 'ADMIN_ONLY' }, 403);
    }

    const db = base44.asServiceRole.entities;
    const rideId = String(body.ride_booking_id || '').trim();
    const ride = isId(rideId) ? await getOrNull(db.RideBooking, rideId) : null;
    if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);
    if (ride.payment_status === 'paid') {
        return json({ success: true, data: { ride_booking_id: ride.id, confirmed: true, already_paid: true } });
    }
    if (ride.payment_status !== 'pending_confirmation' || !ride.transaction_hash) {
        return json({ success: false, error: 'Nothing is on hold for this ride.', code: 'NOT_HELD' }, 409);
    }
    if (!secretKey) return json({ success: false, error: 'Payment service not configured' }, 500);

    // Paystack is asked again: the payment may have been refunded since it
    // was put on hold.
    const reference = ride.transaction_hash;
    const amountNGN = Number(ride.total_price) || 0;
    const paystack = await askPaystack(secretKey, reference);
    if (!paystack.ok) {
        return json({
            success: false,
            error: 'Paystack no longer reports this payment as successful. It may have been refunded. Nothing was confirmed.',
            code: 'PAYMENT_NOT_VERIFIED',
        }, 409);
    }
    const currency = paystack.data?.currency;
    if (paymentIsFor(paystack.data?.metadata, 'ride', ride.id) !== true
        || (Number(paystack.data?.amount) || 0) !== Math.round(amountNGN * 100)
        || (currency && currency !== 'NGN')) {
        return json({
            success: false,
            error: `The payment Paystack holds under ${reference} is not ₦${amountNGN.toLocaleString()} for this ride. Nothing was confirmed.`,
            code: 'PAYMENT_NOT_VERIFIED',
        }, 409);
    }

    // Is the car still free? A ride that is confirmed, completed, or approved
    // and waiting to be paid has a promise on it. A request nobody approved
    // does not: the admin is choosing between them by pressing this. A ride
    // with no stored times cannot be checked, and the admin is choosing.
    const mine = rideSpan(ride);
    if (mine && ride.vehicle_id) {
        const vehicle = isId(ride.vehicle_id) ? await getOrNull(db.Vehicle, ride.vehicle_id).catch(() => null) : null;
        const hours = Number(vehicle?.turnaround_hours);
        const buffer = Number.isFinite(hours) && hours >= 0 ? hours * 60 * 60 * 1000 : 60 * 60 * 1000;
        const others = await db.RideBooking.filter({
            vehicle_id: ride.vehicle_id,
            status: { $in: ['pending', 'confirmed', 'completed'] },
        }, '-start_at', 500);
        const taken = others.find((other: any) => {
            if (other.id === ride.id) return false;
            if (other.status === 'pending' && !other.approved_at) return false;
            const span = rideSpan(other);
            return !!span && mine.startMs < span.endMs + buffer && mine.endMs + buffer > span.startMs;
        });
        if (taken) {
            return json({
                success: false,
                error: `This car is now taken for an overlapping time (ride ${taken.id}, pickup ${taken.start_at}). `
                    + 'Refund this payment in Paystack and mark it refunded, or cancel the other ride first.',
                code: 'VEHICLE_TAKEN',
            }, 409);
        }
    }

    const nowIso = new Date().toISOString();
    await db.RideBooking.update(ride.id, {
        payment_status: 'paid',
        status: 'confirmed',
        payment_method: 'paystack',
        transaction_hash: reference,
        paid_at: nowIso,
        approved_at: ride.approved_at || nowIso,
    });

    // The ride is confirmed from here on, whatever happens below. A failure
    // in the steps that follow must not be answered as "not done": the admin
    // would press again, be told it was already paid, and nobody would know
    // the guest had not been written to.
    let guestEmailed = false;
    try {
        const after = (await getOrNull(db.RideBooking, ride.id).catch(() => null))
            || { ...ride, payment_status: 'paid', status: 'confirmed', paid_at: nowIso };
        guestEmailed = (await afterRidePaid(base44, after, reference)).guest_emailed;
    } catch (err) {
        console.error(`confirmHeldRide: ride ${ride.id} is confirmed, but the steps after it failed:`, err);
    }
    return json({ success: true, data: { ride_booking_id: ride.id, confirmed: true, paid_at: nowIso, reference, guest_emailed: guestEmailed } });
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({})) || {};
        const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');

        // Read before the session: telegramWebhook and decideRideBooking call
        // this with none.
        if (body.confirm_held === true) {
            return await confirmHeldRide(base44, body, secretKey, json);
        }

        // auth.me() throws, rather than answering nothing, for a caller with
        // no session.
        const user = await base44.auth.me().catch(() => null);
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const ride_booking_id = String(body.ride_booking_id || '').trim();
        const reference = String(body.reference || '').trim();
        if (!ride_booking_id || !reference) {
            return json({ success: false, error: 'ride_booking_id and reference are required' }, 400);
        }

        if (!secretKey) return json({ success: false, error: 'Payment service not configured' }, 500);

        // A plain id only. "../Booking/<a stay>" would fetch a stay as if it
        // were a ride, and every check below would be made on the wrong kind
        // of row.
        const db = base44.asServiceRole.entities;
        const ride = isId(ride_booking_id) ? await getOrNull(db.RideBooking, ride_booking_id) : null;
        if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);
        if (ride.guest_email !== user.email && user.role !== 'admin') {
            return json({ success: false, error: 'Not your booking' }, 403);
        }
        if (rideAlreadyPaid(ride)) {
            return json({ success: true, data: { already_paid: true, ride_booking_id } });
        }
        if (ride.payment_status === 'refunded' && ride.transaction_hash === reference) {
            return json({ success: false, error: 'This payment was refunded.', code: 'PAYMENT_REFUNDED' }, 409);
        }

        const paystack = await askPaystack(secretKey, reference);
        if (!paystack.ok) {
            return json({ success: false, error: 'Payment not verified', details: paystack.message }, 402);
        }

        // The reference must be the one that paid for THIS ride: its metadata
        // has to name it (the payment page always attaches the id), and it
        // must not already be on another ride. A transaction that names no
        // booking at all could otherwise be handed in for two rides of the
        // same price.
        const madeFor = paymentIsFor(paystack.data?.metadata, 'ride', ride.id);
        const reused = madeFor !== true ? [] : (await db.RideBooking.filter({ transaction_hash: reference }, '-created_date', 5))
            .filter((row: any) => row.id !== ride.id);
        if (madeFor !== true || reused.length > 0) {
            console.error(`Reference ${reference} was not paid for ride ${ride.id}`);
            return json({
                success: false,
                error: madeFor === null ? 'This payment does not say which booking it was for.' : 'This payment was made for a different booking.',
                code: 'REFERENCE_MISMATCH',
            }, 400);
        }

        const amountNGN = Number(ride.total_price) || 0;
        const expectedKobo = Math.round(amountNGN * 100);
        const actualKobo = Number(paystack.data?.amount) || 0;
        if (actualKobo !== expectedKobo) {
            console.error(`Ride amount mismatch: expected ${expectedKobo}, got ${actualKobo}`);
            return json({
                success: false, error: 'Payment amount mismatch',
                expected_kobo: expectedKobo, actual_kobo: actualKobo,
            }, 400);
        }
        const currency = paystack.data?.currency;
        if (currency && currency !== 'NGN') {
            return json({ success: false, error: `Unexpected currency ${currency}` }, 400);
        }

        // Asking Paystack takes a moment, and Paystack's own webhook for this
        // payment usually lands inside it. So the ride is read again, and what
        // follows is decided on the row as it is now, not as it was.
        const now = (await getOrNull(db.RideBooking, ride.id).catch(() => null)) || ride;
        if (rideAlreadyPaid(now)) {
            return json({
                success: true,
                data: { ride_booking_id: ride.id, paid_at: now.paid_at || null, already_processed_by: 'webhook' },
            });
        }

        // The money is real and it is for this ride. Whether it may confirm
        // the ride is a separate question (ridePaymentVerdict). A ride that
        // already holds a different payment takes no second one.
        const verdict = ridePaymentVerdict(now, await rideGuestBlocked(db, now.guest_email));
        const holdsAnother = now.payment_status === 'pending_confirmation'
            && !!now.transaction_hash && now.transaction_hash !== reference;
        if (verdict !== 'payable' || holdsAnother) {
            const why = holdsAnother ? 'holding' : verdict.slice('held:'.length);
            const outcome = await holdRidePayment(base44, now, reference, why);
            if (outcome === 'paid') {
                return json({ success: true, data: { already_paid: true, ride_booking_id } });
            }
            return json({
                success: false,
                error: rideHeldSentence(amountNGN, why, reference),
                code: 'PAYMENT_HELD',
                data: { ride_booking_id: ride.id, reference, amount_ngn: amountNGN, hold_reason: why },
            }, 409);
        }

        const nowIso = new Date().toISOString();
        await db.RideBooking.update(ride.id, {
            payment_status: 'paid',
            status: 'confirmed',
            payment_method: 'paystack',
            transaction_hash: reference,
            paid_at: nowIso,
        });

        // Race arbitration against paystackWebhook: re-read and only run the
        // side effects if our reference is the one that stuck.
        const after = await getOrNull(db.RideBooking, ride.id);
        if (after?.transaction_hash !== reference) {
            return json({
                success: true,
                data: { ride_booking_id: ride.id, already_processed_by: 'webhook' },
            });
        }

        await afterRidePaid(base44, after, reference);

        return json({
            success: true,
            data: { ride_booking_id: ride.id, paid_at: nowIso, amount_ngn: amountNGN, reference },
        });
    } catch (error) {
        console.error('verifyRidePayment error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
