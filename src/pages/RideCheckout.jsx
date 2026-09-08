import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft, Car, Clock, Users, MapPin, Loader2, AlertCircle,
  CheckCircle, Phone, ShieldCheck,
} from 'lucide-react';
import { createPageUrl } from '@/utils';
import {
  DURATION_OPTIONS, durationOptionId, estimateRidePrice, supportsHourly, minHours,
  extraHourRate,
} from '@/config/rides';
import { motion, AnimatePresence } from 'framer-motion';

// RideCheckout — the ride twin of Checkout.jsx.
//
// Two deliberate differences from the stays flow:
//
//   1. The price shown here is presentational only. checkRideAvailability
//      recomputes it from the Vehicle row and stores that. The stays flow
//      posts a client-computed total_price which the server then trusts.
//
//   2. The approval poll is bounded. Checkout.jsx polls AvailabilityRequest
//      every 3s with no timeout, so a tab left open on an undecided request
//      polls forever. This stops after MAX_POLL_TICKS and tells the guest
//      where to look instead.

// Durations come from src/config/rides.js so this page, the vehicle page and
// the server all name the same set. DURATION_OPTIONS already carries the
// hourly choices, "Full day (12 hours)", 24 hours and multi-day in order.

const POLL_MS = 3000;
const MAX_POLL_TICKS = 100; // ~5 minutes, then hand off to the Bookings page

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

