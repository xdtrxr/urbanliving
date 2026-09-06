import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2, RefreshCw, Car, Clock, MapPin, Mail, Phone, Users,
  Check, X, CalendarClock,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

// RidesAdmin — the in-app twin of the Telegram approve/reject keyboard.
//
// Both paths exist for the same reason the apartment flow has both: Telegram
// is faster on a phone, but it fails silently if the bot token or webhook is
// misconfigured, and a decision made there can't be revisited from a laptop.
// Either path is safe to use — decideRideBooking guards on approved_at, so a
// ride actioned in Telegram is refused here with ALREADY_DECIDED rather than
// being double-approved.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

const fmtWindow = (startIso, endIso) => {
  const opts = { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' };
  try {
    const s = new Date(startIso).toLocaleString('en-GB', opts);
    const e = new Date(endIso).toLocaleString('en-GB', opts);
    return `${s} → ${e}`;
  } catch { return '—'; }
};

const BUCKETS = [
  { value: 'pending-approval', label: 'Awaiting decision' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'current', label: 'In progress' },
  { value: 'past', label: 'Past' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'All' },
];

const STATUS_STYLE = {
  'pending-approval': 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900',
  upcoming: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-900',
  current: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900',
  past: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700',
  cancelled: 'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-rose-200 dark:border-rose-900',
};

export default function RidesAdmin() {
  const { toast } = useToast();
  const [rides, setRides] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('pending-approval');
  const [actioningId, setActioningId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { ride, approve }

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const res = await base44.functions.invoke('getRideBookings', { scope: 'all' });
      if (res?.data?.success) {
        setRides(res.data.data || []);
        setCounts(res.data.counts || {});
      } else {
        throw new Error(res?.data?.error || 'Failed to load rides');
      }
    } catch (err) {
      console.error('RidesAdmin load failed:', err);
      if (!silent) {
        toast({
          title: 'Could not load rides',
          description: err?.message || 'Try the refresh button.',
          variant: 'destructive',
        });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    // 15s matches the pending-availability queue above it, so both admin
    // queues refresh on the same rhythm.
    const t = setInterval(() => load(true), 15000);
    return () => clearInterval(t);
  }, [load]);

  const decide = async () => {
    if (!confirm) return;
    const { ride, approve } = confirm;
    setConfirm(null);
    setActioningId(ride.id);
    try {
      const res = await base44.functions.invoke('decideRideBooking', {
        ride_booking_id: ride.id,
        action: approve ? 'approve' : 'reject',
      });
      if (res?.data?.success) {
        toast({
          title: approve ? 'Ride approved' : 'Ride rejected',
          description: approve
            ? 'The guest has an hour to pay. They have been emailed and notified.'
            : 'The guest has been told and the vehicle is free again.',
        });
      } else if (res?.data?.code === 'ALREADY_DECIDED') {
        // Almost always means it was actioned from Telegram in the meantime.
        toast({
          title: 'Already actioned',
          description: 'This ride was decided elsewhere — refreshing the list.',
        });
      } else {
        throw new Error(res?.data?.error || 'Decision failed');
      }
    } catch (err) {
      console.error('decideRideBooking failed:', err);
      toast({
        title: 'Could not action this ride',
        description: err?.message || 'Try again in a moment.',
        variant: 'destructive',
      });
    } finally {
      setActioningId(null);
      await load();
    }
  };

  const shown = filter === 'all' ? rides : rides.filter((r) => r.bucket === filter);
  const pendingCount = counts['pending-approval'] || 0;

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-slate-900 dark:text-white">
            <Car className="w-5 h-5 text-amber-500 dark:text-amber-400 flex-shrink-0" />
            Ride requests
            {pendingCount > 0 && (
              <Badge className="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-0">
                {pendingCount} awaiting
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Approve or reject here or from Telegram — whichever you reach first wins.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-10 w-44 rounded-xl"><SelectValue /></SelectTrigger>
            <SelectContent>
              {BUCKETS.map((b) => (
                <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline" size="icon" onClick={() => load()}
            disabled={refreshing} className="rounded-xl flex-shrink-0" aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {loading && rides.length === 0 ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        ) : shown.length === 0 ? (
          <p className="text-center text-slate-500 dark:text-slate-400 py-12 text-sm">
            {filter === 'pending-approval'
              ? 'No ride requests waiting. 🚗'
              : `No rides in "${BUCKETS.find((b) => b.value === filter)?.label}".`}
          </p>
        ) : (
          <div className="space-y-3">
            {shown.map((r) => {
              const isPending = r.bucket === 'pending-approval';
              const busy = actioningId === r.id;
              return (
                <div
                  key={r.id}
                  className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <p className="font-semibold text-slate-900 dark:text-white break-words">
                          {r.vehicle_name || 'Vehicle'}
                        </p>
                        <Badge className={`${STATUS_STYLE[r.bucket] || STATUS_STYLE.past} border font-medium`}>
                          {BUCKETS.find((b) => b.value === r.bucket)?.label || r.bucket}
                        </Badge>
                        {r.payment_status === 'paid' && (
                          <Badge className="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-0">
                            Paid
                          </Badge>
                        )}
                        {r.linked_property_booking_id && (
                          <Badge variant="outline" className="text-xs">Add-on to a stay</Badge>
                        )}
                        {r.driver_assigned && (
                          <Badge variant="outline" className="text-xs">Driver assigned</Badge>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
                        <span className="flex items-center gap-1.5 truncate">
                          <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                          <span className="truncate">{r.guest_name} · {r.guest_email}</span>
                        </span>
                        <span className="flex items-center gap-1.5 truncate">
                          <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                          <a href={`tel:${r.guest_phone}`} className="truncate hover:underline">{r.guest_phone || '—'}</a>
                        </span>
                        <span className="flex items-start gap-1.5 sm:col-span-2">
                          <CalendarClock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                          <span className="break-words">{fmtWindow(r.start_at, r.end_at)} · {r.duration_tier}</span>
                        </span>
                        <span className="flex items-start gap-1.5 sm:col-span-2">
                          <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                          <span className="break-words">
                            {[r.pickup_location?.address, r.pickup_location?.area, r.pickup_location?.city]
                              .filter(Boolean).join(', ') || 'No pickup address'}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Users className="w-3.5 h-3.5" /> {r.passengers || 1} passenger{(r.passengers || 1) === 1 ? '' : 's'}
                        </span>
                        <span className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-white">
                          {ngn(r.total_price)}
                        </span>
                      </div>

                      {r.special_requests && (
                        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 italic break-words">
                          &ldquo;{r.special_requests}&rdquo;
                        </p>
                      )}
                    </div>

                    {isPending && (
                      <div className="flex flex-col gap-2 flex-shrink-0 w-full sm:w-auto">
                        <Button
                          size="sm" disabled={busy}
                          onClick={() => setConfirm({ ride: r, approve: true })}
                          className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white w-full sm:w-auto"
                        >
                          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                          Approve
                        </Button>
                        <Button
                          size="sm" variant="outline" disabled={busy}
                          onClick={() => setConfirm({ ride: r, approve: false })}
                          className="rounded-xl border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 w-full sm:w-auto"
                        >
                          <X className="w-4 h-4 mr-2" /> Reject
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.approve ? 'Approve this ride?' : 'Reject this ride?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && (
                <span className="block">
                  <strong>{confirm.ride.vehicle_name}</strong> for{' '}
                  <strong>{confirm.ride.guest_name}</strong>,{' '}
                  {fmtWindow(confirm.ride.start_at, confirm.ride.end_at)}.
                  {confirm.approve ? (
                    <span className="block mt-2 text-xs text-slate-500 dark:text-slate-400">
                      The vehicle stays held and the guest gets one hour to pay. Confirm a driver
                      is realistically available before approving — assignment happens after payment.
                    </span>
                  ) : (
                    <span className="block mt-2 text-xs text-slate-500 dark:text-slate-400">
                      The guest is emailed and notified, and the vehicle is released for that window.
                    </span>
                  )}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={decide}
              className={confirm?.approve
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                : 'bg-rose-600 hover:bg-rose-700 text-white'}
            >
              {confirm?.approve ? 'Approve' : 'Reject'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
