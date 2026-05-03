import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, Users, DollarSign, ExternalLink } from "lucide-react";
import { format, parseISO } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

const statusColors = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-200",
  confirmed: "bg-green-100 text-green-800 border-green-200",
  cancelled: "bg-red-100 text-red-800 border-red-200",
  completed: "bg-blue-100 text-blue-800 border-blue-200"
};

export default function BookingDetailsCard({ booking, property }) {
  return (
    <Card className="bg-white border-slate-200 rounded-2xl shadow-md overflow-hidden hover:shadow-lg transition-shadow duration-300 max-w-md">
      {property && property.images?.[0] && (
        <img 
          src={property.images[0]} 
          alt={property.title}
          className="w-full h-40 object-cover"
        />
      )}
      <CardContent className="p-4 space-y-3">
        <div className="flex justify-between items-start">
          <h3 className="font-bold text-slate-900 text-lg line-clamp-1">
            {property?.title || 'Booking Details'}
          </h3>
          <Badge className={`${statusColors[booking.status]} border font-medium text-xs`}>
            {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
          </Badge>
        </div>

        {property && (
          <div className="flex items-center gap-2 text-slate-600 text-sm">
            <MapPin className="w-4 h-4" />
            <span>{property.location?.city}, {property.location?.country}</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-start gap-2">
            <Calendar className="w-4 h-4 text-slate-500 mt-0.5" />
            <div>
              <p className="text-slate-500 text-xs">Check-in</p>
              <p className="font-semibold text-slate-900">
                {format(parseISO(booking.check_in), "MMM d, yyyy")}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Calendar className="w-4 h-4 text-slate-500 mt-0.5" />
            <div>
              <p className="text-slate-500 text-xs">Check-out</p>
              <p className="font-semibold text-slate-900">
                {format(parseISO(booking.check_out), "MMM d, yyyy")}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Users className="w-4 h-4 text-slate-500 mt-0.5" />
            <div>
              <p className="text-slate-500 text-xs">Guests</p>
              <p className="font-semibold text-slate-900">{booking.guests}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <DollarSign className="w-4 h-4 text-slate-500 mt-0.5" />
            <div>
              <p className="text-slate-500 text-xs">Total</p>
              <p className="font-semibold text-slate-900">${booking.total_price}</p>
            </div>
          </div>
        </div>

        {booking.special_requests && (
          <div className="bg-slate-50 rounded-lg p-2 text-xs">
            <p className="text-slate-500">Special Requests:</p>
            <p className="text-slate-700">{booking.special_requests}</p>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          {property && (
            <Link to={createPageUrl(`Property?id=${property.id}`)} className="flex-1">
              <Button variant="outline" size="sm" className="w-full rounded-lg text-xs">
                <ExternalLink className="w-3 h-3 mr-1" />
                View Property
              </Button>
            </Link>
          )}
          <Link to={createPageUrl("Bookings")} className="flex-1">
            <Button size="sm" className="w-full bg-slate-900 hover:bg-slate-800 rounded-lg text-xs">
              Manage Bookings
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}