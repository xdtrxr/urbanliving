import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, RefreshCw, PauseCircle, AlertCircle, AlertTriangle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { invokeFn } from '@/lib/invokeFn';
import { useToast } from '@/components/ui/use-toast';
import { isPaymentHeld, heldAmount, holdReason, HOLD_REASON_TEXT } from '@/config/payments';

// HeldPaymentsAdmin — stay payments the server is holding.
//
// A payment that reaches Paystack for a booking the admin never approved, or
// for one already cancelled, no longer confirms it. The server holds it: the
// money is in Paystack, the booking is not confirmed, and the guest has been
// told we will confirm or refund. One of the two has to happen here.
//
//   Confirm booking   verifyPaystackPayment { confirm_held } asks Paystack
//                     whether the payment still stands, checks the dates are
//                     still free, and confirms the booking with it.
//   Mark refunded     markHeldPaymentRefunded only RECORDS a refund. The
//                     money goes back by hand, in the Paystack dashboard,
//                     first. That is what the second step is there to say.
//
// The list is read from Booking itself, not through a function: the read rule
// already shows an admin every row, and the list keeps loading on a day the
// backend functions are not answering. The card renders nothing at all while
// nothing is held, which is nearly always.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

// Newest request first, and a ceiling. A filter given neither answers with
// the platform's default page in the platform's own order.
const SORT = '-created_date';
const LIMIT = 50;
// In step with the pending requests list this card sits beside.
const POLL_MS = 15000;

