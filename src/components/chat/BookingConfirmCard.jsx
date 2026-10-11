import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar, MapPin, Users, CheckCircle2, Loader2, AlertCircle, Shield } from 'lucide-react';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import LeadOtpGate from './LeadOtpGate';
import { bookingOptionsOf, priceStay } from '@/config/stays';
import { invokeFn } from '@/lib/invokeFn';

const SERVICE_FEE_RATE = 0.025;

// Computes canonical pricing from the property + dates so we don't trust LLM
// math. Falls back to whatever booking values Nova sent if property isn't
// available yet. Mirrors the breakdown shown on the Checkout page.
function computeBreakdown(booking, property, option) {
  // The same night-by-night sum the server charges, once the property is in.
  const priced = property && option ? priceStay(property, booking?.check_in, booking?.check_out, option.bedrooms) : null;
  if (priced) {
    return { nightly: option.price_per_night, nights: priced.nights, subtotal: priced.subtotal, serviceFee: priced.serviceFee, caution: priced.cautionFee, total: priced.total, lines: priced.lines };
  }
  const nightlyFromProp = Number(property?.price_per_night);
  const nightly = Number.isFinite(nightlyFromProp) && nightlyFromProp > 0
    ? nightlyFromProp
    : Number(booking?.price_per_night) || 0;
  const cautionFromProp = Number(property?.caution_fee);
  const caution = Number.isFinite(cautionFromProp)
    ? cautionFromProp
    : Number(booking?.caution_fee) || 0;
  let nights = 0;
  try {
    const ci = parseISO(booking.check_in);
    const co = parseISO(booking.check_out);
    nights = Math.max(differenceInCalendarDays(co, ci), 0);
  } catch { /* noop */ }
  if (!nights && booking?.nights) nights = Number(booking.nights) || 0;
  const subtotal = nightly * nights;
  const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE);
  const total = subtotal + serviceFee + caution;
  return { nightly, nights, subtotal, serviceFee, caution, total };
}

