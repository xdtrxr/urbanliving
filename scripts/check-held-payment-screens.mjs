// Held payments on the screens — run with: node scripts/check-held-payment-screens.mjs
//
// A stay payment that arrives for a booking nobody approved, or for one
// already cancelled, is HELD by the server instead of confirming the booking.
// Three screens then have to tell the truth about it: the payment page, My
// Bookings and the admin panel. A guest who has paid in full must never be
// shown "Pending", "Payment Expired", a Pay button or a Cancel button, and an
// admin must never be one press away from recording a refund nobody made.
//
// What each screen says is decided by the plain functions in
// src/config/payments.js. This file runs them as shipped, feeds them the
// answers the server contract promises through the real result reader
// (src/lib/fnResult.js), and reads the screens' source to see that they still
// ask those functions rather than deciding for themselves.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HELD_LABEL, REFUNDED_LABEL, HOLD_REASON_TEXT,
  isPaymentHeld, isPaymentRefunded, heldAmount, stayStatusLabel, pendingCardState, stayCanBePaid,
  paymentAllowsCancel, waitsOnTeam, heldNotice, heldPaymentFrom, ridePayDecision, holdReason,
  heldBookingFor, heldBadgeLabel, confirmedNote, refundedNote,
  HELD_GUEST_TEXT, RIDE_HOLD_REASON_TEXT, refundedPaymentFrom, ridePaymentBadge, rideAwaitsPayment,
  rideCanBeCancelled, rideWaitsOnTeam, rideHoldReason, rideConfirmedNote, rideHeldDecisionNote,
} from '../src/config/payments.js';
import { fromResponse, fromThrown } from '../src/lib/fnResult.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FN = (name) => path.join(ROOT, 'base44/functions', name, 'entry.ts');

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// What the browser has in hand after a call, built the way the SDK builds it:
// a 2xx resolves, anything else is thrown by axios with the body on
// err.response. Both go through the reader invokeFn uses.
const answered = (data) => fromResponse({ status: 200, data: { success: true, data } });
const refused = (status, body) => fromThrown(Object.assign(
  new Error(`Request failed with status code ${status}`),
  { response: { status, data: { success: false, ...body } } },
));
const unanswered = () => fromThrown(new Error('Network Error'));

// Bookings as the server leaves them.
const booking = (fields) => ({
  id: 'b1', property_id: 'p1', guest_name: 'Ada Obi', guest_email: 'ada@example.com',
  check_in: '2026-12-13', check_out: '2026-12-17', guests: 2, total_price: 120000,
  status: 'pending', payment_status: 'unpaid', ...fields,
});
const HELD = { payment_status: 'pending_confirmation', transaction_hash: 'LUX_b1_1760000000000' };
const heldNeverApproved = booking({ ...HELD });
const heldCancelled = booking({ ...HELD, status: 'cancelled', cancel_reason: 'user_cancelled', approved_at: '2026-10-12T08:00:00Z' });
const heldExpired = booking({ ...HELD, status: 'cancelled', cancel_reason: 'payment_expired', approved_at: '2026-10-12T08:00:00Z' });
const heldNotSweptYet = booking({ ...HELD, approved_at: '2026-10-12T08:00:00Z' });
const refunded = booking({ status: 'cancelled', payment_status: 'refunded', transaction_hash: 'LUX_b1_1760000000000' });
const paid = booking({ status: 'confirmed', payment_status: 'paid', approved_at: '2026-10-12T08:00:00Z' });
const approved = booking({ approved_at: '2026-10-12T08:00:00Z' });
const naira = (n) => `₦${n.toLocaleString()}`;

