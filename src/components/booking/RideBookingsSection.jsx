import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Car, Clock, MapPin, Users, Loader2, ChevronDown, X, CalendarClock, Compass,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
import { useToast } from '@/components/ui/use-toast';

// RideBookingsSection — the guest's rides, shown under their stays.
//
// Deliberately a grouped list rather than a second five-tab strip: stacking
// two tab bars on one page reads badly, and rides are far lower volume than
// stays. Groups are ordered by how much attention they need.
//
// Buckets come from getRideBookings — the client never derives them, so this
// cannot drift from what the server and admin believe.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

const fmtWhen = (iso) => {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
    });
  } catch { return '—'; }
};

const remaining = (ms) => {
  if (ms == null || ms <= 0) return null;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
};

// Module scope so the 30s refresh does not remount these and reset the
// countdown — the same reason the stay cards live at module scope.
const RideCard = React.memo(function RideCard({ ride, onCancel, cancelling }) {
  const awaitingPayment = ride.bucket !== 'cancelled' && !!ride.approved_at && ride.payment_status !== 'paid';

  const [deadlineMs] = useState(() => {
    const t = Date.parse(ride.payment_deadline || '');
    return Number.isNaN(t) ? null : t;
  });
  const [msLeft, setMsLeft] = useState(() => (deadlineMs ? Math.max(0, deadlineMs - Date.now()) : null));

  useEffect(() => {
    if (!deadlineMs || !awaitingPayment) return undefined;
    const id = setInterval(() => setMsLeft(Math.max(0, deadlineMs - Date.now())), 1000);
    return () => clearInterval(id);
  }, [deadlineMs, awaitingPayment]);

  const pickup = [ride.pickup_location?.address, ride.pickup_location?.area, ride.pickup_location?.city]
    .filter(Boolean).join(', ');

  return (
    <div
      id={`ride-${ride.id}`}
      className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden bg-white/60 dark:bg-slate-900/60"
    >
      <div className="flex flex-col sm:flex-row">
        {ride.vehicle_image ? (
          <img src={ride.vehicle_image} alt="" className="w-full sm:w-40 h-32 sm:h-auto object-cover flex-shrink-0" />
        ) : (
          <div className="w-full sm:w-40 h-32 sm:h-auto bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
            <Car className="w-8 h-8 text-slate-400" />
          </div>
        )}

        <div className="p-4 flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
            <p className="font-semibold text-slate-900 dark:text-white break-words min-w-0 flex-1">
              {ride.vehicle_name || 'Vehicle'}
            </p>
            <div className="flex flex-wrap gap-2 flex-shrink-0">
              {ride.payment_status === 'paid' && (
                <Badge className="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-0">
                  ✓ Paid
                </Badge>
              )}
              {ride.linked_property_booking_id && (
                <Badge variant="outline" className="text-xs">Added to your stay</Badge>
              )}
              {awaitingPayment && msLeft != null && msLeft > 0 && (
                <Badge className={`border font-medium ${
                  msLeft < 5 * 60 * 1000
                    ? 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-200 dark:border-red-900'
                    : 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900'
                }`}>
                  <Clock className="w-3 h-3 mr-1 inline" />
                  {remaining(msLeft)}
                </Badge>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
            <span className="flex items-start gap-1.5 sm:col-span-2">
              <CalendarClock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-words">{fmtWhen(ride.start_at)} · {ride.duration_tier}</span>
            </span>
            {pickup && (
              <span className="flex items-start gap-1.5 sm:col-span-2">
                <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span className="break-words">{pickup}</span>
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" /> {ride.passengers || 1}
            </span>
            <span className="font-semibold text-slate-900 dark:text-white">{ngn(ride.total_price)}</span>
          </div>

          {/* Stage 3 replaces this with a Pay button routed at PaymentPage.
              Until then an approved ride is settled by arrangement, so say
              that plainly rather than leaving the guest at a dead end. */}
          {awaitingPayment && (
            <div className="mt-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl p-3">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-0.5">
                Approved — we&apos;ll be in touch to take payment
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Your vehicle is held. Our team will call {ride.guest_phone} shortly to complete the booking.
              </p>
            </div>
          )}

          {ride.bucket === 'pending-approval' && (
            <div className="mt-3 flex items-start gap-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
              <Loader2 className="w-4 h-4 text-amber-500 dark:text-amber-400 animate-spin flex-shrink-0 mt-0.5" />
              <p className="text-xs text-slate-600 dark:text-slate-300">
                Checking this vehicle is free for your window. You&apos;ll get a notification either way.
              </p>
            </div>
          )}

          {ride.bucket === 'cancelled' && ride.admin_response && (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400 italic break-words">
              {ride.admin_response}
            </p>
          )}

          {ride.payment_status !== 'paid' && ride.bucket !== 'cancelled' && ride.bucket !== 'past' && (
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800">
              <Button
                variant="outline" size="sm" disabled={cancelling}
                onClick={() => onCancel(ride)}
                className="rounded-xl border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                {cancelling ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <X className="w-4 h-4 mr-2" />}
                Cancel ride
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

const GROUPS = [
  { key: 'action', label: 'Needs your attention', match: (r) => r.bucket !== 'cancelled' && r.approved_at && r.payment_status !== 'paid' },
  { key: 'pending-approval', label: 'Awaiting confirmation', match: (r) => r.bucket === 'pending-approval' },
  { key: 'current', label: 'Happening now', match: (r) => r.bucket === 'current' },
  { key: 'upcoming', label: 'Upcoming', match: (r) => r.bucket === 'upcoming' && r.payment_status === 'paid' },
];

export default function RideBookingsSection() {
  const { toast } = useToast();
  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const ridesRef = useRef(rides);

  useEffect(() => { ridesRef.current = rides; }, [rides]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await base44.functions.invoke('getRideBookings', { scope: 'mine' });
      if (res?.data?.success) setRides(res.data.data || []);
    } catch (err) {
      console.error('Could not load rides:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Refresh while anything is still awaiting a decision. Self-terminating
    // so an idle tab is not polling forever.
    const id = setInterval(() => {
      const live = ridesRef.current.some((r) => r.bucket === 'pending-approval');
      if (live) load(true);
    }, 30000);
    return () => clearInterval(id);
  }, [load]);

  const doCancel = async () => {
    if (!confirmCancel) return;
    const ride = confirmCancel;
    setConfirmCancel(null);
    setCancellingId(ride.id);
    try {
      const res = await base44.functions.invoke('cancelRideBooking', { ride_booking_id: ride.id });
      if (res?.data?.success) {
        toast({ title: 'Ride cancelled', description: 'The vehicle has been released.' });
      } else {
        toast({
          title: 'Could not cancel',
          description: res?.data?.error || 'Please try again.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({ title: 'Could not cancel', description: err?.message || 'Please try again.', variant: 'destructive' });
    } finally {
      setCancellingId(null);
      await load();
    }
  };

  if (loading) {
    return (
      <div className="mt-10 flex justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
      </div>
    );
  }

  if (rides.length === 0) return null;

  const used = new Set();
  const groups = GROUPS.map((g) => {
    const items = rides.filter((r) => !used.has(r.id) && g.match(r));
    items.forEach((r) => used.add(r.id));
    return { ...g, items };
  }).filter((g) => g.items.length > 0);

  const history = rides.filter((r) => !used.has(r.id));

  return (
    <div className="mt-10">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Compass className="w-5 h-5 text-amber-500 dark:text-amber-400" />
          My rides
        </h2>
        <Link to={createPageUrl('PlanTrip')}>
          <Button variant="outline" size="sm" className="rounded-xl">Book another</Button>
        </Link>
      </div>

      <div className="space-y-6">
        {groups.map((g) => (
          <div key={g.key}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
              {g.label}
            </p>
            <div className="space-y-3">
              {g.items.map((r) => (
                <RideCard
                  key={r.id} ride={r}
                  cancelling={cancellingId === r.id}
                  onCancel={setConfirmCancel}
                />
              ))}
            </div>
          </div>
        ))}

        {history.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
              Past &amp; cancelled ({history.length})
            </button>
            {showHistory && (
              <div className="space-y-3 mt-2">
                {history.map((r) => (
                  <RideCard key={r.id} ride={r} cancelling={false} onCancel={setConfirmCancel} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={!!confirmCancel} onOpenChange={(o) => { if (!o) setConfirmCancel(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this ride?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmCancel && (
                <span className="block">
                  <strong>{confirmCancel.vehicle_name}</strong> on {fmtWhen(confirmCancel.start_at)}.
                  <span className="block mt-2 text-xs text-slate-500 dark:text-slate-400">
                    This releases the vehicle for other guests and cannot be undone.
                  </span>
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={doCancel} className="bg-red-600 hover:bg-red-700 text-white">
              Yes, cancel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
