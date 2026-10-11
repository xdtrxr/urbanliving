import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { usePropertySearch } from "../components/hooks/usePropertySearch";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { format } from "date-fns";

import SearchHeader from "../components/search/SearchHeader";
import PropertyCard from "../components/search/PropertyCard";
import PropertyFiltersBar, { PRICE_MAX } from "../components/search/PropertyFiltersBar";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw, Sparkles } from 'lucide-react';
import { Badge } from "@/components/ui/badge";
import { awardFirstWishlistAdd } from "@/components/utils/loyaltyService";
import { useAuth } from "@/lib/AuthContext";

export default function SearchPage() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const { properties, isLoading, error, metadata, search, clearCache } = usePropertySearch();
  const [filteredProperties, setFilteredProperties] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [checkIn, setCheckIn] = useState(null);
  const [checkOut, setCheckOut] = useState(null);
  const [guests, setGuests] = useState(2);
  const [bedrooms, setBedrooms] = useState("any");
  const [user, setUser] = useState(null);
  const [wishlist, setWishlist] = useState([]);
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [filters, setFilters] = useState({
    minPrice: 0,
    maxPrice: 500000,
    propertyType: "any",
    amenities: []
  });

  useEffect(() => {
    loadUserAndWishlist();
    search({ limit: 50 });
  }, []);

  const loadUserAndWishlist = async () => {
    try {
      const userData = await base44.auth.me();
      setUser(userData);
      setWishlist(userData.wishlist || []);
    } catch (error) {
      console.error("Error loading user data:", error);
    }
  };
  
  const buildSearchParams = useCallback(() => ({
    location: searchQuery,
    guests,
    bedrooms,
    propertyType: filters.propertyType,
    minPrice: filters.minPrice,
    // The slider's top value is "and above", not a ceiling.
    maxPrice: filters.maxPrice >= PRICE_MAX ? 0 : filters.maxPrice,
    amenities: filters.amenities,
    limit: 50,
  }), [searchQuery, guests, bedrooms, filters]);

  const handleSearch = async () => {
    console.log('🔍 Search initiated');
    await search(buildSearchParams());
  };

  // Filtering is now done at the database layer; the displayed list mirrors fetched results.
  useEffect(() => {
    setFilteredProperties(properties);
  }, [properties]);

  // Re-fetch on any search-related change (debounced) so location, guests,
  // bedrooms, price, type, and amenities all round-trip to the DB without
  // requiring the user to click the Search button.
  useEffect(() => {
    const id = setTimeout(() => {
      search(buildSearchParams());
    }, 400);
    return () => clearTimeout(id);
     
  }, [searchQuery, guests, bedrooms, filters.minPrice, filters.maxPrice, filters.propertyType, filters.amenities]);

  const handleAIRecommendations = async () => {
    if (!isAuthenticated) {
      // Send signed-out users to login, returning here after auth.
      window.location.href = `/login?from_url=${encodeURIComponent(window.location.href)}`;
      return;
    }

    // Recommendations now live inside Nova — Nova owns property awareness,
    // booking conflict checks, and the booking flow that follows. We seed Nova
    // with any active filters so the conversation picks up where the user is.
    const bits = [];
    if (searchQuery?.trim()) bits.push(`in ${searchQuery.trim()}`);
    if (guests && Number(guests) > 0) bits.push(`for ${guests} guest${Number(guests) === 1 ? '' : 's'}`);
    if (bedrooms && bedrooms !== 'any') {
      const label = bedrooms === 'studio' ? 'a studio' : bedrooms === 'loft' ? 'a loft' : `${bedrooms} bedroom${bedrooms === '1' ? '' : 's'}`;
      bits.push(`with ${label}`);
    }
    if (filters?.maxPrice && filters.maxPrice < PRICE_MAX) bits.push(`under ₦${Number(filters.maxPrice).toLocaleString()}/night`);

    const seed = bits.length > 0
      ? `Give me personalized property recommendations ${bits.join(' ')}.`
      : 'Give me personalized property recommendations based on my profile.';

    const params = new URLSearchParams();
    params.set('prompt', seed);
    navigate(`${createPageUrl('AIChatConcierge')}?${params.toString()}`);
  };

  const toggleWishlist = async (propertyId) => {
    if (!user) {
      alert("Please log in to manage your wishlist.");
      return;
    }
    
    try {
      const freshUserData = await base44.auth.me();
      const currentWishlist = freshUserData.wishlist || [];
      
      const newWishlist = currentWishlist.includes(propertyId)
        ? currentWishlist.filter(id => id !== propertyId)
        : [...currentWishlist, propertyId];
      
      await base44.auth.updateMe({ wishlist: newWishlist });
      setWishlist(newWishlist);
      setUser(prev => ({ ...prev, wishlist: newWishlist }));

      // First wishlist add bonus (idempotent server-side check)
      if (newWishlist.length > currentWishlist.length) {
        try { await awardFirstWishlistAdd(); } catch { /* non-fatal */ }
      }
    } catch (error) {
      console.error("Failed to update wishlist:", error);
      alert("Failed to update wishlist. Please try again.");
      await loadUserAndWishlist();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <SearchHeader
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          checkIn={checkIn}
          setCheckIn={setCheckIn}
          checkOut={checkOut}
          setCheckOut={setCheckOut}
          guests={guests}
          setGuests={setGuests}
          bedrooms={bedrooms}
          setBedrooms={setBedrooms}
          onSearch={handleSearch}
          onAIRecommendations={handleAIRecommendations}
          isLoadingAI={isLoadingAI}
        />

        {!isLoading && metadata.totalCount > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              {searchQuery === "AI Recommendations" && (
                <Badge variant="outline" className="bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  AI Personalized
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { clearCache(); handleSearch(); }}
              className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <RefreshCw className="w-4 h-4 mr-1" />
              Refresh
            </Button>
          </div>
        )}

        {isLoading && (
          <div className="text-center my-8">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent mb-4"></div>
            <p className="text-slate-600 dark:text-slate-300 font-semibold">
              {isLoadingAI ? '✨ AI is analyzing your preferences...' : 'Loading properties...'}
            </p>
          </div>
        )}

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 p-4 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-red-900 dark:text-red-100">Search Error</p>
                <p className="text-sm text-red-700 dark:text-red-300 mt-1">{error}</p>
              </div>
            </div>
          </motion.div>
        )}

        {/* Filter chip bar — top row of quick filters + "All filters" sheet.
            Signed-out visitors don't get filters (matches previous behavior). */}
        {isAuthenticated && (
          <PropertyFiltersBar
            filters={filters}
            onFiltersChange={setFilters}
          />
        )}

        <div className="min-w-0">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
              {isLoading
                ? "Loading properties..."
                : isAuthenticated
                  ? `${filteredProperties.length} Properties Found`
                  : "Available Properties"}
            </h2>
            {searchQuery && (
              <div className="text-slate-600 dark:text-slate-300 text-sm sm:text-base">
                {searchQuery === "AI Recommendations" ? (
                  <span className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-purple-500 dark:text-purple-400" />
                    Personalized for you
                  </span>
                ) : (
                  `matching "${searchQuery}"`
                )}
              </div>
            )}
          </div>

          {!isLoading && (
            <AnimatePresence>
              <div className="grid gap-5 sm:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {filteredProperties.map((property, index) => (
                  <motion.div
                    key={property.id || index}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ delay: index * 0.05 }}
                  >
                    <PropertyCard
                      property={property}
                      stay={{ checkIn: checkIn ? format(checkIn, 'yyyy-MM-dd') : '', checkOut: checkOut ? format(checkOut, 'yyyy-MM-dd') : '', guests }}
                      onToggleWishlist={toggleWishlist}
                      isWishlisted={wishlist.includes(property.id)}
                    />
                  </motion.div>
                ))}
              </div>
            </AnimatePresence>
          )}

          {!isLoading && filteredProperties.length === 0 && properties.length > 0 && (
            <div className="text-center py-20">
              <div className="text-6xl mb-4">🔍</div>
              <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">No properties match your filters</h3>
              <p className="text-slate-600 dark:text-slate-300 mb-4">
                Try adjusting your search criteria or clear your filters to see more properties.
              </p>
              <Button
                onClick={() => {
                  setSearchQuery("");
                  setFilters({
                    minPrice: 0,
                    maxPrice: 500000,
                    propertyType: "any",
                    amenities: []
                  });
                }}
                variant="outline"
              >
                Clear All Filters
              </Button>
            </div>
          )}

          {!isLoading && properties.length === 0 && (
            <div className="text-center py-20">
              <div className="text-6xl mb-4">🌍</div>
              <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">No properties found</h3>
              <p className="text-slate-600 dark:text-slate-300 mb-4">Try searching for a different location or generate sample data from the Admin panel.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}