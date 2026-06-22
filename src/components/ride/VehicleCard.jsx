import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, Car, Snowflake, MapPin } from 'lucide-react';

// Small chip used inside the card body — keeps amenity / feature pills tight
function Chip({ icon: Icon, children }) {
  return (
    <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 dark:text-slate-200 text-[11px] font-medium">
      {Icon && <Icon className="w-3 h-3" />}
      {children}
    </div>
  );
}

export default function VehicleCard({ vehicle }) {
  const hero = vehicle.images?.[0]
    || 'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=800';
  const hasAC = (vehicle.amenities || []).includes('air_conditioning');
  const price12 = vehicle.price_12hr_ngn;
  const price24 = vehicle.price_24hr_ngn;

  return (
    <Link to={createPageUrl(`Vehicle?id=${vehicle.id}`)} className="block group">
      <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 group-hover:-translate-y-0.5">
        {/* Hero image */}
        <div className="aspect-[4/3] bg-slate-100 overflow-hidden relative">
          <img
            src={hero}
            alt={vehicle.name}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          />
          {vehicle.vehicle_type && (
            <Badge className="absolute top-3 left-3 bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border-0 capitalize text-[11px] font-semibold backdrop-blur-sm">
              {vehicle.vehicle_type.replace(/_/g, ' ')}
            </Badge>
          )}
          {vehicle.city && (
            <Badge className="absolute top-3 right-3 bg-slate-900/80 text-white border-0 text-[11px] font-semibold backdrop-blur-sm">
              <MapPin className="w-3 h-3 mr-1" />
              {vehicle.city}
            </Badge>
          )}
        </div>

        <CardContent className="p-4">
          <div className="mb-3">
            <h3 className="font-bold text-slate-900 dark:text-white text-base sm:text-lg leading-tight line-clamp-1">
              {vehicle.name}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {vehicle.brand}{vehicle.model_year ? ` · ${vehicle.model_year}` : ''}
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5 mb-4">
            {vehicle.max_passengers > 0 && (
              <Chip icon={Users}>{vehicle.max_passengers} seats</Chip>
            )}
            {hasAC && <Chip icon={Snowflake}>AC</Chip>}
            {vehicle.driver_included !== false && (
              <Chip icon={Car}>Driver included</Chip>
            )}
          </div>

          {/* Pricing row — both 12h and 24h so the guest sees the upgrade math */}
          <div className="flex items-end justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
            <div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">From</div>
              <div className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white leading-none">
                ₦{(price12 || 0).toLocaleString()}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">/ 12 hours</div>
            </div>
            {price24 ? (
              <div className="text-right">
                <div className="text-sm font-semibold text-amber-700">
                  ₦{price24.toLocaleString()}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">/ 24 hours</div>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
