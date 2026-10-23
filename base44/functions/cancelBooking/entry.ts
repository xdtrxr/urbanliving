import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// cancelBooking
// ----------------------------------------------------------------------------
// Guest (or admin) cancellation of a stay. Twin of cancelRideBooking.
//
// Until this existed the Bookings page cancelled a stay by writing
// status='cancelled' straight to the Booking row from the browser. That worked
// only because the Booking update rule let a guest edit their own row — and
// the same rule let them edit payment_status, total_price and approved_at.
// The rule is now admin-only, so every guest-side write to a Booking goes
// through a function that checks what it is being asked to do.
//
// Rules (guest): unpaid, pending or confirmed, and more than 24h before
// check-in. Paid stays need a refund decision, so they go through support.
// Admin can cancel anything that is not already cancelled.

const HOUR_MS = 60 * 60 * 1000;
const MIN_NOTICE_MS = 24 * HOUR_MS;

// An id goes into the URL of the row it fetches, so only a plain id is ever
// used. Lockstep copy, see createWithdrawalRequest.
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
// Nigeria is WAT (UTC+1) year-round. Check-in is treated as the start of the
// calendar day in that zone, matching how the reminders cron reads it.
const WAT_OFFSET = '+01:00';

// ── Taking a referral reward back ────────────────────────────────────────────
// LOCKSTEP: from this line to "end of taking a referral reward back" the text
// is the same in cancelBooking and cancelRideBooking;
// scripts/check-referral-clawback.mjs fails if the two copies differ.
//
// A referral reward is paid the moment a referred guest pays
// (payReferralReward, in the payment functions). Decided on 2026-10-23: when
// an admin cancels a paid stay or ride, which is how a refund starts, the
// reward that booking earned is taken back. The referrer's balance goes down
// by it, but never below zero: what they have already withdrawn is a
// shortfall, written on the record and told to the admin, for a person to
// settle. Only when all of it came back does the guest's referral row go back
// to 'signed_up', so a later booking that is kept can earn the one reward;
// with a shortfall the row keeps saying the reward was used, or the referrer
// would be paid a second time on top of money never returned.
//
// Claim first, as the reward does: the reversal's own loyalty row (negative
// points, same booking id) is written, and only the oldest such row goes on.
// The reward's own row is left in place, so the cancelled booking can never
// earn again (payReferralReward lets only the oldest claim pay). The money is
// moved before the referral row is touched: if the money write fails, the
// claim is removed and nothing else has changed.
//
// Answers { skipped } or { amount_ngn, taken_ngn, shortfall_ngn }. Throws if
// a write fails; the caller tells the admin to check the balance.
const REFERRER_LOYALTY_BONUS = 250;

async function takeBackReferralReward(db: any, booking: any, what: string) {
    const oldestFirst = (a: any, b: any) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
        || String(a.id).localeCompare(String(b.id));
    const rows = await db.Referral.filter({ booking_id: booking.id }, 'created_date', 5);
    const referral = rows.find((row: any) => row.status === 'booking_completed');
    if (!referral) return { skipped: 'no_reward' };
    const amountNGN = Math.max(0, Math.round(Number(referral.amount_earned_ngn) || 0));

    const claim = await db.LoyaltyTransaction.create({
        user_email: referral.referrer_email,
        points_earned: -REFERRER_LOYALTY_BONUS,
        transaction_type: 'referral',
        booking_id: booking.id,
        description: `REFERRAL_REVERSED — ${booking.guest_email}'s ${what} was cancelled by an admin`,
    });
    const reversals = (await db.LoyaltyTransaction.filter({ transaction_type: 'referral', booking_id: booking.id }, 'created_date', 50))
        .filter((row: any) => (Number(row.points_earned) || 0) < 0);
    const first = reversals.slice().sort(oldestFirst)[0];
    if (!first || first.id !== claim.id) {
        await db.LoyaltyTransaction.delete(claim.id).catch(() => {});
        if (!first) throw new Error(`The reversal claim for booking ${booking.id} could not be read back`);
        return { skipped: 'already_taken_back' };
    }

    // The money first, read right before it is written. A write can fail
    // after it has landed: the claim is removed only when the balance reads
    // as it did before, so the money is never taken twice. If it did move,
    // the claim stays, and the error still reaches the admin.
    let taken = 0;
    const findReferrer = async () => (await db.User.filter({ email: referral.referrer_email }, 'created_date', 1))[0];
    let before: any = null;
    try {
        before = await findReferrer();
        if (before) {
            const balance = Math.max(0, Number(before.referral_balance_ngn) || 0);
            taken = Math.min(balance, amountNGN);
            await db.User.update(before.id, {
                referral_balance_ngn: balance - taken,
                loyalty_points: Math.max(0, (Number(before.loyalty_points) || 0) - REFERRER_LOYALTY_BONUS),
            });
        }
    } catch (err) {
        let moved = false;
        if (before) {
            try {
                // Both fields the write touches: with nothing left to take
                // from the balance, only the points tell whether it landed.
                const now = await findReferrer();
                moved = !now
                    || (Number(now.referral_balance_ngn) || 0) !== (Number(before.referral_balance_ngn) || 0)
                    || (Number(now.loyalty_points) || 0) !== (Number(before.loyalty_points) || 0);
            } catch {
                moved = true;
            }
        }
        if (!moved) await db.LoyaltyTransaction.delete(claim.id).catch(() => {});
        throw err;
    }
    const shortfall = amountNGN - taken;
    if (shortfall > 0) {
        await db.LoyaltyTransaction.update(claim.id, {
            description: `${claim.description || 'REFERRAL_REVERSED'}; ₦${shortfall.toLocaleString()} could not be taken back (already withdrawn)`,
        }).catch(() => {});
    } else {
        await db.Referral.update(referral.id, { status: 'signed_up', booking_id: '', amount_earned_ngn: 0 });
    }
    return { amount_ngn: amountNGN, taken_ngn: taken, shortfall_ngn: shortfall };
}

