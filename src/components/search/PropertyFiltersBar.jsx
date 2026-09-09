import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SlidersHorizontal, ChevronDown, X, Wallet, Home, Sparkles } from "lucide-react";

const propertyTypes = [
  { value: "any", label: "Any type" },
  { value: "apartment", label: "Apartment" },
  { value: "house", label: "House" },
  { value: "studio", label: "Studio" },
  { value: "loft", label: "Loft" },
  { value: "penthouse", label: "Penthouse" },
  { value: "villa", label: "Villa" },
];

const amenityOptions = [
  { id: "wifi", label: "WiFi" },
  { id: "kitchen", label: "Kitchen" },
  { id: "parking", label: "Parking" },
  { id: "pool", label: "Pool" },
  { id: "gym", label: "Gym" },
  { id: "balcony", label: "Balcony" },
  { id: "air_conditioning", label: "AC" },
  { id: "washer", label: "Washer" },
  { id: "workspace", label: "Workspace" },
];

const PRICE_MAX = 500000;
const PRICE_MIN = 0;

const DEFAULT_FILTERS = Object.freeze({
  minPrice: PRICE_MIN,
  maxPrice: PRICE_MAX,
  propertyType: "any",
  amenities: [],
});

// Compact chip-button used for each top-row filter trigger.
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
      <PopoverContent align="start" className="w-72 p-4 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl">
        {children}
      </PopoverContent>
    </Popover>
  );
}

