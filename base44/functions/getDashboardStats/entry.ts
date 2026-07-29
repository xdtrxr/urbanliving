import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getDashboardStats
// ----------------------------------------------------------------------------
// Two scopes:
//   scope: 'mine'  — the caller's own booking / referral figures (user dashboard)
//   scope: 'all'   — platform-wide figures (admin dashboard). Admin-gated.
//
// IMPORTANT — pagination. Base44's .filter() returns 50 rows by default and
// caps at 5,000 per request. Any aggregate that scans a whole table therefore
// HAS to page explicitly, otherwise every figure it reports is silently
// computed from the first 50 records. This function previously did
// `.filter({})` with no limit, so platform revenue was capped at whatever the
// oldest 50 bookings happened to total. Everything below goes through
// fetchAll().

const PAGE = 500;
const HARD_CAP = 50000; // guard against an unbounded loop melting the function

async function fetchAll(entity: any, query: Record<string, unknown> = {}, sort?: string): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < HARD_CAP; skip += PAGE) {
        const page = await entity.filter(query, sort, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

// Payment is the single source of truth for "did money actually arrive".
// The old helper also treated status==='confirmed' as paid, which inflated
// revenue for any row confirmed by an admin before payment cleared.
function isPaid(b: any): boolean {
    return b.payment_status === 'paid';
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

function summariseBookings(bookings: any[], nowMs: number) {
    const counts = { total: 0, pending: 0, upcoming: 0, current: 0, past: 0, cancelled: 0 };
    const revenue = {
        // Money that actually cleared Paystack.
        paidNGN: 0,
        // Approved or awaiting approval, not yet paid — the live pipeline.
        pendingNGN: 0,
        // paid + pending. Named explicitly so nobody reads it as earned revenue.
        pipelineNGN: 0,
        // Value on rows that never converted, split by reason.
        cancelledNGN: 0,
        expiredNGN: 0,
    };
    let paidCount = 0;

    for (const b of bookings) {
        const bucket = bucketFor(b, nowMs);
        counts.total += 1;
        counts[bucket as keyof typeof counts] += 1;

        const price = Number(b.total_price) || 0;

        if (b.status === 'cancelled') {
            if (b.cancel_reason === 'payment_expired') revenue.expiredNGN += price;
            else revenue.cancelledNGN += price;
            continue;
        }
        if (isPaid(b)) {
            revenue.paidNGN += price;
            paidCount += 1;
        } else {
            revenue.pendingNGN += price;
        }
    }
    revenue.pipelineNGN = revenue.paidNGN + revenue.pendingNGN;

    return {
        counts,
        revenue,
        paidCount,
        avgPaidBookingNGN: paidCount > 0 ? Math.round(revenue.paidNGN / paidCount) : 0,
        // Of every booking request ever made, what share got paid.
        conversionRate: counts.total > 0 ? Number(((paidCount / counts.total) * 100).toFixed(1)) : 0,
    };
}

function summariseReferrals(referrals: any[]) {
    const successful = referrals.filter((r: any) => r.status === 'booking_completed');
    return {
        count: referrals.length,
        successful: successful.length,
        // Lifetime commission credited. NOT the same as current wallet balance,
        // which drops as users withdraw.
        earningsNGN: referrals.reduce((sum: number, r: any) => sum + (Number(r.amount_earned_ngn) || 0), 0),
    };
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
        const nowMs = Date.now();

        // ---- USER SCOPE ------------------------------------------------
        if (scope === 'mine') {
            const [bookings, referrals] = await Promise.all([
                fetchAll(base44.entities.Booking, { guest_email: user.email }),
                fetchAll(base44.entities.Referral, { referrer_email: user.email }),
            ]);
            const b = summariseBookings(bookings, nowMs);
            return new Response(JSON.stringify({
                success: true,
                data: {
                    scope,
                    bookings: b.counts,
                    revenue: b.revenue,
                    referrals: summariseReferrals(referrals),
                    // Current withdrawable wallet, straight off the User row.
                    walletNGN: Number(user.referral_balance_ngn) || 0,
                    loyaltyPoints: Number(user.loyalty_points) || 0,
                    generated_at: new Date(nowMs).toISOString(),
                },
            }), { status: 200, headers });
        }

        // ---- ADMIN SCOPE -----------------------------------------------
        if (user.role !== 'admin') {
            return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), { status: 403, headers });
        }

        const sr = base44.asServiceRole.entities;
        const [bookings, referrals, users, properties, withdrawals, leads, tickets, vehicles] = await Promise.all([
            fetchAll(sr.Booking),
            fetchAll(sr.Referral),
            fetchAll(sr.User),
            fetchAll(sr.Property),
            fetchAll(sr.WithdrawalRequest),
            fetchAll(sr.Lead),
            fetchAll(sr.SupportTicket),
            fetchAll(sr.Vehicle),
        ]);

        const b = summariseBookings(bookings, nowMs);

        // Trailing-30-day paid revenue, keyed off paid_at so it reflects when
        // money actually landed rather than when the trip is scheduled.
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
        const cutoff = nowMs - THIRTY_DAYS;
        let last30NGN = 0;
        let last30Count = 0;
        for (const row of bookings) {
            if (!isPaid(row)) continue;
            const paidAt = Date.parse(row.paid_at || row.created_date || '');
            if (!Number.isNaN(paidAt) && paidAt >= cutoff) {
                last30NGN += Number(row.total_price) || 0;
                last30Count += 1;
            }
        }

        // Withdrawals: what's been paid out vs what we still owe.
        const wd = { completedNGN: 0, pendingNGN: 0, failedNGN: 0, pendingCount: 0 };
        for (const w of withdrawals) {
            const amt = Number(w.amount) || 0;
            if (w.status === 'completed') wd.completedNGN += amt;
            else if (w.status === 'pending' || w.status === 'processing') {
                wd.pendingNGN += amt;
                wd.pendingCount += 1;
            } else if (w.status === 'failed' || w.status === 'reversed') wd.failedNGN += amt;
        }

        // Outstanding referral wallet balances — money owed to users that
        // hasn't been withdrawn yet. This is a real liability, so it's worth
        // showing next to gross revenue.
        const outstandingWalletNGN = users.reduce(
            (sum: number, u: any) => sum + (Number(u.referral_balance_ngn) || 0), 0,
        );

        const newUsers30d = users.filter((u: any) => {
            const t = Date.parse(u.created_date || '');
            return !Number.isNaN(t) && t >= cutoff;
        }).length;

        return new Response(JSON.stringify({
            success: true,
            data: {
                scope,
                bookings: b.counts,
                revenue: {
                    ...b.revenue,
                    last30NGN,
                    last30Count,
                    avgPaidBookingNGN: b.avgPaidBookingNGN,
                    conversionRate: b.conversionRate,
                    paidCount: b.paidCount,
                },
                referrals: summariseReferrals(referrals),
                withdrawals: wd,
                liabilities: { outstandingWalletNGN },
                users: { total: users.length, new30d: newUsers30d },
                inventory: {
                    properties: properties.length,
                    activeProperties: properties.filter((p: any) => p.active !== false).length,
                    vehicles: vehicles.length,
                },
                pipeline: {
                    leads: leads.length,
                    openTickets: tickets.filter((t: any) => t.status === 'open' || t.status === 'in_progress').length,
                },
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