export default function RideCheckoutPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);

  const vehicleId = params.get('vehicle');
  const linkedBookingId = params.get('property_booking_id') || '';

  const [vehicle, setVehicle] = useState(null);
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [form, setForm] = useState({
    service_date: '',
    start_time: '09:00',
    duration_tier: params.get('tier') || '24hr',
    duration_hours: Number(params.get('hours')) || 1,
    duration_days: Number(params.get('days')) || 2,
    passengers: 1,
    pickup_address: '',
    pickup_area: '',
    dropoff_address: '',
    special_requests: '',
  });

  const [phone, setPhone] = useState('');
  const [showPhoneModal, setShowPhoneModal] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  const [isSavingPhone, setIsSavingPhone] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [rideId, setRideId] = useState(null);
  const [decision, setDecision] = useState(null); // null | 'pending' | 'approved' | 'rejected'
  const [pollExhausted, setPollExhausted] = useState(false);
  // What admin actually confirmed. Distinct from displayTotal, which is only
  // this page's pre-submission estimate.
  const [confirmedTotal, setConfirmedTotal] = useState(null);
  const [priceChanged, setPriceChanged] = useState(null); // the row, when it differs
  const [rejectionNote, setRejectionNote] = useState('');
  const tickRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!vehicleId) {
        navigate(createPageUrl('PlanTrip'));
        return;
      }
      try {
        const [me, v] = await Promise.all([
          base44.auth.me(),
          base44.entities.Vehicle.get(vehicleId),
        ]);
        if (cancelled) return;
        setUser(me);
        setPhone(me?.phone_number || '');
        setVehicle(v);
      } catch (err) {
        console.error('RideCheckout load failed:', err);
        if (!cancelled) setLoadError('Could not load this vehicle. Please go back and try again.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [vehicleId, navigate]);

  // Bounded approval poll. Reads the guest's own row (RLS permits it), and
  // stops on a decision, on exhaustion, or on unmount.
  useEffect(() => {
    if (!rideId || decision !== 'pending') return undefined;
    let stopped = false;
    const id = setInterval(async () => {
      if (stopped) return;
      tickRef.current += 1;
      if (tickRef.current > MAX_POLL_TICKS) {
        setPollExhausted(true);
        clearInterval(id);
        return;
      }
      try {
        const row = await base44.entities.RideBooking.get(rideId);
        if (stopped || !row) return;
        if (row.status === 'cancelled') {
          setDecision('rejected');
          setRejectionNote(row.admin_response || '');
          clearInterval(id);
        } else if (row.approved_at) {
          // Admin may have confirmed at a different figure than the estimate,
          // so take the price off the row rather than trusting what this page
          // calculated before the request went in.
          setConfirmedTotal(Number(row.total_price) || null);
          setPriceChanged(
            Number(row.total_price) !== Number(row.estimated_price) ? row : null,
          );
          setDecision('approved');
          clearInterval(id);
        }
      } catch (err) {
        console.warn('Ride poll failed (will retry):', err);
      }
    }, POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [rideId, decision]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Presentational only — the server prices authoritatively from the Vehicle.
  // Shared with the vehicle page rather than recomputed, and checked against
  // the server copy by scripts/check-ride-time.mjs.
  const displayTotal = estimateRidePrice(vehicle, {
    tier: form.duration_tier,
    hours: form.duration_hours,
    days: form.duration_days,
  }) || 0;

  // Durations this particular vehicle can actually take. Hiding the hourly
  // options on a vehicle with no hourly rate is better than letting the guest
  // fill in the whole form and collect a 409 at the end.
  const availableDurations = DURATION_OPTIONS.filter((o) => {
    if (o.tier !== 'hourly') return true;
    return supportsHourly(vehicle) && o.hours >= minHours(vehicle);
  });

  const savePhone = async () => {
    setPhoneError('');
    if (!phone || phone.trim().length < 10) {
      setPhoneError('Enter a valid phone number (at least 10 digits)');
      return;
    }
    setIsSavingPhone(true);
    try {
      await base44.auth.updateMe({ phone_number: phone.trim() });
      setUser((u) => ({ ...u, phone_number: phone.trim() }));
      setShowPhoneModal(false);
    } catch (err) {
      console.error('Phone save failed:', err);
      setPhoneError('Could not save your number. Please try again.');
    }
    setIsSavingPhone(false);
  };

  const submit = useCallback(async () => {
    setSubmitError(null);

    if (!user?.phone_number) { setShowPhoneModal(true); return; }
    if (!form.service_date) { setSubmitError('Pick a pickup date.'); return; }
    if (!form.start_time) { setSubmitError('Pick a pickup time.'); return; }
    if (!form.pickup_address.trim()) { setSubmitError('Where should the driver collect you?'); return; }

    setSubmitting(true);
    try {
      const res = await base44.functions.invoke('checkRideAvailability', {
        vehicle_id: vehicleId,
        service_date: form.service_date,
        start_time: form.start_time,
        duration_tier: form.duration_tier,
        duration_hours: form.duration_tier === 'hourly' ? Number(form.duration_hours) : undefined,
        duration_days: form.duration_tier === 'multi_day' ? Number(form.duration_days) : 1,
        passengers: Number(form.passengers) || 1,
        pickup_location: {
          address: form.pickup_address.trim(),
          area: form.pickup_area.trim() || undefined,
          city: vehicle?.city,
        },
        dropoff_location: form.dropoff_address.trim()
          ? { address: form.dropoff_address.trim(), city: vehicle?.city }
          : undefined,
        special_requests: form.special_requests.trim(),
        linked_property_booking_id: linkedBookingId || undefined,
      });

      const data = res?.data;
      if (!data?.success) {
        // The server distinguishes its refusals by code so the guest gets a
        // reason they can act on rather than a generic failure.
        setSubmitError(data?.error || 'Could not submit your ride request.');
        return;
      }

      setRideId(data.data.ride_booking_id);
      setDecision(data.data.next === 'payment' ? 'approved' : 'pending');
    } catch (err) {
      console.error('Ride request failed:', err);
      setSubmitError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [user, form, vehicleId, vehicle, linkedBookingId]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (loadError || !vehicle) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="max-w-md w-full bg-white/90 dark:bg-slate-900/90 p-8 text-center">
          <AlertCircle className="w-12 h-12 text-amber-500 dark:text-amber-400 mx-auto mb-3" />
          <p className="text-slate-700 dark:text-slate-200 mb-5">{loadError || 'Vehicle not found.'}</p>
          <Link to={createPageUrl('PlanTrip')}>
            <Button className="rounded-xl">Browse vehicles</Button>
          </Link>
        </Card>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <Link to={createPageUrl(`Vehicle?id=${vehicle.id}`)}>
          <Button variant="ghost" className="mb-5 flex items-center gap-2 text-slate-600 dark:text-slate-300">
            <ArrowLeft className="w-4 h-4" /> Back to vehicle
          </Button>
        </Link>

        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-1 break-words">
            Book the {vehicle.name}
          </h1>
          <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-base">
            {linkedBookingId
              ? 'Adding this ride to your existing stay — no approval needed.'
              : 'Tell us when and where. We confirm availability before you pay.'}
          </p>
        </div>

        {/* Vehicle summary */}
        <Card className="bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-2xl mb-5 overflow-hidden">
          <div className="flex items-center gap-4 p-4">
            {vehicle.images?.[0] ? (
              <img src={vehicle.images[0]} alt="" className="w-20 h-16 rounded-xl object-cover flex-shrink-0" />
            ) : (
              <div className="w-20 h-16 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
                <Car className="w-6 h-6 text-slate-400" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-slate-900 dark:text-white truncate">{vehicle.name}</p>
              <p className="text-sm text-slate-500 dark:text-slate-400 truncate">
                {vehicle.brand} · {vehicle.city} · seats {vehicle.max_passengers || '—'}
              </p>
            </div>
          </div>
        </Card>

        {/* Form */}
        <Card className="bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-2xl mb-5">
          <CardContent className="p-5 sm:p-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="rc-date">Pickup date</Label>
                <Input
                  id="rc-date" type="date" min={today}
                  value={form.service_date}
                  onChange={(e) => set('service_date', e.target.value)}
                  className="mt-1 rounded-xl"
                />
              </div>
              <div>
                <Label htmlFor="rc-time">Pickup time</Label>
                <Input
                  id="rc-time" type="time"
                  value={form.start_time}
                  onChange={(e) => set('start_time', e.target.value)}
                  className="mt-1 rounded-xl"
                />
              </div>
            </div>

            <div>
              <Label>Duration</Label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-1">
                {availableDurations.map((o) => {
                  const active = durationOptionId(form.duration_tier, form.duration_hours) === o.id;
                  const price = estimateRidePrice(vehicle, {
                    tier: o.tier,
                    hours: o.hours,
                    days: form.duration_days,
                  });
                  return (
                    <button
                      key={o.id} type="button"
                      onClick={() => setForm((f) => ({
                        ...f,
                        duration_tier: o.tier,
                        ...(o.tier === 'hourly' ? { duration_hours: o.hours } : {}),
                      }))}
                      className={`rounded-xl border-2 px-3 py-3 text-left transition-colors ${
                        active
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <p className="font-semibold text-sm text-slate-900 dark:text-white">{o.label}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {price ? ngn(price) : '—'}
                      </p>
                    </button>
                  );
                })}
              </div>
              {!supportsHourly(vehicle) && (
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                  This vehicle is booked by the day rather than by the hour.
                </p>
              )}
            </div>

            {form.duration_tier === 'multi_day' && (
              <div>
                <Label htmlFor="rc-days">Number of days</Label>
                <Input
                  id="rc-days" type="number" min={2} max={30}
                  value={form.duration_days}
                  onChange={(e) => set('duration_days', Math.max(1, Number(e.target.value) || 1))}
                  className="mt-1 rounded-xl w-32"
                />
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="rc-pax" className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" /> Passengers
                </Label>
                <Input
                  id="rc-pax" type="number" min={1} max={vehicle.max_passengers || 8}
                  value={form.passengers}
                  onChange={(e) => set('passengers', Math.max(1, Number(e.target.value) || 1))}
                  className="mt-1 rounded-xl"
                />
              </div>
              <div>
                <Label htmlFor="rc-area">Area in {vehicle.city}</Label>
                {/* The vehicle's own pickup areas are offered as suggestions
                    so the guest lands on a district this car actually serves,
                    without being blocked from typing somewhere else in town. */}
                <Input
                  id="rc-area" value={form.pickup_area}
                  onChange={(e) => set('pickup_area', e.target.value)}
                  placeholder={(vehicle.pickup_locations || []).slice(0, 2).join(', ') || 'Wuse 2, Maitama…'}
                  list="rc-area-options"
                  className="mt-1 rounded-xl"
                />
                {(vehicle.pickup_locations?.length || 0) > 0 && (
                  <datalist id="rc-area-options">
                    {vehicle.pickup_locations.map((a) => <option key={a} value={a} />)}
                  </datalist>
                )}
              </div>
            </div>

            <div>
              <Label htmlFor="rc-pickup" className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" /> Pickup location
              </Label>
              <Input
                id="rc-pickup" value={form.pickup_address}
                onChange={(e) => set('pickup_address', e.target.value)}
                placeholder={`Street address or landmark in ${vehicle.city}`}
                className="mt-1 rounded-xl"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                This car is based in {vehicle.city}, so pickup needs to be in or around {vehicle.city}.
              </p>
            </div>

            <div>
              <Label htmlFor="rc-dropoff">Drop-off address (optional)</Label>
              <Input
                id="rc-dropoff" value={form.dropoff_address}
                onChange={(e) => set('dropoff_address', e.target.value)}
                placeholder="Leave blank if the driver stays with you"
                className="mt-1 rounded-xl"
              />
            </div>

            <div>
              <Label htmlFor="rc-notes">Special requests</Label>
              <Textarea
                id="rc-notes" rows={3} value={form.special_requests}
                onChange={(e) => set('special_requests', e.target.value)}
                placeholder="Child seat, airport pickup, specific route…"
                className="mt-1 rounded-xl"
              />
            </div>
          </CardContent>
        </Card>

        {/* Total + submit */}
        <Card className="bg-slate-50/80 dark:bg-slate-900/80 border-slate-200 dark:border-slate-800 rounded-2xl">
          <CardContent className="p-5 sm:p-6">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-300">Estimated price</p>
                <p className="text-2xl font-bold text-slate-900 dark:text-white">{ngn(displayTotal)}</p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <ShieldCheck className="w-4 h-4" /> Confirmed before payment
              </div>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Subject to availability confirmation.
              {extraHourRate(vehicle)
                ? ` Extra hours beyond your booking are ${ngn(extraHourRate(vehicle))} each, settled after the trip.`
                : ''}
            </p>

            {submitError && (
              <div className="mb-4 flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800 dark:text-red-200">{submitError}</p>
              </div>
            )}

            <Button
              onClick={submit}
              disabled={submitting || !!rideId}
              className="w-full rounded-xl bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white font-semibold py-6 text-base"
            >
              {submitting ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting…</>
              ) : linkedBookingId ? (
                <><Car className="w-4 h-4 mr-2" /> Add this ride</>
              ) : (
                <><Clock className="w-4 h-4 mr-2" /> Request availability</>
              )}
            </Button>
            <p className="text-xs text-center text-slate-500 dark:text-slate-400 mt-2">
              The final price is confirmed by our team before any payment is taken.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Phone gate */}
      <Dialog open={showPhoneModal} onOpenChange={setShowPhoneModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Phone className="w-5 h-5 text-amber-500 dark:text-amber-400" /> Add your phone number
            </DialogTitle>
            <DialogDescription>
              Your driver needs a number to reach you on the day.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="+234 801 234 5678" className="rounded-xl"
            />
            {phoneError && <p className="text-sm text-red-600 dark:text-red-400">{phoneError}</p>}
            <Button onClick={savePhone} disabled={isSavingPhone} className="w-full rounded-xl">
              {isSavingPhone ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Save and continue
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Post-submit status */}
      <AnimatePresence>
        {decision && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }}
              className="w-full max-w-md"
            >
              <Card className="bg-white dark:bg-slate-900 rounded-2xl overflow-hidden">
                <CardContent className="p-6 text-center">
                  {decision === 'pending' && !pollExhausted && (
                    <>
                      <Loader2 className="w-10 h-10 text-amber-500 dark:text-amber-400 mx-auto mb-3 animate-spin" />
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1">Your availability request has been received</h2>
                      <p className="text-sm text-slate-600 dark:text-slate-300 mb-5">
                        We&apos;re confirming the {vehicle.name} and a driver for your window and will
                        notify you shortly. Nothing has been charged.
                      </p>
                    </>
                  )}
                  {decision === 'pending' && pollExhausted && (
                    <>
                      <Clock className="w-10 h-10 text-slate-400 mx-auto mb-3" />
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1">Still reviewing</h2>
                      <p className="text-sm text-slate-600 dark:text-slate-300 mb-5">
                        This is taking longer than usual. You can safely close this page — we&apos;ll notify
                        you, and the request is waiting in My Bookings.
                      </p>
                    </>
                  )}
                  {decision === 'approved' && (
                    <>
                      <CheckCircle className="w-10 h-10 text-emerald-500 dark:text-emerald-400 mx-auto mb-3" />
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1">
                        {linkedBookingId ? 'Ride added' : 'Confirmed available'}
                      </h2>
                      <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
                        The {vehicle.name} is held for you at {ngn(confirmedTotal ?? displayTotal)},
                        with a driver arranged. Pay now to lock it in.
                      </p>
                      {/* A price that moved between quote and payment has to be
                          stated before the pay button, never discovered on the
                          Paystack screen. */}
                      {priceChanged && (
                        <div className="text-left rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-3 mb-5">
                          <p className="text-sm font-semibold text-amber-900 dark:text-amber-100 mb-1">
                            The price changed from your estimate
                          </p>
                          <p className="text-sm text-amber-900 dark:text-amber-100">
                            Estimated {ngn(priceChanged.estimated_price)} · confirmed{' '}
                            <span className="font-semibold">{ngn(priceChanged.total_price)}</span>
                          </p>
                          {priceChanged.price_adjustment_reason && (
                            <p className="text-xs text-amber-800 dark:text-amber-200 mt-1.5">
                              {priceChanged.price_adjustment_reason}
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {decision === 'rejected' && (
                    <>
                      <AlertCircle className="w-10 h-10 text-rose-500 dark:text-rose-400 mx-auto mb-3" />
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1">Not available</h2>
                      <p className="text-sm text-slate-600 dark:text-slate-300 mb-5">
                        {rejectionNote
                          || `The ${vehicle.name} isn't free for that window. Try another time or vehicle.`}
                      </p>
                    </>
                  )}

                  <div className="space-y-2">
                    {/* The client asked for this button by name. Sending an
                        approved guest to My Bookings to hunt for a pay button
                        put a needless step between "yes it's available" and
                        the payment that holds it. */}
                    {decision === 'approved' && rideId && (
                      <Button
                        onClick={() => navigate(
                          `${createPageUrl('PaymentPage')}?${new URLSearchParams({ ride_booking_id: rideId })}`,
                        )}
                        className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        Proceed to payment
                      </Button>
                    )}
                    <Button
                      variant={decision === 'approved' ? 'outline' : 'default'}
                      onClick={() => navigate(createPageUrl('Bookings'))}
                      className="w-full rounded-xl"
                    >
                      Go to My Bookings
                    </Button>
                    {decision === 'rejected' && (
                      <Button
                        variant="outline"
                        onClick={() => navigate(createPageUrl('PlanTrip'))}
                        className="w-full rounded-xl"
                      >
                        Browse other vehicles
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
