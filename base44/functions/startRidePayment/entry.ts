import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// startRidePayment
// ----------------------------------------------------------------------------
// Called once when the guest opens the payment page for a ride. Stamps
// payment_started_at and extends payment_deadline.
//
// This exists as a function because the stays equivalent does not. PaymentPage
// writes Booking.payment_started_at straight from the client, which means the
// field that decides how long a guest has to pay is writable by the guest.
// Rides keep that server-side.
//
// Deadline rule, matching stays:
//   min(approved_at + 3h, max(approved_at + 1h, payment_started_at + 1h))
// Opening the page can only ever extend the window, never shorten it, and the
// three-hour cap from approval is absolute.

const HOUR_MS = 60 * 60 * 1000;
const PAYMENT_WINDOW_MS = 1 * HOUR_MS;
const APPROVAL_CAP_MS = 3 * HOUR_MS;

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// Admin blocked this account from rides when resolving a report against it
// (resolveRideReport). Only the boolean true blocks. Lockstep copy, see
// checkRideAvailability.
function isRideBlocked(account: any) {
    return !!account && account.ride_blocked === true;
}

// Whether the account a ride was booked under is blocked from rides. Looks
// only at an account that really has that address: a ride row with no guest
// email must not match whichever account the lookup happened to return.
// Lockstep copy, see assignRideDriver.
function guestIsBlocked(accounts: any[], email: string) {
    const wanted = String(email || '').trim().toLowerCase();
    if (!wanted) return false;
    return (accounts || []).some((a) => !!a && String(a.email || '').trim().toLowerCase() === wanted && isRideBlocked(a));
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
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me().catch(() => null);
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const body = await req.json().catch(() => null);
        const ride_booking_id = body?.ride_booking_id;
        if (!isId(ride_booking_id)) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const ride = await getOrNull(base44.asServiceRole.entities.RideBooking, ride_booking_id);
        if (!ride || ride.id !== ride_booking_id) return json({ success: false, error: 'Ride booking not found' }, 404);
        if (ride.guest_email !== user.email && user.role !== 'admin') {
            return json({ success: false, error: 'Not your booking' }, 403);
        }
        if (ride.payment_status === 'paid') {
            return json({ success: true, data: { already_paid: true, ride_booking_id } });
        }
        // A payment is already on hold for this ride (it arrived before the
        // ride could be confirmed). Asked before anything else: once the
        // admin approves, nothing below would stop a second payment.
        if (ride.payment_status === 'pending_confirmation') {
            const amountNGN = Number(ride.total_price) || 0;
            return json({
                success: false,
                error: `We already have your payment of ₦${amountNGN.toLocaleString()} for this ride. It is waiting for our team to confirm it. Please do not pay again.`,
                code: 'PAYMENT_HELD',
                data: { ride_booking_id, amount_ngn: amountNGN, hold_reason: 'holding' },
            }, 409);
        }
        if (ride.payment_status === 'refunded') {
            return json({
                success: false,
                error: 'The payment for this ride was refunded. Please make a new request if you still want a car.',
                code: 'PAYMENT_REFUNDED',
            }, 409);
        }
        // Blocked since this ride was requested. Read fresh under the service
        // role, not from the session, so a block takes effect at once. Admin
        // opening the page on a guest's behalf is not stopped.
        if (user.role !== 'admin') {
            const accounts = await base44.asServiceRole.entities.User.filter({ email: user.email });
            if (guestIsBlocked(accounts, user.email)) {
                return json({
                    success: false,
                    error: 'Ride bookings are not available on this account. Please contact support.',
                    code: 'RIDE_BLOCKED',
                }, 403);
            }
        }
        if (!ride.approved_at) {
            return json({ success: false, error: 'This ride has not been approved yet', code: 'NOT_APPROVED' }, 409);
        }
        if (ride.status === 'cancelled') {
            return json({ success: false, error: 'This ride was cancelled', code: 'CANCELLED' }, 409);
        }

        const approvedMs = Date.parse(ride.approved_at);
        const startedMs = Date.parse(ride.payment_started_at || '') || Date.now();
        const cap = approvedMs + APPROVAL_CAP_MS;
        const deadlineMs = Math.min(cap, Math.max(approvedMs + PAYMENT_WINDOW_MS, startedMs + PAYMENT_WINDOW_MS));

        if (deadlineMs <= Date.now()) {
            return json({
                success: false,
                error: 'The payment window for this ride has closed.',
                code: 'WINDOW_CLOSED',
            }, 409);
        }

        // payment_started_at is one-shot: re-opening the page must not restart
        // the clock. Only the deadline is refreshed, and it can only grow.
        const update: Record<string, unknown> = { payment_deadline: new Date(deadlineMs).toISOString() };
        if (!ride.payment_started_at) update.payment_started_at = new Date().toISOString();
        await base44.asServiceRole.entities.RideBooking.update(ride_booking_id, update);

        return json({
            success: true,
            data: {
                ride_booking_id,
                total_price: ride.total_price,
                // Carried so the payment screen can restate a price that admin
                // changed at confirmation. The guest has already been told —
                // by email, push, checkout and My Bookings — but this is the
                // last screen before money moves, so it says it once more.
                estimated_price: ride.estimated_price ?? null,
                price_adjustment_reason: ride.price_adjustment_reason ?? null,
                booking_reference: ride.booking_reference ?? null,
                vehicle_name: ride.vehicle_name,
                payment_deadline: new Date(deadlineMs).toISOString(),
            },
        });
    } catch (error) {
        console.error('startRidePayment error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