export default function BookingConfirmCard({ booking, lead, isAuthenticated, onAuthenticated, onSubmitted }) {
  const [status, setStatus] = useState('idle'); // idle | gate | submitting | submitted | error
  const [error, setError] = useState(null);
  const [bookingId, setBookingId] = useState(null);
  const [property, setProperty] = useState(null);

  // Pull canonical price_per_night + caution_fee from the property record so
  // the breakdown reflects what the user will actually pay — never the LLM's
  // arithmetic.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!booking?.property_id) return;
      try {
        const p = await base44.entities.Property.get(booking.property_id);
        if (!cancelled) setProperty(p);
      } catch (err) {
        console.warn('BookingConfirmCard: property fetch failed (fail-open):', err);
      }
    })();
    return () => { cancelled = true; };
  }, [booking?.property_id]);

  // Which booking option, as a bedroom count. An option too small for the
  // party cannot be picked. Until the guest picks, it is the one the chat
  // named, else the only one that fits. When several fit and the chat named
  // none, nothing is chosen for the guest: they have to say.
  const [bedrooms, setBedrooms] = useState(0);
  const options = useMemo(() => bookingOptionsOf(property), [property]);
  const party = Math.round(Number(booking?.guests)) || 0;
  const tooSmall = (o) => o.max_guests > 0 && party > o.max_guests;
  const fitting = options.filter((o) => !tooSmall(o));
  const option = options.length <= 1
    ? options[0] || null
    : fitting.find((o) => o.bedrooms === bedrooms)
      || fitting.find((o) => o.bedrooms === Math.round(Number(booking?.bedrooms)))
      || (fitting.length === 1 ? fitting[0] : null);
  const mustChoose = options.length > 1 && fitting.length > 0 && !option;
  // Nothing here takes a party this size: say so instead of letting the
  // request go and come back refused.
  const partyTooBig = options.length > 0 && fitting.length === 0;
  const largest = options.reduce((most, o) => Math.max(most, o.max_guests), 0);
  const breakdown = useMemo(() => computeBreakdown(booking, property, option), [booking, property, option]);

  const safeDate = (s) => {
    try { return format(parseISO(s), 'EEE, MMM d, yyyy'); }
    catch { return s; }
  };

  const submitBooking = async () => {
    setStatus('submitting');
    setError(null);
    try {
      const result = await invokeFn('checkAvailabilityWebhook', {
        property_id: booking.property_id,
        property_title: booking.property_title,
        property_location: booking.property_location,
        check_in: booking.check_in,
        check_out: booking.check_out,
        guests: booking.guests,
        bedrooms: options.length > 1 && option ? option.bedrooms : undefined,
        special_requests: booking.special_requests || '',
      });
      if (!result.ok) throw new Error(result.error || 'Failed to submit booking');
      setBookingId(result.data.booking_id);
      setStatus('submitted');
      onSubmitted?.(result.data);
    } catch (err) {
      console.error('Booking submission failed:', err);
      setError(err.message || 'Something went wrong');
      setStatus('error');
    }
  };

  const handleSubmit = async () => {
    // Anon users: confirm their email and verify OTP first; account gets created
    // inside LeadOtpGate, then we submit. Signed-in users skip the gate.
    if (!isAuthenticated) {
      setStatus('gate');
      return;
    }
    await submitBooking();
  };

  const handleGateVerified = async () => {
    await onAuthenticated?.();
    await submitBooking();
  };

  if (status === 'gate') {
    return (
      <LeadOtpGate
        lead={lead}
        onVerified={handleGateVerified}
        onCancel={() => setStatus('idle')}
      />
    );
  }

  if (status === 'submitted') {
    return (
      <Card className="bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-900 rounded-2xl shadow-sm">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold text-green-900 dark:text-green-200 mb-1">Booking request submitted</p>
              <p className="text-sm text-green-800 dark:text-green-200 mb-3">
                Admin has been notified via Telegram. You'll get an email once they approve, then you can complete payment.
              </p>
              <Link to={createPageUrl('Bookings')}>
                <Button size="sm" className="bg-green-700 hover:bg-green-800 text-white rounded-xl">
                  View in Bookings
                </Button>
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm">
      <CardContent className="p-5">
        <div className="mb-4">
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Confirm your booking</p>
          <h4 className="text-lg font-bold text-slate-900 dark:text-white">{booking.property_title}</h4>
          {booking.property_location && (
            <p className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1 mt-1">
              <MapPin className="w-3.5 h-3.5" />
              {[booking.property_location.city, booking.property_location.country].filter(Boolean).join(', ')}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
          <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3">
            <p className="text-slate-500 dark:text-slate-400 text-xs mb-1 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" /> Check-in
            </p>
            <p className="font-semibold text-slate-900 dark:text-white">{safeDate(booking.check_in)}</p>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">from 2:00 PM</p>
          </div>
          <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3">
            <p className="text-slate-500 dark:text-slate-400 text-xs mb-1 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" /> Check-out
            </p>
            <p className="font-semibold text-slate-900 dark:text-white">{safeDate(booking.check_out)}</p>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">by 12:00 PM</p>
          </div>
          <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3">
            <p className="text-slate-500 dark:text-slate-400 text-xs mb-1 flex items-center gap-1">
              <Users className="w-3.5 h-3.5" /> Guests
            </p>
            <p className="font-semibold text-slate-900 dark:text-white">{booking.guests}</p>
          </div>
          <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3">
            <p className="text-slate-500 dark:text-slate-400 text-xs mb-1">Nights</p>
            <p className="font-semibold text-slate-900 dark:text-white">{breakdown.nights || ''}</p>
          </div>
        </div>

        {options.length > 1 && (
          <fieldset className="mb-4" disabled={status === 'submitting' || status === 'submitted'}>
            <legend className="text-sm font-medium text-slate-900 dark:text-white mb-2">How many bedrooms do you want?</legend>
            <div className="space-y-2">
              {options.map((o) => (
                <label
                  key={o.bedrooms}
                  className={`flex items-center gap-3 p-3 rounded-xl border text-sm ${tooSmall(o) ? 'opacity-60' : 'cursor-pointer'} ${option?.bedrooms === o.bedrooms ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30' : 'border-slate-200 dark:border-slate-700'}`}
                >
                  <input type="radio" name={`booking_option_${booking.property_id}`} disabled={tooSmall(o)} checked={option?.bedrooms === o.bedrooms} onChange={() => setBedrooms(o.bedrooms)} />
                  <span className="flex-1 text-slate-800 dark:text-slate-100">
                    {o.bedrooms} bedroom{o.bedrooms > 1 ? 's' : ''}
                    {o.max_guests > 0 && (
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        Up to {o.max_guests} guests{tooSmall(o) ? `, too small for ${party}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="font-semibold text-slate-900 dark:text-white">₦{o.price_per_night.toLocaleString()}/night</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {partyTooBig && (
          <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3 mb-4 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800 dark:text-red-200">
              This property takes up to {largest} guests, and this request is for {party}. Ask for a larger place or a smaller party.
            </p>
          </div>
        )}

        {mustChoose ? (
          <p className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-4 mb-4 text-sm text-slate-600 dark:text-slate-300">
            Choose how many bedrooms you want to see the price.
          </p>
        ) : (
        <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-4 mb-4 space-y-2 text-sm">
          {breakdown.lines ? breakdown.lines.map((line) => (
            <div key={line.from} className="flex justify-between gap-3 text-slate-700 dark:text-slate-200">
              <span>
                ₦{line.rate.toLocaleString()} × {line.nights} {line.nights === 1 ? 'night' : 'nights'}
                {line.season && <span className="block text-xs text-amber-700 dark:text-amber-300">{line.season}</span>}
              </span>
              <span className="font-medium">₦{(line.rate * line.nights).toLocaleString()}</span>
            </div>
          )) : (
          <div className="flex justify-between text-slate-700 dark:text-slate-200">
            <span>₦{breakdown.nightly.toLocaleString()} × {breakdown.nights} {breakdown.nights === 1 ? 'night' : 'nights'}</span>
            <span className="font-medium">₦{breakdown.subtotal.toLocaleString()}</span>
          </div>
          )}
          <div className="flex justify-between text-slate-700 dark:text-slate-200">
            <span>Service fee (2.5%)</span>
            <span className="font-medium">₦{breakdown.serviceFee.toLocaleString()}</span>
          </div>
          {breakdown.caution > 0 && (
            <div className="flex justify-between items-center py-2 px-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg">
              <span className="text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5" />
                Refundable caution fee
              </span>
              <span className="font-semibold text-amber-900 dark:text-amber-200">₦{breakdown.caution.toLocaleString()}</span>
            </div>
          )}
          <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800">
            <span className="text-slate-600 dark:text-slate-300 font-medium">Total</span>
            <span className="text-2xl font-bold text-slate-900 dark:text-white">
              ₦{breakdown.total.toLocaleString()}
            </span>
          </div>
          {breakdown.caution > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Caution fee of ₦{breakdown.caution.toLocaleString()} is fully refunded after checkout inspection.
            </p>
          )}
        </div>
        )}

        {booking.special_requests && (
          <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl p-3 mb-4">
            <p className="text-xs font-semibold text-amber-900 dark:text-amber-200 mb-1">Special requests</p>
            <p className="text-sm text-amber-800 dark:text-amber-200">{booking.special_requests}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3 mb-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        <Button
          onClick={handleSubmit}
          disabled={status === 'submitting' || mustChoose || partyTooBig}
          className="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-xl py-6 text-base font-semibold dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
        >
          {status === 'submitting' ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting...</>
          ) : (
            'Submit Booking Request'
          )}
        </Button>
        <p className="text-xs text-slate-500 dark:text-slate-400 text-center mt-2">
          Admin reviews availability via Telegram. Payment happens after approval.
        </p>
      </CardContent>
    </Card>
  );
}
