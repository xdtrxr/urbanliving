import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar, MapPin, Users, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';

export default function BookingConfirmCard({ booking, onSubmitted }) {
  const [status, setStatus] = useState('idle'); // idle | submitting | submitted | error
  const [error, setError] = useState(null);
  const [bookingId, setBookingId] = useState(null);

  const safeDate = (s) => {
    try { return format(parseISO(s), 'EEE, MMM d, yyyy'); }
    catch { return s; }
  };

  const handleSubmit = async () => {
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
        total_price: booking.total_price,
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

  if (status === 'submitted') {
    return (
      <Card className="bg-green-50 border-green-200 rounded-2xl shadow-sm">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-6 h-6 text-green-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold text-green-900 mb-1">Booking request submitted</p>
              <p className="text-sm text-green-800 mb-3">
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
    <Card className="bg-white border-slate-200 rounded-2xl shadow-sm">
      <CardContent className="p-5">
        <div className="mb-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Confirm your booking</p>
          <h4 className="text-lg font-bold text-slate-900">{booking.property_title}</h4>
          {booking.property_location && (
            <p className="text-sm text-slate-600 flex items-center gap-1 mt-1">
              <MapPin className="w-3.5 h-3.5" />
              {[booking.property_location.city, booking.property_location.country].filter(Boolean).join(', ')}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
          <div className="bg-slate-50 rounded-xl p-3">
            <p className="text-slate-500 text-xs mb-1 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" /> Check-in
            </p>
            <p className="font-semibold text-slate-900">{safeDate(booking.check_in)}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-3">
            <p className="text-slate-500 text-xs mb-1 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" /> Check-out
            </p>
            <p className="font-semibold text-slate-900">{safeDate(booking.check_out)}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-3">
            <p className="text-slate-500 text-xs mb-1 flex items-center gap-1">
              <Users className="w-3.5 h-3.5" /> Guests
            </p>
            <p className="font-semibold text-slate-900">{booking.guests}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-3">
            <p className="text-slate-500 text-xs mb-1">Nights</p>
            <p className="font-semibold text-slate-900">{booking.nights || ''}</p>
          </div>
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-slate-200 mb-4">
          <span className="text-slate-600">Total</span>
          <span className="text-2xl font-bold text-slate-900">
            ₦{(booking.total_price || 0).toLocaleString()}
          </span>
        </div>

        {booking.special_requests && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4">
            <p className="text-xs font-semibold text-amber-900 mb-1">Special requests</p>
            <p className="text-sm text-amber-800">{booking.special_requests}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800">{error}</p>
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
        <p className="text-xs text-slate-500 text-center mt-2">
          Admin reviews availability via Telegram. Payment happens after approval.
        </p>
      </CardContent>
    </Card>
  );
}
