import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// What a referrer is shown about their own referrals: how many people they
// brought, how many of those have paid for a stay or ride, what those
// bookings were worth and what the referrer earned.
//
// Everything is read with the service role, AFTER checking that the caller
// is asking about themselves. Read as the caller, the friend's booking was
// refused by the Booking read rule (a referrer is neither its guest nor an
// admin), the refusal was swallowed, and "booked by your referrals" showed 0
// for everyone.

// An id goes into the URL of the row it fetches, so only a plain id is ever
// used. Lockstep copy, see createWithdrawalRequest.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// entity.get() rejects for a row that is not there.
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
    }
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

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);

        // Verify user is authenticated
        const user = await base44.auth.me().catch(() => null);
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const user_email = (body && typeof body.user_email === 'string' && body.user_email) || user.email;

        // Security: Ensure user can only query their own stats (unless admin).
        // This test is what makes the service-role reads below safe.
        if (user.role !== 'admin' && user.email !== user_email) {
            return Response.json({
                error: 'Forbidden: You can only access your own referral statistics'
            }, { status: 403 });
        }

        const db = base44.asServiceRole.entities;
        const lower = (v: unknown) => String(v || '').toLowerCase();
        const referrals = await fetchAll(db.Referral, { referrer_email: user_email });

        // One person is one referral, however many rows they have: rewards
        // paid in May 2026 left a second row beside the sign-up one.
        const people = new Map<string, any[]>();
        for (const referral of referrals) {
            const key = lower(referral.referred_email);
            if (!key) continue;
            people.set(key, [...(people.get(key) || []), referral]);
        }

        let successfulReferrals = 0;
        let totalBookedByReferrals = 0;
        let totalAmountEarnedFromReferralsNGN = 0;

        for (const [referredEmail, rows] of people) {
            for (const row of rows) totalAmountEarnedFromReferralsNGN += Number(row.amount_earned_ngn) || 0;

            const rewarded = rows.find((row) => row.status === 'booking_completed' && row.booking_id);
            if (!rewarded) continue;
            successfulReferrals++;

            // The reward is stamped with the stay or the ride that earned it.
            // Its total counts only if the booking really is that friend's.
            if (!isId(rewarded.booking_id)) continue;
            try {
                const paid = (await getOrNull(db.Booking, rewarded.booking_id))
                    || (await getOrNull(db.RideBooking, rewarded.booking_id));
                if (paid && lower(paid.guest_email) === referredEmail) {
                    totalBookedByReferrals += Number(paid.total_price) || 0;
                }
            } catch (bookingError) {
                // Continue aggregation even if one booking fetch fails
                console.warn(`Could not read booking ${rewarded.booking_id}:`, (bookingError as Error).message);
            }
        }

        const stats = {
            totalReferrals: people.size,
            successfulReferrals,
            totalBookedByReferrals: Math.round(totalBookedByReferrals * 100) / 100,
            totalAmountEarnedFromReferralsNGN: Math.round(totalAmountEarnedFromReferralsNGN * 100) / 100,
        };

        return Response.json({
            success: true,
            data: stats
        }, { status: 200 });

    } catch (error) {
        console.error('Error aggregating referral statistics:', error);
        return Response.json({
            error: 'Internal server error',
            details: (error as Error).message
        }, { status: 500 });
    }
});
