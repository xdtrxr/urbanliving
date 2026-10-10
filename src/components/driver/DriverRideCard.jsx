import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Car, CalendarClock, MapPin, Users, Phone, UserRound, Banknote, Flag, MessageSquare } from 'lucide-react';
import { durationLabel, noPayLine } from '@/config/rides';

// DriverRideCard — one ride as the driver needs to see it: when, where, who,
// and what it pays.
//
// Everything on it comes from getDriverRides, which has already decided what
// the driver may know. This component adds nothing and derives nothing about
// the ride's state; it only words it.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

const fmtWhen = (iso) => {
  if (!iso) return 'Time to be confirmed';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return 'Time to be confirmed'; }
};

const BUCKET_BADGE = {
  current: { label: 'In progress', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900' },
  upcoming: { label: 'Upcoming', className: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-900' },
  past: { label: 'Completed', className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700' },
  cancelled: { label: 'Cancelled', className: 'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-rose-200 dark:border-rose-900' },
};

const PAY_TONE = {
  good: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-900 dark:text-emerald-100',
  held: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-100',
  warn: 'bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-900 text-orange-900 dark:text-orange-100',
  muted: 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300',
};

// The one sentence about money. A ride with no earning row predates pay
// tracking or was assigned at ₦0; either way the driver is told the app is
// holding nothing for it, and before the ride, to confirm with the team.
export function payLine(earning, bucket) {
  if (!earning) return noPayLine(bucket);
  const amount = ngn(earning.amount_ngn);
  if (earning.status === 'released') return { tone: 'good', text: `${amount} released to your wallet` };
  if (earning.status === 'reversed') return { tone: 'muted', text: `${amount} reversed. This ride no longer pays.` };
  if (earning.on_hold || earning.under_review) return { tone: 'warn', text: `${amount} held · under review by the team` };
  return { tone: 'held', text: `${amount} held · releases ${fmtWhen(earning.release_at)}` };
}

export default function DriverRideCard({ ride, onReport }) {
  const badge = BUCKET_BADGE[ride.bucket] || BUCKET_BADGE.upcoming;
  const pickup = [ride.pickup_location?.address, ride.pickup_location?.area, ride.pickup_location?.city]
    .filter(Boolean).join(', ');
  const dropoff = [ride.dropoff_location?.address, ride.dropoff_location?.area].filter(Boolean).join(', ');
  const pay = payLine(ride.earning, ride.bucket);
  const cancelled = ride.bucket === 'cancelled';

  return (
    <div
      id={`ride-${ride.id}`}
      className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden bg-white/80 dark:bg-slate-900/80"
    >
      <div className="flex flex-col sm:flex-row">
        {ride.vehicle_image ? (
          <img src={ride.vehicle_image} alt="" className="w-full sm:w-36 h-28 sm:h-auto object-cover flex-shrink-0" />
        ) : (
          <div className="w-full sm:w-36 h-28 sm:h-auto bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
            <Car className="w-8 h-8 text-slate-400 dark:text-slate-500" />
          </div>
        )}

        <div className="p-4 flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
            <p className={`font-semibold break-words min-w-0 flex-1 ${cancelled ? 'text-slate-500 dark:text-slate-400 line-through' : 'text-slate-900 dark:text-white'}`}>
              {ride.vehicle_name}
            </p>
            <div className="flex flex-wrap gap-2 flex-shrink-0">
              {ride.booking_reference && (
                <Badge variant="outline" className="text-xs font-mono">{ride.booking_reference}</Badge>
              )}
              <Badge className={`${badge.className} border font-medium`}>{badge.label}</Badge>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
            <span className="flex items-start gap-1.5">
              <CalendarClock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-words">
                {fmtWhen(ride.start_at)} · {durationLabel(ride.duration_tier, { hours: ride.duration_hours, days: ride.duration_days })}
              </span>
            </span>
            {pickup && (
              <span className="flex items-start gap-1.5">
                <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span className="break-words">
                  Pickup: {pickup}
                  {dropoff ? ` · Drop-off: ${dropoff}` : ''}
                </span>
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 flex-shrink-0" />
              {ride.passengers} passenger{ride.passengers === 1 ? '' : 's'}
            </span>
          </div>

          {ride.pickup_instructions && !cancelled && (
            <div className="mt-3 flex items-start gap-2 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-xl p-3">
              <MapPin className="w-4 h-4 text-blue-700 dark:text-blue-300 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-blue-900 dark:text-blue-100 break-words">{ride.pickup_instructions}</p>
            </div>
          )}

          {ride.special_requests && !cancelled && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400 break-words">
              <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>Guest asked: {ride.special_requests}</span>
            </p>
          )}

          <div className="mt-3 flex items-center gap-3 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
            <div className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
              <UserRound className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-500 dark:text-slate-400">Your passenger</p>
              <p className="font-semibold text-sm text-slate-900 dark:text-white truncate">{ride.guest_name}</p>
            </div>
            {ride.guest_phone ? (
              <a href={`tel:${ride.guest_phone}`} className="flex-shrink-0">
                <Button size="sm" variant="outline" className="rounded-xl">
                  <Phone className="w-4 h-4 mr-1.5" /> Call
                </Button>
              </a>
            ) : null}
          </div>

          <div className={`mt-3 flex items-center gap-2 border rounded-xl px-3 py-2 ${PAY_TONE[pay.tone]}`}>
            <Banknote className="w-4 h-4 flex-shrink-0" />
            <p className="text-sm font-medium break-words">{pay.text}</p>
          </div>

          {ride.already_reported ? (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              You reported this ride. The team will be in touch.
            </p>
          ) : ride.can_report && onReport ? (
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800">
              <Button
                variant="outline" size="sm" onClick={() => onReport(ride)}
                className="rounded-xl border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                <Flag className="w-4 h-4 mr-2" /> Report this customer
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
