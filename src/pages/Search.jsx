import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePropertySearch } from "../components/hooks/usePropertySearch";
import { base44 } from "@/api/base44Client";

import SearchHeader from "../components/search/SearchHeader";
import PropertyCard from "../components/search/PropertyCard";
import PropertyFilters from "../components/search/PropertyFilters";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw, Sparkles } from 'lucide-react';
import { Badge } from "@/components/ui/badge";

export default function SearchPage() {
  const { properties, isLoading, error, metadata, search, clearCache } = usePropertySearch();
  const [filteredProperties, setFilteredProperties] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [checkIn, setCheckIn] = useState(null);
  const [checkOut, setCheckOut] = useState(null);
  const [guests, setGuests] = useState(2);
  const [bedrooms, setBedrooms] = useState("any");
  const [user, setUser] = useState(null);
  const [wishlist, setWishlist] = useState([]);
  const [showFilters, setShowFilters] = useState(false);
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
  
  const handleSearch = async () => {
    console.log('🔍 Search initiated:', { searchQuery, guests, bedrooms });
    
    await search({
      location: searchQuery,
      guests,
      bedrooms,
      propertyType: filters.propertyType,
      limit: 50
    });
  };
  
  const applyFilters = useCallback(() => {
    let filtered = properties;

    filtered = filtered.filter(p => 
      p.price_per_night >= filters.minPrice && 
      p.price_per_night <= filters.maxPrice
    );

    if (filters.propertyType !== "any") {
      filtered = filtered.filter(p => p.property_type === filters.propertyType);
    }

    if (filters.amenities.length > 0) {
      filtered = filtered.filter(p => 
        filters.amenities.every(amenity => p.amenities?.includes(amenity))
      );
    }

    setFilteredProperties(filtered);
  }, [properties, filters]);

  useEffect(() => {
    applyFilters();
  }, [applyFilters]);

  const handleAIRecommendations = async () => {
    if (!user) {
      alert("Please log in to get personalized AI recommendations");
      return;
    }

    setIsLoadingAI(true);
    
    try {
      console.log('🤖 Getting AI recommendations...');
      
      const userBookings = await base44.entities.Booking.filter({ 
        guest_email: user.email 
      });
      
      const allProperties = await base44.entities.Property.list('-rating', 50);
      
      const userProfile = {
        name: user.full_name,
        loyalty_tier: user.loyalty_tier || 'Bronze',
        previous_bookings: userBookings.length,
        wishlist_count: wishlist.length,
        travel_style: user.travel_style || 'Not specified',
        interests: user.interests || 'Not specified'
      };
      
      const prompt = `
You are a luxury travel advisor AI for LuxeLiving.

## User Profile:
${JSON.stringify(userProfile, null, 2)}

## Available Properties:
${JSON.stringify(allProperties.slice(0, 30).map(p => ({
  id: p.id,
  title: p.title,
  location: p.location,
  price_per_night: p.price_per_night,
  property_type: p.property_type,
  rating: p.rating,
  max_guests: p.max_guests,
  bedrooms: p.bedrooms,
  amenities: p.amenities
})), null, 2)}

## Task:
Based on the user's profile, recommend 5-6 properties that would be perfect for them.

**CRITICAL RULES:**
1. ONLY recommend properties from the "Available Properties" list above
2. Use EXACT property_id from the list
3. Consider user's loyalty tier, booking history, and preferences
4. Provide diverse recommendations (different locations, types, price points)
5. Explain WHY each property is a good match

## Required Output Format (valid JSON):
{
  "recommendations": [
    {
      "property_id": "exact_id_from_list",
      "reason": "Brief explanation why this matches user preferences"
    }
  ]
}

Return ONLY the JSON, no other text.
`;

      const result = await base44.integrations.Core.InvokeLLM({
        prompt: prompt,
        response_json_schema: {
          type: "object",
          properties: {
            recommendations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  property_id: { type: "string" },
                  reason: { type: "string" }
                }
              }
            }
          }
        }
      });
      
      console.log('🤖 AI Response:', result);
      
      const recommendedIds = result.recommendations.map(r => r.property_id);
      const recommendedProperties = allProperties.filter(p => 
        recommendedIds.includes(p.id)
      );
      
      if (recommendedProperties.length > 0) {
        setFilteredProperties(recommendedProperties);
        setSearchQuery("AI Recommendations");
        
        alert(`✨ I've curated ${recommendedProperties.length} personalized recommendations just for you based on your profile and preferences!`);
      } else {
        alert("No personalized recommendations available at the moment. Please try searching by location.");
      }
      
    } catch (error) {
      console.error('❌ AI Recommendations error:', error);
      alert("Failed to get AI recommendations. Please try again.");
    } finally {
      setIsLoadingAI(false);
    }
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
      
    } catch (error) {
      console.error("Failed to update wishlist:", error);
      alert("Failed to update wishlist. Please try again.");
      await loadUserAndWishlist();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
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
                <Badge variant="outline" className="bg-purple-50 text-purple-700 flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  AI Personalized
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { clearCache(); handleSearch(); }}
              className="text-slate-500 hover:text-slate-700"
            >
              <RefreshCw className="w-4 h-4 mr-1" />
              Refresh
            </Button>
          </div>
        )}

        {isLoading && (
          <div className="text-center my-8">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent mb-4"></div>
            <p className="text-slate-600 font-semibold">
              {isLoadingAI ? '✨ AI is analyzing your preferences...' : 'Loading properties...'}
            </p>
          </div>
        )}

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-red-900">Search Error</p>
                <p className="text-sm text-red-700 mt-1">{error}</p>
              </div>
            </div>
          </motion.div>
        )}

        <div className="flex flex-col lg:flex-row gap-8">
          <div className="lg:w-80 flex-shrink-0">
            <PropertyFilters
              filters={filters}
              onFiltersChange={setFilters}
              isOpen={showFilters}
              onToggle={() => setShowFilters(!showFilters)}
            />
          </div>

          <div className="flex-1">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-slate-900">
                {isLoading ? "Loading properties..." : `${filteredProperties.length} Properties Found`}
              </h2>
              {searchQuery && (
                <div className="text-slate-600">
                  {searchQuery === "AI Recommendations" ? (
                    <span className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-purple-500" />
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
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
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
                <h3 className="text-2xl font-bold text-slate-900 mb-2">No properties match your filters</h3>
                <p className="text-slate-600 mb-4">
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
                <h3 className="text-2xl font-bold text-slate-900 mb-2">No properties found</h3>
                <p className="text-slate-600 mb-4">Try searching for a different location or generate sample data from the Admin panel.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}