export default function HeldPaymentsAdmin({ properties = [], reloadKey = 0, onLoaded, onSettled }) {
  const { toast } = useToast();
  const [bookings, setBookings] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [workingId, setWorkingId] = useState(null);
  // The server's sentence for a refused "Confirm booking", by booking id.
  const [refusals, setRefusals] = useState({});
  // "Mark refunded" waiting for its second step: { booking, refused }, where
  // `refused` is the server's sentence if that step was tried and refused.
  const [toRefund, setToRefund] = useState(null);

  // In a ref so `load` never changes: the poll below would otherwise start
  // again every time the page re-rendered with a new callback.
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => { onLoadedRef.current = onLoaded; }, [onLoaded]);
  const latest = useRef(0);

  const load = useCallback(async (silent = false) => {
    latest.current += 1;
    const mine = latest.current;
    if (!silent) setRefreshing(true);
    try {
      const rows = await base44.entities.Booking.filter({ payment_status: 'pending_confirmation' }, SORT, LIMIT);
      // Two loads can be in the air at once: the poll, and the one asked for
      // straight after an action. Only the newest may write. The older
      // answer would put a payment that was just settled back on screen.
      if (mine !== latest.current) return;
      const held = (Array.isArray(rows) ? rows : []).filter(isPaymentHeld);
      setBookings(held);
      onLoadedRef.current?.(held);
    } catch (err) {
      console.error('Failed to load held payments:', err);
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  // reloadKey is the page saying something changed elsewhere: a request was
  // approved or rejected in the list next door, which settles a held payment
  // without going through this card.
  useEffect(() => {
    load(true);
    const t = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(t);
  }, [load, reloadKey]);

  const who = (b) => b.guest_name || b.guest_email;
  const titleOf = (b) => properties.find((p) => p.id === b.property_id)?.title || b.property_id;

  // One path for both buttons. invokeFn never throws: a refusal arrives as
  // r.error, the server's own sentence. Answers with that sentence when the
  // server refused, and with null when the payment has left the list.
  const settle = async (booking, fn, body, done) => {
    setWorkingId(booking.id);
    const r = await invokeFn(fn, body);
    setWorkingId(null);
    if (!r.ok && r.code !== 'NOT_HELD') return r.error;
    // NOT_HELD: nothing is held for this booking any more. Somebody settled
    // it first, in another tab or from the requests list, so the row is out
    // of date and goes with the reload. A sentence shown on the row would go
    // with it, which is why this one refusal is a toast.
    toast(r.ok
      ? { title: done, description: `${who(booking)} · ${titleOf(booking)}` }
      : { title: 'Already settled', description: r.error, variant: 'destructive' });
    await load(true);
    onSettled?.();
    return null;
  };

  const confirmBooking = async (booking) => {
    setRefusals((prev) => ({ ...prev, [booking.id]: null }));
    const refused = await settle(
      booking, 'verifyPaystackPayment', { booking_id: booking.id, confirm_held: true }, 'Booking confirmed',
    );
    if (refused) setRefusals((prev) => ({ ...prev, [booking.id]: refused }));
  };

  const markRefunded = async () => {
    if (!toRefund) return;
    const { booking } = toRefund;
    const refused = await settle(
      booking, 'markHeldPaymentRefunded', { booking_id: booking.id }, 'Marked refunded',
    );
    setToRefund(refused ? { booking, refused } : null);
  };

  // Stays up for an open dialog even if the last held payment has just left
  // the list, so the admin is answered instead of the dialog vanishing.
  if (bookings.length === 0 && !toRefund) return null;

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg mb-8">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <CardTitle className="flex items-center gap-2 min-w-0">
            <PauseCircle className="w-5 h-5 flex-shrink-0" />
            <span className="truncate">Payments on hold</span>
            {bookings.length > 0 && (
              <Badge className="bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-900">
                {bookings.length}
              </Badge>
            )}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => load()}
            disabled={refreshing}
            className="rounded-xl self-start sm:self-auto flex-shrink-0"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
        <CardDescription>
          Paid, but not confirmed: the booking was never approved, or was already cancelled, when the money arrived.
          Confirm the booking with the payment, or refund it in Paystack and then mark it refunded.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {bookings.map((b) => (
            <div
              key={b.id}
              className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4"
            >
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex-1 min-w-[260px]">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <p className="font-semibold text-slate-900 dark:text-white break-words min-w-0">{titleOf(b)}</p>
                    <Badge className="bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-900 text-xs">
                      {ngn(heldAmount(b))} held
                    </Badge>
                  </div>
                  <p className="text-sm text-slate-600 dark:text-slate-300 break-words">
                    <span className="font-medium">{who(b)}</span> · {b.guest_email}
                  </p>
                  <p className="text-sm text-slate-700 dark:text-slate-200 mt-1">
                    {b.check_in} → {b.check_out} · {b.guests} guest{b.guests === 1 ? '' : 's'}
                    {b.bedrooms_booked > 0 && <>{' · '}<span className="font-medium">{b.bedrooms_booked}-bedroom option</span></>}
                  </p>
                  <p className="text-xs text-orange-700 dark:text-orange-300 mt-2">
                    {HOLD_REASON_TEXT[holdReason(b)]}
                  </p>
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-2 break-all">
                    Paystack reference <code className="font-mono select-all">{b.transaction_hash || 'not recorded'}</code>
                    {' · '}Booking <code className="font-mono">{b.id}</code>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => confirmBooking(b)}
                    disabled={workingId !== null}
                    className="bg-green-600 hover:bg-green-700 text-white rounded-xl"
                  >
                    {workingId === b.id ? 'Working…' : 'Confirm booking'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setToRefund({ booking: b, refused: null })}
                    disabled={workingId !== null}
                    className="rounded-xl border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
                  >
                    Mark refunded
                  </Button>
                </div>
              </div>
              {refusals[b.id] && (
                <div className="mt-3 flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
                  <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-800 dark:text-red-200">{refusals[b.id]}</p>
                </div>
              )}
            </div>
          ))}
          {bookings.length >= LIMIT && (
            <p className="text-xs text-slate-500 dark:text-slate-400 text-center pt-2">
              Showing the newest {LIMIT}. Older ones appear as these are settled.
            </p>
          )}
        </div>
      </CardContent>

      <Dialog open={!!toRefund} onOpenChange={(o) => { if (!o && workingId === null) setToRefund(null); }}>
        <DialogContent className="max-w-md">
          {toRefund && (
            <>
              <DialogHeader>
                <DialogTitle>Mark this payment refunded?</DialogTitle>
                <DialogDescription>
                  {ngn(heldAmount(toRefund.booking))} · {who(toRefund.booking)} · {titleOf(toRefund.booking)}
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl p-3">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  Only after you have refunded it in Paystack.
                </p>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                This sends no money. It records that you have refunded the guest, and cancels the booking.
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-300 break-all">
                Paystack reference <code className="font-mono select-all">{toRefund.booking.transaction_hash || 'not recorded'}</code>
              </p>
              {toRefund.refused && (
                <div className="flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
                  <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-800 dark:text-red-200">{toRefund.refused}</p>
                </div>
              )}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setToRefund(null)} disabled={workingId !== null} className="rounded-xl">
                  Not yet
                </Button>
                <Button
                  onClick={markRefunded}
                  disabled={workingId !== null}
                  className="rounded-xl bg-red-600 hover:bg-red-700 text-white"
                >
                  {workingId !== null ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Yes, I have refunded it
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
