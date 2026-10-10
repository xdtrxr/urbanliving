import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// settleDriverEarning
// ----------------------------------------------------------------------------
// Admin's five moves on one row of a driver's pay:
//
//   release   pay it now instead of waiting for the sweep
//   hold      stop the sweep releasing it (a dispute, a question)
//   unhold    let the sweep carry on
//   adjust    change the figure while it is still held (extra hours, a fine)
//   reverse   this ride no longer pays
//
// No action writes a balance, because no balance is stored: the driver's
// available money is always recomputed from these rows (see getDriverWallet).
// So "release" is a status flip, and reversing pay that was already released
// simply lowers what they can withdraw. If they had withdrawn it already, the
// difference is carried as a shortfall against their next released pay.
//
// Every transition is decided by nextEarningState, a pure function the check
// script runs against the whole table of cases.

const MAX_PAYOUT_NGN = 50000000;
const MAX_REASON_LENGTH = 500;

const REFUSALS: Record<string, { status: number; error: string }> = {
    INVALID_ACTION: { status: 400, error: 'Unknown action.' },
    REASON_REQUIRED: { status: 400, error: 'Give a reason. It is kept on the record.' },
    INVALID_AMOUNT: { status: 400, error: 'The new pay must be a whole naira amount between 0 and 50,000,000.' },
    NOT_HELD: { status: 409, error: 'Only pay that is still held can be changed this way.' },
    ALREADY_REVERSED: { status: 409, error: 'This pay has already been reversed.' },
    REVERSED_MEANWHILE: { status: 409, error: 'This pay was reversed while that change was being saved. It stays reversed.' },
};

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// What the earning becomes. Plain JavaScript body: the check script lifts it.
function nextEarningState(action: string, earning: any, input: any, nowIso: string) {
    const reason = typeof (input && input.reason) === 'string' ? input.reason.trim().slice(0, MAX_REASON_LENGTH) : '';
    const status = earning && earning.status;
    const known = ['release', 'hold', 'unhold', 'adjust', 'reverse'];
    if (!known.includes(action)) return { ok: false, code: 'INVALID_ACTION' };
    if (status === 'reversed') return { ok: false, code: 'ALREADY_REVERSED' };
    // A row that carries a reversal time is reversed, even if a release that
    // landed at the same moment left its status saying otherwise. The one
    // move still allowed is to reverse it again, which puts the status right.
    if (earning && earning.reversed_at && action !== 'reverse') return { ok: false, code: 'ALREADY_REVERSED' };

    if (action === 'reverse') {
        if (!reason) return { ok: false, code: 'REASON_REQUIRED' };
        return {
            ok: true,
            patch: {
                status: 'reversed',
                reversed_at: nowIso,
                on_hold: false,
                admin_notes: earning.admin_notes ? `${earning.admin_notes} | ${reason}` : reason,
            },
        };
    }

    // Everything else only makes sense while the pay is still held.
    if (status !== 'held') return { ok: false, code: 'NOT_HELD' };

    if (action === 'release') {
        return { ok: true, patch: { status: 'released', released_at: nowIso, on_hold: false, hold_reason: '' } };
    }
    if (action === 'hold') {
        if (!reason) return { ok: false, code: 'REASON_REQUIRED' };
        return { ok: true, patch: { on_hold: true, hold_reason: reason } };
    }
    if (action === 'unhold') {
        return { ok: true, patch: { on_hold: false, hold_reason: '' } };
    }
    // adjust
    if (!reason) return { ok: false, code: 'REASON_REQUIRED' };
    const n = input && input.amount_ngn;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PAYOUT_NGN) {
        return { ok: false, code: 'INVALID_AMOUNT' };
    }
    const amount = Math.round(n);
    return {
        ok: true,
        patch: {
            amount_ngn: amount,
            basis: 'manual',
            rate_ngn: amount,
            units: 1,
            adjustment_reason: reason,
            adjusted_at: nowIso,
        },
    };
}

// What to do with an earning, given the ride it is for. Lockstep copy, see
// autoCancelExpiredBookings. Used here so admin cannot release pay the sweep
// would have reversed: a cancelled ride, or one now driven by someone else.
function releaseDecision(earning: any, ride: any) {
    if (!ride) return 'reverse:ride no longer exists';
    if (ride.status === 'cancelled') return 'reverse:ride cancelled';
    if (ride.driver_id !== earning.driver_id) return 'reverse:ride reassigned';
    if (ride.payment_status !== 'paid') return 'hold:ride is not paid';
    return 'release';
}

// True while admin has not closed a complaint the GUEST made about this ride.
// That is a dispute about the service the driver is being paid for, so the
// pay waits. A report the DRIVER filed about the guest never holds the
// driver's own pay: that would punish them for speaking up. Lockstep copy,
// see autoCancelExpiredBookings.
async function hasOpenGuestReport(sr: any, rideBookingId: string) {
    const open = await sr.RideReport.filter({
        ride_booking_id: rideBookingId, reporter_role: 'guest', status: { $in: ['open', 'reviewing'] },
    });
    return Array.isArray(open) && open.length > 0;
}

