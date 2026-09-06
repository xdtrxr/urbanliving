import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getRideBookings
// ----------------------------------------------------------------------------
// Read-only. The single source of truth for which bucket a ride belongs in, so
// the client never invents a state name — same contract as getBookings for
// stays.
//
// Pages at 500. A bare .filter() silently caps at 50, which is how the
// apartment flow once hid a guest's older bookings from them entirely.

// ── Ride time model — lockstep copy, see checkRideAvailability ──────────────
const WAT_OFFSET = '+01:00';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function rideDurationMs(tier: string, days?: number): number {
    switch (tier) {
        case '12hr': return 12 * HOUR_MS;
        case '24hr': return DAY_MS;
        case 'multi_day': return Math.max(1, Number(days) || 1) * DAY_MS;
        case 'weekly': return 7 * DAY_MS;
        case 'monthly': return 30 * DAY_MS;
        default: return NaN;
    }
}

// Prefer the stored instants. Fall back to deriving them for any row written
// before start_at existed, so bucketing never silently misplaces a ride.
function windowOf(r: any): { startMs: number; endMs: number } | null {
    let startMs = Date.parse(r.start_at || '');
    if (Number.isNaN(startMs)) startMs = Date.parse(`${r.service_date}T${r.start_time}:00${WAT_OFFSET}`);
    if (Number.isNaN(startMs)) return null;
    let endMs = Date.parse(r.end_at || '');
    if (Number.isNaN(endMs)) {
        const dur = rideDurationMs(r.duration_tier, r.duration_days);
        if (Number.isNaN(dur)) return null;
        endMs = startMs + dur;
    }
    return { startMs, endMs };
}

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

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, '-created_date', PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
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

        const body = await req.json().catch(() => ({}));
        const scope: 'mine' | 'all' = body.scope === 'all' ? 'all' : 'mine';

        let rides: any[];
        if (scope === 'all') {
            if (user.role !== 'admin') return json({ success: false, error: 'Admin access required' }, 403);
            rides = await fetchAll(base44.asServiceRole.entities.RideBooking, {});
        } else {
            rides = await fetchAll(base44.entities.RideBooking, { guest_email: user.email });
        }

        const nowMs = Date.now();
        const counts: Record<string, number> = {
            'pending-approval': 0, upcoming: 0, current: 0, past: 0, cancelled: 0,
        };
        const enriched = rides.map((r) => {
            const bucket = computeBucket(r, nowMs);
            counts[bucket] = (counts[bucket] || 0) + 1;
            const w = windowOf(r);
            return {
                ...r,
                bucket,
                // Surface the derived instants so the client never re-derives
                // them and risks disagreeing about the timezone.
                start_at: w ? new Date(w.startMs).toISOString() : null,
                end_at: w ? new Date(w.endMs).toISOString() : null,
                // Never leak driver identity through the list endpoint — the
                // reveal is gated behind getRideDriverContact.
                driver_id: undefined,
                driver_assigned: !!r.driver_id,
            };
        });

        return json({ success: true, data: enriched, counts });
    } catch (error) {
        console.error('getRideBookings error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
