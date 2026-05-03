import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  Sparkles, 
  Trophy, 
  Map, 
  Camera, 
  Plane, 
  Mountain, 
  Waves, 
  Building,
  ChevronRight,
  Gift
} from "lucide-react";

const rarityConfig = {
  Common: { color: "bg-gray-100 text-gray-700 border-gray-200", glow: "" },
  Rare: { color: "bg-blue-100 text-blue-700 border-blue-200", glow: "shadow-blue-200" },
  Epic: { color: "bg-purple-100 text-purple-700 border-purple-200", glow: "shadow-purple-200" },
  Legendary: { color: "bg-amber-100 text-amber-700 border-amber-200", glow: "shadow-amber-200" },
  Mythic: { color: "bg-rose-100 text-rose-700 border-rose-200", glow: "shadow-rose-200" }
};

const tokenTypeIcons = {
  destination: Map,
  experience: Camera,
  journey: Plane,
  adventure: Mountain,
  coastal: Waves,
  urban: Building,
  milestone: Trophy
};

export default function NFTCollection({ user }) {
  const [selectedToken, setSelectedToken] = useState(null);
  const nftTokens = user?.nft_tokens || [];

  // Sample NFT tokens for demonstration (these would be earned through various activities)
  const sampleTokens = nftTokens.length === 0 ? [
    {
      id: "welcome-001",
      name: "Welcome Explorer",
      type: "milestone",
      rarity: "Common",
      earned_date: new Date().toISOString().split('T')[0],
      image_url: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=200",
      description: "Awarded for joining the Luxeliving community",
      benefits: ["5% discount on first booking", "Priority customer support"]
    }
  ] : nftTokens;

  if (sampleTokens.length === 0) {
    return (
      <Card className="group bg-white/90 backdrop-blur-sm border-slate-200/60 shadow-lg hover:shadow-2xl transition-all duration-500 rounded-2xl overflow-hidden relative before:absolute before:inset-0 before:bg-gradient-to-r before:from-purple-400/20 before:via-pink-400/20 before:to-rose-400/20 before:opacity-0 before:transition-opacity before:duration-500 hover:before:opacity-100 before:animate-pulse">
        <div className="relative z-10">
          <CardHeader>
            <CardTitle className="text-lg font-bold text-slate-900 flex items-center gap-2 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:from-purple-600 group-hover:to-pink-600 group-hover:bg-clip-text transition-all duration-300">
              <div className="transform transition-all duration-300 group-hover:scale-110 group-hover:rotate-12">
                <Sparkles className="w-5 h-5 text-amber-500 group-hover:text-purple-500 transition-colors duration-300" />
              </div>
              NFT Travel Tokens
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center py-8">
            <div className="transform transition-all duration-300 group-hover:scale-110">
              <Gift className="w-16 h-16 text-slate-400 mx-auto mb-4 group-hover:text-purple-400 transition-colors duration-300" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2 group-hover:text-purple-600 transition-colors duration-300">Start Your Collection</h3>
            <p className="text-slate-600 mb-4 group-hover:text-slate-700 transition-colors duration-300">
              Complete bookings and milestones to earn exclusive NFT travel tokens!
            </p>
            <Button variant="outline" className="transform transition-all duration-300 group-hover:scale-105">Learn More</Button>
          </CardContent>
        </div>
      </Card>
    );
  }

  return (
    <Card className="group bg-white/90 backdrop-blur-sm border-slate-200/60 shadow-lg hover:shadow-2xl transition-all duration-500 rounded-2xl overflow-hidden relative before:absolute before:inset-0 before:bg-gradient-to-r before:from-purple-400/20 before:via-pink-400/20 before:to-rose-400/20 before:opacity-0 before:transition-opacity before:duration-500 hover:before:opacity-100 before:animate-pulse">
      <div className="relative z-10">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-bold text-slate-900 flex items-center gap-2 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:from-purple-600 group-hover:to-pink-600 group-hover:bg-clip-text transition-all duration-300">
              <div className="transform transition-all duration-300 group-hover:scale-110 group-hover:rotate-12">
                <Sparkles className="w-5 h-5 text-amber-500 group-hover:text-purple-500 transition-colors duration-300" />
              </div>
              NFT Travel Tokens
            </CardTitle>
            <Badge variant="outline" className="font-semibold transform transition-all duration-300 group-hover:scale-105">
              {sampleTokens.length} Collected
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {sampleTokens.slice(0, 6).map((token) => {
              const IconComponent = tokenTypeIcons[token.type] || Sparkles;
              const rarityStyle = rarityConfig[token.rarity] || rarityConfig.Common;
              
              return (
                <div
                  key={token.id}
                  className={`relative group/token cursor-pointer transition-all duration-300 hover:scale-105 ${rarityStyle.glow} hover:shadow-lg`}
                  onClick={() => setSelectedToken(token)}
                >
                  <div className="aspect-square rounded-xl overflow-hidden bg-gradient-to-br from-slate-100 to-slate-200 border-2 border-slate-200 group-hover/token:border-amber-400 transition-all duration-300">
                    {token.image_url ? (
                      <img
                        src={token.image_url}
                        alt={token.name}
                        className="w-full h-full object-cover transform transition-all duration-300 group-hover/token:scale-110"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
                        <IconComponent className="w-8 h-8 text-amber-400 transform transition-all duration-300 group-hover/token:scale-110 group-hover/token:rotate-12" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover/token:opacity-100 transition-opacity duration-300" />
                    <div className="absolute bottom-2 left-2 opacity-0 group-hover/token:opacity-100 transition-opacity duration-300">
                      <Badge className={`${rarityStyle.color} border text-xs`}>
                        {token.rarity}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-xs font-medium text-slate-900 mt-2 text-center line-clamp-1 group-hover/token:text-purple-600 transition-colors duration-300">
                    {token.name}
                  </p>
                </div>
              );
            })}
          </div>

          {sampleTokens.length > 6 && (
            <Button variant="outline" className="w-full transform transition-all duration-300 group-hover:scale-105">
              View All Tokens
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          )}

          {selectedToken && (
            <div className="mt-6 p-4 bg-slate-50 rounded-xl border transform transition-all duration-300 hover:bg-slate-100">
              <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-lg overflow-hidden bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center flex-shrink-0">
                  {selectedToken.image_url ? (
                    <img src={selectedToken.image_url} alt={selectedToken.name} className="w-full h-full object-cover" />
                  ) : (
                    <Sparkles className="w-6 h-6 text-amber-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-semibold text-slate-900">{selectedToken.name}</h4>
                  <p className="text-sm text-slate-600 mb-2">{selectedToken.description}</p>
                  {selectedToken.benefits && selectedToken.benefits.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-slate-700 mb-1">Benefits:</p>
                      <ul className="text-xs text-slate-600 space-y-1">
                        {selectedToken.benefits.map((benefit, index) => (
                          <li key={index} className="flex items-center gap-1">
                            <div className="w-1 h-1 bg-amber-500 rounded-full" />
                            {benefit}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </div>
    </Card>
  );
}