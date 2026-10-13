// Stay payments — what the screens say about the money on a booking.
//
// A payment that reached Paystack for a stay the admin had never approved, or
// for one already cancelled, used to confirm the booking anyway. It is now
// HELD: the server records it as payment_status 'pending_confirmation' with
// the Paystack reference in transaction_hash, leaves status as it was and
// does not set paid_at. The admin then confirms the booking with that
// payment, or refunds it by hand in Paystack and marks it refunded
// (payment_status 'refunded', status 'cancelled').
//
// Three screens show such a booking: the payment page, My Bookings and the
// admin panel. What each one calls it, whether the guest may pay or cancel,
// and why the money is held are decided here, once, as plain functions.
// No imports on purpose: scripts/check-held-payment-screens.mjs loads this
// file as it is and runs every one of them.

const naira = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

// ── What state the money is in ──────────────────────────────────────────────
export const isPaymentHeld = (booking) => !!booking && booking.payment_status === 'pending_confirmation';

export const isPaymentRefunded = (booking) => !!booking && booking.payment_status === 'refunded';

// The three payment states in which money has already moved for a booking.
const MONEY_MOVED = ['paid', 'pending_confirmation', 'refunded'];
const moneyMoved = (booking) => !!booking && MONEY_MOVED.includes(booking.payment_status);

// The amount being held. A held row has no amount field of its own. What is
// held is a payment that would have confirmed the booking, and only a payment
// of the booking's total does that, so the total is the figure.
export const heldAmount = (booking) => Math.max(0, Number(booking && booking.total_price) || 0);

// ── What a booking's badge says ─────────────────────────────────────────────
export const HELD_LABEL = 'Payment received, awaiting confirmation';
export const REFUNDED_LABEL = 'Refunded';

// The badge on a stay: { key, label }. `key` picks the colour on the page.
// payment_status is read before status on purpose. A held booking keeps the
// status it had when the money arrived ('pending', or 'cancelled' with
// cancel_reason 'payment_expired'), and going by that it would be badged
// "Pending" or "Payment Expired" over a guest who has paid in full.
export function stayStatusLabel(booking) {
  const b = booking || {};
  if (isPaymentHeld(b)) return { key: 'payment_held', label: HELD_LABEL };
  if (isPaymentRefunded(b)) return { key: 'refunded', label: REFUNDED_LABEL };
  if (b.status === 'cancelled' && b.cancel_reason === 'payment_expired') {
    return { key: 'payment_expired', label: 'Payment Expired' };
  }
  if (b.payment_status === 'paid' && b.status !== 'cancelled') {
    return { key: 'paid', label: '✓ Payment Made' };
  }
  const status = b.status || 'pending';
  return { key: status, label: status.charAt(0).toUpperCase() + status.slice(1) };
}

// ── What the guest may do ───────────────────────────────────────────────────
// What the card for a stay that is not yet confirmed is about: the admin's
// answer to the availability request ('pending', 'approved' or 'rejected'),
// unless a payment is being held. Held outranks all three: the guest has
// paid, so the card must not say "awaiting approval", "pay now" or "declined".
export const pendingCardState = (booking, request) =>
  (isPaymentHeld(booking) ? 'held' : (request && request.status) || 'pending');

// Whether the guest is offered the payment page: the request was approved and
// no payment has been taken, held or refunded for it. `cardState` is
// pendingCardState's answer.
export const stayCanBePaid = (booking, cardState) =>
  cardState === 'approved' && !!booking && !moneyMoved(booking);

// Whether the money lets a guest cancel with one tap. Only when none has
// moved: a paid booking needs a refund decision, a held payment is already
// with the admin, and a refunded one is finished. The status and 24-hour
// rules stay on the Bookings page.
export const paymentAllowsCancel = (booking) => !!booking && !moneyMoved(booking);

// Whether My Bookings keeps asking the server about this booking, because it
// is waiting on the team: for an answer to the request, or for a decision on
// a payment being held.
export const waitsOnTeam = (booking) => !!booking
  && ((booking.status === 'pending' && booking.payment_status === 'unpaid') || isPaymentHeld(booking));

const HELD_PROMISE = 'We will confirm this booking or refund you in full. You do not need to pay again.';

// What a guest is told on the card of a held booking, as { title, body }.
export function heldNotice(booking) {
  const amount = heldAmount(booking);
  return {
    title: amount > 0 ? `We have your payment of ${naira(amount)}.` : 'We have your payment.',
    body: HELD_PROMISE,
  };
}

