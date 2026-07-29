import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

const BUCKETS = ['pending-approval', 'upcoming', 'current', 'past', 'cancelled'] as const;
type Bucket = typeof BUCKETS[number];

const HOUR_MS = 60 * 60 * 1000;
const PAYMENT_WINDOW_MS = 1 * HOUR_MS;       // 1 hour after PaymentPage open
const APPROVAL_CAP_MS = 3 * HOUR_MS;          // 3 hour hard cap from approval

function computeDeadlineMs(b: any): number | null {
    const approvedAt = Date.parse(b.approved_at || '');
    if (Number.isNaN(approvedAt)) return null;
    const startedAt = Date.parse(b.payment_started_at || '');
    const fromOpen = Number.isNaN(startedAt) ? 0 : startedAt + PAYMENT_WINDOW_MS;
    const fromApproval = approvedAt + PAYMENT_WINDOW_MS;
    const cap = approvedAt + APPROVAL_CAP_MS;
    return Math.min(cap, Math.max(fromApproval, fromOpen));
}

function computeBucket(b: any, nowMs: number): Bucket {
    if (b.status === 'cancelled') return 'cancelled';
    if (b.status === 'completed') return 'past';

    // Pending bookings split by whether admin has approved yet:
    //   approved_at unset → still awaiting admin decision → pending-approval
    //   approved_at set   → admin approved, awaiting payment → date-based bucket
    if (b.status === 'pending' && !b.approved_at) return 'pending-approval';

    const checkInMs = Date.parse(b.check_in);
    const checkOutMs = Date.parse(b.check_out);
    if (Number.isNaN(checkInMs) || Number.isNaN(checkOutMs)) return 'pending-approval';

    const isPaid = b.payment_status === 'paid';

    // Only paid stays graduate to 'past'. If checkout has passed but the
    // booking was never paid, treat as cancelled — the autoCancelExpiredBookings
    // cron will catch up and stamp cancel_reason='payment_expired' on the row.
    // This guarantees 'past' only ever holds completed/used stays.
    if (nowMs > checkOutMs) return isPaid ? 'past' : 'cancelled';
    if (nowMs < checkInMs) return 'upcoming';
    return 'current';
}


Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), { status: 405, headers });
    }

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
        }

        const body = await req.json().catch(() => ({}));
        const scope: 'mine' | 'all' = body.scope === 'all' ? 'all' : 'mine';

        // Base44's .filter() caps at 50 rows by default, which silently hid a
        // user's older bookings (and almost all bookings in admin scope) from
        // the Bookings page. Page through the full set instead.
        const PAGE = 500;
        const fetchAll = async (entity: any, query: Record<string, unknown>) => {
            const out: any[] = [];
            for (let skip = 0; skip < 50000; skip += PAGE) {
                const page = await entity.filter(query, '-created_date', PAGE, skip);
                if (!Array.isArray(page) || page.length === 0) break;
                out.push(...page);
                if (page.length < PAGE) break;
            }
            return out;
        };

        let bookings: any[];
        if (scope === 'all') {
            if (user.role !== 'admin') {
                return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), { status: 403, headers });
            }
            bookings = await fetchAll(base44.asServiceRole.entities.Booking, {});
        } else {
            bookings = await fetchAll(base44.entities.Booking, { guest_email: user.email });
        }

        const nowMs = Date.now();
        const enriched: any[] = [];

        // Read-only enrichment. Auto-cancel of expired bookings runs in the
        // autoCancelExpiredBookings scheduled function (Deno.cron every 5 min).
        for (const b of bookings) {
            const deadlineMs = computeDeadlineMs(b);
            const enrichedBooking = {
                ...b,
                bucket: computeBucket(b, nowMs),
                payment_deadline: deadlineMs ? new Date(deadlineMs).toISOString() : null,
            };
            enriched.push(enrichedBooking);
        }

        const counts = enriched.reduce((acc: Record<string, number>, b) => {
            acc[b.bucket] = (acc[b.bucket] || 0) + 1;
            return acc;
        }, {});

        return new Response(JSON.stringify({ success: true, data: enriched, counts }), { status: 200, headers });
    } catch (error) {
        console.error('getBookings error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
