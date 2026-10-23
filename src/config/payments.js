// Stay and ride payments — what the screens say about the money on a booking.
//
// A payment that reached Paystack for a stay the admin had never approved, or
// for one already cancelled, used to confirm the booking anyway. It is now
// HELD: the server records it as payment_status 'pending_confirmation' with
// the Paystack reference in transaction_hash, leaves status as it was and
// does not set paid_at. The admin then confirms the booking with that
// payment, or refunds it by hand in Paystack and marks it refunded
// (payment_status 'refunded', status 'cancelled').
//
// Rides are held the same way, on the same row fields, and for one more
// reason: the guest has been blocked from rides since asking. "Rides", at the
// end, has the helpers whose words or rules differ for a ride.
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

// What a guest is promised about money that is being held, by what it paid
// for. `blocked` is for a guest blocked from rides since asking: that ride
// will not be confirmed, so it is not promised. Nothing on the screen says
// why; the team tells them, with the refund.
export const HELD_GUEST_TEXT = {
  stay: HELD_PROMISE,
  ride: 'We will confirm this ride or refund you in full. You do not need to pay again.',
  blocked: 'Our team will contact you about a refund. You do not need to pay again.',
};

// `kind` is 'stay' or 'ride'. `reason` is the server's hold_reason, when the
// screen has it: only the payment page does.
const promiseFor = (kind, reason) => {
  if (kind !== 'ride') return HELD_GUEST_TEXT.stay;
  return reason === 'blocked' ? HELD_GUEST_TEXT.blocked : HELD_GUEST_TEXT.ride;
};

// What a guest is told on the card of a held booking or ride, as
// { title, body }.
export function heldNotice(booking, kind = 'stay') {
  const amount = heldAmount(booking);
  return {
    title: amount > 0 ? `We have your payment of ${naira(amount)}.` : 'We have your payment.',
    body: promiseFor(kind),
  };
}

// ── The payment page ────────────────────────────────────────────────────────
// A refusal's sentence and its `data`, read off invokeFn's result. invokeFn
// keeps `data` only for answers that succeeded, so on a refusal both are read
// from the body.
function refusalOf(result) {
  const body = result && result.body && typeof result.body === 'object' ? result.body : {};
  return {
    data: body.data && typeof body.data === 'object' ? body.data : {},
    said: typeof body.error === 'string' ? body.error.trim() : '',
  };
}

// What the server said about a payment being held, read off invokeFn's
// result: { sentence, reference, reason }, or null when the answer is
// anything else. For a stay that is startStayPayment or verifyPaystackPayment,
// for a ride startRidePayment or verifyRidePayment. All four answer 409 with
// code PAYMENT_HELD and a sentence for the guest in `error`; after a payment
// the reference and the hold_reason come too, in `data`. `paidReference` is
// the one Paystack gave the page, for an answer that names none. `kind`
// ('stay' or 'ride') words the promise for an answer that has no sentence.
export function heldPaymentFrom(result, paidReference, kind = 'stay') {
  if (!result || result.ok || result.code !== 'PAYMENT_HELD') return null;
  const { data, said } = refusalOf(result);
  const reason = typeof data.hold_reason === 'string' && data.hold_reason ? data.hold_reason : null;
  return {
    // The server always sends a sentence. Without one invokeFn falls back to
    // "Request failed with status code 409", which nobody should read here.
    sentence: said || promiseFor(kind, reason),
    reference: String(data.reference || paidReference || ''),
    reason,
  };
}

const REFUNDED_SENTENCE = {
  stay: 'This payment was refunded. Request the dates again to book.',
  ride: 'This payment was refunded. Book the ride again if you still need it.',
};

// The same for a payment that has already been refunded: 409 with code
// PAYMENT_REFUNDED, from verifyRidePayment for a reference handed in again
// and from startRidePayment for a ride whose payment went back. The payment
// page gives a ride a screen of its own for it. A stay's is still an ordinary
// refusal, shown in the error card.
export function refundedPaymentFrom(result, paidReference, kind = 'stay') {
  if (!result || result.ok || result.code !== 'PAYMENT_REFUNDED') return null;
  const { data, said } = refusalOf(result);
  return {
    sentence: said || REFUNDED_SENTENCE[kind === 'ride' ? 'ride' : 'stay'],
    reference: String(data.reference || paidReference || ''),
  };
}

