import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Label } from '@/components/ui/label';
import {
  Car, MapPin, Users, ChevronDown, ChevronRight, AlertCircle, Sparkles, ArrowLeft,
} from 'lucide-react';
import VehicleCard from '@/components/ride/VehicleCard';
import { CITIES, CATEGORIES, categoryLabel, effectiveCategory } from '@/config/rides';

// UrbanStays Drive — browse.
//
// The order of these steps is the point, not decoration. Vehicles are physical
// objects in one city, and until the whole fleet is under real-time control we
// cannot let someone in Abuja fall in love with a Lagos car. So city is a gate,
// not a filter: with no city chosen, NO vehicle renders anywhere on the page.
//
//   city  ->  category  ->  car  ->  booking details
//
// State lives in the URL rather than useState so that back/forward work, links
// are shareable, and — the one that actually bites — the add-on chain carrying
// property_booking_id survives every step. A useState version would drop it the
// moment someone used the browser back button.

const SEAT_OPTIONS = [
  { value: 'any', label: 'Any size' },
  { value: '2', label: '2+ seats' },
  { value: '4', label: '4+ seats' },
  { value: '6', label: '6+ seats' },
  { value: '8', label: '8+ seats' },
];

const LAST_CITY_KEY = 'urbanstays.drive.lastCity';

// Compact pill-style filter trigger — same visual language as PropertyFiltersBar
function FilterChip({ icon: Icon, label, isActive, children }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`h-10 rounded-full px-4 gap-2 font-medium transition-colors whitespace-nowrap ${
            isActive
              ? 'bg-slate-900 text-white border-slate-900 hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 dark:border-white'
              : 'bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-amber-400'
          }`}
        >
          {Icon && <Icon className="w-4 h-4" />}
          {label}
          <ChevronDown className="w-3.5 h-3.5 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl">
        {children}
      </PopoverContent>
    </Popover>
  );
}

const shell = 'min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8';