export default function PropertyFiltersBar({ filters, onFiltersChange }) {
  const [sheetOpen, setSheetOpen] = useState(false);

  const priceActive = filters.minPrice > PRICE_MIN || filters.maxPrice < PRICE_MAX;
  const typeActive = filters.propertyType && filters.propertyType !== 'any';
  const amenitiesActive = (filters.amenities?.length || 0) > 0;
  const anyActive = priceActive || typeActive || amenitiesActive;

  const priceLabel = priceActive
    ? `₦${filters.minPrice.toLocaleString()} – ₦${filters.maxPrice.toLocaleString()}`
    : 'Price';

  const typeLabel = typeActive
    ? propertyTypes.find((p) => p.value === filters.propertyType)?.label || 'Type'
    : 'Type';

  const amenityLabel = amenitiesActive
    ? `${filters.amenities.length} amenit${filters.amenities.length === 1 ? 'y' : 'ies'}`
    : 'Amenities';

  // Active count drives the "More filters" badge so users can see something
  // is filtering the grid even when the chip is collapsed inside the sheet.
  const activeCount = useMemo(() => {
    let n = 0;
    if (priceActive) n += 1;
    if (typeActive) n += 1;
    if (amenitiesActive) n += filters.amenities.length;
    return n;
  }, [priceActive, typeActive, amenitiesActive, filters.amenities]);

  const handlePriceChange = ([min, max]) => {
    onFiltersChange({ ...filters, minPrice: min, maxPrice: max });
  };

  const toggleAmenity = (id) => (checked) => {
    const next = checked
      ? [...(filters.amenities || []), id]
      : (filters.amenities || []).filter((a) => a !== id);
    onFiltersChange({ ...filters, amenities: next });
  };

  const clearAll = () => onFiltersChange({ ...DEFAULT_FILTERS });

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 sm:gap-3">
      <FilterChip icon={Wallet} label={priceLabel} isActive={priceActive}>
        <div>
          <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">
            Price range (per night)
          </Label>
          <Slider
            value={[filters.minPrice, filters.maxPrice]}
            onValueChange={handlePriceChange}
            max={PRICE_MAX}
            min={PRICE_MIN}
            step={5000}
            className="w-full mt-2"
          />
          <div className="flex justify-between text-sm text-slate-600 dark:text-slate-300 mt-3 font-medium">
            <span>₦{filters.minPrice.toLocaleString()}</span>
            <span>₦{filters.maxPrice.toLocaleString()}</span>
          </div>
          {priceActive && (
            <button
              onClick={() => handlePriceChange([PRICE_MIN, PRICE_MAX])}
              className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline mt-3"
            >
              Reset price
            </button>
          )}
        </div>
      </FilterChip>

      <FilterChip icon={Home} label={typeLabel} isActive={typeActive}>
        <div>
          <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">
            Property type
          </Label>
          <div className="grid grid-cols-2 gap-2">
            {propertyTypes.map((t) => {
              const selected = filters.propertyType === t.value;
              return (
                <button
                  key={t.value}
                  onClick={() => onFiltersChange({ ...filters, propertyType: t.value })}
                  className={`text-sm rounded-lg px-3 py-2 border transition-colors text-left ${
                    selected
                      ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
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

      <FilterChip icon={Sparkles} label={amenityLabel} isActive={amenitiesActive}>
        <div>
          <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">
            Amenities
          </Label>
          <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
            {amenityOptions.map((amenity) => (
              <label
                key={amenity.id}
                htmlFor={`bar-${amenity.id}`}
                className="flex items-center space-x-2 cursor-pointer py-1"
              >
                <Checkbox
                  id={`bar-${amenity.id}`}
                  checked={filters.amenities?.includes(amenity.id) || false}
                  onCheckedChange={toggleAmenity(amenity.id)}
                />
                <span className="text-sm text-slate-700 dark:text-slate-200">{amenity.label}</span>
              </label>
            ))}
          </div>
          {amenitiesActive && (
            <button
              onClick={() => onFiltersChange({ ...filters, amenities: [] })}
              className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline mt-3"
            >
              Clear amenities
            </button>
          )}
        </div>
      </FilterChip>

      {/* All-in-one sheet — same controls, useful on small screens where chips wrap */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-10 rounded-full px-4 gap-2 font-medium bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-amber-400 whitespace-nowrap"
          >
            <SlidersHorizontal className="w-4 h-4" />
            All filters
            {activeCount > 0 && (
              <Badge className="ml-1 bg-amber-500 text-white border-0 h-5 px-1.5 rounded-full text-[10px]">
                {activeCount}
              </Badge>
            )}
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Filter properties</SheetTitle>
          </SheetHeader>

          <div className="mt-6 space-y-6">
            <div>
              <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">
                Price range (per night, NGN)
              </Label>
              <Slider
                value={[filters.minPrice, filters.maxPrice]}
                onValueChange={handlePriceChange}
                max={PRICE_MAX}
                min={PRICE_MIN}
                step={5000}
              />
              <div className="flex justify-between text-sm text-slate-600 dark:text-slate-300 mt-3 font-medium">
                <span>₦{filters.minPrice.toLocaleString()}</span>
                <span>₦{filters.maxPrice.toLocaleString()}</span>
              </div>
            </div>

            <div>
              <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">
                Property type
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {propertyTypes.map((t) => {
                  const selected = filters.propertyType === t.value;
                  return (
                    <button
                      key={t.value}
                      onClick={() => onFiltersChange({ ...filters, propertyType: t.value })}
                      className={`text-sm rounded-lg px-3 py-2 border transition-colors text-left ${
                        selected
                          ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-amber-400'
                      }`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 block">
                Amenities
              </Label>
              <div className="grid grid-cols-2 gap-3">
                {amenityOptions.map((amenity) => (
                  <label
                    key={amenity.id}
                    htmlFor={`sheet-${amenity.id}`}
                    className="flex items-center space-x-2 cursor-pointer"
                  >
                    <Checkbox
                      id={`sheet-${amenity.id}`}
                      checked={filters.amenities?.includes(amenity.id) || false}
                      onCheckedChange={toggleAmenity(amenity.id)}
                    />
                    <span className="text-sm text-slate-700 dark:text-slate-200">{amenity.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-2 sticky bottom-0 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm -mx-1 px-1 pb-1">
              <Button
                variant="outline"
                className="flex-1 rounded-xl"
                onClick={clearAll}
              >
                Clear all
              </Button>
              <Button
                className="flex-1 rounded-xl bg-slate-900 hover:bg-slate-800"
                onClick={() => setSheetOpen(false)}
              >
                Show results
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {anyActive && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearAll}
          className="h-10 rounded-full text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 px-3"
        >
          <X className="w-4 h-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
}
