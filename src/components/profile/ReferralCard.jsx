
import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy, Gift, CheckCircle, Clock, DollarSign, TrendingUp, Users, Target, Loader2 } from "lucide-react";

export default function ReferralCard({ user, referrals, referralStats, isLoadingStats }) {
    const [copied, setCopied] = useState(false);
    
    // Generate the full referral link with custom domain
    const referralLink = `https://luxelivingproperty.io/?ref=${user.referral_code}`;

    const handleCopy = () => {
        navigator.clipboard.writeText(referralLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const completedReferrals = referrals.filter(ref => ref.status === 'booking_completed');
    const pendingReferrals = referrals.filter(ref => ref.status === 'signed_up');

    return (
        <Card className="bg-white/90 backdrop-blur-sm border-slate-200 rounded-3xl shadow-lg overflow-hidden relative">
            <div className="h-2 bg-gradient-to-r from-amber-400 via-orange-400 to-red-400" />
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Gift className="w-6 h-6 text-amber-500" />
                    Refer & Earn 5%
                </CardTitle>
                <CardDescription>
                    Share your unique link. When friends book, you get 5% of their booking value in Naira!
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                <div>
                    <Label className="text-sm font-semibold text-slate-700">Your Unique Referral Link</Label>
                    <div className="flex gap-2 mt-2">
                        <Input value={referralLink} readOnly className="bg-slate-100 font-mono text-sm" />
                        <Button onClick={handleCopy} variant="outline" size="icon">
                            {copied ? <CheckCircle className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                        </Button>
                    </div>
                </div>

                {/* Enhanced Stats Summary with Backend Data */}
                {isLoadingStats ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-6 h-6 animate-spin text-amber-500" />
                    </div>
                ) : referralStats ? (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-4 border border-blue-200">
                                <div className="flex items-center gap-2 mb-2">
                                    <Users className="w-4 h-4 text-blue-600" />
                                    <span className="text-xs text-blue-600 font-medium">Total Referrals</span>
                                </div>
                                <div className="text-2xl font-bold text-blue-900">{referralStats.totalReferrals}</div>
                            </div>
                            <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-4 border border-green-200">
                                <div className="flex items-center gap-2 mb-2">
                                    <CheckCircle className="w-4 h-4 text-green-600" />
                                    <span className="text-xs text-green-600 font-medium">Completed</span>
                                </div>
                                <div className="text-2xl font-bold text-green-900">{referralStats.successfulReferrals}</div>
                            </div>
                        </div>

                        <div className="bg-gradient-to-br from-amber-50 to-orange-100 rounded-xl p-4 border-2 border-amber-200">
                            <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2">
                                    <DollarSign className="w-5 h-5 text-amber-600" />
                                    <span className="text-sm text-amber-900 font-semibold">Total Revenue Generated</span>
                                </div>
                            </div>
                            <div className="text-3xl font-bold text-amber-900 mb-1">
                                ₦{referralStats.totalBookedByReferrals.toLocaleString()}
                            </div>
                            <p className="text-xs text-amber-700">
                                From {referralStats.successfulReferrals} successful booking{referralStats.successfulReferrals !== 1 ? 's' : ''}
                            </p>
                        </div>

                        <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl p-4 border-2 border-purple-200">
                            <div className="flex items-center gap-2 mb-2">
                                <TrendingUp className="w-5 h-5 text-purple-600" />
                                <span className="text-sm text-purple-900 font-semibold">Your Earnings</span>
                            </div>
                            <div className="text-3xl font-bold text-purple-900 mb-1">
                                ₦{referralStats.totalAmountEarnedFromReferralsNGN.toLocaleString()}
                            </div>
                            <p className="text-xs text-purple-700">
                                5% commission on referral bookings
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="grid grid-cols-3 gap-4 py-4 border-y border-slate-200">
                        <div className="text-center">
                            <div className="text-2xl font-bold text-slate-900">{referrals.length}</div>
                            <div className="text-xs text-slate-500">Total Referrals</div>
                        </div>
                        <div className="text-center">
                            <div className="text-2xl font-bold text-green-600">{completedReferrals.length}</div>
                            <div className="text-xs text-slate-500">Completed</div>
                        </div>
                        <div className="text-center">
                            <div className="text-2xl font-bold text-amber-600">
                                ₦{referrals.reduce((sum, ref) => sum + (ref.amount_earned_ngn || 0), 0).toLocaleString()}
                            </div>
                            <div className="text-xs text-slate-500">Earned (NGN)</div>
                        </div>
                    </div>
                )}

                <div className="space-y-4">
                    <h4 className="font-semibold text-slate-800 flex items-center gap-2">
                        <Target className="w-4 h-4 text-slate-600" />
                        Your Referrals
                    </h4>
                    <div className="border rounded-xl p-4 space-y-3 max-h-60 overflow-y-auto bg-slate-50">
                        {referrals.length > 0 ? (
                            referrals.map(ref => (
                                <div key={ref.id} className="flex justify-between items-center text-sm bg-white p-3 rounded-lg border border-slate-200">
                                    <div className="flex items-center gap-3">
                                        {ref.status === 'booking_completed' ? (
                                            <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />
                                        ) : (
                                            <Clock className="w-5 h-5 text-amber-500 flex-shrink-0" />
                                        )}
                                        <div>
                                            <div className="font-medium text-slate-700">{ref.referred_email}</div>
                                            <div className="text-xs text-slate-500">
                                                {ref.status === 'booking_completed' ? 'Booked' : 'Signed up'}
                                            </div>
                                        </div>
                                    </div>
                                    {ref.status === 'booking_completed' && ref.amount_earned_ngn ? (
                                        <div className="flex items-center gap-1 font-semibold text-green-600">
                                            <span>+₦{ref.amount_earned_ngn.toLocaleString()}</span>
                                        </div>
                                    ) : (
                                        <span className="text-xs text-slate-500 italic">Pending</span>
                                    )}
                                </div>
                            ))
                        ) : (
                            <p className="text-sm text-slate-500 text-center py-4">You haven't referred anyone yet.</p>
                        )}
                    </div>
                    {pendingReferrals.length > 0 && (
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                            <p className="text-blue-800">
                                💡 You have {pendingReferrals.length} pending referral{pendingReferrals.length > 1 ? 's' : ''}. You'll earn 5% of their booking value in Naira when they complete their first booking!
                            </p>
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
