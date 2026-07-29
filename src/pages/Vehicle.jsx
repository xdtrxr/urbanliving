import React, { useState, useEffect } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft, MapPin, Users, Car, Snowflake, Wifi, Music,
  Fuel, PlayCircle, Calendar, Shield, Sparkles, CheckCircle,
} from 'lucide-react';
import { createPageUrl } from '@/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/lib/AuthContext';
import MediaLightbox from '@/components/media/MediaLightbox';

const AMENITY_LABELS = {
  air_conditioning: { label: 'Air conditioning', icon: Snowflake },
  leather_seats: { label: 'Leather seats', icon: Car },
  wifi: { label: 'WiFi', icon: Wifi },
  child_seat: { label: 'Child seat available', icon: Shield },
  bottled_water: { label: 'Bottled water', icon: Sparkles },
  sound_system: { label: 'Premium sound', icon: Music },
  tinted_windows: { label: 'Tinted windows', icon: Car },
  executive_partition: { label: 'Executive partition', icon: Car },
};

const FUEL_POLICY_LABELS = {
  fuel_included: 'Fuel included',
  guest_pays_fuel: 'Guest pays for fuel',
  fuel_capped: 'Fuel capped daily',
};

const DURATION_TIERS = [
  { id: '12hr', label: '12 hours', priceKey: 'price_12hr_ngn', suffix: 'per 12 hours' },
  { id: '24hr', label: '24 hours', priceKey: 'price_24hr_ngn', suffix: 'per day' },
];

