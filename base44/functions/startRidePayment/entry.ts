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

        const { ride_booking_id } = await req.json().catch(() => ({}));
        if (!ride_booking_id) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const ride = await base44.asServiceRole.entities.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);
        if (ride.guest_email !== user.email && user.role !== 'admin') {
            return json({ success: false, error: 'Not your booking' }, 403);
        }
        if (ride.payment_status === 'paid') {
            return json({ success: true, data: { already_paid: true, ride_booking_id } });
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
