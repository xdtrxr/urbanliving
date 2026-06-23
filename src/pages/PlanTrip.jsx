import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Label } from '@/components/ui/label';
import { Car, MapPin, Users, ChevronDown, AlertCircle, Sparkles } from 'lucide-react';
import VehicleCard from '@/components/ride/VehicleCard';

const VEHICLE_TYPES = [
  { value: 'any', label: 'Any type' },
  { value: 'sedan', label: 'Sedan' },
  { value: 'suv', label: 'SUV' },
  { value: 'luxury_sedan', label: 'Luxury Sedan' },
  { value: 'luxury_suv', label: 'Luxury SUV' },
  { value: 'executive', label: 'Executive' },
  { value: 'van', label: 'Van' },
  { value: 'minibus', label: 'Minibus' },
];

const CITIES = [
  { value: 'any', label: 'All cities' },
  { value: 'Abuja', label: 'Abuja' },
  { value: 'Lagos', label: 'Lagos' },
];

const SEAT_OPTIONS = [
  { value: 'any', label: 'Any size' },
  { value: '2', label: '2+ seats' },
  { value: '4', label: '4+ seats' },
  { value: '6', label: '6+ seats' },
  { value: '8', label: '8+ seats' },
];

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
              ? 'bg-slate-900 text-white border-slate-900 hover:bg-slate-800'
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

export default function PlanTripPage() {
  const [vehicles, setVehicles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    city: 'any',
    type: 'any',
    seats: 'any',
  });

  useEffect(() => {
    loadVehicles();

  }, []);

  const loadVehicles = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Pull active + admin-approved vehicles only. Filtering by these flags
      // server-side keeps inactive draft rows out of the public browse list.
      const rows = await base44.entities.Vehicle.filter({
        active: true,
        admin_approved: true,
      }, '-created_date', 100);
      setVehicles(rows || []);
    } catch (err) {
      console.error('Failed to load vehicles:', err);
      setError(err?.message || 'Could not load vehicles');
    } finally {
      setIsLoading(false);
    }
  };

  // Client-side filter — vehicle inventory will be small enough for V1 that
  // pulling everything and filtering in memory is faster than round-tripping
  // each filter change to the backend.
  const filtered = vehicles.filter((v) => {
    if (filters.city !== 'any' && v.city !== filters.city) return false;
    if (filters.type !== 'any' && v.vehicle_type !== filters.type) return false;
    if (filters.seats !== 'any') {
      const min = Number(filters.seats);
      if ((v.max_passengers || 0) < min) return false;
    }
    return true;
  });

  const anyActive =
    filters.city !== 'any' || filters.type !== 'any' || filters.seats !== 'any';

  const cityLabel =
    filters.city === 'any'
      ? 'All cities'
      : CITIES.find((c) => c.value === filters.city)?.label || 'City';
  const typeLabel =
    filters.type === 'any'
      ? 'Any type'
      : VEHICLE_TYPES.find((t) => t.value === filters.type)?.label || 'Type';
  const seatsLabel =
    filters.seats === 'any'
      ? 'Any size'
      : SEAT_OPTIONS.find((s) => s.value === filters.seats)?.label || 'Seats';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Hero header — explains what this surface is for */}
        <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-3xl shadow-xl border border-slate-200 dark:border-slate-800/50 p-5 sm:p-8 mb-6 sm:mb-8">
          <div className="flex flex-col gap-5 sm:gap-6">
            <div className="text-center">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-100 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200 text-xs font-semibold mb-4">
                <Sparkles className="w-3 h-3" />
                Chauffeur-driven · Abuja & Lagos
              </div>
              <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-2 tracking-tight">
                Plan a Trip
              </h1>
              <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-lg font-medium max-w-xl mx-auto">
                Book a luxury vehicle with a vetted driver — by 12 hours, 24 hours, or multiple days.
              </p>
            </div>
          </div>
        </div>

        {/* Filter chip bar — same UX language as the property search bar */}
        <div className="mb-6 flex flex-wrap items-center gap-2 sm:gap-3">
          <FilterChip icon={MapPin} label={cityLabel} isActive={filters.city !== 'any'}>
            <div>
              <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">City</Label>
              <div className="grid grid-cols-1 gap-2">
                {CITIES.map((c) => {
                  const selected = filters.city === c.value;
                  return (
                    <button
                      key={c.value}
                      onClick={() => setFilters((f) => ({ ...f, city: c.value }))}
                      className={`text-sm rounded-lg px-3 py-2 border transition-colors text-left ${
                        selected
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-amber-400'
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </FilterChip>

          <FilterChip icon={Car} label={typeLabel} isActive={filters.type !== 'any'}>
            <div>
              <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">Vehicle type</Label>
              <div className="grid grid-cols-2 gap-2">
                {VEHICLE_TYPES.map((t) => {
                  const selected = filters.type === t.value;
                  return (
                    <button
                      key={t.value}
                      onClick={() => setFilters((f) => ({ ...f, type: t.value }))}
                      className={`text-sm rounded-lg px-3 py-2 border transition-colors text-left ${
                        selected
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-amber-400'
                      }`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </FilterChip>

          <FilterChip icon={Users} label={seatsLabel} isActive={filters.seats !== 'any'}>
            <div>
              <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">Capacity</Label>
              <div className="grid grid-cols-1 gap-2">
                {SEAT_OPTIONS.map((s) => {
                  const selected = filters.seats === s.value;
                  return (
                    <button
                      key={s.value}
                      onClick={() => setFilters((f) => ({ ...f, seats: s.value }))}
                      className={`text-sm rounded-lg px-3 py-2 border transition-colors text-left ${
                        selected
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-amber-400'
                      }`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </FilterChip>

          {anyActive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFilters({ city: 'any', type: 'any', seats: 'any' })}
              className="h-10 rounded-full text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:text-slate-100 px-3"
            >
              Clear
            </Button>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-red-900 dark:text-red-200">Couldn&apos;t load vehicles</p>
              <p className="text-sm text-red-700 dark:text-red-300 mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Results count */}
        <div className="mb-6">
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
            {isLoading
              ? 'Loading vehicles...'
              : `${filtered.length} ${filtered.length === 1 ? 'vehicle' : 'vehicles'} available`}
          </h2>
        </div>

        {/* Loading skeleton */}
        {isLoading && (
          <div className="grid gap-5 sm:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="aspect-[4/3] bg-slate-200 rounded-2xl mb-3" />
                <div className="h-5 bg-slate-200 rounded w-3/4 mb-2" />
                <div className="h-4 bg-slate-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        )}

        {/* Grid */}
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
                  <VehicleCard vehicle={vehicle} />
                </motion.div>
              ))}
            </div>
          </AnimatePresence>
        )}

        {/* Empty states */}
        {!isLoading && filtered.length === 0 && vehicles.length > 0 && (
          <div className="text-center py-16">
            <Car className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">No vehicles match these filters</h3>
            <p className="text-slate-600 dark:text-slate-300 mb-4">Try widening your search.</p>
            <Button
              variant="outline"
              onClick={() => setFilters({ city: 'any', type: 'any', seats: 'any' })}
            >
              Clear filters
            </Button>
          </div>
        )}

        {!isLoading && vehicles.length === 0 && !error && (
          <div className="text-center py-16">
            <Car className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">No vehicles listed yet</h3>
            <p className="text-slate-600 dark:text-slate-300">Our fleet is being added — check back soon.</p>
          </div>
        )}
      </div>
    </div>
  );
}
