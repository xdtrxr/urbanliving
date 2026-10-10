import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getDriverRides
// ----------------------------------------------------------------------------
// The signed-in driver's rides, each with what it pays and where that pay
// stands. Read-only.
//
// Three rules shape it:
//   1. The driver is resolved from the session email on the server. Nothing
//      the browser sends chooses whose rides come back.
//   2. The ride is returned through an allow-list, not a spread. What the
//      guest paid, their email and admin's notes are not the driver's to see.
//   3. The guest's phone is included only while the ride is still to happen or
//      under way. Afterwards the driver has no reason to hold it.
//
// Buckets come from the same computeBucket as getRideBookings, so the driver,
// the guest and admin can never disagree about whether a ride is over.

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

// Lockstep copy, see getRideBookings.
function computeBucket(r: any, nowMs: number): string {
    if (r.status === 'cancelled') return 'cancelled';
    if (r.status === 'completed') return 'past';
    if (r.status === 'pending' && !r.approved_at) return 'pending-approval';
    const w = windowOf(r);
    if (!w) return 'pending-approval';
    const isPaid = r.payment_status === 'paid';
    // An unpaid ride whose window has passed is dead, not history.
    if (nowMs > w.endMs) return isPaid ? 'past' : 'cancelled';
    if (nowMs < w.startMs) return 'upcoming';
    return 'current';
}

// ISO string for an instant, or null when it is not a representable date.
// Lockstep copy, see assignRideDriver.
function safeIso(ms: number) {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

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

// The Driver row this login belongs to, or null. Lockstep copy, see
// getDriverProfile.
async function findDriverForUser(sr: any, email: string) {
    const raw = String(email || '').trim();
    const lower = raw.toLowerCase();
    if (!lower) return null;
    let rows = await sr.Driver.filter({ user_email: lower });
    if ((!rows || rows.length === 0) && raw !== lower) rows = await sr.Driver.filter({ user_email: raw });
    if (!rows || rows.length === 0) return null;
    rows.sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')));
    return rows[0];
}

// Which earning row speaks for a ride on the driver's card: one still in play
// if there is one (held or released), otherwise the most recent reversed row.
function earningForRide(rows: any[]) {
    const live = rows.filter((e) => e.status !== 'reversed');
    const pool = live.length > 0 ? live : rows;
    if (pool.length === 0) return null;
    const newestFirst = pool.slice().sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')));
    return newestFirst[0];
}

// Everything the driver may know about one ride. An explicit allow-list, so a
// column added to RideBooking or DriverEarning later cannot leak here by
// default. bucket is one of upcoming | current | past | cancelled.
function driverRideView(ride: any, bucket: string, win: any, earning: any) {
    const live = bucket === 'upcoming' || bucket === 'current';
    return {
        id: ride.id,
        booking_reference: ride.booking_reference || null,
        vehicle_name: ride.vehicle_name || 'Vehicle',
        vehicle_image: ride.vehicle_image || null,
        service_date: ride.service_date || null,
        start_time: ride.start_time || null,
        start_at: win ? safeIso(win.startMs) : null,
        end_at: win ? safeIso(win.endMs) : null,
        duration_tier: ride.duration_tier || null,
        duration_hours: ride.duration_hours || null,
        duration_days: ride.duration_days || null,
        pickup_location: ride.pickup_location || null,
        dropoff_location: ride.dropoff_location || null,
        pickup_instructions: ride.pickup_instructions || null,
        passengers: ride.passengers || 1,
        special_requests: ride.special_requests || null,
        guest_name: ride.guest_name || 'Guest',
        // Needed to find each other at pickup. Not needed once the ride is over.
        guest_phone: live ? (ride.guest_phone || null) : null,
        bucket,
        status: ride.status,
        earning: earning ? {
            id: earning.id,
            amount_ngn: Math.max(0, Math.round(Number(earning.amount_ngn) || 0)),
            status: earning.status,
            on_hold: !!earning.on_hold,
            release_at: earning.release_at || null,
            released_at: earning.released_at || null,
        } : null,
    };
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

        const sr = base44.asServiceRole.entities;
        const driver = await findDriverForUser(sr, user.email);
        if (!driver) {
            return json({
                success: false,
                error: 'This account is not linked to a driver profile.',
                code: 'NOT_A_DRIVER',
            }, 403);
        }

        const [rides, earnings] = await Promise.all([
            fetchAll(sr.RideBooking, { driver_id: driver.id }),
            fetchAll(sr.DriverEarning, { driver_id: driver.id }),
        ]);

        const earningsByRide = new Map<string, any[]>();
        for (const e of earnings) {
            const list = earningsByRide.get(e.ride_booking_id) || [];
            list.push(e);
            earningsByRide.set(e.ride_booking_id, list);
        }

        const nowMs = Date.now();
        const counts: Record<string, number> = { upcoming: 0, current: 0, past: 0, cancelled: 0 };
        const views = rides.map((r) => {
            const raw = computeBucket(r, nowMs);
            // A ride only gets a driver after it is paid, so 'pending-approval'
            // here can only mean its time could not be read. Show it as
            // upcoming rather than hide a job from the person doing it.
            const bucket = raw === 'pending-approval' ? 'upcoming' : raw;
            counts[bucket] = (counts[bucket] || 0) + 1;
            return driverRideView(r, bucket, windowOf(r), earningForRide(earningsByRide.get(r.id) || []));
        });

        // What needs the driver now comes first: in progress, then upcoming
        // soonest first, then history newest first.
        const groupOrder: Record<string, number> = { current: 0, upcoming: 1, past: 2, cancelled: 3 };
        views.sort((a, b) => {
            if (a.bucket !== b.bucket) return groupOrder[a.bucket] - groupOrder[b.bucket];
            const byStart = String(a.start_at || '').localeCompare(String(b.start_at || ''));
            return a.bucket === 'current' || a.bucket === 'upcoming' ? byStart : -byStart;
        });

        return json({ success: true, data: { rides: views, counts } });
    } catch (error) {
        console.error('getDriverRides error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