export default function VehiclePage() {
  const { isAuthenticated } = useAuth();
  const [vehicle, setVehicle] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [media, setMedia] = useState([]);
  const [selectedMedia, setSelectedMedia] = useState(null);
  const [selectedTier, setSelectedTier] = useState('24hr');
  const [multiDayCount, setMultiDayCount] = useState(2);
  // Lightbox state — full-screen gallery viewer with swipe / arrow navigation.
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const location = useLocation();

  useEffect(() => {
    const loadVehicle = async () => {
      const params = new URLSearchParams(location.search);
      const vehicleId = params.get('id');
      if (!vehicleId) {
        setIsLoading(false);
        return;
      }
      try {
        const data = await base44.entities.Vehicle.get(vehicleId);
        setVehicle(data);

        const images = (data.images || []).map((url) => ({ type: 'image', url }));
        const videos = (data.videos || []).map((url) => ({ type: 'video', url }));
        const combined = [...images, ...videos];
        setMedia(combined);
        if (combined.length > 0) setSelectedMedia(combined[0]);
      } catch (error) {
        console.error('Failed to fetch vehicle:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadVehicle();
  }, [location.search]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-16 w-16 border-4 border-slate-900 border-t-transparent"></div>
      </div>
    );
  }

  if (!vehicle) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-8 text-center">
        <Card className="max-w-md w-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-xl p-12">
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-4">Vehicle Not Found</h2>
          <p className="text-slate-600 dark:text-slate-300 mb-6">The vehicle you&apos;re looking for doesn&apos;t exist or has been removed.</p>
          <Link to={createPageUrl('PlanTrip')}>
            <Button>Back to all vehicles</Button>
          </Link>
        </Card>
      </div>
    );
  }

  // Pricing calc — what shows in the right-hand sticky card
  const tier12 = vehicle.price_12hr_ngn || 0;
  const tier24 = vehicle.price_24hr_ngn || 0;
  const extraDay = vehicle.price_per_extra_day_ngn || tier24;
  const multiDayTotal = tier24 + (multiDayCount - 1) * extraDay;

  const computedTotal = selectedTier === '12hr'
    ? tier12
    : selectedTier === '24hr'
      ? tier24
      : selectedTier === 'multi_day'
        ? multiDayTotal
        : tier24;

  const checkoutHref = `${createPageUrl('RideCheckout')}?vehicle=${vehicle.id}&tier=${selectedTier}${
    selectedTier === 'multi_day' ? `&days=${multiDayCount}` : ''
  }`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <Link to={createPageUrl('PlanTrip')}>
          <Button variant="ghost" className="mb-6 flex items-center gap-2 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:text-white">
            <ArrowLeft className="w-4 h-4" />
            Back to all vehicles
          </Button>
        </Link>

        <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg p-4 sm:p-6 md:p-8">
          {/* Media gallery — hero opens the full-screen lightbox; thumbnails
              jump to a specific item inside it. No more click-to-swap. */}
          <div className="mb-6 sm:mb-8">
            <button
              type="button"
              onClick={() => {
                const heroIdx = selectedMedia
                  ? media.findIndex((m) => m.url === selectedMedia.url)
                  : 0;
                setLightboxIndex(Math.max(0, heroIdx));
                setLightboxOpen(true);
              }}
              className="group relative block w-full aspect-video bg-slate-200 rounded-2xl overflow-hidden shadow-lg cursor-zoom-in"
              aria-label="Open photo gallery"
            >
              <AnimatePresence mode="wait">
                {selectedMedia?.type === 'image' && (
                  <motion.img
                    key={selectedMedia.url}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.3 }}
                    src={selectedMedia.url}
                    alt={vehicle.name}
                    className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                  />
                )}
                {selectedMedia?.type === 'video' && (
                  <motion.video
                    key={selectedMedia.url}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.3 }}
                    src={selectedMedia.url}
                    className="w-full h-full object-cover"
                    muted
                    loop
                    playsInline
                  >
                    Your browser does not support the video tag.
                  </motion.video>
                )}
              </AnimatePresence>
              {/* Photo count overlay so users know there's more */}
              {media.length > 1 && (
                <div className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-xs font-semibold">
                  <PlayCircle className="w-3.5 h-3.5" />
                  {media.length} items
                </div>
              )}
            </button>

            {media.length > 1 && (
              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-3 mt-4">
                {media.map((item, index) => (
                  <button
                    type="button"
                    key={index}
                    onClick={() => {
                      setLightboxIndex(index);
                      setLightboxOpen(true);
                      setSelectedMedia(item);
                    }}
                    className={`relative aspect-square rounded-lg overflow-hidden ring-2 transition-all duration-200 ${
                      selectedMedia?.url === item.url ? 'ring-amber-500 ring-offset-2' : 'ring-transparent hover:ring-amber-300'
                    }`}
                  >
                    <img
                      src={item.type === 'image' ? item.url : 'https://static.thenounproject.com/png/11204-200.png'}
                      alt={`${vehicle.name} thumbnail ${index + 1}`}
                      className="w-full h-full object-cover"
                    />
                    {item.type === 'video' && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <PlayCircle className="w-6 h-6 text-white" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <MediaLightbox
            media={media}
            startIndex={lightboxIndex}
            open={lightboxOpen}
            onClose={() => setLightboxOpen(false)}
          />

          <CardHeader className="p-0 mb-6">
            <div className="flex flex-col md:flex-row justify-between items-start gap-4">
              <div className="min-w-0">
                <CardTitle className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-2 break-words">
                  {vehicle.name}
                </CardTitle>
                <p className="text-slate-600 dark:text-slate-300 mb-3">
                  {vehicle.brand}{vehicle.model_year ? ` · ${vehicle.model_year}` : ''}
                  {vehicle.vehicle_type ? ` · ${vehicle.vehicle_type.replace(/_/g, ' ')}` : ''}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-300 text-sm">
                  {vehicle.city && (
                    <Badge variant="outline" className="border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200">
                      <MapPin className="w-3 h-3 mr-1" />
                      {vehicle.city}
                    </Badge>
                  )}
                  {vehicle.max_passengers > 0 && (
                    <Badge variant="outline" className="border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200">
                      <Users className="w-3 h-3 mr-1" />
                      {vehicle.max_passengers} seats
                    </Badge>
                  )}
                  {vehicle.driver_included !== false && (
                    <Badge variant="outline" className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200">
                      <CheckCircle className="w-3 h-3 mr-1" />
                      Driver included
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              {/* Left: description + amenities + driver */}
              <div className="lg:col-span-2 space-y-8">
                {vehicle.description && (
                  <div>
                    <h3 className="font-bold text-xl text-slate-800 dark:text-slate-100 mb-3">About this vehicle</h3>
                    <p className="text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line">{vehicle.description}</p>
                  </div>
                )}

                {/* Amenities */}
                {(vehicle.amenities?.length || 0) > 0 && (
                  <div>
                    <h3 className="font-bold text-xl text-slate-800 dark:text-slate-100 mb-4">What&apos;s included</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {vehicle.amenities.map((id) => {
                        const meta = AMENITY_LABELS[id];
                        const Icon = meta?.icon || Sparkles;
                        return (
                          <div key={id} className="flex items-center gap-3 bg-slate-50 rounded-xl px-4 py-3">
                            <Icon className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                            <span className="text-sm text-slate-700 dark:text-slate-200">
                              {meta?.label || id.replace(/_/g, ' ')}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Fuel + service area */}
                {(vehicle.fuel_policy || vehicle.service_area) && (
                  <div>
                    <h3 className="font-bold text-xl text-slate-800 dark:text-slate-100 mb-4">Good to know</h3>
                    <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
                      {vehicle.fuel_policy && (
                        <div className="flex items-start gap-3">
                          <Fuel className="w-5 h-5 text-slate-500 dark:text-slate-400 flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-white">{FUEL_POLICY_LABELS[vehicle.fuel_policy] || vehicle.fuel_policy}</p>
                            {vehicle.fuel_policy === 'fuel_capped' && vehicle.fuel_cap_daily_ngn ? (
                              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                Fuel covered up to ₦{vehicle.fuel_cap_daily_ngn.toLocaleString()}/day. Anything over is on you.
                              </p>
                            ) : null}
                          </div>
                        </div>
                      )}
                      {vehicle.service_area && (
                        <div className="flex items-start gap-3">
                          <MapPin className="w-5 h-5 text-slate-500 dark:text-slate-400 flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-white">Service area</p>
                            <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">{vehicle.service_area}</p>
                          </div>
                        </div>
                      )}
                      {(vehicle.pickup_locations?.length || 0) > 0 && (
                        <div className="flex items-start gap-3">
                          <MapPin className="w-5 h-5 text-slate-500 dark:text-slate-400 flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-white">Pickup areas</p>
                            <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">{vehicle.pickup_locations.join(', ')}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Driver — generic until the booking is confirmed. Drivers are
                    a pooled resource: admin assigns one from the Driver roster
                    per RideBooking, so we don't promise a specific person on
                    the vehicle detail page. Name, photo, and phone surface on
                    the Bookings page once status is confirmed + paid. */}
                <div>
                  <h3 className="font-bold text-xl text-slate-800 dark:text-slate-100 mb-4">Your driver</h3>
                  <div className="bg-slate-50 rounded-2xl p-4 sm:p-5 flex items-start gap-4">
                    <div className="w-14 h-14 rounded-full bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center flex-shrink-0">
                      <Car className="w-7 h-7 text-amber-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 dark:text-white mb-1">UrbanStays-vetted chauffeur</p>
                      <p className="text-sm text-slate-600 dark:text-slate-300">
                        Every driver in our pool is admin-vetted. We&apos;ll match you with one and share their name, photo, and phone number as soon as your booking is confirmed and paid.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: pricing + CTA */}
              <div className="lg:col-span-1">
                <Card className="bg-slate-50/80 border-slate-200 dark:border-slate-800 shadow-md rounded-2xl p-5 sm:p-6 lg:sticky lg:top-24">
                  <div className="mb-5">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                      Choose a duration
                    </p>
                    <div className="space-y-2">
                      {DURATION_TIERS.map((tier) => {
                        const price = vehicle[tier.priceKey];
                        if (!price) return null;
                        const isActive = selectedTier === tier.id;
                        return (
                          <button
                            key={tier.id}
                            onClick={() => setSelectedTier(tier.id)}
                            className={`w-full flex items-center justify-between rounded-xl border-2 px-4 py-3 text-left transition-all ${
                              isActive
                                ? 'border-slate-900 bg-white dark:bg-slate-900 shadow-sm'
                                : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 bg-white dark:bg-slate-900'
                            }`}
                          >
                            <div>
                              <p className="font-semibold text-slate-900 dark:text-white">{tier.label}</p>
                              <p className="text-xs text-slate-500 dark:text-slate-400">{tier.suffix}</p>
                            </div>
                            <p className="font-bold text-slate-900 dark:text-white">₦{price.toLocaleString()}</p>
                          </button>
                        );
                      })}

                      {vehicle.price_per_extra_day_ngn ? (
                        <button
                          onClick={() => setSelectedTier('multi_day')}
                          className={`w-full flex items-center justify-between rounded-xl border-2 px-4 py-3 text-left transition-all ${
                            selectedTier === 'multi_day'
                              ? 'border-slate-900 bg-white dark:bg-slate-900 shadow-sm'
                              : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 bg-white dark:bg-slate-900'
                          }`}
                        >
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-white">Multiple days</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">+ ₦{(vehicle.price_per_extra_day_ngn || 0).toLocaleString()} / extra day</p>
                          </div>
                          <p className="font-bold text-slate-900 dark:text-white">From ₦{tier24.toLocaleString()}</p>
                        </button>
                      ) : null}
                    </div>

                    {selectedTier === 'multi_day' && (
                      <div className="mt-4">
                        <label className="text-xs font-semibold text-slate-700 dark:text-slate-200 block mb-2">
                          How many days?
                        </label>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setMultiDayCount((n) => Math.max(2, n - 1))}
                            className="w-10 h-10 rounded-xl"
                          >
                            −
                          </Button>
                          <div className="flex-1 text-center font-bold text-lg text-slate-900 dark:text-white">
                            {multiDayCount}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setMultiDayCount((n) => Math.min(30, n + 1))}
                            className="w-10 h-10 rounded-xl"
                          >
                            +
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="border-t border-slate-200 dark:border-slate-800 pt-4 mb-5">
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="text-sm text-slate-600 dark:text-slate-300">Total</span>
                      <span className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">
                        ₦{computedTotal.toLocaleString()}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      You won&apos;t be charged until admin confirms availability.
                    </p>
                  </div>

                  {!isAuthenticated ? (
                    <Link to={`/login?from_url=${encodeURIComponent(window.location.href)}`}>
                      <Button size="lg" className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold rounded-xl">
                        Sign in to book
                      </Button>
                    </Link>
                  ) : (
                    <Link to={checkoutHref}>
                      <Button size="lg" className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold rounded-xl">
                        <Calendar className="w-4 h-4 mr-2" />
                        Check availability
                      </Button>
                    </Link>
                  )}
                </Card>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
