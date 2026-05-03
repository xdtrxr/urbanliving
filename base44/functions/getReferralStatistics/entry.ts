import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Verify user is authenticated
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { user_email } = body;

        // Security: Ensure user can only query their own stats (unless admin)
        if (user.role !== 'admin' && user.email !== user_email) {
            return Response.json({ 
                error: 'Forbidden: You can only access your own referral statistics' 
            }, { status: 403 });
        }

        console.log(`📊 Aggregating referral statistics for: ${user_email}`);

        // Initialize aggregation variables
        let totalReferrals = 0;
        let successfulReferrals = 0;
        let totalBookedByReferrals = 0;
        let totalAmountEarnedFromReferralsNGN = 0;

        // Query all referrals where this user is the referrer
        const referrals = await base44.entities.Referral.filter({ 
            referrer_email: user_email 
        });

        console.log(`Found ${referrals.length} referrals`);

        // Iterate through referrals and aggregate data
        for (const referral of referrals) {
            totalReferrals++;
            
            // Add amount earned in NGN (even if 0)
            totalAmountEarnedFromReferralsNGN += (referral.amount_earned_ngn || 0);

            // Check if booking was completed
            if (referral.status === 'booking_completed' && referral.booking_id) {
                successfulReferrals++;

                // Fetch the booking to get total_price
                try {
                    const booking = await base44.entities.Booking.get(referral.booking_id);
                    if (booking && booking.total_price) {
                        totalBookedByReferrals += booking.total_price;
                        console.log(`✅ Booking ${referral.booking_id}: ₦${booking.total_price}`);
                    } else {
                        console.warn(`⚠️ Booking ${referral.booking_id} not found or has no price`);
                    }
                } catch (bookingError) {
                    console.warn(`⚠️ Error fetching booking ${referral.booking_id}:`, bookingError.message);
                    // Continue aggregation even if one booking fetch fails
                }
            }
        }

        const stats = {
            totalReferrals,
            successfulReferrals,
            totalBookedByReferrals: Math.round(totalBookedByReferrals * 100) / 100, // Round to 2 decimals
            totalAmountEarnedFromReferralsNGN: Math.round(totalAmountEarnedFromReferralsNGN * 100) / 100 // Round to 2 decimals
        };

        console.log('📈 Aggregation complete:', stats);

        return Response.json({
            success: true,
            data: stats
        }, { status: 200 });

    } catch (error) {
        console.error('❌ Error aggregating referral statistics:', error);
        return Response.json({ 
            error: 'Internal server error',
            details: error.message 
        }, { status: 500 });
    }
});