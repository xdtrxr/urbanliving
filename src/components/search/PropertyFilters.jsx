import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }
from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SlidersHorizontal, X } from "lucide-react";

const propertyTypes = [
  { value: "apartment", label: "Apartment" },
  { value: "house", label: "House" },
  { value: "studio", label: "Studio" },
  { value: "loft", label: "Loft" },
  { value: "penthouse", label: "Penthouse" },
  { value: "villa", label: "Villa" }
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
  { id: "workspace", label: "Workspace" }
];

export default function PropertyFilters({ 
  filters, 
  onFiltersChange, 
  isOpen, 
  onToggle 
}) {
  const handlePriceChange = ([min, max]) => {
    onFiltersChange({ ...filters, minPrice: min, maxPrice: max });
  };

  if (!isOpen) {
    return (
      <Button
        onClick={onToggle}
        variant="outline"
        className="mb-6 bg-white/80 backdrop-blur-sm border-slate-200 hover:border-amber-400 rounded-xl px-6 py-3"
      >
        <SlidersHorizontal className="w-4 h-4 mr-2" />
        Filters
      </Button>
    );
  }

  return (
    <Card className="mb-6 bg-white/90 backdrop-blur-sm border-slate-200 rounded-2xl">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-bold text-slate-900">Filters</CardTitle>
          <Button variant="ghost" size="icon" onClick={onToggle}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <Label className="text-sm font-semibold text-slate-700 mb-3 block">
            Price Range (per night, NGN)
          </Label>
          <Slider
            value={[filters.minPrice, filters.maxPrice]}
            onValueChange={handlePriceChange}
            max={500000}
            min={0}
            step={5000}
            className="w-full mt-2"
          />
          <div className="flex justify-between text-sm text-slate-500 mt-2">
            <span>₦{filters.minPrice.toLocaleString()}</span>
            <span>₦{filters.maxPrice.toLocaleString()}</span>
          </div>
        </div>

        <div>
          <Label className="text-sm font-semibold text-slate-700 mb-3 block">
            Property Type
          </Label>
          <Select 
            value={filters.propertyType} 
            onValueChange={(value) => onFiltersChange({ ...filters, propertyType: value })}
          >
            <SelectTrigger className="rounded-xl border-slate-200">
              <SelectValue placeholder="Any type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any type</SelectItem>
              {propertyTypes.map((type) => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-sm font-semibold text-slate-700 mb-3 block">
            Amenities
          </Label>
          <div className="grid grid-cols-2 gap-3">
            {amenityOptions.map((amenity) => (
              <div key={amenity.id} className="flex items-center space-x-2">
                <Checkbox
                  id={amenity.id}
                  checked={filters.amenities.includes(amenity.id)}
                  onCheckedChange={(checked) => {
                    const newAmenities = checked
                      ? [...filters.amenities, amenity.id]
                      : filters.amenities.filter(a => a !== amenity.id);
                    onFiltersChange({ ...filters, amenities: newAmenities });
                  }}
                />
                <Label htmlFor={amenity.id} className="text-sm text-slate-600">
                  {amenity.label}
                </Label>
              </div>
            ))}
          </div>
        </div>

        <Button
          onClick={() => onFiltersChange({
            minPrice: 0,
            maxPrice: 500000,
            propertyType: "any",
            amenities: []
          })}
          variant="outline"
          className="w-full rounded-xl"
        >
          Clear Filters
        </Button>
      </CardContent>
    </Card>
  );
}