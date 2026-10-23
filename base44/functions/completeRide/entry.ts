import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// completeRide
// ----------------------------------------------------------------------------
// Admin marks a ride completed now, instead of waiting for the sweep to do it
// when the booked window ends. Two cases need it: the guest finished early,
// and a ride whose time the sweep cannot read (it never completes on a guess).
//
// Completing a ride does NOT release the driver's pay. Pay releases two hours
// after the booked end, or when admin releases it in Rides → Earnings.

// ── Ride time model — lockstep copy, see checkRideAvailability ──────────────
const WAT_OFFSET = '+01:00';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const MAX_HOURLY = 8;

function rideDurationMs(tier: string, days?: number, hours?: number): number {
    switch (tier) {
        case 'hourly': return Math.min(MAX_HOURLY, Math.max(1, Number(hours) || 1)) * HOUR_MS;
        case '12hr': return 12 * HOUR_MS;
        case '24hr': return DAY_MS;
        case 'multi_day': return Math.max(1, Number(days) || 1) * DAY_MS;
        case 'weekly': return 7 * DAY_MS;
        case 'monthly': return 30 * DAY_MS;
        default: return NaN;
    }
}

// Prefer the stored instants. Fall back to deriving them for any row written
// before start_at existed.
function windowOf(r: any): { startMs: number; endMs: number } | null {
    let startMs = Date.parse(r.start_at || '');
    if (Number.isNaN(startMs)) startMs = Date.parse(`${r.service_date}T${r.start_time}:00${WAT_OFFSET}`);
    if (Number.isNaN(startMs)) return null;
    let endMs = Date.parse(r.end_at || '');
    if (Number.isNaN(endMs)) {
        const dur = rideDurationMs(r.duration_tier, r.duration_days, r.duration_hours);
        if (Number.isNaN(dur)) return null;
        endMs = startMs + dur;
    }
    return { startMs, endMs };
}

// Why this ride cannot be completed now, or '' when it can. A ride with no
// readable time is allowed through: that is the case admin exists for.
function completionProblem(ride: any, nowMs: number) {
    if (ride.status === 'completed') return 'ALREADY';
    if (ride.status === 'cancelled') return 'CANCELLED';
    if (ride.payment_status !== 'paid') return 'NOT_PAID';
    const w = windowOf(ride);
    if (w && w.startMs > nowMs) return 'NOT_STARTED';
    return '';
}

const REFUSALS: Record<string, string> = {
    CANCELLED: 'This ride was cancelled.',
    NOT_PAID: 'Only a paid ride can be completed.',
    NOT_STARTED: 'This ride has not started yet.',
};

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
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
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me().catch(() => null);
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);
        if (user.role !== 'admin') return json({ success: false, error: 'Admin access required' }, 403);

        const body = await req.json().catch(() => null);
        const ride_booking_id = body?.ride_booking_id;
        if (!isId(ride_booking_id)) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const sr = base44.asServiceRole.entities;
        const ride = await getOrNull(sr.RideBooking, ride_booking_id);
        if (!ride || ride.id !== ride_booking_id) {
            return json({ success: false, error: 'Ride booking not found', code: 'NOT_FOUND' }, 404);
        }

        const problem = completionProblem(ride, Date.now());
        if (problem === 'ALREADY') {
            return json({ success: true, data: { ride_booking_id, status: 'completed', already: true } });
        }
        if (problem) {
            return json({ success: false, error: REFUSALS[problem], code: problem }, 409);
        }

        await sr.RideBooking.update(ride_booking_id, {
            status: 'completed',
            completed_at: new Date().toISOString(),
            completed_by: 'admin',
        });

        return json({ success: true, data: { ride_booking_id, status: 'completed', already: false } });
    } catch (error) {
        console.error('completeRide error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
