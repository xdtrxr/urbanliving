import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Trophy, Star, Crown, Gem, Award } from "lucide-react";

const tierConfig = {
  Bronze: { 
    color: "bg-orange-100 text-orange-800 border-orange-200",
    icon: Award,
    nextTier: "Silver",
    pointsRequired: 1000,
    gradient: "from-orange-400 to-orange-600"
  },
  Silver: { 
    color: "bg-gray-100 text-gray-800 border-gray-200",
    icon: Star,
    nextTier: "Gold",
    pointsRequired: 2500,
    gradient: "from-gray-400 to-gray-600"
  },
  Gold: { 
    color: "bg-yellow-100 text-yellow-800 border-yellow-200",
    icon: Trophy,
    nextTier: "Platinum",
    pointsRequired: 5000,
    gradient: "from-yellow-400 to-yellow-600"
  },
  Platinum: { 
    color: "bg-purple-100 text-purple-800 border-purple-200",
    icon: Crown,
    nextTier: "Diamond",
    pointsRequired: 10000,
    gradient: "from-purple-400 to-purple-600"
  },
  Diamond: { 
    color: "bg-blue-100 text-blue-800 border-blue-200",
    icon: Gem,
    nextTier: null,
    pointsRequired: null,
    gradient: "from-blue-400 to-blue-600"
  }
};

export default function LoyaltyCard({ user }) {
  const currentTier = user?.loyalty_tier || "Bronze";
  const points = user?.loyalty_points || 0;
  const tierInfo = tierConfig[currentTier];
  const TierIcon = tierInfo.icon;

  const getProgressToNextTier = () => {
    if (!tierInfo.nextTier) return 100; // Diamond tier - maxed out
    
    const currentTierPoints = {
      Bronze: 0,
      Silver: 1000,
      Gold: 2500,
      Platinum: 5000
    }[currentTier] || 0;
    
    const progressPoints = points - currentTierPoints;
    const neededPoints = tierInfo.pointsRequired - currentTierPoints;
    
    return Math.min((progressPoints / neededPoints) * 100, 100);
  };

  const getPointsToNextTier = () => {
    if (!tierInfo.nextTier) return 0;
    return Math.max(tierInfo.pointsRequired - points, 0);
  };

  return (
    <Card className="group bg-white/90 backdrop-blur-sm border-slate-200/60 shadow-lg hover:shadow-2xl transition-all duration-500 overflow-hidden rounded-2xl relative before:absolute before:inset-0 before:bg-gradient-to-r before:from-gold-400/20 before:via-amber-400/20 before:to-yellow-400/20 before:opacity-0 before:transition-opacity before:duration-500 hover:before:opacity-100 before:animate-pulse">
      <div className={`h-2 bg-gradient-to-r ${tierInfo.gradient} relative z-10`} />
      <div className="relative z-10">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-bold text-slate-900 flex items-center gap-2 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:from-amber-600 group-hover:to-gold-600 group-hover:bg-clip-text transition-all duration-300">
              <div className="transform transition-all duration-300 group-hover:scale-110 group-hover:rotate-12">
                <TierIcon className="w-5 h-5 text-slate-700 group-hover:text-amber-500 transition-colors duration-300" />
              </div>
              Loyalty Status
            </CardTitle>
            <Badge className={`${tierInfo.color} border font-semibold transform transition-all duration-300 group-hover:scale-105`}>
              {currentTier}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center">
            <div className="text-3xl font-bold text-slate-900 mb-1 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:from-gold-600 group-hover:to-amber-600 group-hover:bg-clip-text transition-all duration-300">
              {points.toLocaleString()}
            </div>
            <p className="text-sm text-slate-600 group-hover:text-slate-700 transition-colors duration-300">Luxe Points</p>
          </div>

          {tierInfo.nextTier && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-600 group-hover:text-slate-700 transition-colors duration-300">Progress to {tierInfo.nextTier}</span>
                <span className="font-semibold text-slate-900 group-hover:text-amber-600 transition-colors duration-300">
                  {getPointsToNextTier().toLocaleString()} points to go
                </span>
              </div>
              <Progress value={getProgressToNextTier()} className="h-2" />
            </div>
          )}

          {currentTier === "Diamond" && (
            <div className="text-center py-2">
              <div className="flex items-center justify-center gap-2 text-blue-600 group-hover:text-blue-500 transition-colors duration-300">
                <Gem className="w-4 h-4 transform transition-all duration-300 group-hover:scale-110" />
                <span className="text-sm font-semibold">Maximum Tier Achieved!</span>
              </div>
            </div>
          )}

          <div className="text-xs text-slate-500 text-center group-hover:text-slate-600 transition-colors duration-300">
            Earn points through bookings, reviews, and referrals
          </div>
        </CardContent>
      </div>
    </Card>
  );
}