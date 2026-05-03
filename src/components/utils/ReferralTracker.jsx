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
            console.log('🎯 Attributing stored referral code for user:', user.email);
            try {
              const result = await base44.functions.invoke('attributeReferral', {
                ref_code: storedRefCode,
              });
              if (result?.data?.success) {
                console.log('✅ Referral attributed:', result.data.data);
              } else {
                console.warn('⚠️ Referral attribution failed:', result?.data?.code || result?.data?.error);
              }
            } catch (error) {
              console.error('❌ Error attributing referral:', error);
            }
            // Clear regardless — single attempt per visit
            localStorage.removeItem('luxeliving_referral_code');
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