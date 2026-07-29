import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar, MapPin, Users, CheckCircle2, Loader2, AlertCircle, Shield } from 'lucide-react';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import LeadOtpGate from './LeadOtpGate';

const SERVICE_FEE_RATE = 0.025;

// Computes canonical pricing from the property + dates so we don't trust LLM
// math. Falls back to whatever booking values Nova sent if property isn't
// available yet. Mirrors the breakdown shown on the Checkout page.
function computeBreakdown(booking, property) {
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

  const breakdown = useMemo(() => computeBreakdown(booking, property), [booking, property]);

  const safeDate = (s) => {
    try { return format(parseISO(s), 'EEE, MMM d, yyyy'); }
    catch { return s; }
  };

  const submitBooking = async () => {
    setStatus('submitting');
    setError(null);
    try {
      const result = await base44.functions.invoke('checkAvailabilityWebhook', {
        property_id: booking.property_id,
        property_title: booking.property_title,
        property_location: booking.property_location,
        check_in: booking.check_in,
        check_out: booking.check_out,
        guests: booking.guests,
        total_price: breakdown.total,
        special_requests: booking.special_requests || '',
      });
      const data = result?.data;
      if (!data?.success) throw new Error(data?.error || 'Failed to submit booking');
      setBookingId(data.data.booking_id);
      setStatus('submitted');
      onSubmitted?.(data.data);
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

        <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-4 mb-4 space-y-2 text-sm">
          <div className="flex justify-between text-slate-700 dark:text-slate-200">
            <span>₦{breakdown.nightly.toLocaleString()} × {breakdown.nights} {breakdown.nights === 1 ? 'night' : 'nights'}</span>
            <span className="font-medium">₦{breakdown.subtotal.toLocaleString()}</span>
          </div>
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
          disabled={status === 'submitting'}
          className="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-xl py-6 text-base font-semibold"
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
