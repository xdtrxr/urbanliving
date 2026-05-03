import React, { useState, useRef, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar as CalendarIcon, Users, Search, MapPin, Bed } from "lucide-react";
import { format } from "date-fns";

export default function BookingAssistant({ initialParams, onSearch, onCancel }) {
  const [location, setLocation] = useState(initialParams?.location || "");
  const [checkIn, setCheckIn] = useState(null);
  const [checkOut, setCheckOut] = useState(null);
  const [guests, setGuests] = useState(initialParams?.guests || "2");
  const [bedrooms, setBedrooms] = useState(initialParams?.bedrooms || "any");
  const locationInputRef = useRef(null);

  useEffect(() => {
    if (!initialParams?.location) {
      locationInputRef.current?.focus();
    }
  }, [initialParams]);

  const handleSearch = () => {
    if (!location.trim()) {
      alert("Please enter a destination");
      return;
    }
    if (!checkIn || !checkOut) {
      alert("Please select check-in and check-out dates");
      return;
    }
    if (checkOut <= checkIn) {
      alert("Check-out must be after check-in");
      return;
    }

    onSearch({
      location: location.trim(),
      checkIn,
      checkOut,
      guests: parseInt(guests),
      bedrooms: bedrooms === "any" ? null : bedrooms
    });
  };

  const guestOptions = [
    ...Array.from({ length: 16 }, (_, i) => i + 1),
    20, 25, 30, 35, 40, 45, 50
  ];

  const bedroomOptions = [
    { value: 'any', label: 'Any Bedrooms' },
    { value: 'studio', label: 'Studio' },
    { value: '1', label: '1 Bedroom' },
    { value: '2', label: '2 Bedrooms' },
    { value: '3', label: '3 Bedrooms' },
    { value: '4', label: '4+ Bedrooms' }
  ];

  return (
    <div className="bg-white border-2 border-slate-200 rounded-2xl shadow-xl p-4 mt-2 mb-4">
      <div className="flex flex-col gap-4">
        {/* Search Fields Row */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {/* Location */}
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4 pointer-events-none z-10" />
            <Input
              ref={locationInputRef}
              placeholder="Where to?"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="pl-10 h-12 rounded-xl border-slate-200 focus:border-slate-400"
            />
          </div>

          {/* Check-in */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-12 rounded-xl border-slate-200 justify-start pl-3 hover:border-slate-400">
                <CalendarIcon className="mr-2 h-4 w-4 text-slate-400" />
                <span className={checkIn ? "text-slate-900" : "text-slate-500"}>
                  {checkIn ? format(checkIn, "MMM d") : "Check-in"}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={checkIn}
                onSelect={setCheckIn}
                disabled={(date) => date < new Date()}
              />
            </PopoverContent>
          </Popover>

          {/* Check-out */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-12 rounded-xl border-slate-200 justify-start pl-3 hover:border-slate-400">
                <CalendarIcon className="mr-2 h-4 w-4 text-slate-400" />
                <span className={checkOut ? "text-slate-900" : "text-slate-500"}>
                  {checkOut ? format(checkOut, "MMM d") : "Check-out"}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={checkOut}
                onSelect={setCheckOut}
                disabled={(date) => date < new Date() || (checkIn && date <= checkIn)}
              />
            </PopoverContent>
          </Popover>

          {/* Guests */}
          <Select value={guests} onValueChange={setGuests}>
            <SelectTrigger className="h-12 rounded-xl border-slate-200">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-slate-400" />
                <span>{guests} {parseInt(guests) === 1 ? 'Guest' : 'Guests'}</span>
              </div>
            </SelectTrigger>
            <SelectContent>
              {guestOptions.map((num) => (
                <SelectItem key={num} value={num.toString()}>
                  {num >= 50 ? '50+ Guests' : `${num} ${num === 1 ? 'Guest' : 'Guests'}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Bedrooms */}
          <Select value={bedrooms} onValueChange={setBedrooms}>
            <SelectTrigger className="h-12 rounded-xl border-slate-200">
              <div className="flex items-center gap-2">
                <Bed className="h-4 w-4 text-slate-400" />
                <span>{bedroomOptions.find(b => b.value === bedrooms)?.label}</span>
              </div>
            </SelectTrigger>
            <SelectContent>
              {bedroomOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onCancel} className="rounded-xl">
            Cancel
          </Button>
          <Button onClick={handleSearch} className="bg-slate-900 hover:bg-slate-800 text-white rounded-xl px-6">
            <Search className="w-4 h-4 mr-2" />
            Search Properties
          </Button>
        </div>
      </div>
    </div>
  );
}