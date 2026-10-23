import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// cancelRideBooking
// ----------------------------------------------------------------------------
// Guest (or admin) cancellation.
//
// Exists as a function specifically because the apartment equivalent does not.
// Stays are cancelled by an unvalidated client-side entity write straight from
// Bookings.jsx, which means the 24-hour rule is enforced only in the UI, no
// cancel_reason is ever stamped, and nobody is notified. Routing rides through
// a function closes all three: eligibility is checked server-side, the reason
// is recorded, and the admin hears about it — which matters more for rides,
// where a cancellation frees a vehicle someone else may be waiting on.

const HOUR_MS = 60 * 60 * 1000;
const MIN_NOTICE_MS = 24 * HOUR_MS;

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, undefined, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

// Reverse the pay still HELD on a ride for every driver except keepDriverId
// (pass '' to reverse all of it). Released rows are never clawed back here;
// they are totalled so the caller can tell admin. The rows that were reversed
// are handed back as they were read, pay figures included. Lockstep copy, see
// assignRideDriver; scripts/check-driver-wallet.mjs fails if the two differ.
async function reverseHeldEarnings(sr: any, rideId: string, keepDriverId: string, note: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: rideId });
    const out = { reversed_ngn: 0, released_ngn: 0, driver_ids: [], rows: [] };
    for (const e of ledger) {
        if (keepDriverId && e.driver_id === keepDriverId) continue;
        const amount = Math.max(0, Math.round(Number(e.amount_ngn) || 0));
        if (e.status === 'held') {
            await sr.DriverEarning.update(e.id, {
                status: 'reversed',
                reversed_at: nowIso,
                on_hold: false,
                admin_notes: e.admin_notes ? `${e.admin_notes} | ${note}` : note,
            });
            out.reversed_ngn += amount;
            if (!out.driver_ids.includes(e.driver_id)) out.driver_ids.push(e.driver_id);
            out.rows.push(e);
        } else if (e.status === 'released') {
            out.released_ngn += amount;
        }
    }
    return out;
}

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

    // The money first, read right before it is written.
    let taken = 0;
    try {
        const referrer = (await db.User.filter({ email: referral.referrer_email }, 'created_date', 1))[0];
        if (referrer) {
            const balance = Math.max(0, Number(referrer.referral_balance_ngn) || 0);
            taken = Math.min(balance, amountNGN);
            await db.User.update(referrer.id, {
                referral_balance_ngn: balance - taken,
                loyalty_points: Math.max(0, (Number(referrer.loyalty_points) || 0) - REFERRER_LOYALTY_BONUS),
            });
        }
    } catch (err) {
        await db.LoyaltyTransaction.delete(claim.id).catch(() => {});
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

async function notifyAdmin(ride: any, byAdmin: boolean, payLine = '') {
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
    const text = `🚫 *RIDE CANCELLED*${byAdmin ? ' (by admin)' : ''}\n\n` +
        `Ride \`${ride.id}\`\n` +
        `• Vehicle: ${ride.vehicle_name}\n` +
        `• Guest: ${ride.guest_name} (${ride.guest_email})\n` +
        `• Was booked for: ${when}\n` +
        `• Value: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n\n` +
        `The vehicle is free again for that window.` + payLine;
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
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const { ride_booking_id, reason } = await req.json().catch(() => ({}));
        if (!ride_booking_id) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const ride = isId(ride_booking_id) ? await getOrNull(base44.asServiceRole.entities.RideBooking, ride_booking_id) : null;
        if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);

        const isAdmin = user.role === 'admin';
        if (ride.guest_email !== user.email && !isAdmin) {
            return json({ success: false, error: 'Not your booking' }, 403);
        }

        if (ride.status === 'cancelled') {
            return json({ success: true, data: { ride_booking_id, already_cancelled: true } });
        }
        if (ride.status === 'completed') {
            return json({ success: false, error: 'This ride has already been completed', code: 'ALREADY_COMPLETED' }, 409);
        }

        // Money is waiting on this ride for the admin to confirm or send back
        // (see ridePaymentVerdict in verifyRidePayment). Cancelled by the
        // guest, it would read "the vehicle is free again" and nobody would
        // be reminded of the money.
        if (ride.payment_status === 'pending_confirmation' && !isAdmin) {
            return json({
                success: false,
                error: 'We are holding a payment for this ride. Contact support to cancel it and get your refund.',
                code: 'PAYMENT_HELD',
            }, 409);
        }

        // Paid rides need a refund decision, so they go through support —
        // same policy as paid stays. Admin can still force a cancellation.
        if (ride.payment_status === 'paid' && !isAdmin) {
            return json({
                success: false,
                error: 'This ride is already paid. Contact support to cancel and arrange a refund.',
                code: 'PAID_NEEDS_SUPPORT',
            }, 409);
        }

        const startMs = Date.parse(ride.start_at || '');
        if (!isAdmin && !Number.isNaN(startMs) && startMs - Date.now() < MIN_NOTICE_MS) {
            return json({
                success: false,
                error: 'Rides can only be cancelled more than 24 hours before pickup. Contact support.',
                code: 'TOO_LATE_TO_CANCEL',
            }, 409);
        }

        await base44.asServiceRole.entities.RideBooking.update(ride_booking_id, {
            status: 'cancelled',
            cancel_reason: isAdmin && ride.guest_email !== user.email ? 'other' : 'user_cancelled',
            admin_response: typeof reason === 'string' && reason.trim() ? reason.trim() : undefined,
        });

        // The driver's pay follows the ride. A failure here must not undo the
        // cancellation: the release pass in autoCancelExpiredBookings reverses
        // any held row whose ride is cancelled, so this is belt and braces.
        // Asked of the ledger whatever the ride row said when it was read: an
        // assignment may be writing a driver onto it at this very moment.
        let payLine = '';
        {
            try {
                const sr = base44.asServiceRole.entities;
                const pay = await reverseHeldEarnings(sr, ride_booking_id, '', 'Ride cancelled', new Date().toISOString());
                if (pay.reversed_ngn > 0) {
                    payLine += `\n• Driver pay reversed: ₦${pay.reversed_ngn.toLocaleString()}`;
                }
                if (pay.released_ngn > 0) {
                    payLine += `\n• Driver pay ALREADY RELEASED: ₦${pay.released_ngn.toLocaleString()} — review in Rides → Earnings`;
                }
                const driver = ride.driver_id ? await sr.Driver.get(ride.driver_id) : null;
                const driverEmail = typeof driver?.user_email === 'string' ? driver.user_email.trim().toLowerCase() : '';
                if (driverEmail) {
                    await tryPush(base44, {
                        user_email: driverEmail,
                        title: '🚫 Ride cancelled',
                        body: `The ${ride.vehicle_name} booking you were assigned to has been cancelled.`,
                        url: '/DriverRides',
                        tag: `driver-cancelled-${ride.id}`,
                    });
                }
            } catch (err) {
                console.error('Driver pay reversal on cancel failed (the sweep will retry):', err);
                payLine = '\n• Driver pay could not be reversed just now; the next sweep will do it';
            }
        }

        // A paid ride cancelled by an admin is on its way to a refund: the
        // referral reward it earned is taken back. A failure must not undo
        // the cancellation.
        if (ride.payment_status === 'paid') {
            try {
                payLine += rewardLine(await takeBackReferralReward(base44.asServiceRole.entities, ride, 'ride'), false);
            } catch (err) {
                console.error(`Referral reward for ride ${ride_booking_id} could not be taken back:`, err);
                payLine += rewardLine(null, true);
            }
        }
        if (ride.payment_status === 'pending_confirmation') {
            payLine += '\n\n⚠️ A payment is ON HOLD for this ride. Refund it in Paystack, then mark it refunded under Admin, Payments on hold.';
        }

        await notifyAdmin(ride, isAdmin && ride.guest_email !== user.email, payLine);

        return json({ success: true, data: { ride_booking_id, status: 'cancelled' } });
    } catch (error) {
        console.error('cancelRideBooking error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