// A reversal always wins. Nothing here can lock a row, so a release can land
// on top of a reversal made a moment earlier and leave the row saying
// "released". reversed_at is never cleared, so after any write that sets a
// status other than reversed the row is read again, and put back if it
// carries one. Returns the row as it now stands. Lockstep copy, see
// autoCancelExpiredBookings.
async function keepReversed(sr: any, earningId: string) {
    const fresh = await sr.DriverEarning.get(earningId);
    if (!fresh || !fresh.reversed_at || fresh.status === 'reversed') return fresh;
    await sr.DriverEarning.update(earningId, { status: 'reversed', on_hold: false });
    return { ...fresh, status: 'reversed', on_hold: false };
}

// Write a decided change and hand back the row as it now stands. A change
// that is not itself a reversal is followed by keepReversed, so a reversal
// made while this one was being decided is not overwritten.
async function writeEarningChange(sr: any, earning: any, patch: any) {
    await sr.DriverEarning.update(earning.id, patch);
    if (patch && patch.status === 'reversed') return sr.DriverEarning.get(earning.id);
    return keepReversed(sr, earning.id);
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
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
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);
        if (user.role !== 'admin') return json({ success: false, error: 'Admin access required' }, 403);

        const body = await req.json().catch(() => null);
        const { earning_id, action, reason, amount_ngn } = body || {};
        if (!isId(earning_id) || typeof action !== 'string') {
            return json({ success: false, error: 'earning_id and action are required' }, 400);
        }

        const sr = base44.asServiceRole.entities;
        const earning = await sr.DriverEarning.get(earning_id);
        if (!earning || earning.id !== earning_id) {
            return json({ success: false, error: 'That pay record no longer exists.', code: 'NOT_FOUND' }, 404);
        }

        const nowIso = new Date().toISOString();
        const next = nextEarningState(action, earning, { reason, amount_ngn }, nowIso);
        if (!next.ok) {
            const refusal = REFUSALS[next.code as string] || { status: 400, error: 'That change is not allowed.' };
            return json({ success: false, error: refusal.error, code: next.code }, refusal.status);
        }

        // Releasing by hand must not pay for a ride the sweep would refuse.
        if (action === 'release') {
            const ride = isId(earning.ride_booking_id) ? await sr.RideBooking.get(earning.ride_booking_id) : null;
            const verdict = releaseDecision(earning, ride);
            if (verdict !== 'release') {
                return json({
                    success: false,
                    error: `This pay cannot be released: ${verdict.split(':')[1]}. Reverse it instead.`,
                    code: 'RIDE_STATE',
                }, 409);
            }
            // Releasing around an open complaint would make the report
            // pointless. Admin closes it first, in Rides → Reports.
            if (await hasOpenGuestReport(sr, earning.ride_booking_id)) {
                return json({
                    success: false,
                    error: 'The guest has an open report on this ride. Resolve or dismiss it under Rides → Reports first.',
                    code: 'OPEN_REPORT',
                }, 409);
            }
        }

        const updated = await writeEarningChange(sr, earning, next.patch);
        // Somebody reversed this pay while the change above was being decided.
        // The reversal stands, and admin is told that, not that the change
        // was saved. No "your pay is available" push goes out either.
        if (action !== 'reverse' && updated && updated.status === 'reversed') {
            const refusal = REFUSALS.REVERSED_MEANWHILE;
            return json({ success: false, error: refusal.error, code: 'REVERSED_MEANWHILE' }, refusal.status);
        }

        if (action === 'release') {
            try {
                const driver = await sr.Driver.get(earning.driver_id);
                const driverEmail = typeof driver?.user_email === 'string' ? driver.user_email.trim().toLowerCase() : '';
                if (driverEmail) {
                    const amount = `₦${(Number(earning.amount_ngn) || 0).toLocaleString()}`;
                    await tryPush(base44, {
                        user_email: driverEmail,
                        title: `💸 ${amount} is now available`,
                        body: `Your pay for the ${earning.vehicle_name || 'ride'}${earning.service_date ? ` on ${earning.service_date}` : ''} has been released to your wallet.`,
                        url: '/DriverWallet',
                        tag: `driver-released-${earning.id}`,
                    });
                }
            } catch (err) {
                console.warn('Release push failed (non-fatal):', err);
            }
        }

        return json({
            success: true,
            data: {
                earning: updated,
                // True when the driver could already withdraw this before the
                // call. After a reverse, their available balance has dropped
                // by the amount; the admin screen says so.
                was_released: earning.status === 'released',
            },
        });
    } catch (error) {
        console.error('settleDriverEarning error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