// ── The schema these read ──────────────────────────────────────────────────
console.log('\n— the Booking schema —');
const statuses = ((read('base44/entities/Booking.jsonc').match(/"payment_status"\s*:\s*\{[\s\S]*?"enum"\s*:\s*\[([\s\S]*?)\]/) || [])[1] || '')
  .match(/"[^"]+"/g) || [];
check('payment_status can be pending_confirmation and refunded, the two values the screens branch on',
  ['"pending_confirmation"', '"refunded"'].every((v) => statuses.includes(v)), true);
check('held is pending_confirmation', [isPaymentHeld(heldNeverApproved), isPaymentHeld(approved), isPaymentHeld(paid), isPaymentHeld(refunded), isPaymentHeld(null)], [true, false, false, false, false]);
check('refunded is refunded', [isPaymentRefunded(refunded), isPaymentRefunded(heldNeverApproved), isPaymentRefunded(paid), isPaymentRefunded(undefined)], [true, false, false, false]);
check('the amount held is the booking total', [heldAmount(heldNeverApproved), heldAmount({ total_price: '45000' }), heldAmount({}), heldAmount(null), heldAmount({ total_price: -5 })], [120000, 45000, 0, 0, 0]);

// ── The badge ──────────────────────────────────────────────────────────────
console.log('\n— the badge: payment_status is read before status —');
const badge = (b) => { const s = stayStatusLabel(b); return [s.key, s.label]; };
check('the words', [HELD_LABEL, REFUNDED_LABEL], ['Payment received, awaiting confirmation', 'Refunded']);
check('paid before approval: not "Pending"', badge(heldNeverApproved), ['payment_held', HELD_LABEL]);
check('paid after the window closed: not "Payment Expired"', badge(heldExpired), ['payment_held', HELD_LABEL]);
check('paid after a cancellation: not "Cancelled"', badge(heldCancelled), ['payment_held', HELD_LABEL]);
check('refunded: not "Cancelled"', badge(refunded), ['refunded', REFUNDED_LABEL]);
check('refunded: not "Payment Expired" either', badge({ ...refunded, cancel_reason: 'payment_expired' }), ['refunded', REFUNDED_LABEL]);
console.log('  the badges that were already there say what they said');
check('expired without paying', badge(booking({ status: 'cancelled', cancel_reason: 'payment_expired' })), ['payment_expired', 'Payment Expired']);
check('paid and confirmed', badge(paid), ['paid', '✓ Payment Made']);
check('paid, then cancelled', badge({ ...paid, status: 'cancelled' }), ['cancelled', 'Cancelled']);
check('waiting for an answer', badge(booking({})), ['pending', 'Pending']);
check('approved, not yet paid', badge(approved), ['pending', 'Pending']);
check('completed', badge({ ...paid, status: 'completed' }), ['paid', '✓ Payment Made']);
check('cancelled by the guest', badge(booking({ status: 'cancelled', cancel_reason: 'user_cancelled' })), ['cancelled', 'Cancelled']);
check('a row with no status is its schema default, not a crash', [badge({}), badge(null)], [['pending', 'Pending'], ['pending', 'Pending']]);

// ── The pending card ───────────────────────────────────────────────────────
console.log('\n— the pending card: held outranks the admin\'s answer —');
const request = (status) => ({ status, admin_response: 'x' });
check('the answer to the request is what the card is about', ['pending', 'approved', 'rejected'].map((s) => pendingCardState(approved, request(s))), ['pending', 'approved', 'rejected']);
check('no request found reads as pending', [pendingCardState(approved, null), pendingCardState(approved, {})], ['pending', 'pending']);
check('a held payment outranks every answer', [null, 'pending', 'approved', 'rejected'].map((s) => pendingCardState(heldCancelled, s && request(s))), ['held', 'held', 'held', 'held']);
const offered = (b, r) => stayCanBePaid(b, pendingCardState(b, r));
check('approved and unpaid: Proceed to Payment', offered(approved, request('approved')), true);
check('not approved yet: nothing to pay', [offered(booking({}), request('pending')), offered(booking({}), null)], [false, false]);
check('rejected: nothing to pay', offered(booking({}), request('rejected')), false);
check('held, whatever the request says: no Pay button, so no countdown',
  [heldNeverApproved, heldCancelled, heldExpired, heldNotSweptYet].flatMap((b) => ['pending', 'approved', 'rejected'].map((s) => offered(b, request(s)))),
  Array(12).fill(false));
check('and no Pay button even if the card is told "approved" outright', [stayCanBePaid(heldExpired, 'approved'), stayCanBePaid(refunded, 'approved'), stayCanBePaid(paid, 'approved')], [false, false, false]);
check('no booking, no button', stayCanBePaid(null, 'approved'), false);

// ── Cancel and polling ─────────────────────────────────────────────────────
console.log('\n— cancel, and when to keep asking —');
check('no money has moved: the guest may cancel', [paymentAllowsCancel(booking({})), paymentAllowsCancel(approved)], [true, true]);
check('a row that never had a payment_status is unpaid, as before', paymentAllowsCancel(booking({ payment_status: undefined })), true);
check('paid: through support, as before', paymentAllowsCancel(paid), false);
check('held: no Cancel button', [paymentAllowsCancel(heldNeverApproved), paymentAllowsCancel(heldNotSweptYet)], [false, false]);
check('refunded: no Cancel button', paymentAllowsCancel(refunded), false);
check('nothing to cancel', paymentAllowsCancel(null), false);
check('a request waiting for an answer is polled, as before', waitsOnTeam(booking({})), true);
check('a held payment is polled until the admin settles it', [waitsOnTeam(heldNeverApproved), waitsOnTeam(heldCancelled), waitsOnTeam(heldExpired)], [true, true, true]);
check('settled bookings are not', [waitsOnTeam(paid), waitsOnTeam(refunded), waitsOnTeam(booking({ status: 'cancelled' })), waitsOnTeam(null)], [false, false, false, false]);

// ── What the guest is told ─────────────────────────────────────────────────
console.log('\n— the notice —');
const notice = heldNotice(heldNeverApproved);
check('the card says how much we have, that we will confirm or refund, and not to pay again',
  `${notice.title} ${notice.body}`,
  `We have your payment of ${naira(120000)}. We will confirm this booking or refund you in full. You do not need to pay again.`);
check('the same words whichever way it came to be held', [heldNotice(heldCancelled), heldNotice(heldExpired)], [notice, notice]);
check('no amount on the row: no "₦0"', heldNotice({}).title, 'We have your payment.');

// ── The payment page ───────────────────────────────────────────────────────
console.log('\n— the payment page: what the server said —');
const SAID = 'We have your payment for this booking. We will confirm it or refund you in full.';
const onLoad = refused(409, { code: 'PAYMENT_HELD', error: SAID });
check('opening the page for a held booking: its own screen, with the server\'s sentence', heldPaymentFrom(onLoad), { sentence: SAID, reference: '', reason: null });
const afterPaying = refused(409, { code: 'PAYMENT_HELD', error: SAID, data: { booking_id: 'b1', reference: 'LUX_b1_1760000000000', amount_ngn: 120000, hold_reason: 'not_approved' } });
check('paying into a booking nobody approved: held, with the reference and the reason', heldPaymentFrom(afterPaying, 'LUX_b1_1760000000000'), { sentence: SAID, reference: 'LUX_b1_1760000000000', reason: 'not_approved' });
check('the reference is the server\'s when the two differ', heldPaymentFrom(afterPaying, 'something-else').reference, 'LUX_b1_1760000000000');
check('an answer that names no reference shows the one Paystack gave the page', heldPaymentFrom(onLoad, 'LUX_b1_2').reference, 'LUX_b1_2');
const wordless = heldPaymentFrom(refused(409, { code: 'PAYMENT_HELD' }));
check('a held answer with no sentence still reassures, and never shows the status line', [/status code/.test(wordless.sentence), wordless.sentence], [false, notice.body]);
console.log('  everything else is not a held payment');
const refundedAnswer = refused(409, { code: 'PAYMENT_REFUNDED', error: 'This payment was refunded. Request the dates again to book.' });
check('refunded: an ordinary refusal, shown with its sentence', [heldPaymentFrom(refundedAnswer), refundedAnswer.error], [null, 'This payment was refunded. Request the dates again to book.']);
check('not approved yet', heldPaymentFrom(refused(409, { code: 'NOT_APPROVED', error: 'This booking has not been approved yet' })), null);
const unverified = refused(402, { error: 'Payment not verified' });
check('paid but Paystack does not confirm it: the "could not verify" message, with the reason', [heldPaymentFrom(unverified, 'ref'), unverified.error], [null, 'Payment not verified']);
check('a payment that confirmed the booking', heldPaymentFrom(answered({ booking_id: 'b1', paid_at: '2026-10-12T09:00:00Z' }), 'ref'), null);
check('a server that says PAYMENT_HELD on a 200 has not refused', heldPaymentFrom({ ok: true, code: 'PAYMENT_HELD' }), null);
check('no answer at all', [heldPaymentFrom(unanswered(), 'ref'), heldPaymentFrom(null), heldPaymentFrom(undefined)], [null, null, null]);

console.log('\n— rides: pressing Pay asks the server again —');
check('still payable: open Paystack', ridePayDecision(answered({ ride_booking_id: 'r1', total_price: 80000 })), { open: true });
check('paid in another tab: say so, do not charge twice', ridePayDecision(answered({ already_paid: true, ride_booking_id: 'r1' })), { open: false, error: 'This ride has already been paid for.' });
const blocked = 'Ride bookings are not available on this account. Please contact support.';
check('blocked since the page loaded: the server\'s sentence, no Paystack', ridePayDecision(refused(403, { code: 'RIDE_BLOCKED', error: blocked })), { open: false, error: blocked });
check('window closed since the page loaded', ridePayDecision(refused(409, { code: 'WINDOW_CLOSED', error: 'The payment window for this ride has closed.' })), { open: false, error: 'The payment window for this ride has closed.' });
check('cancelled since the page loaded', ridePayDecision(refused(409, { code: 'CANCELLED', error: 'This ride was cancelled' })).open, false);
const noAnswer = ridePayDecision(unanswered());
check('nothing came back: no Paystack, no error card, try again', [noAnswer.open, 'error' in noAnswer, /try again/.test(noAnswer.retry)], [false, false, true]);
check('the server fell over: the same', ridePayDecision(refused(500, { error: 'Internal server error' })), noAnswer);
check('no result in hand: the same', [ridePayDecision(null), ridePayDecision(undefined)], [noAnswer, noAnswer]);
check('Paystack is never opened without a yes', [refused(401, { error: 'Unauthorized' }), refused(404, { error: 'Ride booking not found' }), refused(402, {}), unanswered()].map((r) => ridePayDecision(r).open), [false, false, false, false]);

// ── Admin ──────────────────────────────────────────────────────────────────
console.log('\n— admin: why it is held —');
check('paid before the request was answered', holdReason(heldNeverApproved), 'not_approved');
check('paid into a cancelled booking', [holdReason(heldCancelled), holdReason({ ...heldCancelled, cancel_reason: 'admin_rejected' }), holdReason({ ...heldCancelled, cancel_reason: undefined })], ['cancelled', 'cancelled', 'cancelled']);
check('paid after the sweep expired it', holdReason(heldExpired), 'expired');
// The server never holds an approved booking for being late: while it is
// still waiting it still has its dates, and its payment confirms it. If one
// is ever seen held, it is not called "expired".
check('an approved booking that is still waiting is never "expired": the money and the approval crossed', holdReason(heldNotSweptYet), 'approved_since');
check('nothing held, no reason', [holdReason(approved), holdReason(paid), holdReason(refunded), holdReason(null)], [null, null, null, null]);
// The server's three reasons, and one the screen works out for itself: a
// payment held a moment before its request was approved.
check('a sentence for each of the server\'s three reasons and for the crossed approval, and no others', Object.keys(HOLD_REASON_TEXT).sort(), ['approved_since', 'cancelled', 'expired', 'not_approved']);
check('each one a sentence the admin can read', Object.values(HOLD_REASON_TEXT).every((t) => /^Held because .+\.$/.test(t)), true);

console.log('\n— admin: which pending request is already paid for —');
const pendingRequest = { id: 'q1', property_id: 'p1', check_in: '2026-12-13', check_out: '2026-12-17', user_email: 'ada@example.com', status: 'pending' };
check('the request for the same property, dates and guest', heldBookingFor(pendingRequest, [heldNeverApproved]), heldNeverApproved);
check('picked out of a list of several', heldBookingFor(pendingRequest, [booking({ ...HELD, id: 'b9', property_id: 'p9' }), heldNeverApproved]).id, 'b1');
check('another guest\'s request for those dates', heldBookingFor({ ...pendingRequest, user_email: 'bola@example.com' }, [heldNeverApproved]), null);
check('the same guest, other dates', heldBookingFor({ ...pendingRequest, check_out: '2026-12-18' }, [heldNeverApproved]), null);
check('the same guest and dates, another property', heldBookingFor({ ...pendingRequest, property_id: 'p2' }, [heldNeverApproved]), null);
check('a held booking that is cancelled: Approve would not find it, so the button must not promise to confirm it', heldBookingFor(pendingRequest, [heldCancelled, heldExpired]), null);
// A request names its booking (since 2026-10-12), and Approve acts on that
// booking and no other, whatever else matches.
const cancelledOne = { ...heldCancelled, id: 'b-cancelled' };
const named = { ...pendingRequest, booking_id: cancelledOne.id };
check('a request that names its booking finds that booking, cancelled or not', heldBookingFor(named, [heldNeverApproved, cancelledOne]), cancelledOne);
check('and no other, even one for the same property, dates and guest', heldBookingFor({ ...pendingRequest, booking_id: 'some-other-booking' }, [heldNeverApproved]), null);
check('a named booking that is somebody else\'s is not it', heldBookingFor({ ...named, user_email: 'bola@example.com' }, [cancelledOne]), null);
check('a booking nobody has paid for', heldBookingFor(pendingRequest, [booking({}), paid]), null);
check('nothing held, or nothing loaded yet', [heldBookingFor(pendingRequest, []), heldBookingFor(pendingRequest, null), heldBookingFor(null, [heldNeverApproved])], [null, null, null]);
check('its badge', [heldBadgeLabel(heldNeverApproved), heldBadgeLabel({})], [`Paid, ${naira(120000)} held`, 'Paid, payment held']);

// ── The screens ask these functions (source) ───────────────────────────────
console.log('\n— the payment page (source) —');
const PAGE = read('src/pages/PaymentPage.jsx');
const PAYMENT_CALLS = ['startStayPayment', 'startRidePayment', 'verifyPaystackPayment', 'verifyRidePayment'];
check('none of the four payment calls is a bare invoke, which throws on a refusal',
  PAYMENT_CALLS.filter((name) => new RegExp(`functions\\.invoke\\(\\s*['"]${name}['"]`).test(PAGE)), []);
check('all four go through invokeFn', PAYMENT_CALLS.filter((name) => !PAGE.includes(`invokeFn('${name}'`)), []);
check('a ride is asked about twice: when the page loads and when Pay is pressed', PAGE.split("invokeFn('startRidePayment'").length - 1, 2);
const sliceOf = (src, from, to) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  return start === -1 || end === -1 ? '' : src.slice(start, end);
};
const onPay = sliceOf(PAGE, 'const handlePayment = async', '// PREVENT ANY AUTOMATIC REDIRECTS');
check('pressing Pay asks before Paystack is opened, and stops on anything but a yes',
  onPay.indexOf('ridePayDecision(') !== -1 && onPay.indexOf('ridePayDecision(') < onPay.indexOf('handlePaystackPayment()')
  && /if \(!decision\.open\) \{[\s\S]*?return;/.test(onPay), true);
check('a refusal goes to the error card', /if \(decision\.error\) setError\(decision\.error\);/.test(onPay), true);
const onSuccess = sliceOf(PAGE, 'const handlePaymentSuccess = async', 'const handlePaystackPayment = async');
const heldAt = onSuccess.indexOf('heldPaymentFrom(result');
check('a held payment leaves before milestones are awarded and before "Payment Successful"',
  heldAt !== -1 && /if \(held\) \{[\s\S]*?return;/.test(onSuccess.slice(heldAt))
  && heldAt < onSuccess.indexOf('awardBookingMilestones(') && heldAt < onSuccess.indexOf('setPaymentComplete(true)'), true);
check('the "received but could not verify" message is still there for the rest', /could not verify it automatically/.test(onSuccess), true);
const heldScreen = sliceOf(PAGE, 'if (heldPayment) {', 'if (refundedPayment) {');
check('the held screen has both headings, the sentence, the reference and one way out',
  ['Payment received, booking not confirmed yet', 'We have your payment', '{heldPayment.sentence}', '{heldPayment.reference}', 'View my bookings'].filter((t) => !heldScreen.includes(t)), []);
check('and nothing to pay with, no "Payment Successful", no ID step', /handlePayment|Payment Successful|IdUploadGate/.test(heldScreen), false);
check('it comes ahead of the error card', PAGE.indexOf('if (heldPayment) {') !== -1 && PAGE.indexOf('if (heldPayment) {') < PAGE.indexOf('if (error) {'), true);
check('the expiry alert does not fire over a payment that was made, is held or was refunded',
  /if \(!hasExpired \|\| !bookingData\?\.id \|\| paymentComplete \|\| heldPayment \|\| refundedPayment\) return;/.test(PAGE), true);

console.log('\n— the payment page, rides (source) —');
const rideLoad = sliceOf(PAGE, "const start = await invokeFn('startRidePayment'", 'setBookingData({');
const loadRefusal = sliceOf(rideLoad, 'if (!start.ok) {', 'return;');
check('opening the page for a held ride: the held screen, read in ride words',
  loadRefusal.includes("heldPaymentFrom(start, '', 'ride')") && /if \(held\) setHeldPayment\(held\);/.test(loadRefusal), true);
check('for a refunded one: the refunded screen',
  loadRefusal.includes("refundedPaymentFrom(start, '', 'ride')") && /else if \(refunded\) setRefundedPayment\(refunded\);/.test(loadRefusal), true);
check('both are looked for before the error card is',
  loadRefusal.indexOf('setHeldPayment(') !== -1 && loadRefusal.indexOf('setRefundedPayment(') !== -1
  && loadRefusal.indexOf('setHeldPayment(') < loadRefusal.indexOf('setError(') && loadRefusal.indexOf('setRefundedPayment(') < loadRefusal.indexOf('setError('), true);
const payRefusal = sliceOf(onPay, 'if (!decision.open) {', 'return;');
check('pressing Pay on a ride held since the page loaded: the held screen, not Paystack',
  /if \(decision\.held\) setHeldPayment\(decision\.held\);/.test(payRefusal), true);
check('on one refunded since: the refunded screen',
  /else if \(decision\.refunded\) setRefundedPayment\(decision\.refunded\);/.test(payRefusal), true);
check('ahead of the error card and the retry', payRefusal.indexOf('decision.held') !== -1 && payRefusal.indexOf('decision.held') < payRefusal.indexOf('decision.error')
  && payRefusal.indexOf('decision.refunded') < payRefusal.indexOf('decision.error'), true);
check('after paying, a ride\'s hold is read in ride words', onSuccess.includes("heldPaymentFrom(result, transactionRef, isRide ? 'ride' : 'stay')"), true);
const refundedAt = onSuccess.indexOf("isRide ? refundedPaymentFrom(result, transactionRef, 'ride') : null");
check('and a ride\'s refunded reference leaves before milestones and before "Payment Successful"',
  refundedAt !== -1 && /if \(refunded\) \{\s*setRefundedPayment\(refunded\);\s*return;/.test(onSuccess.slice(refundedAt))
  && refundedAt < onSuccess.indexOf('awardBookingMilestones(') && refundedAt < onSuccess.indexOf('setPaymentComplete(true)'), true);
check('a stay\'s refunded reference is left as it was: the "could not verify" message',
  /isRide \? refundedPaymentFrom/.test(onSuccess) && !/:\s*refundedPaymentFrom\(/.test(onSuccess), true);
check('only the ride paths ever show the refunded screen',
  PAGE.split('setRefundedPayment(').length - 1 === 3 && !sliceOf(PAGE, 'const stayStart = await', 'const bookingInfo').includes('refunded'), true);
check('the held screen names a ride a ride', heldScreen.includes("isRide ? 'Payment received, ride not confirmed yet' : 'Payment received, booking not confirmed yet'"), true);
const refundedScreen = sliceOf(PAGE, 'if (refundedPayment) {', 'if (error) {');
check('the refunded screen has the sentence, the reference, and a way to book again or see the bookings',
  ['Payment refunded', '{refundedPayment.sentence}', '{refundedPayment.reference}', "createPageUrl('PlanTrip')", "createPageUrl('Bookings')"].filter((t) => !refundedScreen.includes(t)), []);
check('and nothing to pay with, no "Payment Successful", no ID step', /handlePayment|Payment Successful|IdUploadGate|Pay ₦/.test(refundedScreen), false);
const order = ['if (heldPayment) {', 'if (refundedPayment) {', 'if (error) {', 'if (!bookingData) {', 'if (paymentComplete) {'].map((t) => PAGE.indexOf(t));
check('held, then refunded, ahead of the error card, the missing booking, success and the Pay button',
  order.every((at) => at !== -1) && order.every((at, i) => i === 0 || order[i - 1] < at), true);

console.log('\n— My Bookings (source) —');
const BOOKINGS = read('src/pages/Bookings.jsx');
const colours = (sliceOf(BOOKINGS, 'const statusColors = {', '\n};').match(/^ {2}(\w+):/gm) || []).map((k) => k.trim().replace(':', ''));
const keys = [heldNeverApproved, refunded, paid, approved, booking({ status: 'confirmed' }), { ...paid, status: 'completed', payment_status: 'unpaid' },
  booking({ status: 'cancelled' }), booking({ status: 'cancelled', cancel_reason: 'payment_expired' })].map((b) => stayStatusLabel(b).key);
check('every badge the function can ask for has a colour on the page', keys.filter((k) => !colours.includes(k)), []);
check('the badge on a booking card is stayStatusLabel\'s', /const s = stayStatusLabel\(booking\);/.test(BOOKINGS) && !/labelForStatus/.test(BOOKINGS), true);
check('the pending card is keyed on pendingCardState', /const approvalStatus = pendingCardState\(booking, availabilityRequest\);/.test(BOOKINGS), true);
check('Proceed to Payment and the countdown both hang on stayCanBePaid',
  /const canPay = stayCanBePaid\(booking, approvalStatus\);/.test(BOOKINGS) && /\{canPay && msLeft != null && msLeft > 0 && \(/.test(BOOKINGS)
  && /\{canPay && \(\s*<Link to=\{`\$\{createPageUrl\('PaymentPage'\)\}/.test(BOOKINGS), true);
check('nothing else on the page links to the payment page', BOOKINGS.split("createPageUrl('PaymentPage')").length - 1, 1);
check('the pending card shows the held badge and the notice', /\{approvalStatus === 'held' && HELD_LABEL\}/.test(BOOKINGS) && /\{approvalStatus === 'held' && <HeldPaymentNotice booking=\{booking\} \/>\}/.test(BOOKINGS), true);
check('the admin\'s earlier answer is not repeated over a held payment', /\{approvalStatus !== 'held' && availabilityRequest\?\.admin_response && \(/.test(BOOKINGS), true);
check('the card used in the Cancelled tab shows the same notice', /\{isPaymentHeld\(booking\) && <HeldPaymentNotice booking=\{booking\} \/>\}/.test(BOOKINGS), true);
check('and a way to reach support', /\{isPaymentHeld\(booking\) && \(\s*<Link to=\{createPageUrl\('Support'\)\}>[\s\S]{0,200}?Contact Support\s*<\/Button>/.test(BOOKINGS), true);
check('the notice is heldNotice\'s words', /const notice = heldNotice\(booking\);/.test(BOOKINGS), true);
check('Cancel is refused first by paymentAllowsCancel', /if \(!paymentAllowsCancel\(booking\)\) return false;/.test(BOOKINGS), true);
check('the page keeps polling by waitsOnTeam', /bookingsRef\.current\.some\(waitsOnTeam\)/.test(BOOKINGS), true);

console.log('\n— My Bookings, rides (source) —');
const RIDES = read('src/components/booking/RideBookingsSection.jsx');
check('Pay on a ride hangs on rideAwaitsPayment', /const awaitingPayment = rideAwaitsPayment\(ride\);/.test(RIDES), true);
check('and is the one link to the payment page, inside that block',
  RIDES.split("createPageUrl('PaymentPage')").length - 1 === 1
  && /\{awaitingPayment && \(\s*<div[^>]*>[\s\S]{0,300}?createPageUrl\('PaymentPage'\)/.test(RIDES), true);
check('the money badge is ridePaymentBadge\'s, and no card decides "Paid" for itself',
  /const moneyBadge = ridePaymentBadge\(ride\);/.test(RIDES) && /\{moneyBadge\.label\}/.test(RIDES) && !RIDES.includes('✓ Paid'), true);
const rideBadgeStyles = (sliceOf(RIDES, 'const MONEY_BADGE_STYLE = {', '\n};').match(/^ {2}(\w+):/gm) || []).map((k) => k.trim().replace(':', ''));
check('every money badge it can ask for has a colour',
  ['pending_confirmation', 'refunded', 'paid'].map((s) => ridePaymentBadge({ id: `r-badge-${s}`, payment_status: s }).key).filter((k) => !rideBadgeStyles.includes(k)), []);
check('a held ride shows the notice, in ride words', /\{held && <HeldRideNotice ride=\{ride\} \/>\}/.test(RIDES) && /const notice = heldNotice\(ride, 'ride'\);/.test(RIDES), true);
check('"Nothing has been charged" is never said over a held ride', /\{ride\.bucket === 'pending-approval' && !held && \(/.test(RIDES), true);
check('Cancel hangs on rideCanBeCancelled, and there is one Cancel button',
  /\{rideCanBeCancelled\(ride\) && \(\s*<div[^>]*>\s*<Button[\s\S]{0,700}?Cancel ride\s*<\/Button>/.test(RIDES) && RIDES.split('Cancel ride').length - 1 === 1, true);
const groupsSrc = sliceOf(RIDES, 'const GROUPS = [', '];');
check('a ride that needs paying is filed by rideAwaitsPayment, one waiting on the team by rideWaitsOnTeam',
  /key: 'action',[^\n]*match: rideAwaitsPayment \}/.test(groupsSrc) && /key: 'pending-approval',[^\n]*match: rideWaitsOnTeam \}/.test(groupsSrc), true);
check('a held ride is filed before Happening now and Upcoming can take it',
  groupsSrc.indexOf("key: 'pending-approval'") !== -1 && groupsSrc.indexOf("key: 'pending-approval'") < groupsSrc.indexOf("key: 'current'")
  && groupsSrc.indexOf("key: 'pending-approval'") < groupsSrc.indexOf("key: 'upcoming'"), true);
check('the list keeps asking while a ride waits on the team', /ridesRef\.current\.some\(rideWaitsOnTeam\)/.test(RIDES), true);

console.log('\n— admin (source) —');
const CARD = read('src/components/admin/HeldPaymentsAdmin.jsx');
check('the list is read with an explicit sort and limit',
  /entities\.Booking\.filter\(\{ payment_status: 'pending_confirmation' \}, SORT, LIMIT\)/.test(CARD)
  && /const SORT = '-created_date';/.test(CARD) && /const LIMIT = \d+;/.test(CARD), true);
check('Confirm booking is verifyPaystackPayment with confirm_held', /'verifyPaystackPayment', \{ booking_id: booking\.id, confirm_held: true \}/.test(CARD), true);
check('Mark refunded is markHeldPaymentRefunded, for a stay and for a ride', /'markHeldPaymentRefunded', ride \? \{ ride_booking_id: booking\.id \} : \{ booking_id: booking\.id \}/.test(CARD), true);
check('Confirm ride is verifyRidePayment with confirm_held', /'verifyRidePayment', \{ ride_booking_id: ride\.id, confirm_held: true \}/.test(CARD), true);
check('the card lists held rides as well as stays', /base44\.entities\.RideBooking\.filter\(\{ payment_status: 'pending_confirmation' \}/.test(CARD), true);
check('both go through invokeFn, so a refusal is the server\'s sentence', /const r = await invokeFn\(fn, body\);/.test(CARD) && !/functions\.invoke\(/.test(CARD), true);
check('the second step says when it may be pressed', CARD.includes('Only after you have refunded it in Paystack.'), true);
check('the Mark refunded button on a row only opens that step', /onClick=\{\(\) => setToRefund\(\{ booking: b, refused: null \}\)\}/.test(CARD), true);
check('the refund is recorded from inside the dialog and nowhere else',
  CARD.split('onClick={markRefunded}').length - 1 === 1 && CARD.indexOf('onClick={markRefunded}') > CARD.indexOf('<Dialog open='), true);
check('the card shows nothing at all when nothing is held', /const count = bookings\.length \+ rides\.length;/.test(CARD) && /if \(count === 0 && !toRefund\) return null;/.test(CARD), true);
check('why it is held comes from holdReason', /HOLD_REASON_TEXT\[holdReason\(b\)\]/.test(CARD), true);
const ADMIN = read('src/pages/Admin.jsx');
check('the card is mounted on the admin page, with the properties it has loaded', /<HeldPaymentsAdmin\s+properties=\{properties\}/.test(ADMIN), true);
check('a pending request whose booking is held is badged', /\{heldFor\(req\) && \(\s*<Badge [^>]*>\{heldBadgeLabel\(heldFor\(req\)\)\}<\/Badge>/.test(ADMIN), true);
check('and its approve button says what approving does', /heldFor\(req\) \? '✅ Approve and confirm payment' : '✅ Approve'/.test(ADMIN), true);
check('approve and reject go through invokeFn', /invokeFn\('decideAvailabilityRequest'/.test(ADMIN) && !/functions\.invoke\(\s*'decideAvailabilityRequest'/.test(ADMIN), true);
check('a decision reloads the held list', /setHeldReloadKey\(\(n\) => n \+ 1\);/.test(ADMIN) && /reloadKey=\{heldReloadKey\}/.test(ADMIN), true);

// ── The server side, once it is in this checkout ───────────────────────────
// The names below cross the wire, so both sides have to spell them alike.
// The server half of this change is written separately. Until it has landed
// these are skipped, out loud, rather than failed.
console.log('\n— the server speaks the same words —');
const serverSrc = (name) => (fs.existsSync(FN(name)) ? fs.readFileSync(FN(name), 'utf8') : '');
const verify = serverSrc('verifyPaystackPayment');
if (!verify.includes('PAYMENT_HELD')) {
  console.log('  --   verifyPaystackPayment does not hold payments in this checkout yet: skipped');
} else {
  check('startStayPayment answers PAYMENT_HELD, the code the payment page looks for', serverSrc('startStayPayment').includes('PAYMENT_HELD'), true);
  check('verifyPaystackPayment takes confirm_held and can answer NOT_HELD', ['confirm_held', 'NOT_HELD'].filter((w) => !verify.includes(w)), []);
  check('markHeldPaymentRefunded exists', fs.existsSync(FN('markHeldPaymentRefunded')), true);
  check('a held booking is written as pending_confirmation', verify.includes('pending_confirmation'), true);
}

console.log('\n— what the admin is told after settling one —');
// The server says what became of the email to the guest. The screen repeats
// that, and never says the guest was told when the server did not say so.
check('confirmed, arrival email sent', confirmedNote({ confirmed: true, arrival_email: 'sent' }), 'The guest has been sent their arrival details.');
check('confirmed, the property has no host details', /waiting for the host details/.test(confirmedNote({ arrival_email: 'waiting_for_host_details' })), true);
check('confirmed, the email failed: the admin is told to contact the guest', /could not be sent/.test(confirmedNote({ arrival_email: 'not_sent' })), true);
check('an answer that does not say: the same, never "has been sent"', [confirmedNote({}), confirmedNote(null), confirmedNote(undefined)].every((t) => /could not be sent/.test(t)), true);
check('it was already paid', /already paid/.test(confirmedNote({ already_paid: true, arrival_email: 'sent' })), true);
check('refunded, guest emailed', refundedNote({ refunded: true, guest_emailed: true }), 'The guest has been emailed.');
check('refunded, the email failed', [refundedNote({ refunded: true, guest_emailed: false }), refundedNote({}), refundedNote(null)].every((t) => /could not be sent/.test(t)), true);
check('already marked refunded', /already marked refunded/.test(refundedNote({ already: true })), true);

// ── Rides ──────────────────────────────────────────────────────────────────
// A ride payment is held on the same row fields, for the stay's reasons and
// one more: the guest has been blocked from rides since asking. Rides as
// getRideBookings hands them to My Bookings and to the admin's ride list,
// each with the server's bucket. Every fixture has an id of its own.
console.log('\n— rides: the helpers —');
const APPROVED_AT = '2026-10-20T08:00:00.000Z';
const ride = (fields) => ({
  id: 'r-asked', vehicle_id: 'v1', vehicle_name: 'Toyota Prado', guest_name: 'Bola Ade', guest_email: 'bola@example.com',
  start_at: '2026-12-20T09:00:00.000Z', end_at: '2026-12-20T21:00:00.000Z', duration_tier: '12hr',
  total_price: 85000, estimated_price: 85000, status: 'pending', payment_status: 'unpaid', bucket: 'pending-approval', ...fields,
});
const rideHeld = (id, fields) => ride({ id, payment_status: 'pending_confirmation', transaction_hash: `LUX_${id}_1760000000000`, ...fields });
const rideAsked = ride({});
const rideApproved = ride({ id: 'r-approved', approved_at: APPROVED_AT, bucket: 'upcoming', payment_deadline: '2026-10-20T09:00:00.000Z' });
const rideHeldUnapproved = rideHeld('r-held-unapproved', {});
const rideHeldApproved = rideHeld('r-held-approved', { approved_at: APPROVED_AT, bucket: 'upcoming' });
const rideHeldNow = rideHeld('r-held-now', { approved_at: APPROVED_AT, bucket: 'current' });
const rideHeldCancelled = rideHeld('r-held-cancelled', { status: 'cancelled', cancel_reason: 'user_cancelled', bucket: 'cancelled' });
const rideHeldRejected = rideHeld('r-held-rejected', { status: 'cancelled', cancel_reason: 'admin_rejected', bucket: 'cancelled' });
const rideHeldExpired = rideHeld('r-held-expired', { status: 'cancelled', cancel_reason: 'payment_expired', approved_at: APPROVED_AT, bucket: 'cancelled' });
const rideRefunded = ride({ id: 'r-refunded', status: 'cancelled', cancel_reason: 'admin_rejected', payment_status: 'refunded', transaction_hash: 'LUX_r-refunded_1', bucket: 'cancelled' });
const ridePaid = ride({ id: 'r-paid', status: 'confirmed', payment_status: 'paid', approved_at: APPROVED_AT, bucket: 'upcoming' });
const ridePast = ride({ id: 'r-past', status: 'completed', payment_status: 'paid', approved_at: APPROVED_AT, bucket: 'past' });
const rideLapsed = ride({ id: 'r-lapsed', status: 'cancelled', cancel_reason: 'payment_expired', approved_at: APPROVED_AT, bucket: 'cancelled' });
const allHeldRides = [rideHeldUnapproved, rideHeldApproved, rideHeldNow, rideHeldCancelled, rideHeldRejected, rideHeldExpired];
check('the fixtures have ids of their own',
  new Set([rideAsked, rideApproved, ...allHeldRides, rideRefunded, ridePaid, ridePast, rideLapsed].map((r) => r.id)).size, 12);
check('the shared readers serve a ride as they are',
  [isPaymentHeld(rideHeldApproved), isPaymentRefunded(rideRefunded), heldAmount(rideHeldApproved), heldBadgeLabel(rideHeldApproved), paymentAllowsCancel(rideHeldApproved)],
  [true, true, 85000, `Paid, ${naira(85000)} held`, false]);

const rideBadge = (r) => { const b = ridePaymentBadge(r); return b && [b.key, b.label]; };
check('a held ride is badged held, whatever its status or bucket', allHeldRides.map(rideBadge), Array(6).fill(['payment_held', HELD_LABEL]));
check('a refunded ride says Refunded', rideBadge(rideRefunded), ['refunded', REFUNDED_LABEL]);
check('a paid ride says Paid, as before', [rideBadge(ridePaid), rideBadge(ridePast)], [['paid', '✓ Paid'], ['paid', '✓ Paid']]);
check('an unpaid ride has no money badge', [rideBadge(rideAsked), rideBadge(rideApproved), rideBadge(rideLapsed), rideBadge(null)], [null, null, null, null]);

check('approved and unpaid: Pay', rideAwaitsPayment(rideApproved), true);
check('held, even approved and still standing: no Pay', allHeldRides.map(rideAwaitsPayment), Array(6).fill(false));
check('not approved, paid, refunded, lapsed or nothing: no Pay',
  [rideAsked, ridePaid, ridePast, rideRefunded, rideLapsed, null].map(rideAwaitsPayment), Array(6).fill(false));
check('a row that never had a payment_status is unpaid, as before', rideAwaitsPayment({ ...rideApproved, payment_status: undefined }), true);

check('no money moved and still standing: Cancel', [rideCanBeCancelled(rideAsked), rideCanBeCancelled(rideApproved)], [true, true]);
check('held: no Cancel', allHeldRides.map(rideCanBeCancelled), Array(6).fill(false));
check('paid, refunded, over or cancelled: no Cancel, as before',
  [ridePaid, ridePast, rideRefunded, rideLapsed, null].map(rideCanBeCancelled), Array(5).fill(false));

check('waiting on the team: a request with no answer, and every held ride', [rideAsked, ...allHeldRides].map(rideWaitsOnTeam), Array(7).fill(true));
check('not waiting on the team', [rideApproved, ridePaid, ridePast, rideRefunded, rideLapsed, null].map(rideWaitsOnTeam), Array(6).fill(false));

check('why a ride is held, read off the row',
  [rideHeldUnapproved, rideHeldApproved, rideHeldNow, rideHeldCancelled, rideHeldRejected, rideHeldExpired].map(rideHoldReason),
  ['not_approved', 'after_approval', 'after_approval', 'cancelled', 'cancelled', 'expired']);
check('nothing held, no reason', [rideAsked, rideApproved, ridePaid, rideRefunded, null].map(rideHoldReason), [null, null, null, null, null]);
check('a sentence for each reason rideHoldReason can give, and no others', Object.keys(RIDE_HOLD_REASON_TEXT).sort(), ['after_approval', 'cancelled', 'expired', 'not_approved']);
check('each one a sentence about a ride', Object.values(RIDE_HOLD_REASON_TEXT).every((t) => /^Held .+\.$/.test(t) && !/booking|stay|request/i.test(t)), true);
check('the one the row cannot settle names a block from rides among its causes', /blocked from rides/.test(RIDE_HOLD_REASON_TEXT.after_approval), true);

console.log('\n— rides: what the guest is told —');
const rideNotice = heldNotice(rideHeldApproved, 'ride');
check('the card says how much we have, that we will confirm the ride or refund, and not to pay again',
  `${rideNotice.title} ${rideNotice.body}`,
  `We have your payment of ${naira(85000)}. We will confirm this ride or refund you in full. You do not need to pay again.`);
check('the stay\'s words are unchanged', heldNotice(heldNeverApproved).body, HELD_GUEST_TEXT.stay);
check('a blocked guest is told the team will be in touch about a refund, and not to pay again',
  [/contact you about a refund/.test(HELD_GUEST_TEXT.blocked), /do not need to pay again/.test(HELD_GUEST_TEXT.blocked)], [true, true]);
check('calm: nothing about a block, a report or the account, and no promise to confirm',
  /block|report|account|confirm/i.test(HELD_GUEST_TEXT.blocked), false);

console.log('\n— rides: the payment page —');
const RIDE_SAID = 'We have your payment for this ride. We will be in touch.';
const rideAfterPaying = (reason, said = RIDE_SAID) => refused(409, {
  code: 'PAYMENT_HELD', ...(said ? { error: said } : {}),
  data: { ride_booking_id: 'r-held-approved', reference: 'LUX_r-held-approved_1760000000000', amount_ngn: 85000, hold_reason: reason },
});
check('verifyRidePayment holds it: the server\'s sentence, the reference and the reason',
  heldPaymentFrom(rideAfterPaying('blocked'), 'LUX_r-held-approved_1760000000000', 'ride'),
  { sentence: RIDE_SAID, reference: 'LUX_r-held-approved_1760000000000', reason: 'blocked' });
check('each of the server\'s reasons is passed on as it came',
  ['not_approved', 'expired', 'cancelled', 'blocked', 'holding'].map((why) => heldPaymentFrom(rideAfterPaying(why), 'x', 'ride').reason),
  ['not_approved', 'expired', 'cancelled', 'blocked', 'holding']);
check('with no sentence, a ride is promised in ride words', heldPaymentFrom(rideAfterPaying('not_approved', ''), 'x', 'ride').sentence, HELD_GUEST_TEXT.ride);
check('and a blocked guest is told about the refund, not promised the ride', heldPaymentFrom(rideAfterPaying('blocked', ''), 'x', 'ride').sentence, HELD_GUEST_TEXT.blocked);
check('a stay with no sentence keeps the stay\'s words, whatever the reason says', heldPaymentFrom(rideAfterPaying('blocked', '')).sentence, HELD_GUEST_TEXT.stay);

const REFUNDED_SAID = 'This payment was refunded.';
const rideRefundedAnswer = refused(409, { code: 'PAYMENT_REFUNDED', error: REFUNDED_SAID });
check('a refunded payment: its own screen, with the server\'s sentence and the page\'s reference',
  refundedPaymentFrom(rideRefundedAnswer, 'LUX_r-refunded_1', 'ride'), { sentence: REFUNDED_SAID, reference: 'LUX_r-refunded_1' });
check('the reference is the server\'s when it names one',
  refundedPaymentFrom(refused(409, { code: 'PAYMENT_REFUNDED', error: REFUNDED_SAID, data: { reference: 'LUX_r-refunded_2' } }), 'other', 'ride').reference, 'LUX_r-refunded_2');
const wordlessRefund = refundedPaymentFrom(refused(409, { code: 'PAYMENT_REFUNDED' }), '', 'ride');
check('with no sentence: plain words, never the status line', [/status code/.test(wordlessRefund.sentence), /refunded/.test(wordlessRefund.sentence), /ride/.test(wordlessRefund.sentence)], [false, true, true]);
check('everything else is not a refunded payment',
  [refundedPaymentFrom(rideAfterPaying('holding'), 'x', 'ride'), refundedPaymentFrom(refused(400, { code: 'REFERENCE_MISMATCH', error: 'x' }), 'x', 'ride'),
    refundedPaymentFrom(answered({ ride_booking_id: 'r-paid' }), 'x', 'ride'), refundedPaymentFrom({ ok: true, code: 'PAYMENT_REFUNDED' }), refundedPaymentFrom(unanswered()), refundedPaymentFrom(null)],
  [null, null, null, null, null, null]);
check('and a refunded payment is not a held one', heldPaymentFrom(rideRefundedAnswer, 'x', 'ride'), null);

const startHeld = refused(409, { code: 'PAYMENT_HELD', error: RIDE_SAID, data: { ride_booking_id: 'r-held-unapproved', amount_ngn: 85000, hold_reason: 'holding' } });
check('Pay on a ride whose payment is already held: the held screen, never Paystack',
  ridePayDecision(startHeld), { open: false, held: { sentence: RIDE_SAID, reference: '', reason: 'holding' } });
check('Pay on a ride whose payment was refunded: the refunded screen, never Paystack',
  ridePayDecision(refused(409, { code: 'PAYMENT_REFUNDED', error: REFUNDED_SAID })), { open: false, refunded: { sentence: REFUNDED_SAID, reference: '' } });
check('the other refusals still go to the error card',
  ridePayDecision(refused(409, { code: 'NOT_APPROVED', error: 'This ride has not been approved yet' })), { open: false, error: 'This ride has not been approved yet' });

console.log('\n— rides: what the admin is told —');
check('confirmed, guest emailed', rideConfirmedNote({ ride_booking_id: 'r-held-approved', confirmed: true, paid_at: APPROVED_AT, reference: 'x', guest_emailed: true }),
  'The guest has been emailed. Assign a driver next.');
check('confirmed, the email failed', rideConfirmedNote({ confirmed: true, guest_emailed: false }), 'The email to the guest could not be sent. Tell them yourself. Assign a driver next.');
check('an answer that does not say: never "has been emailed"', [rideConfirmedNote({ confirmed: true }), rideConfirmedNote(null), rideConfirmedNote(undefined)].every((t) => /could not be sent/.test(t)), true);
check('it was already paid', rideConfirmedNote({ already_paid: true, confirmed: true, guest_emailed: true }), 'It was already paid. Nothing was changed.');
check('marked refunded: a ride\'s answer is read as a stay\'s is',
  [refundedNote({ ride_booking_id: 'r-held-rejected', refunded: true, reference: 'x', amount_ngn: 85000, guest_emailed: true }), refundedNote({ ride_booking_id: 'r-held-rejected', refunded: true, guest_emailed: false }), refundedNote({ already: true })],
  ['The guest has been emailed.', 'The email to the guest could not be sent. Tell them yourself.', 'It was already marked refunded.']);
const approvedHeld = rideHeldDecisionNote({ ride_booking_id: 'r-held-unapproved', status: 'approved', total_price: 85000, confirmed_with_payment: true });
check('approving a held ride: it is confirmed with the payment, and needs a driver',
  [approvedHeld.title, /confirmed with the payment that was on hold/.test(approvedHeld.description), /Assign a driver/.test(approvedHeld.description)], ['Approved and paid', true, true]);
check('and the email is not mentioned when the answer does not say', /email/i.test(approvedHeld.description), false);
check('when it does say',
  [/has been emailed/.test(rideHeldDecisionNote({ confirmed_with_payment: true, guest_emailed: true }).description), /could not be sent/.test(rideHeldDecisionNote({ confirmed_with_payment: true, guest_emailed: false }).description)], [true, true]);
const rejectedHeld = rideHeldDecisionNote({ ride_booking_id: 'r-held-rejected', status: 'rejected', refund_owed: true });
check('rejecting a held ride: a refund is owed, refunded in Paystack and then marked',
  [rejectedHeld.title, /Refund it in Paystack/.test(rejectedHeld.description), /Mark refunded/.test(rejectedHeld.description)], ['Rejected. A refund is owed', true, true]);
check('a decision that touched no money keeps the panel\'s usual words',
  [rideHeldDecisionNote({ status: 'approved', total_price: 85000, price_changed: false }), rideHeldDecisionNote({ status: 'rejected', suggested: [] }), rideHeldDecisionNote(null)], [null, null, null]);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
