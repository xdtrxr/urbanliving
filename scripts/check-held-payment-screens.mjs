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
check('opening the page for a held booking: its own screen, with the server\'s sentence', heldPaymentFrom(onLoad), { sentence: SAID, reference: '' });
const afterPaying = refused(409, { code: 'PAYMENT_HELD', error: SAID, data: { booking_id: 'b1', reference: 'LUX_b1_1760000000000', amount_ngn: 120000, hold_reason: 'not_approved' } });
check('paying into a booking nobody approved: held, with the reference', heldPaymentFrom(afterPaying, 'LUX_b1_1760000000000'), { sentence: SAID, reference: 'LUX_b1_1760000000000' });
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
const heldScreen = sliceOf(PAGE, 'if (heldPayment) {', 'if (error) {');
check('the held screen has both headings, the sentence, the reference and one way out',
  ['Payment received, booking not confirmed yet', 'We have your payment', '{heldPayment.sentence}', '{heldPayment.reference}', 'View my bookings'].filter((t) => !heldScreen.includes(t)), []);
check('and nothing to pay with, no "Payment Successful", no ID step', /handlePayment|Payment Successful|IdUploadGate/.test(heldScreen), false);
check('it comes ahead of the error card', PAGE.indexOf('if (heldPayment) {') !== -1 && PAGE.indexOf('if (heldPayment) {') < PAGE.indexOf('if (error) {'), true);
check('the expiry alert does not fire over a payment that was made or is held', /if \(!hasExpired \|\| !bookingData\?\.id \|\| paymentComplete \|\| heldPayment\) return;/.test(PAGE), true);

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

console.log('\n— admin (source) —');
const CARD = read('src/components/admin/HeldPaymentsAdmin.jsx');
check('the list is read with an explicit sort and limit',
  /entities\.Booking\.filter\(\{ payment_status: 'pending_confirmation' \}, SORT, LIMIT\)/.test(CARD)
  && /const SORT = '-created_date';/.test(CARD) && /const LIMIT = \d+;/.test(CARD), true);
check('Confirm booking is verifyPaystackPayment with confirm_held', /'verifyPaystackPayment', \{ booking_id: booking\.id, confirm_held: true \}/.test(CARD), true);
check('Mark refunded is markHeldPaymentRefunded', /'markHeldPaymentRefunded', \{ booking_id: booking\.id \}/.test(CARD), true);
check('both go through invokeFn, so a refusal is the server\'s sentence', /const r = await invokeFn\(fn, body\);/.test(CARD) && !/functions\.invoke\(/.test(CARD), true);
check('the second step says when it may be pressed', CARD.includes('Only after you have refunded it in Paystack.'), true);
check('the Mark refunded button on a row only opens that step', /onClick=\{\(\) => setToRefund\(\{ booking: b, refused: null \}\)\}/.test(CARD), true);
check('the refund is recorded from inside the dialog and nowhere else',
  CARD.split('onClick={markRefunded}').length - 1 === 1 && CARD.indexOf('onClick={markRefunded}') > CARD.indexOf('<Dialog open='), true);
check('the card shows nothing at all when nothing is held', /if \(bookings\.length === 0 && !toRefund\) return null;/.test(CARD), true);
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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