// What pressing Pay on a ride does with startRidePayment's answer. The page
// asks again at that moment: it may have been open for an hour, and a guest
// blocked from rides since it loaded must not reach Paystack.
//   { open: true }           go on to Paystack
//   { open: false, held }    a payment for this ride is already on hold
//                            (paid in another tab, or straight to Paystack):
//                            the held screen, never a second payment. `held`
//                            is heldPaymentFrom's answer
//   { open: false, refunded }  its payment has been refunded: the refunded
//                            screen. `refunded` is refundedPaymentFrom's
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
  const held = heldPaymentFrom(start, '', 'ride');
  if (held) return { open: false, held };
  const refunded = refundedPaymentFrom(start, '', 'ride');
  if (refunded) return { open: false, refunded };
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
  // Held and approved: the money and the approval crossed. It arrived a
  // moment before the request was approved, so it was held, and nothing
  // confirms it now but the button.
  return booking.approved_at ? 'approved_since' : 'not_approved';
}

export const HOLD_REASON_TEXT = {
  not_approved: 'Held because the request has not been approved.',
  approved_since: 'Held because it arrived just before the request was approved. Confirm the booking to finish.',
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

// ── What the admin is told after settling a held payment ────────────────────
// Only what is known to have happened. The server answers what became of the
// email to the guest: it can fail, or wait on host details the property does
// not have, and "the guest has been told" over a guest who was not is how
// nobody finds out. `data` is the function's answer.
export function confirmedNote(data) {
  const d = data || {};
  if (d.already_paid) return 'It was already paid. Nothing was changed.';
  if (d.arrival_email === 'sent') return 'The guest has been sent their arrival details.';
  if (d.arrival_email === 'waiting_for_host_details') return 'The arrival email is waiting for the host details. Answer the prompt in Telegram.';
  return 'The arrival email could not be sent. Contact the guest yourself.';
}

// For a stay and a ride alike: markHeldPaymentRefunded answers both with the
// same { refunded, guest_emailed }, or { already }.
export function refundedNote(data) {
  const d = data || {};
  if (d.already) return 'It was already marked refunded.';
  return d.guest_emailed ? 'The guest has been emailed.' : 'The email to the guest could not be sent. Tell them yourself.';
}

// The badge on that request in the admin's pending list, and on a held ride
// in the admin's ride list.
export const heldBadgeLabel = (booking) => {
  const amount = heldAmount(booking);
  return amount > 0 ? `Paid, ${naira(amount)} held` : 'Paid, payment held';
};

// ── Rides ───────────────────────────────────────────────────────────────────
// A ride is held on the row fields a stay is: payment_status
// 'pending_confirmation', the reference in transaction_hash, any further
// payment for the same ride in payment_extra_refs, status left as it was and
// paid_at unset. So the helpers above that read nothing but payment_status
// and total_price serve a ride as they are: isPaymentHeld, isPaymentRefunded,
// heldAmount, paymentAllowsCancel, heldBadgeLabel and refundedNote, and
// heldNotice, heldPaymentFrom and refundedPaymentFrom given kind 'ride'.
// What follows is what a ride does differently. A ride on My Bookings and in
// the admin's ride list comes from getRideBookings, with `bucket`, the
// server's word for where it belongs.

// The badge for the money on a ride, { key, label }, or null when there is
// nothing to say (unpaid). Read before the bucket, for the reason
// stayStatusLabel reads payment_status first.
export function ridePaymentBadge(ride) {
  if (isPaymentHeld(ride)) return { key: 'payment_held', label: HELD_LABEL };
  if (isPaymentRefunded(ride)) return { key: 'refunded', label: REFUNDED_LABEL };
  if (ride && ride.payment_status === 'paid') return { key: 'paid', label: '✓ Paid' };
  return null;
}

// Whether the guest is offered Pay on a ride: approved, still standing, and
// no payment taken, held or refunded for it. A held ride can be approved and
// standing (its guest was blocked after the approval), and must not be
// offered a second payment.
export const rideAwaitsPayment = (ride) => !!ride && ride.bucket !== 'cancelled' && ride.bucket !== 'past'
  && ride.status !== 'cancelled' && !!ride.approved_at && !moneyMoved(ride);

// Whether the guest is offered Cancel on a ride: no money has moved for it,
// and it is neither over nor cancelled already. cancelRideBooking refuses a
// held ride with PAYMENT_HELD; this keeps the button from being there.
export const rideCanBeCancelled = (ride) => !!ride && paymentAllowsCancel(ride)
  && ride.bucket !== 'cancelled' && ride.bucket !== 'past';

// Whether a ride is waiting on the team: for an answer to the request, or for
// a decision on a payment being held. My Bookings files both under "Awaiting
// confirmation", and keeps asking the server while there are any.
export const rideWaitsOnTeam = (ride) => !!ride && (ride.bucket === 'pending-approval' || isPaymentHeld(ride));

// Why a ride's payment is being held, read back off the row as holdReason
// does for a stay: 'not_approved', 'cancelled', 'expired' or
// 'after_approval'. null for a ride with nothing held.
//
// The server holds a ride's payment as 'not_approved', 'expired',
// 'cancelled' or 'blocked', and stores none of them. A cancelled ride and one
// nobody approved say which they are. One that was approved and still stands
// does not: its guest has been blocked from rides since, or the payment came
// after the window to pay had closed, or it crossed the approval. The row
// cannot tell those apart, so the admin is told all three, not a guess.
export function rideHoldReason(ride) {
  if (!isPaymentHeld(ride)) return null;
  if (ride.status === 'cancelled') return ride.cancel_reason === 'payment_expired' ? 'expired' : 'cancelled';
  return ride.approved_at ? 'after_approval' : 'not_approved';
}

export const RIDE_HOLD_REASON_TEXT = {
  not_approved: 'Held because the ride has not been approved. Approving it confirms it with this payment.',
  cancelled: 'Held because the ride was cancelled.',
  expired: 'Held because the ride had run out of time to pay and was cancelled.',
  after_approval: 'Held after the ride was approved: the guest has been blocked from rides, the window to pay had closed, or the payment crossed the approval.',
};

// What the admin is told after confirming a held ride with its payment
// (verifyRidePayment with confirm_held). The server says whether the guest
// was emailed, and anything but a plain yes is taken as no, as confirmedNote
// does for a stay. A confirmed ride still needs a driver.
export function rideConfirmedNote(data) {
  const d = data || {};
  if (d.already_paid) return 'It was already paid. Nothing was changed.';
  const told = d.guest_emailed === true
    ? 'The guest has been emailed.'
    : 'The email to the guest could not be sent. Tell them yourself.';
  return `${told} Assign a driver next.`;
}

// What the admin is told after approving or rejecting a ride whose payment
// was on hold, from decideRideBooking's answer, as { title, description }.
// Approving one held because it was never approved confirms it with that
// payment (confirmed_with_payment); rejecting one leaves a refund owed
// (refund_owed). null for a decision that touched no money, so the panel
// keeps its usual words. The email to the guest is mentioned only when the
// answer says what became of it.
export function rideHeldDecisionNote(data) {
  const d = data || {};
  if (d.refund_owed) {
    return {
      title: 'Rejected. A refund is owed',
      description: 'The guest had already paid for this ride. Refund it in Paystack, then press "Mark refunded" under Payments on hold.',
    };
  }
  if (d.confirmed_with_payment) {
    const told = d.guest_emailed === true
      ? ' The guest has been emailed.'
      : d.guest_emailed === false ? ' The email to the guest could not be sent. Tell them yourself.' : '';
    return {
      title: 'Approved and paid',
      description: `The ride is confirmed with the payment that was on hold.${told} Assign a driver next.`,
    };
  }
  return null;
}
