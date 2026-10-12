import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

const REWARD_RATE = 0.05;
const REFERRER_LOYALTY_BONUS = 250;

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
        const bookingId = (body.booking_id || '').toString().trim();
        if (!bookingId) {
            return new Response(JSON.stringify({ success: false, error: 'booking_id is required' }), { status: 400, headers });
        }

        const booking = await base44.asServiceRole.entities.Booking.get(bookingId);
        if (!booking) {
            return new Response(JSON.stringify({ success: false, error: 'Booking not found' }), { status: 404, headers });
        }

        // Authorization: caller must be the booking guest (or admin)
        if (booking.guest_email !== user.email && user.role !== 'admin') {
            return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403, headers });
        }

        // A reward is owed for a stay that was paid for, and for nothing
        // else. A guest can call this for their own booking, so without this
        // check an unpaid request (any length, at any listing's price) put 5%
        // of its total on the referrer's withdrawable balance. Status is
        // checked as well as payment: a paid stay the admin cancelled keeps
        // payment_status 'paid'.
        if (booking.payment_status !== 'paid' || !['confirmed', 'completed'].includes(booking.status)) {
            return new Response(JSON.stringify({
                success: false,
                error: 'This booking has not been paid for.',
                code: 'NOT_PAID',
            }), { status: 409, headers });
        }

        // Find the booking guest's referrer code
        const guests = await base44.asServiceRole.entities.User.filter({ email: booking.guest_email });
        const guest = guests[0];
        if (!guest?.referred_by_code) {
            return new Response(JSON.stringify({ success: true, data: { skipped: 'no_referrer' } }), { status: 200, headers });
        }

        const referrers = await base44.asServiceRole.entities.User.filter({ referral_code: guest.referred_by_code });
        const referrer = referrers[0];
        if (!referrer) {
            return new Response(JSON.stringify({ success: true, data: { skipped: 'referrer_not_found' } }), { status: 200, headers });
        }

        // Find existing Referral record (or create if missing)
        let referrals = await base44.asServiceRole.entities.Referral.filter({
            referrer_email: referrer.email,
            referred_email: guest.email,
        });
        let referral = referrals[0];
        if (!referral) {
            referral = await base44.asServiceRole.entities.Referral.create({
                referrer_email: referrer.email,
                referred_email: guest.email,
                status: 'signed_up',
            });
        }

        // Idempotency: only award once. Two guards — status, and a
        // booking_id stamp on the referral row. The booking_id check catches
        // races where two writers (verifyPaystackPayment + paystackWebhook +
        // this function) pass the status check before either has written.
        if (referral.status === 'booking_completed' || referral.booking_id === booking.id) {
            return new Response(JSON.stringify({
                success: true,
                data: { skipped: 'already_awarded', referral_id: referral.id },
            }), { status: 200, headers });
        }

        const amountNGN = Math.round((Number(booking.total_price) || 0) * REWARD_RATE);
        const newBalance = (Number(referrer.referral_balance_ngn) || 0) + amountNGN;
        const newLoyalty = (Number(referrer.loyalty_points) || 0) + REFERRER_LOYALTY_BONUS;

        await base44.asServiceRole.entities.User.update(referrer.id, {
            referral_balance_ngn: newBalance,
            loyalty_points: newLoyalty,
        });
        await base44.asServiceRole.entities.Referral.update(referral.id, {
            status: 'booking_completed',
            booking_id: booking.id,
            amount_earned_ngn: amountNGN,
        });
        // Loyalty transaction record for the referrer's audit trail
        try {
            await base44.asServiceRole.entities.LoyaltyTransaction.create({
                user_email: referrer.email,
                points_earned: REFERRER_LOYALTY_BONUS,
                transaction_type: 'referral',
                booking_id: booking.id,
                description: `REFERRAL_BONUS — Referred ${guest.email} who booked`,
            });
        } catch (loyaltyErr) {
            console.warn('Referrer loyalty transaction log failed (non-fatal):', loyaltyErr);
        }

        return new Response(JSON.stringify({
            success: true,
            data: {
                referrer_email: referrer.email,
                amount_awarded_ngn: amountNGN,
                referrer_loyalty_bonus: REFERRER_LOYALTY_BONUS,
                referral_id: referral.id,
            },
        }), { status: 200, headers });
    } catch (error) {
        console.error('processReferralReward error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
