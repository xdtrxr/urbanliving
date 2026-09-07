import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getRideDriverContact
// ----------------------------------------------------------------------------
// The progressive-disclosure boundary for driver identity.
//
// This has to be a function rather than a direct entity read: Driver RLS is
// admin-only for READ, so a guest can never load the row themselves. That is
// deliberate — the roster (including licence numbers and expiry dates) is not
// guest-visible, and only a narrow projection is ever returned here.
//
// Three conditions must all hold, checked server-side:
//   1. the caller owns the ride (or is admin)
//   2. the ride is confirmed AND paid
//   3. a driver has actually been assigned
//
// getRideBookings deliberately strips driver_id from its rows and returns a
// driver_assigned boolean instead, so the list endpoint cannot be used as a
// side channel around this gate.

// Fields safe to show a paying guest. licence_number and licence_expiry are
// intentionally absent — they identify the driver to the state, not to their
// passenger, and the guest has no use for them.
const PUBLIC_DRIVER_FIELDS = [
    'full_name', 'phone', 'photo', 'languages', 'years_experience', 'rating', 'bio',
] as const;

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

        // 1. Ownership
        if (ride.guest_email !== user.email && user.role !== 'admin') {
            return json({ success: false, error: 'Not your booking' }, 403);
        }

        // 2. Paid and confirmed
        if (ride.status !== 'confirmed' || ride.payment_status !== 'paid') {
            return json({
                success: false,
                error: 'Driver details become available once your ride is confirmed and paid.',
                code: 'NOT_PAID',
            }, 403);
        }

        // 3. Actually assigned
        if (!ride.driver_id) {
            return json({
                success: false,
                error: "We're still assigning your driver. You'll be notified as soon as they're confirmed.",
                code: 'NOT_ASSIGNED',
            }, 404);
        }

        const driver = await base44.asServiceRole.entities.Driver.get(ride.driver_id);
        if (!driver) {
            console.error(`Ride ${ride.id} references missing driver ${ride.driver_id}`);
            return json({
                success: false,
                error: "We're re-confirming your driver. Please check back shortly.",
                code: 'DRIVER_MISSING',
            }, 404);
        }

        // Explicit allow-list rather than deleting fields, so a future column
        // on Driver cannot leak here by default.
        const safe: Record<string, unknown> = {};
        for (const f of PUBLIC_DRIVER_FIELDS) {
            if (driver[f] !== undefined && driver[f] !== null) safe[f] = driver[f];
        }

        // The plate completes the handoff: a name and a number identify the
        // person, the registration identifies the car they arrive in. It comes
        // off the Vehicle rather than the Driver, so it is added as its own
        // named field rather than by widening PUBLIC_DRIVER_FIELDS — that list
        // stays strictly an allow-list over the Driver row.
        let registration_number: string | null = null;
        try {
            const vehicle = await base44.asServiceRole.entities.Vehicle.get(ride.vehicle_id);
            registration_number = vehicle?.registration_number || null;
        } catch (err) {
            // A missing plate is a degraded handoff, not a failed one.
            console.warn('Could not read vehicle for plate (non-fatal):', err);
        }

        return json({
            success: true,
            data: {
                ...safe,
                assigned_at: ride.driver_assigned_at || null,
                registration_number,
                pickup_instructions: ride.pickup_instructions || null,
            },
        });
    } catch (error) {
        console.error('getRideDriverContact error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
