import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invokeFn } from '@/lib/invokeFn';
import { REFERRAL_KEY, isFinalRefusal } from '@/lib/referralLink';

export default function ReferralCodePrompt({ user, onSubmitted }) {
    const [open, setOpen] = useState(true);
    const [code, setCode] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    // The server's last word for this account ("already booked with us",
    // "already used a code"): no other code would change it.
    const [settled, setSettled] = useState(null);

    useEffect(() => {
        // Check for referral code in localStorage first (set by ReferralTracker)
        const storedCode = localStorage.getItem(REFERRAL_KEY);
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

        // A refusal is a 4xx, which the SDK throws. invokeFn hands back the
        // server's code and its own sentence instead, and that sentence is
        // what is shown.
        const result = await invokeFn('attributeReferral', { ref_code: code });
        if (result.ok) {
            localStorage.removeItem(REFERRAL_KEY);
            alert('🎉 Referral code applied! Your referrer will earn rewards when you make your first booking!');
            onSubmitted();
            setOpen(false);
            return;
        }
        if (isFinalRefusal(result.code)) {
            // Said calmly, and the only way on is Close: another code would
            // get the same answer.
            try { localStorage.removeItem(REFERRAL_KEY); } catch { /* nothing kept */ }
            setSettled(result.error);
        } else {
            setError(result.error);
        }
        setIsLoading(false);
    };

    const handleSkip = async () => {
        try {
            await base44.auth.updateMe({ referral_prompt_seen: true });
            // Clear stored code if user skips
            localStorage.removeItem(REFERRAL_KEY);
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
                        disabled={isLoading || !!settled}
                    />
                    {settled && (
                        <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
                            <p className="text-sm text-slate-700 dark:text-slate-300">{settled}</p>
                        </div>
                    )}
                    {error && (
                        <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg p-3">
                            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
                        </div>
                    )}
                    {code && !error && !settled && (
                        <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-lg p-3">
                            <p className="text-sm text-blue-700 dark:text-blue-300">
                                ℹ️ You'll be connected to the user with code: <strong>{code}</strong>
                            </p>
                        </div>
                    )}
                </div>
                <div className="flex justify-end gap-4">
                    {settled ? (
                        <Button onClick={handleSkip}>Close</Button>
                    ) : (
                        <>
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
                        </>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
