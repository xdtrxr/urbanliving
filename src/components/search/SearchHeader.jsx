import React from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin, Calendar as CalendarIcon, Users, Sparkles, SlidersHorizontal, Bed } from "lucide-react";
import { format } from "date-fns";

export default function SearchHeader({ 
  searchQuery, 
  setSearchQuery, 
  checkIn, 
  setCheckIn, 
  checkOut, 
  setCheckOut, 
  guests, 
  setGuests,
  bedrooms,
  setBedrooms,
  onSearch,
  onAIRecommendations,
  isLoadingAI 
}) {
  const guestOptions = [
    ...Array.from({ length: 16 }, (_, i) => i + 1),
    20, 25, 30, 35, 40, 45, 50, 51
  ];

  const bedroomOptions = [
    { value: 'any', label: 'Any Bedrooms' },
    { value: 'studio', label: 'Studio' },
    { value: 'loft', label: 'Loft' },
    { value: '1', label: 'One Bedroom' },
    { value: '2', label: 'Two Bedroom' },
    { value: '3', label: 'Three Bedroom' },
    { value: '4', label: 'Four Bedroom' }
  ];

  return (
    <div className="bg-white/80 backdrop-blur-xl rounded-3xl shadow-xl border border-slate-200/50 p-8 mb-8">
      <div className="flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-slate-900 mb-2 tracking-tight">
            Find Your Perfect Stay
          </h1>
          <p className="text-slate-600 text-lg font-medium">
            AI-powered recommendations for extraordinary experiences
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="md:col-span-1">
            <div className="relative">
              <MapPin className="absolute left-4 top-1/2 transform -translate-y-1/2 text-slate-400 w-5 h-5" />
              <Input
                placeholder="Where to?"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-12 h-14 rounded-xl border-slate-200 focus:border-amber-400 focus:ring-amber-400/20 text-slate-900 font-medium"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 md:col-span-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="h-14 rounded-xl border-slate-200 hover:border-amber-400 justify-start pl-4 font-medium"
                >
                  <CalendarIcon className="mr-3 h-5 w-5 text-slate-400" />
                  {checkIn ? format(checkIn, "MMM d") : "Check-in"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0 bg-white/95 backdrop-blur-xl">
                <Calendar
                  mode="single"
                  selected={checkIn}
                  onSelect={setCheckIn}
                  disabled={(date) => date < new Date()}
                />
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="h-14 rounded-xl border-slate-200 hover:border-amber-400 justify-start pl-4 font-medium"
                >
                  <CalendarIcon className="mr-3 h-5 w-5 text-slate-400" />
                  {checkOut ? format(checkOut, "MMM d") : "Check-out"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0 bg-white/95 backdrop-blur-xl">
                <Calendar
                  mode="single"
                  selected={checkOut}
                  onSelect={setCheckOut}
                  disabled={(date) => date < new Date() || (checkIn && date <= checkIn)}
                />
              </PopoverContent>
            </Popover>
          </div>

          <div className="md:col-span-1">
            <Select value={guests.toString()} onValueChange={(value) => setGuests(parseInt(value))}>
              <SelectTrigger className="h-14 rounded-xl border-slate-200 focus:border-amber-400">
                <div className="flex items-center">
                  <Users className="mr-3 h-5 w-5 text-slate-400" />
                  <SelectValue placeholder="Guests" />
                </div>
              </SelectTrigger>
              <SelectContent className="bg-white/95 backdrop-blur-xl max-h-60">
                {guestOptions.map((num) => (
                  <SelectItem key={num} value={num.toString()}>
                    {num > 50 ? '50+ Guests' : `${num} ${num === 1 ? 'Guest' : 'Guests'}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="md:col-span-1">
            <Select value={bedrooms} onValueChange={setBedrooms}>
              <SelectTrigger className="h-14 rounded-xl border-slate-200 focus:border-amber-400">
                <div className="flex items-center">
                  <Bed className="mr-3 h-5 w-5 text-slate-400" />
                  <SelectValue placeholder="Bedrooms" />
                </div>
              </SelectTrigger>
              <SelectContent className="bg-white/95 backdrop-blur-xl">
                {bedroomOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button 
            onClick={onSearch}
            className="bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white px-8 py-4 rounded-xl font-semibold text-lg shadow-lg transition-all duration-300 hover:shadow-xl"
          >
            <SlidersHorizontal className="mr-2 h-5 w-5" />
            Search Properties
          </Button>
          
          <Button 
            onClick={onAIRecommendations}
            disabled={isLoadingAI}
            className="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white px-8 py-4 rounded-xl font-semibold text-lg shadow-lg transition-all duration-300 hover:shadow-xl"
          >
            {isLoadingAI ? (
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-white/30 border-t-white mr-2" />
            ) : (
              <Sparkles className="mr-2 h-5 w-5" />
            )}
            AI Recommendations
          </Button>
        </div>
      </div>
    </div>
  );
}