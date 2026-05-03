import { useEffect } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * ReferralTracker Component
 * 
 * This component handles the capture and storage of referral codes.
 * It should be placed in the Layout or a top-level component to ensure
 * it runs on every page load.
 * 
 * Flow:
 * 1. Checks URL for ?ref=CODE parameter
 * 2. Stores the code in localStorage (in case user hasn't signed up yet)
 * 3. After user logs in, checks if they have a referred_by_code
 * 4. If not, assigns the stored referral code to their profile
 */
export default function ReferralTracker() {
  useEffect(() => {
    const trackReferral = async () => {
      try {
        // Step 1: Check URL for referral code
        const urlParams = new URLSearchParams(window.location.search);
        const refCode = urlParams.get('ref');
        
        if (refCode) {
          console.log('🔗 Referral code detected in URL:', refCode);
          // Store in localStorage for later (after signup)
          localStorage.setItem('luxeliving_referral_code', refCode);
          console.log('💾 Referral code saved to localStorage');
        }
        
        // Step 2: Check if user is authenticated
        let user;
        try {
          user = await base44.auth.me();
        } catch (error) {
          // User not logged in, that's okay - we'll catch them after signup
          console.log('ℹ️ User not logged in yet, referral code stored for later');
          return;
        }
        
        // Step 3: If user is logged in and doesn't have referred_by_code
        if (user && !user.referred_by_code) {
          const storedRefCode = localStorage.getItem('luxeliving_referral_code');
          
          if (storedRefCode) {
            console.log('🎯 Processing stored referral code for user:', user.email);
            
            try {
              // Verify the referral code exists and belongs to a valid user
              const referrers = await base44.asServiceRole.entities.User.filter({ 
                referral_code: storedRefCode.toUpperCase() 
              });
              
              if (referrers.length === 0) {
                console.error('⚠️ Invalid referral code:', storedRefCode);
                localStorage.removeItem('luxeliving_referral_code');
                return;
              }
              
              const referrer = referrers[0];
              
              // Don't allow self-referral
              if (referrer.email === user.email) {
                console.error('⚠️ Cannot refer yourself!');
                localStorage.removeItem('luxeliving_referral_code');
                return;
              }
              
              console.log('✅ Valid referrer found:', referrer.email);
              
              // Check if referral already exists
              const existingReferral = await base44.entities.Referral.filter({
                referred_email: user.email
              });
              
              if (existingReferral.length > 0) {
                console.log('ℹ️ User already has a referral record');
                localStorage.removeItem('luxeliving_referral_code');
                return;
              }
              
              // Update user with referred_by_code
              await base44.auth.updateMe({ 
                referred_by_code: storedRefCode.toUpperCase(),
                referral_prompt_seen: true
              });
              
              console.log('✅ User profile updated with referral code');
              
              // Create initial Referral record with 'signed_up' status
              await base44.asServiceRole.entities.Referral.create({
                referrer_email: referrer.email,
                referred_email: user.email,
                status: 'signed_up'
              });
              
              console.log('✅ Referral record created');
              
              // Clear localStorage after successful processing
              localStorage.removeItem('luxeliving_referral_code');
              console.log('🧹 Cleared referral code from localStorage');
              
              console.log('🎉 Referral tracking complete!');
            } catch (error) {
              console.error('❌ Error processing referral:', error);
              console.error('Error details:', {
                message: error.message,
                code: storedRefCode,
                user: user.email
              });
            }
          }
        }
      } catch (error) {
        console.error('❌ Error in referral tracking:', error);
      }
    };
    
    // Run on component mount
    trackReferral();
  }, []); // Empty dependency array - run once on mount
  
  return null; // This component doesn't render anything
}