import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ReferralCodePrompt({ user, onSubmitted }) {
    const [open, setOpen] = useState(true);
    const [code, setCode] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        // Check for referral code in localStorage first (set by ReferralTracker)
        const storedCode = localStorage.getItem('luxeliving_referral_code');
        if (storedCode) {
            console.log('📋 Found stored referral code in localStorage:', storedCode);
            setCode(storedCode);
        } else {
            // Fallback: Check URL parameters
            const urlParams = new URLSearchParams(window.location.search);
            const refCode = urlParams.get('ref');
            if (refCode) {
                console.log('📋 Found referral code in URL:', refCode);
                setCode(refCode);
            }
        }
    }, []);

    const handleSubmit = async () => {
        if (!code.trim()) {
            setError("Please enter a referral code");
            return;
        }
        
        setIsLoading(true);
        setError(null);
        
        try {
            console.log('🔍 Validating referral code:', code);
            
            // Check if user already has a referral
            const existingReferral = await base44.entities.Referral.filter({
                referred_email: user.email
            });
            
            if (existingReferral.length > 0) {
                setError("You've already used a referral code!");
                setIsLoading(false);
                return;
            }
            
            // 1. Find the referrer by the code they entered (use service role to bypass RLS)
            const referrers = await base44.asServiceRole.entities.User.filter({ 
                referral_code: code.trim().toUpperCase() 
            });
            
            if (referrers.length === 0) {
                setError("This referral code is not valid. Please check and try again.");
                setIsLoading(false);
                return;
            }
            
            const referrer = referrers[0];
            
            // Prevent self-referral
            if (referrer.email === user.email) {
                setError("You cannot use your own referral code!");
                setIsLoading(false);
                return;
            }
            
            console.log('✅ Valid referrer found:', referrer.email);
            
            // 2. Update the current user's data
            await base44.auth.updateMe({ 
                referred_by_code: code.trim().toUpperCase(),
                referral_prompt_seen: true
            });
            
            console.log('✅ User updated with referral code');
            
            // 3. Create a new Referral record (use service role to ensure it works)
            await base44.asServiceRole.entities.Referral.create({
                referrer_email: referrer.email,
                referred_email: user.email,
                status: 'signed_up'
            });
            
            console.log('✅ Referral record created');
            
            // 4. Clear the stored code from localStorage
            localStorage.removeItem('luxeliving_referral_code');
            console.log('🧹 Cleared referral code from localStorage');
            
            alert('🎉 Referral code applied! Your referrer will earn rewards when you make your first booking!');
            
            onSubmitted();
            setOpen(false);

        } catch (err) {
            console.error('❌ Error applying referral code:', err);
            console.error('Error details:', {
                message: err.message,
                response: err.response?.data,
                stack: err.stack
            });
            
            // Provide specific error messages based on the error type
            if (err.message?.includes('already exists') || err.message?.includes('duplicate')) {
                setError("You've already used a referral code!");
            } else if (err.message?.includes('not found') || err.response?.status === 404) {
                setError("Invalid referral code. Please check and try again.");
            } else if (err.message?.includes('permission') || err.response?.status === 403) {
                setError("Permission denied. Please contact support.");
            } else {
                setError(`Error: ${err.message || 'An error occurred. Please try again.'}`);
            }
        }
        setIsLoading(false);
    };

    const handleSkip = async () => {
        try {
            await base44.auth.updateMe({ referral_prompt_seen: true });
            // Clear stored code if user skips
            localStorage.removeItem('luxeliving_referral_code');
            onSubmitted();
            setOpen(false);
        } catch (error) {
            console.error('Error marking prompt as seen:', error);
            setOpen(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleSkip()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="text-2xl">Welcome to Luxeliving! 🎉</DialogTitle>
                    <DialogDescription>
                        Did a friend refer you? Enter their referral code below to help them earn rewards when you book!
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                    <Input 
                        placeholder="Enter referral code (e.g. JOHN1A2B3C4D)" 
                        value={code}
                        onChange={(e) => {
                            setCode(e.target.value.toUpperCase());
                            setError(null);
                        }}
                        className="uppercase"
                        disabled={isLoading}
                    />
                    {error && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                            <p className="text-sm text-red-700">{error}</p>
                        </div>
                    )}
                    {code && !error && (
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                            <p className="text-sm text-blue-700">
                                ℹ️ You'll be connected to the user with code: <strong>{code}</strong>
                            </p>
                        </div>
                    )}
                </div>
                <div className="flex justify-end gap-4">
                    <Button variant="ghost" onClick={handleSkip} disabled={isLoading}>
                        Skip for now
                    </Button>
                    <Button 
                        onClick={handleSubmit} 
                        disabled={isLoading || !code.trim()}
                        className="bg-gradient-to-r from-slate-900 to-slate-800"
                    >
                        {isLoading ? "Applying..." : "Apply Code"}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}