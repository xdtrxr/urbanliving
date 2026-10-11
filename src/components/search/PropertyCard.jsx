
import React, { useState } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heart, Star, MapPin, Users, Bed, Bath, Wifi, Car, Utensils, Shield } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { cardPricing } from "@/config/stays";

const amenityIcons = {
  wifi: Wifi,
  parking: Car,
  kitchen: Utensils,
};

// App is NGN-only — every entry resolves to ₦ so guests never see $/€/£.
const currencySymbols = {
  NGN: '₦',
  USD: '₦',
  EUR: '₦',
  GBP: '₦',
  CAD: '₦'
};

export default function PropertyCard({ property, onToggleWishlist, isWishlisted = false, stay }) {
  const { isAuthenticated } = useAuth();
  const [isUpdating, setIsUpdating] = useState(false);

  const mainImage = property.images?.[0] || 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800';
  const currencySymbol = currencySymbols[property.currency] || '₦';
  // A search attaches the option(s) it matched (propertyService); the card
  // then shows that option's price and guests, and links straight to it.
  // `stay` is what the guest picked on the search page (dates as YYYY-MM-DD
  // and a party size). It travels with every link out of the card, so nobody
  // types it again at checkout, and it decides whether a seasonal rate is
  // worth mentioning here.
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const dated = !!stay && DAY.test(stay.checkIn || '') && DAY.test(stay.checkOut || '') && stay.checkIn < stay.checkOut;
  const shown = cardPricing(property, dated ? stay : null, new Date().toISOString().slice(0, 10));
  const optionQuery = `${shown.openOn ? `&bedrooms=${shown.openOn}` : ''}${dated ? `&checkIn=${stay.checkIn}&checkOut=${stay.checkOut}` : ''}${stay && Number(stay.guests) > 0 ? `&guests=${Number(stay.guests)}` : ''}`;

  // The parent owns the wishlist write — this card just emits the click.
  // (Previously both this card AND the parent wrote to user.wishlist on every
  // click, the second write toggled the value back, and the heart never
  // actually changed state in the UI.)
  const handleToggleWishlist = async () => {
    if (isUpdating) return;
    if (!isAuthenticated) {
      window.location.href = `/login?from_url=${encodeURIComponent(window.location.href)}`;
      return;
    }
    if (!onToggleWishlist) return;
    setIsUpdating(true);
    try {
      await onToggleWishlist(property.id);
    } catch (error) {
      console.error('Failed to update wishlist:', error);
      alert('Failed to update wishlist. Please try again.');
    }
    setIsUpdating(false);
  };

  return (
    <Card className="group hover:shadow-2xl transition-all duration-500 border-0 rounded-3xl overflow-hidden bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm">
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
          className={`absolute top-4 right-4 rounded-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm hover:bg-white dark:bg-slate-900 transition-all duration-300 ${
            isWishlisted ? 'text-red-500 dark:text-red-400' : 'text-slate-600 dark:text-slate-300 hover:text-red-500'
          }`}
        >
          {isUpdating ? (
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-slate-300 border-t-red-500" />
          ) : (
            <Heart className={`w-5 h-5 ${isWishlisted ? 'fill-current' : ''}`} />
          )}
        </Button>

        <div className="absolute bottom-4 left-4 flex flex-col gap-2">
          <Badge className="bg-white/95 dark:bg-slate-900/95 text-slate-900 dark:text-white font-semibold px-3 py-1 rounded-full">
            {shown.from ? 'From ' : ''}{currencySymbol}{shown.price.toLocaleString()}/night
          </Badge>
          {property.caution_fee > 0 && (
            <Badge className="bg-amber-100/95 dark:bg-amber-900/60 text-amber-900 dark:text-amber-100 font-medium px-3 py-1 rounded-full flex items-center gap-1">
              <Shield className="w-3 h-3" />
              {currencySymbols[property.currency] || '₦'}{property.caution_fee.toLocaleString()} caution
            </Badge>
          )}
        </div>
      </div>

      <CardContent className="p-6">
        <div className="space-y-4">
          <div>
            <h3 className="font-bold text-xl text-slate-900 dark:text-white group-hover:text-amber-600 transition-colors duration-300 line-clamp-1">
              {property.title}
            </h3>
            <div className="flex items-center gap-1 text-slate-500 dark:text-slate-400 mt-1">
              <MapPin className="w-4 h-4" />
              <span className="text-sm font-medium">
                {property.location?.city}, {property.location?.country}
              </span>
            </div>
            {shown.note && (
              <p className={`text-sm mt-2 ${shown.matched ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-slate-600 dark:text-slate-300'}`}>
                {shown.note}
              </p>
            )}
            {shown.season && (
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                {shown.season.name}: {currencySymbol}{shown.season.rate.toLocaleString()}/night
                {shown.season.of > 0 ? ` for ${shown.season.nights} of your ${shown.season.of} night${shown.season.of === 1 ? '' : 's'}` : ' at the moment'}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-300">
              <div className="flex items-center gap-1">
                <Users className="w-4 h-4" />
                <span className="text-sm font-medium">{shown.guests}</span>
              </div>
              <div className="flex items-center gap-1">
                <Bed className="w-4 h-4" />
                <span className="text-sm font-medium">{shown.bedrooms}</span>
              </div>
              <div className="flex items-center gap-1">
                <Bath className="w-4 h-4" />
                <span className="text-sm font-medium">{property.bathrooms || 1}</span>
              </div>
            </div>

            {property.rating > 0 && (
              <div className="flex items-center gap-1">
                <Star className="w-4 h-4 text-amber-400 fill-current" />
                <span className="font-semibold text-slate-900 dark:text-white">{property.rating}</span>
                <span className="text-slate-500 dark:text-slate-400 text-sm">({property.reviews_count || 0})</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {property.amenities?.slice(0, 3).map((amenity) => {
              const Icon = amenityIcons[amenity];
              return Icon ? (
                <div key={amenity} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg">
                  <Icon className="w-4 h-4 text-slate-600 dark:text-slate-300" />
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
            <Link to={`${createPageUrl('Property')}?id=${property.id}${optionQuery}`}>
              <Button variant="outline" className="w-full rounded-xl transition-all duration-300 hover:shadow-lg">
                View Details
              </Button>
            </Link>
            
            {isAuthenticated ? (
              <Link to={`${createPageUrl('Checkout')}?property=${property.id}${optionQuery}`}>
                <Button className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold py-3 rounded-xl transition-all duration-300 hover:shadow-lg dark:from-white dark:to-slate-200 dark:text-slate-900">
                  Book Now
                </Button>
              </Link>
            ) : (
              <Link to={`/login?from_url=${encodeURIComponent(`${window.location.origin}${createPageUrl('Property')}?id=${property.id}${optionQuery}`)}`}>
                <Button className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold py-3 rounded-xl transition-all duration-300 hover:shadow-lg dark:from-white dark:to-slate-200 dark:text-slate-900">
                  Sign in to Book
                </Button>
              </Link>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
