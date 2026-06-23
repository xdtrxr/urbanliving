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
        const storedCode = localStorage.getItem('urbanstays_referral_code');
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
            console.log('🔍 Submitting referral code:', code);
            const result = await base44.functions.invoke('attributeReferral', {
                ref_code: code,
            });
            const data = result?.data;

            if (data?.success) {
                console.log('✅ Referral attributed:', data.data);
                localStorage.removeItem('urbanstays_referral_code');
                alert('🎉 Referral code applied! Your referrer will earn rewards when you make your first booking!');
                onSubmitted();
                setOpen(false);
                return;
            }

            const codeReason = data?.code;
            if (codeReason === 'ALREADY_ATTRIBUTED') {
                setError("You've already used a referral code!");
            } else if (codeReason === 'INVALID_CODE') {
                setError('This referral code is not valid. Please check and try again.');
            } else if (codeReason === 'SELF_REFERRAL') {
                setError('You cannot use your own referral code!');
            } else {
                setError(data?.error || 'An error occurred. Please try again.');
            }
        } catch (err) {
            console.error('❌ Error applying referral code:', err);
            setError(err.message || 'An error occurred. Please try again.');
        }
        setIsLoading(false);
    };

    const handleSkip = async () => {
        try {
            await base44.auth.updateMe({ referral_prompt_seen: true });
            // Clear stored code if user skips
            localStorage.removeItem('urbanstays_referral_code');
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
                    <DialogTitle className="text-2xl">Welcome to Urban Stays! 🎉</DialogTitle>
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
                        <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg p-3">
                            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
                        </div>
                    )}
                    {code && !error && (
                        <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-lg p-3">
                            <p className="text-sm text-blue-700 dark:text-blue-300">
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