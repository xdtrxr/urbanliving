import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

const HOUR_MS = 60 * 60 * 1000;
const PAYMENT_WINDOW_MS = 1 * HOUR_MS;
const APPROVAL_CAP_MS = 3 * HOUR_MS;

function isPaid(b: any): boolean {
    return b.payment_status === 'paid' || b.status === 'confirmed' || b.status === 'completed';
}

function bucketFor(b: any, nowMs: number): string {
    if (b.status === 'cancelled') return 'cancelled';
    if (b.status === 'pending') return 'pending';
    if (b.status === 'completed') return 'past';
    const inMs = Date.parse(b.check_in);
    const outMs = Date.parse(b.check_out);
    if (Number.isNaN(inMs) || Number.isNaN(outMs)) return 'pending';
    if (nowMs > outMs) return 'past';
    if (nowMs < inMs) return 'upcoming';
    return 'current';
}

function emptyBookingStats() {
    return { total: 0, pending: 0, upcoming: 0, current: 0, past: 0, cancelled: 0 };
}
function emptyRevenue() {
    return { totalNGN: 0, paidNGN: 0, pendingNGN: 0 };
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

        let bookings: any[];
        let referrals: any[];

        if (scope === 'all') {
            if (user.role !== 'admin') {
                return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), { status: 403, headers });
            }
            bookings = await base44.asServiceRole.entities.Booking.filter({});
            referrals = await base44.asServiceRole.entities.Referral.filter({});
        } else {
            bookings = await base44.entities.Booking.filter({ guest_email: user.email });
            referrals = await base44.entities.Referral.filter({ referrer_email: user.email });
        }

        const nowMs = Date.now();
        const bookingStats = emptyBookingStats();
        const revenue = emptyRevenue();

        for (const b of bookings) {
            const bucket = bucketFor(b, nowMs);
            bookingStats.total += 1;
            bookingStats[bucket as keyof typeof bookingStats] = (bookingStats[bucket as keyof typeof bookingStats] || 0) + 1;

            const price = Number(b.total_price) || 0;
            if (b.status === 'cancelled') continue;
            revenue.totalNGN += price;
            if (isPaid(b)) revenue.paidNGN += price;
            else if (b.status === 'pending') revenue.pendingNGN += price;
        }

        const referralStats = {
            count: referrals.length,
            successful: referrals.filter((r: any) => r.status === 'booking_completed' || r.status === 'completed').length,
            earningsNGN: referrals.reduce((sum: number, r: any) => sum + (Number(r.amount_earned_ngn) || 0), 0),
        };

        return new Response(JSON.stringify({
            success: true,
            data: {
                scope,
                bookings: bookingStats,
                revenue,
                referrals: referralStats,
                generated_at: new Date(nowMs).toISOString(),
            },
        }), { status: 200, headers });
    } catch (error) {
        console.error('getDashboardStats error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
