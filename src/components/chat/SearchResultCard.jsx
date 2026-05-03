import React, { useState, useEffect } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heart, Star, MapPin, Users, Bed, Bath, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { User } from "@/entities/User";

const currencySymbols = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    NGN: '₦',
    CAD: 'C$'
};

export default function SearchResultCard({ property, user: initialUser }) {
  const [user, setUser] = useState(initialUser);
  const [isWishlisted, setIsWishlisted] = useState(false);
  const [isUpdatingWishlist, setIsUpdatingWishlist] = useState(false);

  const mainImage = property.images?.[0] || 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=400';
  const currencySymbol = currencySymbols[property.currency] || '$';

  // Update wishlist status when user prop changes
  useEffect(() => {
    if (user?.wishlist) {
      setIsWishlisted(user.wishlist.includes(property.id));
    }
  }, [user, property.id]);

  const handleToggleWishlist = async () => {
    if (!user) {
      alert("Please log in to manage your wishlist.");
      return;
    }
    
    setIsUpdatingWishlist(true);
    try {
      // Get fresh user data
      const freshUserData = await User.me();
      const currentWishlist = freshUserData.wishlist || [];
      
      const newWishlist = isWishlisted
        ? currentWishlist.filter(id => id !== property.id)
        : [...currentWishlist, property.id];
      
      await User.updateMyUserData({ wishlist: newWishlist });
      
      // Update local states
      setUser({ ...freshUserData, wishlist: newWishlist });
      setIsWishlisted(!isWishlisted);
      
    } catch (error) {
      console.error("Failed to update wishlist:", error);
      alert("Failed to update wishlist. Please try again.");
    }
    setIsUpdatingWishlist(false);
  };

  return (
    <Card className="overflow-hidden border-slate-200 shadow-sm hover:shadow-md transition-all duration-300">
      <div className="flex">
        <div className="w-32 h-24 flex-shrink-0">
          <img 
            src={mainImage}
            alt={property.title}
            className="w-full h-full object-cover"
          />
        </div>
        <CardContent className="flex-1 p-3">
          <div className="space-y-2">
            <div className="flex justify-between items-start">
              <h3 className="font-semibold text-slate-900 text-sm line-clamp-1">
                {property.title}
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggleWishlist}
                disabled={isUpdatingWishlist}
                className={`p-1 h-auto ${
                  isWishlisted ? 'text-red-500' : 'text-slate-400 hover:text-red-500'
                }`}
              >
                {isUpdatingWishlist ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-slate-300 border-t-red-500" />
                ) : (
                  <Heart className={`w-4 h-4 ${isWishlisted ? 'fill-current' : ''}`} />
                )}
              </Button>
            </div>
            
            <div className="flex items-center gap-1 text-slate-500 text-xs">
              <MapPin className="w-3 h-3" />
              <span>{property.location?.city}, {property.location?.country}</span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-slate-600 text-xs">
                <div className="flex items-center gap-1">
                  <Users className="w-3 h-3" />
                  <span>{property.max_guests}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Bed className="w-3 h-3" />
                  <span>{property.bedrooms || 1}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Bath className="w-3 h-3" />
                  <span>{property.bathrooms || 1}</span>
                </div>
              </div>

              {property.rating && property.rating > 0 && (
                <div className="flex items-center gap-1">
                  <Star className="w-3 h-3 text-amber-400 fill-current" />
                  <span className="text-xs font-semibold text-slate-900">{property.rating}</span>
                </div>
              )}
            </div>

            <div className="flex justify-between items-center pt-1">
              <Badge className="bg-slate-100 text-slate-700 text-xs font-semibold">
                {currencySymbol}{property.price_per_night}/night
              </Badge>
              <Link to={createPageUrl(`Property?id=${property.id}`)}>
                <Button variant="outline" size="sm" className="text-xs px-2 py-1 h-auto">
                  <ExternalLink className="w-3 h-3 mr-1" />
                  View
                </Button>
              </Link>
            </div>
          </div>
        </CardContent>
      </div>
    </Card>
  );
}