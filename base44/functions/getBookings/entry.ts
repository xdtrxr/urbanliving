import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

const BUCKETS = ['pending-approval', 'upcoming', 'current', 'past', 'cancelled'] as const;
type Bucket = typeof BUCKETS[number];

function computeBucket(booking: any, nowMs: number): Bucket {
    if (booking.status === 'cancelled') return 'cancelled';
    if (booking.status === 'pending') return 'pending-approval';
    if (booking.status === 'completed') return 'past';

    // status === 'confirmed' (or unknown): decide by dates
    const checkInMs = Date.parse(booking.check_in);
    const checkOutMs = Date.parse(booking.check_out);

    if (Number.isNaN(checkInMs) || Number.isNaN(checkOutMs)) {
        // Missing/invalid dates on a confirmed booking — surface for review
        return 'pending-approval';
    }

    if (nowMs > checkOutMs) return 'past';
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

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
    }

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

        let filter: Record<string, unknown> = {};
        if (scope === 'all') {
            if (user.role !== 'admin') {
                return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), { status: 403, headers });
            }
            // Use service role so admins see every row regardless of RLS
            const allBookings = await base44.asServiceRole.entities.Booking.filter({}, '-created_date');
            return respondWithBuckets(allBookings, headers);
        }

        filter = { guest_email: user.email };
        const bookings = await base44.entities.Booking.filter(filter, '-created_date');
        return respondWithBuckets(bookings, headers);
    } catch (error) {
        console.error('getBookings error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});

function respondWithBuckets(bookings: any[], headers: Record<string, string>) {
    const nowMs = Date.now();
    const enriched = bookings.map((b) => ({ ...b, bucket: computeBucket(b, nowMs) }));
    const counts = enriched.reduce((acc: Record<string, number>, b) => {
        acc[b.bucket] = (acc[b.bucket] || 0) + 1;
        return acc;
    }, {});
    return new Response(JSON.stringify({
        success: true,
        data: enriched,
        counts,
    }), { status: 200, headers });
}