export default function PlanTripPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [vehicles, setVehicles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [seats, setSeats] = useState('any');
  const [lastCity, setLastCity] = useState('');

  // Carried in from Bookings' "Add a Ride". Nothing here reads it except the
  // links out — but it has to survive every step or the ride silently becomes
  // a standalone request needing approval.
  const addOnBookingId = searchParams.get('property_booking_id') || '';

  // An unrecognised value is treated as absent rather than shown as an empty
  // result — a stale or hand-edited link should land on the chooser, not on a
  // dead end saying "0 vehicles in Atlantis".
  const rawCity = searchParams.get('city') || '';
  const city = CITIES.includes(rawCity) ? rawCity : '';
  const rawCategory = searchParams.get('category') || '';
  const category = CATEGORIES.some((c) => c.value === rawCategory) ? rawCategory : '';

  const go = (next) => {
    const params = new URLSearchParams();
    const merged = { city, category, ...next };
    if (merged.city) params.set('city', merged.city);
    if (merged.category) params.set('category', merged.category);
    if (addOnBookingId) params.set('property_booking_id', addOnBookingId);
    setSearchParams(params);
  };

  useEffect(() => {
    try {
      setLastCity(window.localStorage.getItem(LAST_CITY_KEY) || '');
    } catch {
      // Private browsing or blocked storage — the shortcut is a convenience.
      setLastCity('');
    }
  }, []);

  useEffect(() => {
    if (!city) return;
    try {
      window.localStorage.setItem(LAST_CITY_KEY, city);
    } catch {
      // Not being able to remember the city is not worth surfacing.
    }
  }, [city]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        // Pull active + admin-approved vehicles only. Filtering by these flags
        // server-side keeps inactive draft rows out of the public browse list.
        const rows = await base44.entities.Vehicle.filter({
          active: true,
          admin_approved: true,
        }, '-created_date', 100);
        if (!cancelled) setVehicles(rows || []);
      } catch (err) {
        console.error('Failed to load vehicles:', err);
        if (!cancelled) setError(err?.message || 'Could not load vehicles');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const inCity = useMemo(
    () => (city ? vehicles.filter((v) => v.city === city) : []),
    [vehicles, city],
  );

  const filtered = useMemo(() => inCity.filter((v) => {
    if (category && effectiveCategory(v) !== category) return false;
    if (seats !== 'any' && (v.max_passengers || 0) < Number(seats)) return false;
    return true;
  }), [inCity, category, seats]);

  const cityCounts = useMemo(() => {
    const m = new Map(CITIES.map((c) => [c, 0]));
    for (const v of vehicles) if (m.has(v.city)) m.set(v.city, m.get(v.city) + 1);
    return m;
  }, [vehicles]);

  const categoryCounts = useMemo(() => {
    const m = new Map(CATEGORIES.map((c) => [c.value, 0]));
    for (const v of inCity) {
      const c = effectiveCategory(v);
      if (m.has(c)) m.set(c, m.get(c) + 1);
    }
    return m;
  }, [inCity]);

  const seatsLabel = SEAT_OPTIONS.find((s) => s.value === seats)?.label || 'Any size';

  const addOnBanner = addOnBookingId && (
    <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-3 sm:p-4">
      <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
      <p className="text-sm text-emerald-900 dark:text-emerald-100">
        <span className="font-semibold">Adding a ride to your stay.</span>{' '}
        Pick a vehicle and you&apos;ll go straight to payment — no waiting on approval.
      </p>
    </div>
  );

  const errorBanner = error && (
    <div className="mb-6 p-4 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
      <div>
        <p className="font-semibold text-red-900 dark:text-red-200">Couldn&apos;t load vehicles</p>
        <p className="text-sm text-red-700 dark:text-red-300 mt-1">{error}</p>
      </div>
    </div>
  );

  // ── Step 1: city ─────────────────────────────────────────────────────────
  if (!city) {
    return (
      <div className={shell}>
        <div className="max-w-4xl mx-auto">
          {addOnBanner}
          {errorBanner}

          <div className="text-center mb-8 sm:mb-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-100 dark:bg-amber-900/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200 text-xs font-semibold mb-4">
              <Sparkles className="w-3 h-3" />
              Chauffeur-driven
            </div>
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-2 tracking-tight">
              Where do you need a ride?
            </h1>
            <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-lg font-medium">
              Choose your city. Choose your car. Choose your time.
            </p>
          </div>

          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {CITIES.map((c) => {
              const count = cityCounts.get(c) || 0;
              return (
                <button
                  key={c}
                  onClick={() => go({ city: c, category: '' })}
                  className="group text-left bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 shadow-sm hover:shadow-xl hover:border-amber-400 transition-all hover:-translate-y-0.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <MapPin className="w-4 h-4 text-amber-500 flex-shrink-0" />
                        <span className="text-lg font-bold text-slate-900 dark:text-white truncate">{c}</span>
                      </div>
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        {isLoading
                          ? 'Checking availability…'
                          : count === 0
                            ? 'No vehicles yet'
                            : `${count} vehicle${count === 1 ? '' : 's'} available`}
                      </p>
                    </div>
                    <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-amber-500 transition-colors flex-shrink-0" />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Offered, never applied automatically — skipping the step the client
              asked for would defeat the point of having it. */}
          {lastCity && CITIES.includes(lastCity) && (
            <div className="mt-6 text-center">
              <Button variant="ghost" onClick={() => go({ city: lastCity, category: '' })} className="rounded-xl">
                Continue in {lastCity}
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const cityHeader = (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <MapPin className="w-4 h-4 text-amber-500" />
        <span>Showing vehicles in <span className="font-semibold text-slate-900 dark:text-white">{city}</span></span>
      </div>
      <Button variant="outline" size="sm" onClick={() => go({ city: '', category: '' })} className="rounded-full h-9">
        Change city
      </Button>
    </div>
  );

  // ── Step 2: category ─────────────────────────────────────────────────────
  if (!category) {
    return (
      <div className={shell}>
        <div className="max-w-4xl mx-auto">
          {addOnBanner}
          {errorBanner}
          {cityHeader}

          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-1 tracking-tight">
            What type of vehicle?
          </h1>
          <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-base mb-6">
            Every option comes with a vetted driver.
          </p>

          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            {CATEGORIES.map((c) => {
              const count = categoryCounts.get(c.value) || 0;
              const none = !isLoading && count === 0;
              return (
                <button
                  key={c.value}
                  disabled={none}
                  onClick={() => go({ category: c.value })}
                  className={`group text-left border rounded-2xl p-4 sm:p-5 transition-all ${
                    none
                      ? 'bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 opacity-60 cursor-not-allowed'
                      : 'bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-lg hover:border-amber-400 hover:-translate-y-0.5'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold text-slate-900 dark:text-white">{c.label}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{c.blurb}</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-1.5">
                        {isLoading
                          ? '…'
                          : none
                            ? `None in ${city} right now`
                            : `${count} available`}
                      </p>
                    </div>
                    {!none && (
                      <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-amber-500 transition-colors flex-shrink-0" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {!isLoading && inCity.length === 0 && (
            <div className="text-center py-12">
              <Car className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
                No vehicles in {city} yet
              </h3>
              <p className="text-slate-600 dark:text-slate-300 mb-4">
                We&apos;re still adding cars here — try another city.
              </p>
              <Button variant="outline" onClick={() => go({ city: '', category: '' })} className="rounded-xl">
                Choose a different city
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Step 3: the vehicles ─────────────────────────────────────────────────
  return (
    <div className={shell}>
      <div className="max-w-7xl mx-auto">
        {addOnBanner}
        {errorBanner}
        {cityHeader}

        <div className="mb-6 flex flex-wrap items-center gap-2 sm:gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => go({ category: '' })}
            className="h-10 rounded-full px-3 text-slate-600 dark:text-slate-300"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            All categories
          </Button>

          <FilterChip icon={Users} label={seatsLabel} isActive={seats !== 'any'}>
            <div>
              <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">Capacity</Label>
              <div className="grid grid-cols-1 gap-2">
                {SEAT_OPTIONS.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => setSeats(s.value)}
                    className={`text-sm rounded-lg px-3 py-2 border transition-colors text-left ${
                      seats === s.value
                        ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-amber-400'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </FilterChip>
        </div>

        <div className="mb-6">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
            {isLoading
              ? 'Loading vehicles…'
              : `${filtered.length} ${categoryLabel(category)} ${filtered.length === 1 ? 'vehicle' : 'vehicles'} in ${city}`}
          </h1>
        </div>

        {isLoading && (
          <div className="grid gap-5 sm:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="aspect-[4/3] bg-slate-200 dark:bg-slate-800 rounded-2xl mb-3" />
                <div className="h-5 bg-slate-200 dark:bg-slate-800 rounded w-3/4 mb-2" />
                <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-1/2" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && filtered.length > 0 && (
          <AnimatePresence>
            <div className="grid gap-5 sm:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((vehicle, index) => (
                <motion.div
                  key={vehicle.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ delay: Math.min(index * 0.05, 0.3) }}
                >
                  <VehicleCard vehicle={vehicle} propertyBookingId={addOnBookingId} />
                </motion.div>
              ))}
            </div>
          </AnimatePresence>
        )}

        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-16">
            <Car className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
              {seats !== 'any'
                ? `No ${categoryLabel(category)} vehicle in ${city} seats that many`
                : `No ${categoryLabel(category)} vehicles in ${city} right now`}
            </h3>
            <p className="text-slate-600 dark:text-slate-300 mb-4">Try another category or capacity.</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {seats !== 'any' && (
                <Button variant="outline" onClick={() => setSeats('any')} className="rounded-xl">
                  Any capacity
                </Button>
              )}
              <Button variant="outline" onClick={() => go({ category: '' })} className="rounded-xl">
                All categories
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
