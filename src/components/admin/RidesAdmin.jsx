import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Loader2, RefreshCw, Car, MapPin, Mail, Phone, Users,
  Check, X, CalendarClock, UserPlus, Inbox, IdCard, Banknote, Flag,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { invokeFn } from '@/lib/invokeFn';
import { useToast } from '@/components/ui/use-toast';
import {
  categoryLabel, ADJUSTMENT_REASONS, driverPayoutFor, typedDriverPay, RELEASE_BUFFER_HOURS,
} from '@/config/rides';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import DriversAdmin from '@/components/admin/DriversAdmin';
import DriverEarningsAdmin from '@/components/admin/DriverEarningsAdmin';
import RideReportsAdmin from '@/components/admin/RideReportsAdmin';

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
  const [instructions, setInstructions] = useState('');
  // Driver pay. `suggested` is what the vehicle's costing row works out to for
  // this booking; `pay` is what admin typed. An empty box means "use the
  // suggestion", and the server computes that same figure for itself.
  const [pay, setPay] = useState('');
  const [suggested, setSuggested] = useState(null);

  useEffect(() => { setInstructions(ride?.pickup_instructions || ''); }, [ride]);

  useEffect(() => {
    setPay('');
    setSuggested(null);
    if (!ride) return undefined;
    let cancelled = false;
    (async () => {
      try {
        // Both entities are admin-only at the API, like the Driver roster below.
        const [costings, held] = await Promise.all([
          base44.entities.VehicleCosting.filter({ vehicle_id: ride.vehicle_id }),
          base44.entities.DriverEarning.filter({ ride_booking_id: ride.id, status: 'held' }),
        ]);
        if (cancelled) return;
        setSuggested(driverPayoutFor(costings?.[0] || null, ride.duration_tier, {
          hours: ride.duration_hours, days: ride.duration_days,
        }));
        // Changing the driver: start from the figure the outgoing driver was promised.
        const current = Array.isArray(held) && held.length > 0 ? held[0] : null;
        if (current) setPay(String(Math.round(Number(current.amount_ngn) || 0)));
      } catch (err) {
        console.error('Could not load the driver pay context:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [ride]);

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
    const typed = typedDriverPay(!!driver.user_email, pay, suggested ? suggested.amount : null);
    if (!typed.ok) {
      toast({ title: 'Driver pay needed', description: typed.message, variant: 'destructive' });
      return;
    }
    setSaving(driver.id);
    // invokeFn never throws. A refusal comes back as r.error, which is the
    // sentence the server wrote: specific and actionable, so it is shown as is.
    const r = await invokeFn('assignRideDriver', {
      ride_booking_id: ride.id,
      driver_id: driver.id,
      pickup_instructions: instructions.trim() || undefined,
      driver_payout_ngn: typed.value,
    });
    setSaving(null);
    if (!r.ok) {
      toast({ title: 'Could not assign', description: r.error, variant: 'destructive' });
      return;
    }
    const d = r.data || {};
    const payNote = !d.pay_tracked
      ? `${driver.full_name} has no login, so their pay is not tracked in the app.`
      : d.driver_payout_ngn > 0
        ? `${ngn(d.driver_payout_ngn)} is held for them and released ${RELEASE_BUFFER_HOURS} hours after the ride ends.`
        : 'No pay was recorded for this ride.';
    toast({
      title: ride?.driver_id ? 'Driver changed' : 'Driver assigned',
      description: `${driver.full_name} is on this ride. The guest has been emailed and notified. ${payNote}`,
    });
    if (d.previous_earning_released) {
      toast({
        title: 'Check the previous driver',
        description: 'Their pay for this ride had already been released and was not taken back. Review it under Earnings.',
        variant: 'destructive',
      });
    }
    onAssigned();
  };

  const city = ride?.pickup_location?.city;
  const relevant = city ? drivers.filter((d) => !d.city || d.city === city) : drivers;

  return (
    <Dialog open={!!ride} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{ride?.driver_id ? 'Change driver' : 'Assign a driver'}</DialogTitle>
          <DialogDescription>
            {ride && (
              <>
                {ride.vehicle_name} · {fmtWindow(ride.start_at, ride.end_at)}
                {ride.driver_id && (
                  <> · currently {ride.driver_name || 'assigned'}</>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div>
          <Label htmlFor="ad-instructions">Pickup instructions</Label>
          <Textarea
            id="ad-instructions" rows={2} value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Driver waits at the Zone 4 gate — guest should call on arrival."
            className="mt-1 rounded-xl"
          />
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Sent to the guest with the driver&apos;s details. Leaving this blank on a
            reassignment keeps whatever is already there.
          </p>
        </div>

        <div>
          <Label htmlFor="ad-pay" className="flex items-center gap-1.5">
            <Banknote className="w-3.5 h-3.5" /> Driver pay (₦)
          </Label>
          <Input
            id="ad-pay" type="text" inputMode="numeric" autoComplete="off" value={pay}
            onChange={(e) => setPay(e.target.value)}
            placeholder={suggested ? String(suggested.amount) : 'for example 15000'}
            className="mt-1 rounded-xl"
          />
          {suggested ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Leave empty to use {ngn(suggested.amount)} from this vehicle&apos;s costing
              ({suggested.units} × {ngn(suggested.rate)} per {suggested.basis === 'hourly' ? 'hour' : 'day'}).
              It is held for the driver and released {RELEASE_BUFFER_HOURS} hours after the ride ends.
            </p>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
              No driver cost set for this vehicle. Enter the pay here or set it under Vehicles → Internal costing.
            </p>
          )}
        </div>

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
                  <p className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                    {d.full_name}
                    {d.id === ride?.driver_id && (
                      <span className="ml-2 text-xs font-normal text-emerald-600 dark:text-emerald-400">
                        on this ride
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {[d.city, d.years_experience ? `${d.years_experience} yrs` : null,
                      d.trips_completed ? `${d.trips_completed} trips` : null,
                      d.user_email ? null : 'no login, pay not tracked'].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={d.id === ride?.driver_id ? 'outline' : 'default'}
                  disabled={saving === d.id || d.id === ride?.driver_id}
                  onClick={() => assign(d)}
                  className="rounded-xl flex-shrink-0"
                >
                  {saving === d.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : d.id === ride?.driver_id ? 'Assigned' : 'Assign'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The approval moment, where the client's "confirm availability AND final
// price" step actually happens. Deliberately a form rather than a yes/no:
// approving is where admin commits to a number, and rejecting is the last
// chance to keep the guest in the funnel by offering something else.
function DecideDialog({ confirm, onClose, onDecide }) {
  const ride = confirm?.ride;
  const approve = !!confirm?.approve;
  const estimate = Number(ride?.estimated_price ?? ride?.total_price) || 0;

  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [alts, setAlts] = useState([]);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ride) return;
    setPrice(String(estimate));
    setReason('');
    setNote('');
    setPicked([]);
    setAlts([]);
  }, [ride, estimate]);

  // Only load the alternatives list when it can actually be used.
  useEffect(() => {
    if (!ride || approve) return;
    let cancelled = false;
    (async () => {
      try {
        const city = ride.pickup_location?.city;
        const rows = await base44.entities.Vehicle.filter(
          { active: true, admin_approved: true, ...(city ? { city } : {}) }, 'name', 50,
        );
        if (!cancelled) setAlts((rows || []).filter((v) => v.id !== ride.vehicle_id));
      } catch (err) {
        console.warn('Could not load alternative vehicles:', err);
        if (!cancelled) setAlts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [ride, approve]);

  if (!ride) return null;

  const parsed = Number(price);
  const moved = Number.isFinite(parsed) && parsed > 0 && parsed !== estimate;
  const blocked = approve && (!Number.isFinite(parsed) || parsed <= 0 || (moved && !reason.trim()));

  const submit = async () => {
    setBusy(true);
    await onDecide({
      ride,
      approve,
      note: note.trim() || undefined,
      final_price: approve ? parsed : undefined,
      price_adjustment_reason: approve && moved ? reason.trim() : undefined,
      suggested_vehicle_ids: !approve && picked.length ? picked : undefined,
    });
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{approve ? 'Confirm availability' : 'Mark unavailable'}</DialogTitle>
          <DialogDescription>
            {ride.vehicle_name} for {ride.guest_name} · {fmtWindow(ride.start_at, ride.end_at)}
            {ride.booking_reference ? ` · ${ride.booking_reference}` : ''}
          </DialogDescription>
        </DialogHeader>

        {approve ? (
          <div className="space-y-4">
            <div>
              <Label htmlFor="rd-price">Final price (₦)</Label>
              <Input
                id="rd-price" type="number" min={1} value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="mt-1 rounded-xl"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Guest was quoted {ngn(estimate)}. Change this only if the real cost differs.
              </p>
            </div>

            {moved && (
              <div>
                <Label htmlFor="rd-reason">Why the price changed *</Label>
                {/* The additional charges the client listed, as one-tap
                    presets. Appends rather than replaces so two charges can
                    be stacked ("Airport pickup, Waiting time"). */}
                <div className="flex flex-wrap gap-1.5 mt-1 mb-2">
                  {ADJUSTMENT_REASONS.map((r) => (
                    <button
                      key={r} type="button"
                      onClick={() => setReason((cur) => {
                        const t = cur.trim();
                        if (t.includes(r)) return cur;
                        return t ? `${t.replace(/[.,]\s*$/, '')}, ${r}` : r;
                      })}
                      className="rounded-full border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-200 hover:border-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors"
                    >
                      + {r}
                    </button>
                  ))}
                </div>
                <Textarea
                  id="rd-reason" rows={2} value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Airport pickup surcharge and one extra hour of waiting."
                  className="mt-1 rounded-xl"
                />
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                  Shown to the guest before they pay. Required — a price cannot move silently.
                </p>
              </div>
            )}

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-xs text-slate-600 dark:text-slate-300">
              Confirm a driver can realistically be arranged before approving. The
              specific driver is assigned after payment, so nothing is held against
              an unpaid booking.
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor="rd-note">Message to the guest</Label>
              <Textarea
                id="rd-note" rows={2} value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="The owner has it out for servicing that morning."
                className="mt-1 rounded-xl"
              />
            </div>

            <div>
              <Label>Suggest alternatives{ride.pickup_location?.city ? ` in ${ride.pickup_location.city}` : ''}</Label>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 mb-2">
                Optional, up to 4. Turns a dead end into another shot at the booking.
              </p>
              {alts.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400 py-2">
                  No other bookable vehicles in that city.
                </p>
              ) : (
                <div className="space-y-1.5 max-h-52 overflow-y-auto">
                  {alts.map((v) => {
                    const on = picked.includes(v.id);
                    const full = picked.length >= 4 && !on;
                    return (
                      <button
                        key={v.id} type="button" disabled={full}
                        onClick={() => setPicked((p) =>
                          on ? p.filter((x) => x !== v.id) : [...p, v.id])}
                        className={`w-full text-left rounded-xl border px-3 py-2 text-sm transition-colors ${
                          on
                            ? 'border-slate-900 dark:border-amber-500 bg-slate-50 dark:bg-slate-800'
                            : full
                              ? 'border-slate-200 dark:border-slate-800 opacity-50 cursor-not-allowed'
                              : 'border-slate-200 dark:border-slate-800 hover:border-slate-400'
                        }`}
                      >
                        <span className="font-medium text-slate-900 dark:text-white">{v.name}</span>
                        <span className="text-slate-500 dark:text-slate-400">
                          {' · '}{categoryLabel(v.category)}
                          {v.price_per_hour_ngn ? ` · ${ngn(v.price_per_hour_ngn)}/hr` : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} className="w-full sm:w-auto rounded-xl">
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={blocked || busy}
            className={`w-full sm:flex-1 rounded-xl text-white ${
              approve ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
            }`}
          >
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {approve
              ? `Confirm at ${ngn(Number.isFinite(parsed) && parsed > 0 ? parsed : estimate)}`
              : picked.length
                ? `Reject and suggest ${picked.length}`
                : 'Reject'}
          </Button>
        </div>
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
  const [completingId, setCompletingId] = useState(null);

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

  const decide = async (payload) => {
    if (!payload?.ride) return;
    const { ride, approve, note, final_price, price_adjustment_reason, suggested_vehicle_ids } = payload;
    setConfirm(null);
    setActioningId(ride.id);
    try {
      const res = await base44.functions.invoke('decideRideBooking', {
        ride_booking_id: ride.id,
        action: approve ? 'approve' : 'reject',
        note,
        final_price,
        price_adjustment_reason,
        suggested_vehicle_ids,
      });
      if (res?.data?.success) {
        toast({
          title: approve ? 'Availability confirmed' : 'Marked unavailable',
          description: approve
            ? res.data.data?.price_changed
              ? `Confirmed at ${ngn(res.data.data.total_price)} — the guest has been told the price changed and why.`
              : 'The guest has an hour to pay. They have been emailed and notified.'
            : suggested_vehicle_ids?.length
              ? `The guest has been sent ${suggested_vehicle_ids.length} alternative${suggested_vehicle_ids.length === 1 ? '' : 's'}.`
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

  // The sweep completes a ride when its booked window ends. This is for the
  // two cases it cannot handle: the guest finished early, or the ride's time
  // cannot be read. Completing never releases the driver's pay.
  const complete = async (ride) => {
    setCompletingId(ride.id);
    const r = await invokeFn('completeRide', { ride_booking_id: ride.id });
    setCompletingId(null);
    if (r.ok) {
      toast({
        title: 'Ride marked completed',
        description: `The driver's pay is released ${RELEASE_BUFFER_HOURS} hours after the booked end, or sooner from Earnings.`,
      });
    } else {
      toast({ title: 'Could not complete this ride', description: r.error, variant: 'destructive' });
    }
    await load();
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
                        {r.booking_reference && (
                          <Badge variant="outline" className="text-xs font-mono">{r.booking_reference}</Badge>
                        )}
                        {r.linked_property_booking_id && (
                          <Badge variant="outline" className="text-xs">Add-on to a stay</Badge>
                        )}
                        {Number(r.total_price) !== Number(r.estimated_price) && r.estimated_price ? (
                          <Badge className="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-0 text-xs">
                            Price adjusted
                          </Badge>
                        ) : null}
                        {r.driver_assigned && (
                          <Badge variant="outline" className="text-xs">
                            {r.driver_name ? `Driver: ${r.driver_name}` : 'Driver assigned'}
                          </Badge>
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
                          {r.extra_hour_rate_ngn ? (
                            <span className="font-normal text-xs text-slate-500 dark:text-slate-400">
                              · extra hr {ngn(r.extra_hour_rate_ngn)}
                            </span>
                          ) : null}
                        </span>
                      </div>

                      {r.special_requests && (
                        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 italic break-words">
                          &ldquo;{r.special_requests}&rdquo;
                        </p>
                      )}
                    </div>

                    {r.payment_status === 'paid' && r.status === 'confirmed'
                      && (!r.driver_assigned || r.bucket === 'upcoming' || r.bucket === 'current') && (
                      <div className="flex flex-col gap-2 flex-shrink-0 w-full sm:w-auto">
                        {/* Reassignment stays available right up to the end of the
                            ride: a driver calling in sick on the morning is the
                            case this exists for. assignRideDriver re-runs the
                            overlap and city checks and re-pushes the guest, so
                            swapping is as safe as the first assignment. */}
                        <Button
                          size="sm"
                          variant={r.driver_assigned ? 'outline' : 'default'}
                          onClick={() => setAssigning(r)}
                          className={r.driver_assigned
                            ? 'rounded-xl w-full sm:w-auto'
                            : 'rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-amber-500 dark:hover:bg-amber-600 dark:text-slate-950 text-white w-full sm:w-auto'}
                        >
                          <UserPlus className="w-4 h-4 mr-2" />
                          {r.driver_assigned ? 'Change driver' : 'Assign driver'}
                        </Button>
                      </div>
                    )}

                    {r.payment_status === 'paid' && r.status === 'confirmed'
                      && (r.bucket === 'current' || r.bucket === 'past') && (
                      <div className="flex flex-col gap-2 flex-shrink-0 w-full sm:w-auto">
                        <Button
                          size="sm" variant="outline" disabled={completingId === r.id}
                          onClick={() => complete(r)}
                          className="rounded-xl w-full sm:w-auto"
                        >
                          {completingId === r.id
                            ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            : <Check className="w-4 h-4 mr-2" />}
                          Mark completed
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

      <DecideDialog
        confirm={confirm}
        onClose={() => setConfirm(null)}
        onDecide={decide}
      />
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
      <TabsList className="grid w-full grid-cols-4 max-w-2xl">
        <TabsTrigger value="requests">
          <Inbox className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Requests</span>
        </TabsTrigger>
        <TabsTrigger value="drivers">
          <IdCard className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Drivers</span>
        </TabsTrigger>
        <TabsTrigger value="earnings">
          <Banknote className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Earnings</span>
        </TabsTrigger>
        <TabsTrigger value="reports">
          <Flag className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Reports</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="requests">
        <RideRequestsPanel />
      </TabsContent>

      <TabsContent value="drivers">
        <DriversAdmin />
      </TabsContent>

      <TabsContent value="earnings">
        <DriverEarningsAdmin />
      </TabsContent>

      <TabsContent value="reports">
        <RideReportsAdmin />
      </TabsContent>
    </Tabs>
  );
}
