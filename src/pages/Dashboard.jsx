
import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Briefcase, Heart, Search, Settings, ArrowRight } from 'lucide-react';
import LoyaltyCard from '../components/dashboard/LoyaltyCard';
import NFTCollection from '../components/dashboard/NFTCollection';
import ReferralCodePrompt from '../components/dashboard/ReferralCodePrompt';
import ReferralCard from '../components/profile/ReferralCard';
import PropertyCard from '../components/search/PropertyCard';

// Reusable Stat Card Component with Hover Animation
function StatCard({ icon, title, value, description }) {
  return (
    <Card className="group bg-white/80 backdrop-blur-sm border-slate-200/60 shadow-sm hover:shadow-2xl transition-all duration-500 rounded-2xl overflow-hidden relative before:absolute before:inset-0 before:bg-gradient-to-r before:from-blue-400/20 before:via-purple-400/20 before:to-pink-400/20 before:opacity-0 before:transition-opacity before:duration-500 hover:before:opacity-100 before:animate-pulse">
      <div className="relative z-10">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-slate-600 group-hover:text-slate-800 transition-colors duration-300">{title}</CardTitle>
          <div className="transform transition-all duration-300 group-hover:scale-110 group-hover:rotate-3">
            {icon}
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-slate-900 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:from-blue-600 group-hover:to-purple-600 group-hover:bg-clip-text transition-all duration-300">{value}</div>
          <p className="text-xs text-slate-500 group-hover:text-slate-600 transition-colors duration-300">{description}</p>
        </CardContent>
      </div>
    </Card>
  );
}

