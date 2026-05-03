
import React, { useState } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heart, Star, MapPin, Users, Bed, Bath, Wifi, Car, Utensils, Shield } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";

const amenityIcons = {
  wifi: Wifi,
  parking: Car,
  kitchen: Utensils,
};

const currencySymbols = {
  NGN: '₦',
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'C$'
};

export default function PropertyCard({ property, onToggleWishlist, isWishlisted = false }) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [localIsWishlisted, setLocalIsWishlisted] = useState(isWishlisted);

  const mainImage = property.images?.[0] || 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800';
  const currencySymbol = currencySymbols[property.currency] || '₦';

  const handleToggleWishlist = async () => {
    if (isUpdating) return;
    
    setIsUpdating(true);
    
    try {
      const userData = await base44.auth.me();
      const currentWishlist = userData.wishlist || [];
      
      const newWishlist = localIsWishlisted
        ? currentWishlist.filter(id => id !== property.id)
        : [...currentWishlist, property.id];
      
      await base44.auth.updateMe({ wishlist: newWishlist });
      
      setLocalIsWishlisted(!localIsWishlisted);
      
      if (onToggleWishlist) {
        onToggleWishlist(property.id);
      }
      
    } catch (error) {
      console.error("Failed to update wishlist:", error);
      alert("Failed to update wishlist. Please try again.");
    }
    
    setIsUpdating(false);
  };

  return (
    <Card className="group hover:shadow-2xl transition-all duration-500 border-0 rounded-3xl overflow-hidden bg-white/90 backdrop-blur-sm">
      <div className="relative">
        <img 
          src={mainImage}
          alt={property.title}
          className="w-full h-64 object-cover group-hover:scale-105 transition-transform duration-700"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent" />
        
        <Button
          variant="ghost"
          size="icon"
          onClick={handleToggleWishlist}
          disabled={isUpdating}
          className={`absolute top-4 right-4 rounded-full bg-white/90 backdrop-blur-sm hover:bg-white transition-all duration-300 ${
            localIsWishlisted ? 'text-red-500' : 'text-slate-600 hover:text-red-500'
          }`}
        >
          {isUpdating ? (
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-slate-300 border-t-red-500" />
          ) : (
            <Heart className={`w-5 h-5 ${localIsWishlisted ? 'fill-current' : ''}`} />
          )}
        </Button>

        <div className="absolute bottom-4 left-4 flex flex-col gap-2">
          <Badge className="bg-white/95 text-slate-900 font-semibold px-3 py-1 rounded-full">
            {currencySymbol}{property.price_per_night.toLocaleString()}/night
          </Badge>
          {property.caution_fee > 0 && (
            <Badge className="bg-amber-100/95 text-amber-900 font-medium px-3 py-1 rounded-full flex items-center gap-1">
              <Shield className="w-3 h-3" />
              {currencySymbols[property.currency] || '₦'}{property.caution_fee.toLocaleString()} caution
            </Badge>
          )}
        </div>
      </div>

      <CardContent className="p-6">
        <div className="space-y-4">
          <div>
            <h3 className="font-bold text-xl text-slate-900 group-hover:text-amber-600 transition-colors duration-300 line-clamp-1">
              {property.title}
            </h3>
            <div className="flex items-center gap-1 text-slate-500 mt-1">
              <MapPin className="w-4 h-4" />
              <span className="text-sm font-medium">
                {property.location?.city}, {property.location?.country}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 text-slate-600">
              <div className="flex items-center gap-1">
                <Users className="w-4 h-4" />
                <span className="text-sm font-medium">{property.max_guests}</span>
              </div>
              <div className="flex items-center gap-1">
                <Bed className="w-4 h-4" />
                <span className="text-sm font-medium">{property.bedrooms || 1}</span>
              </div>
              <div className="flex items-center gap-1">
                <Bath className="w-4 h-4" />
                <span className="text-sm font-medium">{property.bathrooms || 1}</span>
              </div>
            </div>

            {property.rating && property.rating > 0 && (
              <div className="flex items-center gap-1">
                <Star className="w-4 h-4 text-amber-400 fill-current" />
                <span className="font-semibold text-slate-900">{property.rating}</span>
                <span className="text-slate-500 text-sm">({property.reviews_count || 0})</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {property.amenities?.slice(0, 3).map((amenity) => {
              const Icon = amenityIcons[amenity];
              return Icon ? (
                <div key={amenity} className="p-2 bg-slate-100 rounded-lg">
                  <Icon className="w-4 h-4 text-slate-600" />
                </div>
              ) : null;
            })}
            {property.amenities?.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{property.amenities.length - 3} more
              </Badge>
            )}
          </div>

          <div className="space-y-2">
            <Link to={createPageUrl(`Property?id=${property.id}`)}>
              <Button variant="outline" className="w-full rounded-xl transition-all duration-300 hover:shadow-lg">
                View Details
              </Button>
            </Link>
            
            <Link to={createPageUrl(`Checkout?property=${property.id}&checkIn=2024-02-15&checkOut=2024-02-18&guests=2`)}>
              <Button className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold py-3 rounded-xl transition-all duration-300 hover:shadow-lg">
                Book Now
              </Button>
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