// One line for the admin's cancellation message.
function rewardLine(result: any, failed: boolean) {
    if (failed) return '\n• Referral reward: could NOT be taken back. Check the referrer\'s balance in Admin.';
    if (!result || result.skipped) return '';
    return result.shortfall_ngn > 0
        ? `\n• Referral reward: ₦${result.taken_ngn.toLocaleString()} taken back; ₦${result.shortfall_ngn.toLocaleString()} was already withdrawn and could not be`
        : `\n• Referral reward taken back: ₦${result.taken_ngn.toLocaleString()}`;
}
// ── end of taking a referral reward back ─────────────────────────────────────

async function notifyAdmin(booking: any, propertyTitle: string, byAdmin: boolean, extraLine = '') {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const text = `🚫 *STAY CANCELLED*${byAdmin ? ' (by admin)' : ''}\n\n` +
        `Booking \`${booking.id}\`\n` +
        `• Property: ${propertyTitle}\n` +
        `• Guest: ${booking.guest_name || ''} (${booking.guest_email})\n` +
        `• Dates: ${booking.check_in} → ${booking.check_out}\n` +
        `• Value: ₦${(Number(booking.total_price) || 0).toLocaleString()}\n\n` +
        `The dates are free again.` +
        // A payment was on hold for it (it arrived before the booking could
        // be confirmed). Cancelling does not send it back.
        (booking.payment_status === 'pending_confirmation'
            ? `\n\n⚠️ A payment is ON HOLD for this booking. Refund it in Paystack, then mark it refunded under Admin, Payments on hold.`
            : '') +
        extraLine;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Cancellation notify failed (non-fatal):', err);
    }
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me().catch(() => null);
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const { booking_id, reason } = await req.json().catch(() => ({}));
        if (!booking_id) return json({ success: false, error: 'booking_id is required' }, 400);

        const booking = isId(booking_id) ? await getOrNull(base44.asServiceRole.entities.Booking, booking_id) : null;
        if (!booking) return json({ success: false, error: 'Booking not found' }, 404);

        const isAdmin = user.role === 'admin';
        if (booking.guest_email !== user.email && !isAdmin) {
            return json({ success: false, error: 'Not your booking' }, 403);
        }

        if (booking.status === 'cancelled') {
            return json({ success: true, data: { booking_id, already_cancelled: true } });
        }
        if (booking.status === 'completed') {
            return json({ success: false, error: 'This stay has already been completed', code: 'ALREADY_COMPLETED' }, 409);
        }

        if (!isAdmin) {
            // Money is waiting on this booking for the admin to confirm or
            // send back. Cancelled, it would read "the dates are free again"
            // and nobody would be reminded of the money.
            if (booking.payment_status === 'pending_confirmation') {
                return json({
                    success: false,
                    error: 'We are holding a payment for this booking. Contact support to cancel it and get your refund.',
                    code: 'PAYMENT_HELD',
                }, 409);
            }
            if (booking.payment_status === 'paid') {
                return json({
                    success: false,
                    error: 'This booking is already paid. Contact support to cancel and arrange a refund.',
                    code: 'PAID_NEEDS_SUPPORT',
                }, 409);
            }
            if (!['pending', 'confirmed'].includes(booking.status)) {
                return json({ success: false, error: 'This booking cannot be cancelled', code: 'NOT_CANCELLABLE' }, 409);
            }
            const checkInMs = Date.parse(`${booking.check_in}T00:00:00${WAT_OFFSET}`);
            if (!Number.isNaN(checkInMs) && checkInMs - Date.now() < MIN_NOTICE_MS) {
                return json({
                    success: false,
                    error: 'Stays can only be cancelled more than 24 hours before check-in. Contact support.',
                    code: 'TOO_LATE_TO_CANCEL',
                }, 409);
            }
        }

        await base44.asServiceRole.entities.Booking.update(booking_id, {
            status: 'cancelled',
            cancel_reason: isAdmin && booking.guest_email !== user.email ? 'other' : 'user_cancelled',
        });

        // A paid stay cancelled by an admin is on its way to a refund: the
        // referral reward it earned is taken back. Only an admin can get here
        // with a paid stay. A failure must not undo the cancellation.
        let extraLine = '';
        if (booking.payment_status === 'paid') {
            try {
                extraLine = rewardLine(await takeBackReferralReward(base44.asServiceRole.entities, booking, 'stay'), false);
            } catch (err) {
                console.error(`Referral reward for stay ${booking_id} could not be taken back:`, err);
                extraLine = rewardLine(null, true);
            }
        }

        let propertyTitle = booking.property_id;
        try {
            const property = await getOrNull(base44.asServiceRole.entities.Property, booking.property_id);
            propertyTitle = property?.title || propertyTitle;
        } catch (err) {
            console.warn('Could not read property for cancellation notice (non-fatal):', err);
        }
        await notifyAdmin(
            { ...booking, ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}) },
            propertyTitle,
            isAdmin && booking.guest_email !== user.email,
            extraLine,
        );

        return json({ success: true, data: { booking_id, status: 'cancelled' } });
    } catch (error) {
        console.error('cancelBooking error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