// Main Dashboard Page
export default function DashboardPage() {
  const [user, setUser] = useState(null);
  const [stats, setStats] = useState({ bookings: 0, wishlist: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [showReferralPrompt, setShowReferralPrompt] = useState(false);
  const [referrals, setReferrals] = useState([]);
  const [wishlistItems, setWishlistItems] = useState([]);
  const [referralStats, setReferralStats] = useState(null);
  const [isLoadingReferralStats, setIsLoadingReferralStats] = useState(false);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    setIsLoading(true);
    try {
      let userData = await base44.auth.me();
      
      let shouldUpdateUser = false;
      let updatePayload = {};

      // Generate referral code for user if they don't have one
      if (!userData.referral_code) {
        const generateCode = () => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let result = '';
            for (let i = 0; i < 8; i++) {
                result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return result;
        };
        const userFirstName = userData.full_name ? userData.full_name.split(' ')[0].toUpperCase() : 'USER';
        updatePayload.referral_code = `${userFirstName}${generateCode()}`;
        shouldUpdateUser = true;
      }
      
      // Initialize loyalty system
      if (userData.loyalty_points === undefined || userData.loyalty_points === null) {
        updatePayload.loyalty_points = 100; // Welcome bonus
        updatePayload.loyalty_tier = "Bronze";
        shouldUpdateUser = true;
        
        // Create transaction record for welcome bonus
        if (!userData.loyalty_points) {
          try {
            await base44.entities.LoyaltyTransaction.create({
              user_email: userData.email,
              points_earned: 100,
              transaction_type: 'bonus',
              description: 'Welcome bonus for joining Luxeliving'
            });
          } catch (txError) {
            console.error('Error creating welcome bonus transaction:', txError);
          }
        }
      }
      
      if(userData.nft_tokens === undefined || userData.nft_tokens === null || userData.nft_tokens.length === 0) {
          updatePayload.nft_tokens = [
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
          ];
          shouldUpdateUser = true;
      }

      if (shouldUpdateUser) {
        await base44.auth.updateMe(updatePayload);
        userData = await base44.auth.me();
      }
      
      setUser(userData);
      
      // Check if we should show the referral prompt
      // Show if: user doesn't have referred_by_code AND hasn't seen the prompt
      if (!userData.referred_by_code && !userData.referral_prompt_seen) {
          console.log('👀 Checking for stored referral code...');
          const storedRefCode = localStorage.getItem('luxeliving_referral_code');
          if (storedRefCode) {
              console.log('📋 Found stored referral code, showing prompt');
              setShowReferralPrompt(true);
          } else {
              console.log('ℹ️ No stored referral code found');
              setShowReferralPrompt(false);
          }
      } else {
          setShowReferralPrompt(false);
      }

      // Load referral data
      if (userData.referral_code) {
        const referralData = await base44.entities.Referral.filter({ referrer_email: userData.email });
        setReferrals(referralData);
        
        console.log('📊 Loading referral stats for user:', userData.email);
        console.log('📋 Current referrals:', referralData);
        
        // Load aggregated referral statistics using base44.functions.invoke
        setIsLoadingReferralStats(true);
        try {
          const statsResult = await base44.functions.invoke('getReferralStatistics', { 
            user_email: userData.email 
          });
          
          if (statsResult.data && statsResult.data.success) {
            setReferralStats(statsResult.data.data);
            console.log('✅ Referral stats loaded:', statsResult.data.data);
          }
        } catch (statsError) {
          console.error('Error loading referral stats:', statsError);
          // Set default stats if function fails
          setReferralStats({
            totalReferrals: referralData.length,
            successfulReferrals: referralData.filter(r => r.status === 'booking_completed').length,
            totalBookedByReferrals: 0,
            totalAmountEarnedFromReferralsNGN: referralData.reduce((sum, ref) => sum + (ref.amount_earned_ngn || 0), 0)
          });
        }
        setIsLoadingReferralStats(false);
      }

      const bookingData = await base44.entities.Booking.filter({ guest_email: userData.email });
      
      const wishlistProperties = userData.wishlist && userData.wishlist.length > 0
        ? await base44.entities.Property.filter({ id: { $in: userData.wishlist } })
        : [];
      setWishlistItems(wishlistProperties);

      setStats({
        bookings: bookingData.length,
        wishlist: userData.wishlist?.length || 0
      });

    } catch (error) {
      console.error("Error loading dashboard data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleWishlist = async (propertyId) => {
    if (!user) return;
    const newWishlist = user.wishlist.filter(id => id !== propertyId);
    
    // Optimistic UI update
    const updatedUser = { ...user, wishlist: newWishlist };
    setUser(updatedUser);
    setWishlistItems(prev => prev.filter(p => p.id !== propertyId));
    setStats(prev => ({ ...prev, wishlist: newWishlist.length }));

    try {
        await base44.auth.updateMe({ wishlist: newWishlist });
    } catch (error) {
        console.error("Failed to update wishlist:", error);
        loadDashboardData(); 
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-8">
        <div className="animate-pulse space-y-8">
          <div className="h-8 bg-slate-200 rounded-lg w-1/3" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="h-28 bg-slate-200 rounded-lg" />
            <div className="h-28 bg-slate-200 rounded-lg" />
            <div className="h-48 bg-slate-200 rounded-lg md:col-span-2" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-8">
      {showReferralPrompt && user && (
        <ReferralCodePrompt user={user} onSubmitted={loadDashboardData} />
      )}
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Welcome back, {user?.full_name?.split(' ')[0]}!</h1>
        <p className="text-slate-600">Here's your travel snapshot.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {/* Stats */}
        <StatCard
          title="Total Bookings"
          value={stats.bookings}
          description="All your past and future trips"
          icon={<Briefcase className="h-4 w-4 text-slate-500 group-hover:text-blue-500 transition-colors duration-300" />}
        />
        <StatCard
          title="Wishlisted Properties"
          value={stats.wishlist}
          description="Your saved favorites"
          icon={<Heart className="h-4 w-4 text-slate-500 group-hover:text-pink-500 transition-colors duration-300" />}
        />
      </div>

      {/* Wishlist Preview Section */}
      {wishlistItems.length > 0 && (
        <div className="mt-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold text-slate-900">From Your Wishlist</h2>
            <Link to={createPageUrl("Wishlist")}>
              <Button variant="outline" size="sm" className="rounded-xl">
                View All ({stats.wishlist}) <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {wishlistItems.slice(0, 3).map((property) => (
              <PropertyCard
                key={property.id}
                property={property}
                isWishlisted={true}
                onToggleWishlist={() => handleToggleWishlist(property.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Loyalty, NFT, and Referral Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <LoyaltyCard user={user} />
        <NFTCollection user={user} />
        {user && user.referral_code && (
          <ReferralCard 
            user={user} 
            referrals={referrals} 
            referralStats={referralStats}
            isLoadingStats={isLoadingReferralStats}
          />
        )}
      </div>

      <div>
        <h2 className="text-2xl font-bold text-slate-900 mb-4">Quick Links</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          <Link to={createPageUrl("Search")}>
            <Card className="group hover:border-amber-400/50 hover:shadow-2xl transition-all duration-500 p-6 flex items-center gap-4 bg-white/80 backdrop-blur-sm border-slate-200/60 rounded-2xl overflow-hidden relative before:absolute before:inset-0 before:bg-gradient-to-r before:from-amber-400/20 before:via-orange-400/20 before:to-red-400/20 before:opacity-0 before:transition-opacity before:duration-500 hover:before:opacity-100 before:animate-pulse">
              <div className="relative z-10 flex items-center gap-4 w-full">
                <div className="transform transition-all duration-300 group-hover:scale-110 group-hover:rotate-12">
                  <Search className="w-8 h-8 text-amber-500 group-hover:text-orange-500 transition-colors duration-300" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-800 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:from-amber-600 group-hover:to-orange-600 group-hover:bg-clip-text transition-all duration-300">New Search</h3>
                  <p className="text-sm text-slate-500 group-hover:text-slate-600 transition-colors duration-300">Find your next destination</p>
                </div>
              </div>
            </Card>
          </Link>
          <Link to={createPageUrl("Profile")}>
            <Card className="group hover:border-amber-400/50 hover:shadow-2xl transition-all duration-500 p-6 flex items-center gap-4 bg-white/80 backdrop-blur-sm border-slate-200/60 rounded-2xl overflow-hidden relative before:absolute before:inset-0 before:bg-gradient-to-r before:from-purple-400/20 before:via-indigo-400/20 before:to-blue-400/20 before:opacity-0 before:transition-opacity before:duration-500 hover:before:opacity-100 before:animate-pulse">
              <div className="relative z-10 flex items-center gap-4 w-full">
                <div className="transform transition-all duration-300 group-hover:scale-110 group-hover:rotate-12">
                  <Settings className="w-8 h-8 text-amber-500 group-hover:text-purple-500 transition-colors duration-300" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-800 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:from-purple-600 group-hover:to-indigo-600 group-hover:bg-clip-text transition-all duration-300">Manage Profile</h3>
                  <p className="text-sm text-slate-500 group-hover:text-slate-600 transition-colors duration-300">Update your preferences</p>
                </div>
              </div>
            </Card>
          </Link>
          <Link to={createPageUrl("Bookings")}>
            <Card className="group hover:border-amber-400/50 hover:shadow-2xl transition-all duration-500 p-6 flex items-center gap-4 bg-white/80 backdrop-blur-sm border-slate-200/60 rounded-2xl overflow-hidden relative before:absolute before:inset-0 before:bg-gradient-to-r before:from-green-400/20 before:via-emerald-400/20 before:to-teal-400/20 before:opacity-0 before:transition-opacity before:duration-500 hover:before:opacity-100 before:animate-pulse">
              <div className="relative z-10 flex items-center gap-4 w-full">
                <div className="transform transition-all duration-300 group-hover:scale-110 group-hover:rotate-12">
                  <Briefcase className="w-8 h-8 text-amber-500 group-hover:text-green-500 transition-colors duration-300" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-800 group-hover:text-transparent group-hover:bg-gradient-to-r group-hover:from-green-600 group-hover:to-emerald-600 group-hover:bg-clip-text transition-all duration-300">All Bookings</h3>
                  <p className="text-sm text-slate-500 group-hover:text-slate-600 transition-colors duration-300">View your trip history</p>
                </div>
              </div>
            </Card>
          </Link>
        </div>
      </div>
    </div>
  );
}
