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
  Check, X, CalendarClock, UserPlus, Inbox, IdCard,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import DriversAdmin from '@/components/admin/DriversAdmin';

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
  { value: 'needs-driver', label: 'Needs a driver' },
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

// AssignDriverDialog — picks a driver for a paid ride.
//
// Reads Driver directly rather than through a function: Driver RLS is
// admin-only for read, so this list is already gated and only ever loads for
// an admin. Guests never see the roster — their view comes from
// getRideDriverContact, which returns a narrow projection.
//
// Availability is enforced server-side by assignRideDriver (overlap on the
// driver's other bookings, plus a city match). This dialog pre-filters by city
// to keep the list short, but does not attempt to predict the overlap check —
// a clash comes back as DRIVER_DOUBLE_BOOKED with the conflicting window.
function AssignDriverDialog({ ride, onClose, onAssigned }) {
  const { toast } = useToast();
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(null);

  useEffect(() => {
    if (!ride) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await base44.entities.Driver.filter(
          { active: true, admin_approved: true }, 'full_name', 200,
        );
        if (!cancelled) setDrivers(Array.isArray(rows) ? rows : []);
      } catch (err) {
        console.error('Could not load drivers:', err);
        if (!cancelled) setDrivers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ride]);

  const assign = async (driver) => {
    setSaving(driver.id);
    try {
      const res = await base44.functions.invoke('assignRideDriver', {
        ride_booking_id: ride.id,
        driver_id: driver.id,
      });
      if (res?.data?.success) {
        toast({
          title: 'Driver assigned',
          description: `${driver.full_name} is on this ride. The guest has been emailed and notified.`,
        });
        onAssigned();
      } else {
        // Server refusals are specific and actionable — show them verbatim
        // rather than a generic failure.
        toast({
          title: 'Could not assign',
          description: res?.data?.error || 'Please try another driver.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({ title: 'Could not assign', description: err?.message || 'Try again.', variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  const city = ride?.pickup_location?.city;
  const relevant = city ? drivers.filter((d) => !d.city || d.city === city) : drivers;

  return (
    <Dialog open={!!ride} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign a driver</DialogTitle>
          <DialogDescription>
            {ride && (
              <>
                {ride.vehicle_name} · {fmtWindow(ride.start_at, ride.end_at)}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
          </div>
        ) : relevant.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300 py-6 text-center">
            No approved, active drivers{city ? ` in ${city}` : ''}. Add one on the Drivers tab, and make sure they are both active and approved.
          </p>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {relevant.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-3 border border-slate-200 dark:border-slate-800 rounded-xl p-3"
              >
                {d.photo ? (
                  <img src={d.photo} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
                    <UserPlus className="w-4 h-4 text-slate-400" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm text-slate-900 dark:text-white truncate">{d.full_name}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {[d.city, d.years_experience ? `${d.years_experience} yrs` : null,
                      d.trips_completed ? `${d.trips_completed} trips` : null].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <Button
                  size="sm" disabled={saving === d.id}
                  onClick={() => assign(d)}
                  className="rounded-xl flex-shrink-0"
                >
                  {saving === d.id ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Assign'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RideRequestsPanel() {
  const { toast } = useToast();
  const [rides, setRides] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('pending-approval');
  const [actioningId, setActioningId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { ride, approve }
  const [assigning, setAssigning] = useState(null); // ride awaiting a driver

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

  // 'needs-driver' is a cross-cutting view, not a bucket the server returns:
  // paid, not cancelled, no driver yet.
  const shown = filter === 'all'
    ? rides
    : filter === 'needs-driver'
      ? rides.filter((r) => r.payment_status === 'paid' && r.status === 'confirmed' && !r.driver_assigned)
      : rides.filter((r) => r.bucket === filter);
  const needsDriverCount = rides.filter(
    (r) => r.payment_status === 'paid' && r.status === 'confirmed' && !r.driver_assigned,
  ).length;
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
            {needsDriverCount > 0 && (
              <Badge className="bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-0">
                {needsDriverCount} need a driver
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

                    {r.payment_status === 'paid' && r.status === 'confirmed' && !r.driver_assigned && (
                      <div className="flex flex-col gap-2 flex-shrink-0 w-full sm:w-auto">
                        <Button
                          size="sm"
                          onClick={() => setAssigning(r)}
                          className="rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-amber-500 dark:hover:bg-amber-600 dark:text-slate-950 text-white w-full sm:w-auto"
                        >
                          <UserPlus className="w-4 h-4 mr-2" /> Assign driver
                        </Button>
                      </div>
                    )}

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

      <AssignDriverDialog
        ride={assigning}
        onClose={() => setAssigning(null)}
        onAssigned={() => { setAssigning(null); load(); }}
      />

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

// The Rides tab holds two jobs that share nothing but a subject: acting on
// incoming requests, and maintaining the roster those requests get dispatched
// to. Nesting them here rather than adding an eighth top-level Admin tab keeps
// the header from wrapping on a phone, which is where these decisions actually
// get made.
export default function RidesAdmin() {
  const [innerTab, setInnerTab] = useState('requests');

  return (
    <Tabs value={innerTab} onValueChange={setInnerTab} className="space-y-4">
      <TabsList className="grid w-full grid-cols-2 max-w-md">
        <TabsTrigger value="requests">
          <Inbox className="w-4 h-4 mr-2" /> Requests
        </TabsTrigger>
        <TabsTrigger value="drivers">
          <IdCard className="w-4 h-4 mr-2" /> Drivers
        </TabsTrigger>
      </TabsList>

      <TabsContent value="requests">
        <RideRequestsPanel />
      </TabsContent>

      <TabsContent value="drivers">
        <DriversAdmin />
      </TabsContent>
    </Tabs>
  );
}