// ── The payment page ────────────────────────────────────────────────────────
// What startStayPayment or verifyPaystackPayment said about a payment being
// held, read off invokeFn's result: { sentence, reference }, or null when the
// answer is anything else. Both answer 409 with code PAYMENT_HELD and a
// sentence for the guest in `error`; after a payment the reference comes too,
// in `data`. invokeFn keeps `data` for answers that succeeded, so on this
// refusal it is read from the body. `paidReference` is the one Paystack gave
// the page, for an answer that names none.
export function heldPaymentFrom(result, paidReference) {
  if (!result || result.ok || result.code !== 'PAYMENT_HELD') return null;
  const body = result.body && typeof result.body === 'object' ? result.body : {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const said = typeof body.error === 'string' ? body.error.trim() : '';
  return {
    // The server always sends a sentence. Without one invokeFn falls back to
    // "Request failed with status code 409", which nobody should read here.
    sentence: said || HELD_PROMISE,
    reference: String(data.reference || paidReference || ''),
  };
}

// What pressing Pay on a ride does with startRidePayment's answer. The page
// asks again at that moment: it may have been open for an hour, and a guest
// blocked from rides since it loaded must not reach Paystack.
//   { open: true }           go on to Paystack
//   { open: false, error }   the server refused, or the ride is paid for:
//                            shown in the page's error card
//   { open: false, retry }   nothing usable came back: say so and leave the
//                            page as it is, so the guest can press Pay again
export function ridePayDecision(start) {
  if (start && start.ok) {
    return start.data && start.data.already_paid
      ? { open: false, error: 'This ride has already been paid for.' }
      : { open: true };
  }
  // A refusal is an answer in the 400s. No answer at all, or a server that
  // fell over, is not the server saying no.
  const status = Number(start && start.status) || 0;
  if (status >= 400 && status < 500) {
    return { open: false, error: (start && start.error) || 'This ride is not ready for payment.' };
  }
  return {
    open: false,
    retry: 'We could not check this ride just now, so nothing was charged. Check your connection and try again.',
  };
}

// ── Admin ───────────────────────────────────────────────────────────────────
// Why a payment is being held, in the server's own words for it (the
// hold_reason verifyPaystackPayment answers with): 'not_approved',
// 'cancelled' or 'expired'. The row does not store the reason, so it is read
// back off what the server left untouched: status, approved_at and
// cancel_reason. null for a booking with nothing held.
export function holdReason(booking) {
  if (!isPaymentHeld(booking)) return null;
  // MIRROR of stayPaymentVerdict in verifyPaystackPayment: a cancelled
  // booking is held as 'expired' or 'cancelled', a waiting one only because
  // nobody approved it. An approved booking that is still waiting is never
  // held for being late: it still has its dates, so its payment confirms it.
  if (booking.status === 'cancelled') return booking.cancel_reason === 'payment_expired' ? 'expired' : 'cancelled';
  return 'not_approved';
}

export const HOLD_REASON_TEXT = {
  not_approved: 'Held because the request has not been approved.',
  cancelled: 'Held because the booking was cancelled.',
  expired: 'Held because the booking had run out of time to pay and was cancelled.',
};

// The held booking a pending availability request belongs to, or null. The
// same lookup decideAvailabilityRequest makes when the admin presses Approve
// (bookingForRequest): the booking the request names, if it is that guest's
// booking of that property; and for a request from before requests carried an
// id, a pending booking for the same property, dates and guest.
export function heldBookingFor(request, heldBookings) {
  if (!request || !Array.isArray(heldBookings)) return null;
  const held = heldBookings.filter(isPaymentHeld);
  if (request.booking_id) {
    return held.find((b) => b.id === request.booking_id
      && b.property_id === request.property_id
      && b.guest_email === request.user_email) || null;
  }
  return held.find((b) => b.status === 'pending'
    && b.property_id === request.property_id
    && b.check_in === request.check_in
    && b.check_out === request.check_out
    && b.guest_email === request.user_email) || null;
}

// The badge on that request in the admin's pending list.
export const heldBadgeLabel = (booking) => {
  const amount = heldAmount(booking);
  return amount > 0 ? `Paid, ${naira(amount)} held` : 'Paid, payment held';
};
