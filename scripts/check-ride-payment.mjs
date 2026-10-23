// Paying for a ride — run with: node scripts/check-ride-payment.mjs
//
// The ride twin of scripts/check-stay-payment.mjs. Money reaches a ride two
// ways: the payment page reports back (verifyRidePayment) and Paystack calls
// the webhook (paystackWebhook). Until 2026-10-23 either one confirmed ANY ride
// the payment matched: a request the admin had never approved, one cancelled
// or expired whose car may since have gone to someone else, or one whose guest
// had been blocked from rides. Now such a payment is put on hold for the
// admin, who confirms the ride with it or refunds it.
//
// This runs the shipped functions together, in memory, against
// scripts/lib/function-rig.mjs: Paystack and Telegram are stand-ins, and one
// function calling another really runs the other.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRig, loadFunction, call, stubNetwork, ROOT } from './lib/function-rig.mjs';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const rig = createRig({
  serverOnlyCreate: ['RideBooking', 'LoyaltyTransaction', 'Referral'],
  userReads: { RideBooking: (row, user) => row.guest_email === user.email || user.role === 'admin' },
});
stubNetwork(rig);
rig.env.INTERNAL_FUNCTION_SECRET = 'internal-check-secret';
const verify = await loadFunction(rig, 'verifyRidePayment');
const webhook = await loadFunction(rig, 'paystackWebhook');
const openPaymentPage = await loadFunction(rig, 'startRidePayment');
const decide = await loadFunction(rig, 'decideRideBooking');
const telegram = await loadFunction(rig, 'telegramWebhook');
const markRefunded = await loadFunction(rig, 'markHeldPaymentRefunded');
const cancel = await loadFunction(rig, 'cancelRideBooking');
const sweep = await loadFunction(rig, 'autoCancelExpiredBookings');
const listRides = await loadFunction(rig, 'getRideBookings');
const requestRide = await loadFunction(rig, 'checkRideAvailability');

const guest = { id: 'gina', email: 'gina@example.com', role: 'user', full_name: 'Gina Guest', phone_number: '08030000000', loyalty_points: 0 };
const blocked = { id: 'bo', email: 'bo@example.com', role: 'user', full_name: 'Bo Blocked', phone_number: '08030000001', ride_blocked: true };
const admin = { id: 'root', email: 'root@example.com', role: 'admin' };
// Rita referred Gina; Sade referred Tayo.
const rita = { id: 'rita', email: 'rita@example.com', role: 'user', referral_balance_ngn: 0, loyalty_points: 0 };
const sade = { id: 'sade', email: 'sade@example.com', role: 'user', referral_balance_ngn: 0, loyalty_points: 0 };
const tayo = { id: 'tayo', email: 'tayo@example.com', role: 'user', full_name: 'Tayo Guest', phone_number: '08030000002', loyalty_points: 0 };
rig.db.User = [guest, blocked, admin, rita, sade, tayo].map((u) => ({ ...u }));
rig.db.Referral = [
  { id: 'ref-gina', referrer_email: rita.email, referred_email: guest.email, status: 'signed_up', created_date: '2026-01-01T00:00:00.000Z' },
  { id: 'ref-tayo', referrer_email: sade.email, referred_email: tayo.email, status: 'signed_up', created_date: '2026-01-01T00:00:00.000Z' },
];
const balanceOf = (id) => rig.db.User.find((u) => u.id === id).referral_balance_ngn || 0;
const pointsOf = (id) => rig.db.User.find((u) => u.id === id).loyalty_points || 0;
rig.db.Vehicle = [
  { id: 'v1', name: 'Prado', city: 'Abuja', active: true, admin_approved: true, price_12hr_ngn: 120000, turnaround_hours: 1, max_passengers: 6 },
];

const PRICE = 120000;
// A 12-hour ride from 09:00 WAT on the given day of March 2027.
const on = (day) => {
  const service_date = `2027-03-${String(day).padStart(2, '0')}`;
  const startMs = Date.parse(`${service_date}T09:00:00+01:00`);
  return { service_date, start_time: '09:00', duration_tier: '12hr', start_at: new Date(startMs).toISOString(), end_at: new Date(startMs + 12 * 3600000).toISOString() };
};
const ride = (id, day, fields) => ({
  id, guest_email: guest.email, guest_name: 'Gina Guest', guest_phone: '08030000000',
  vehicle_id: 'v1', vehicle_name: 'Prado', ...on(day),
  pickup_location: { city: 'Abuja', address: '1 Aso Drive' },
  total_price: PRICE, estimated_price: PRICE, status: 'pending', payment_status: 'unpaid', ...fields,
});
const APPROVED = { approved_at: '2026-10-23T08:00:00.000Z', payment_deadline: '2026-10-23T09:00:00.000Z' };
rig.db.RideBooking = [];
const add = (id, day, fields = {}) => { rig.db.RideBooking.push(ride(id, day, fields)); return id; };
const row = (id) => rig.db.RideBooking.find((b) => b.id === id);
const state = (id) => [row(id).status, row(id).payment_status, row(id).transaction_hash || null];

const pay = (reference, rideId, fields = {}) => {
  rig.paystack[reference] = { status: 'success', amount: PRICE * 100, currency: 'NGN', metadata: { ride_booking_id: rideId }, ...fields };
  return reference;
};
const report = (ride_booking_id, reference, user = guest) => call(rig, verify, { ride_booking_id, reference }, user);
const deliver = (reference, rideId, fields = {}) => {
  const rawBody = JSON.stringify({ event: 'charge.success', data: { reference, amount: PRICE * 100, currency: 'NGN', metadata: { ride_booking_id: rideId }, ...fields } });
  const signature = crypto.createHmac('sha512', rig.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  return call(rig, webhook, null, null, 'POST', { rawBody, headers: { 'x-paystack-signature': signature } });
};
const told = () => ({ admin: rig.telegram.length, mail: rig.emails.length });
const since = (before) => ({ admin: rig.telegram.length - before.admin, mail: rig.emails.length - before.mail });
const paidCards = () => rig.sent.filter((t) => t.includes('RIDE PAID')).length;
const holdAlerts = () => rig.telegram.filter((m) => String(m.text || '').includes('RIDE PAYMENT ON HOLD')).length;

console.log('\n— an approved ride is paid for —');
add('approved', 1, APPROVED);
let mark = told();
let r = await report('approved', pay('ref-approved', 'approved'));
check('the payment page reporting back confirms it', [r.status, state('approved')], [200, ['confirmed', 'paid', 'ref-approved']]);
check('the admin gets the paid card, the guest the confirmation email and points', [since(mark), rig.sent.at(-1).includes('RIDE PAID'), rig.emails.at(-1).subject.startsWith('Ride confirmed'), pointsOf('gina')], [{ admin: 1, mail: 1 }, true, true, 500]);
check('and the friend who referred the guest is paid 5% of it', balanceOf('rita'), 6000);
mark = told();
r = await deliver('ref-approved', 'approved');
check('Paystack\'s own event for it afterwards changes nothing and tells nobody', [r.json.skipped, since(mark)], ['already_paid', { admin: 0, mail: 0 }]);
add('approved-hook', 2, APPROVED);
r = await deliver('ref-hook', 'approved-hook');
check('Paystack\'s event alone confirms an approved ride too', [r.json.processed, state('approved-hook')], [true, ['confirmed', 'paid', 'ref-hook']]);

console.log('\n— a ride the admin never approved —');
const cardsBefore = paidCards();
const pointsBefore = pointsOf('gina');
add('unapproved', 3);
mark = told();
r = await report('unapproved', pay('ref-early', 'unapproved'));
check('the payment is not turned into a confirmed ride', [r.status, r.code, state('unapproved'), row('unapproved').paid_at || null], [409, 'PAYMENT_HELD', ['pending', 'pending_confirmation', 'ref-early'], null]);
check('the answer says what was held and why', r.data, { ride_booking_id: 'unapproved', reference: 'ref-early', amount_ngn: PRICE, hold_reason: 'not_approved' });
check('and tells the guest in words, with the reference', [r.error.includes('has not been approved yet'), r.error.includes('ref-early'), r.error.includes('Please do not pay again')], [true, true, true]);
const alert = rig.telegram.at(-1);
check('the admin is alerted, in plain text', [since(mark).admin, alert.text.includes('RIDE PAYMENT ON HOLD'), alert.parse_mode || null], [1, true, null]);
check('with the two buttons', alert.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['held_ride_confirm_unapproved', 'held_ride_refund_unapproved']);
check('the guest is emailed that it is not confirmed', rig.emails.at(-1).subject, 'We have your payment. Your ride is not confirmed yet');
check('no paid card, no points, no referral reward', [paidCards() - cardsBefore, pointsOf('gina') - pointsBefore, balanceOf('rita')], [0, 0, 6000]);

mark = told();
r = await report('unapproved', 'ref-early');
check('reporting the same payment again tells nobody again', [r.status, r.code, since(mark)], [409, 'PAYMENT_HELD', { admin: 0, mail: 0 }]);
r = await deliver('ref-early', 'unapproved');
check('nor does Paystack\'s event for it', [r.json.held, r.json.outcome, since(mark)], [true, 'again', { admin: 0, mail: 0 }]);

r = await deliver(pay('ref-early-2', 'unapproved'), 'unapproved');
check('a second, different payment is kept beside the first', [r.json.outcome, row('unapproved').transaction_hash, row('unapproved').payment_extra_refs], ['second', 'ref-early', ['ref-early-2']]);
check('and the admin is told there are two, without buttons', [rig.telegram.at(-1).text.includes('SECOND PAYMENT'), rig.telegram.at(-1).text.includes('ref-early-2'), !!rig.telegram.at(-1).reply_markup], [true, true, false]);
mark = told();
r = await deliver('ref-early-2', 'unapproved');
check('the second one arriving again is not announced again', [r.json.outcome, since(mark)], ['again', { admin: 0, mail: 0 }]);

console.log('\n— rides that are closed, and a guest who has been blocked —');
add('expired', 4, { ...APPROVED, status: 'cancelled', cancel_reason: 'payment_expired' });
r = await deliver(pay('ref-expired', 'expired'), 'expired');
check('a ride that ran out of time: held, not revived', [r.json.held, r.json.reason, state('expired')], [true, 'expired', ['cancelled', 'pending_confirmation', 'ref-expired']]);
add('declined', 5, { status: 'cancelled', cancel_reason: 'admin_rejected' });
r = await report('declined', pay('ref-declined', 'declined'));
check('a ride the admin declined: held', [r.status, r.data && r.data.hold_reason, state('declined')], [409, 'cancelled', ['cancelled', 'pending_confirmation', 'ref-declined']]);
rig.db.RideBooking.push({ ...ride('blocked', 6, APPROVED), guest_email: blocked.email, guest_name: 'Bo Blocked' });
r = await report('blocked', pay('ref-blocked', 'blocked'), blocked);
check('a guest blocked from rides since asking: held, even on an approved ride', [r.status, r.data && r.data.hold_reason, state('blocked')], [409, 'blocked', ['pending', 'pending_confirmation', 'ref-blocked']]);

console.log('\n— whose payment it is —');
add('mine', 7, APPROVED);
add('theirs', 8, APPROVED);
r = await report('mine', pay('ref-nameless', 'x', { metadata: {} }));
check('a payment that names no ride is refused', [r.status, r.code, r.error, state('mine')], [400, 'REFERENCE_MISMATCH', 'This payment does not say which booking it was for.', ['pending', 'unpaid', null]]);
r = await report('mine', pay('ref-theirs', 'theirs'));
check('a payment made for another ride is refused', [r.status, r.code, state('mine')], [400, 'REFERENCE_MISMATCH', ['pending', 'unpaid', null]]);
r = await report('mine', pay('ref-a-stay', 'x', { metadata: { booking_id: 'some-stay' } }));
check('and one made for a stay', [r.status, r.code], [400, 'REFERENCE_MISMATCH']);
add('reused-target', 9, APPROVED);
r = await deliver('ref-approved', 'reused-target');
check('Paystack\'s event with a reference already on another ride is not used twice', [r.json.skipped, state('reused-target')], ['reference_reused', ['pending', 'unpaid', null]]);
add('refunded', 10, { status: 'cancelled', cancel_reason: 'admin_rejected', payment_status: 'refunded', transaction_hash: 'ref-refunded' });
pay('ref-refunded', 'refunded');
r = await report('refunded', 'ref-refunded');
check('a payment that was refunded is not taken again', [r.status, r.code, state('refunded')], [409, 'PAYMENT_REFUNDED', ['cancelled', 'refunded', 'ref-refunded']]);
r = await deliver('ref-refunded', 'refunded');
check('nor from Paystack\'s event', r.json.skipped, 'refunded');

console.log('\n— the payment page and Paystack arrive together, for a ride nobody approved —');
add('together', 11);
pay('ref-together', 'together');
{
  let release;
  rig.paystackGate = new Promise((go) => { release = go; });
  const before = holdAlerts();
  const page = report('together', 'ref-together');
  await new Promise((tick) => setTimeout(tick, 5));
  const hook = await deliver('ref-together', 'together');
  rig.paystackGate = null;
  release();
  const pageAnswer = await page;
  check('both say it is held', [hook.json.held, pageAnswer.status, pageAnswer.code], [true, 409, 'PAYMENT_HELD']);
  check('and the admin gets one alert, not two', holdAlerts() - before, 1);
}

console.log('\n— the payment page, the sweep, cancelling, the guest\'s list —');
r = await call(rig, openPaymentPage, { ride_booking_id: 'unapproved' }, guest);
check('the payment page will not take a second payment for a held ride', [r.status, r.code, r.data], [409, 'PAYMENT_HELD', { ride_booking_id: 'unapproved', amount_ngn: PRICE, hold_reason: 'holding' }]);
r = await call(rig, openPaymentPage, { ride_booking_id: 'refunded' }, guest);
check('nor for a refunded one', [r.status, r.code], [409, 'PAYMENT_REFUNDED']);
r = await call(rig, cancel, { ride_booking_id: 'unapproved' }, guest);
check('the guest cannot cancel a held ride away', [r.status, r.code, state('unapproved')], [409, 'PAYMENT_HELD', ['pending', 'pending_confirmation', 'ref-early']]);
// Past its deadline, approved, with money on hold: the sweep must leave it.
add('held-late', 12, { approved_at: '2026-10-01T08:00:00.000Z', payment_deadline: '2026-10-01T09:00:00.000Z', payment_status: 'pending_confirmation', transaction_hash: 'ref-held-late' });
add('late', 13, { approved_at: '2026-10-01T08:00:00.000Z', payment_deadline: '2026-10-01T09:00:00.000Z' });
r = await call(rig, sweep, {}, admin);
check('the sweep releases an unpaid ride past its deadline', [r.status, row('late').status, row('late').cancel_reason], [200, 'cancelled', 'payment_expired']);
check('but not one whose payment is on hold', state('held-late'), ['pending', 'pending_confirmation', 'ref-held-late']);
r = await call(rig, listRides, {}, guest);
const bucketOf = (id) => (r.data || []).find((x) => x.id === id)?.bucket;
check('the guest sees held rides as waiting, even a cancelled one', [r.status, bucketOf('unapproved'), bucketOf('expired'), bucketOf('declined')], [200, 'pending-approval', 'pending-approval', 'pending-approval']);

console.log('\n— a new request for the same car —');
const ask = (day, user = tayo) => call(rig, requestRide, {
  vehicle_id: 'v1', ...(({ service_date, start_time, duration_tier }) => ({ service_date, start_time, duration_tier }))(on(day)),
  pickup_location: { city: 'Abuja', address: '2 Aso Drive' }, passengers: 2,
}, user);
r = await ask(4);
check('a held ride keeps its window, even though it was cancelled', [r.status, r.code], [409, 'VEHICLE_DOUBLE_BOOKED']);
r = await ask(20);
check('a window nobody holds can still be asked for', [r.status, !!(r.data && r.data.ride_booking_id)], [200, true]);

console.log('\n— the admin confirms a held payment —');
const confirm = (ride_booking_id, user = admin, extra = {}) => call(rig, verify, { ride_booking_id, confirm_held: true, ...extra }, user);
r = await confirm('unapproved', guest);
check('a guest cannot', [r.status, r.code, state('unapproved')], [403, 'ADMIN_ONLY', ['pending', 'pending_confirmation', 'ref-early']]);
r = await confirm('unapproved', null, { internal_secret: 'wrong' });
check('nor can a caller with the wrong secret', [r.status, r.code], [403, 'ADMIN_ONLY']);
r = await confirm('mine');
check('nothing on hold: said so', [r.status, r.code], [409, 'NOT_HELD']);
rig.paystack['ref-declined'] = { ...rig.paystack['ref-declined'], status: 'reversed' };
r = await confirm('declined');
check('a payment Paystack no longer calls successful is not confirmed', [r.status, r.code, state('declined')], [409, 'PAYMENT_NOT_VERIFIED', ['cancelled', 'pending_confirmation', 'ref-declined']]);
// Held on day 14, and another guest's ride on the same car is confirmed for it.
add('held-clash', 14, { payment_status: 'pending_confirmation', transaction_hash: pay('ref-clash', 'held-clash') });
rig.db.RideBooking.push({ ...ride('confirmed-other', 14, APPROVED), guest_email: tayo.email, status: 'confirmed', payment_status: 'paid', transaction_hash: 'ref-other' });
r = await confirm('held-clash');
check('the car has gone to another confirmed ride: refused, and the other ride is named', [r.status, r.code, String(r.error || '').includes('confirmed-other'), state('held-clash')], [409, 'VEHICLE_TAKEN', true, ['pending', 'pending_confirmation', 'ref-clash']]);
// Held on day 15, while an unapproved request sits on the same window.
add('held-free', 15, { payment_status: 'pending_confirmation', transaction_hash: pay('ref-free', 'held-free') });
rig.db.RideBooking.push({ ...ride('asked-only', 15), guest_email: tayo.email });
add('held-promised', 16, { payment_status: 'pending_confirmation', transaction_hash: pay('ref-promised', 'held-promised') });
rig.db.RideBooking.push({ ...ride('approved-other', 16, APPROVED), guest_email: tayo.email });
r = await confirm('held-promised');
check('an approved ride waiting to be paid has a promise on the car too', [r.status, r.code], [409, 'VEHICLE_TAKEN']);
const cards = paidCards();
mark = told();
r = await confirm('held-free');
check('a request nobody approved does not stop it: confirmed with the money on hold', [r.status, r.data && r.data.confirmed, state('held-free'), !!row('held-free').approved_at, !!row('held-free').paid_at], [200, true, ['confirmed', 'paid', 'ref-free'], true, true]);
check('it gets what a paid ride gets: the card, the email, and says the email went', [paidCards() - cards, rig.emails.slice(mark.mail).some((m) => m.subject.startsWith('Ride confirmed')), r.data.guest_emailed], [1, true, true]);
r = await confirm('held-free');
check('pressing again changes nothing', [r.status, r.data && r.data.already_paid], [200, true]);
// From Telegram there is no session: the internal secret is what lets it in.
rig.db.RideBooking.push({ ...ride('tayo-held', 17), guest_email: tayo.email, guest_name: 'Tayo Guest', payment_status: 'pending_confirmation', transaction_hash: pay('ref-tayo', 'tayo-held') });
r = await confirm('tayo-held', null, { internal_secret: 'internal-check-secret' });
check('with the internal secret and no session, it is confirmed', [r.status, state('tayo-held')], [200, ['confirmed', 'paid', 'ref-tayo']]);
check('and the guest\'s referrer is paid then, not before', balanceOf('sade'), 6000);

console.log('\n— the admin marks a held payment refunded —');
const refund = (ride_booking_id, user = admin) => call(rig, markRefunded, { ride_booking_id }, user);
r = await refund('unapproved', guest);
check('a guest cannot', [r.status, r.code], [403, 'ADMIN_ONLY']);
mark = told();
r = await refund('unapproved');
check('recorded: refunded, and the ride stops holding its car', [r.status, r.data.refunded, state('unapproved'), row('unapproved').cancel_reason], [200, true, ['cancelled', 'refunded', 'ref-early'], 'admin_rejected']);
check('the guest is emailed, and the answer says so', [rig.emails.at(-1).subject, r.data.guest_emailed, r.data.reference, r.data.amount_ngn], ['Your payment has been refunded', true, 'ref-early', PRICE]);
r = await refund('unapproved');
check('pressing again: already done', [r.status, r.data.already], [200, true]);
r = await refund('approved');
check('a paid ride has nothing on hold', [r.status, r.code], [409, 'NOT_HELD']);

console.log('\n— the admin decides a ride whose payment is already on hold —');
const decideAs = (ride_booking_id, action, extra = {}) => call(rig, decide, { ride_booking_id, action, ...extra }, admin);
add('pay-first', 21, { payment_status: 'pending_confirmation', transaction_hash: pay('ref-pay-first', 'pay-first') });
r = await decideAs('pay-first', 'approve', { final_price: PRICE + 5000, price_adjustment_reason: 'Airport run' });
check('the price cannot change once the money is in', [r.status, r.code, state('pay-first'), row('pay-first').approved_at || null], [409, 'PRICE_FIXED_BY_PAYMENT', ['pending', 'pending_confirmation', 'ref-pay-first'], null]);
mark = told();
r = await decideAs('pay-first', 'approve');
check('approving confirms it with the money already there', [r.status, r.data.confirmed_with_payment, r.data.guest_emailed, state('pay-first')], [200, true, true, ['confirmed', 'paid', 'ref-pay-first']]);
check('and the guest is not told to go and pay', rig.emails.slice(mark.mail).some((m) => m.subject.startsWith('Approved')), false);
add('pay-first-clash', 14, { payment_status: 'pending_confirmation', transaction_hash: pay('ref-pfc', 'pay-first-clash') });
r = await decideAs('pay-first-clash', 'approve');
check('if the car has gone, approving says why and changes nothing', [r.status, r.code, state('pay-first-clash'), row('pay-first-clash').approved_at || null], [409, 'VEHICLE_TAKEN', ['pending', 'pending_confirmation', 'ref-pfc'], null]);
mark = told();
r = await decideAs('pay-first-clash', 'reject');
check('declining it leaves a refund owed', [r.status, r.data.refund_owed, state('pay-first-clash'), row('pay-first-clash').cancel_reason], [200, true, ['cancelled', 'pending_confirmation', 'ref-pfc'], 'admin_rejected']);
const owed = rig.telegram.slice(mark.admin).find((m) => String(m.text || '').startsWith('REFUND OWED'));
check('the admin is reminded, with the button that records it', [!!owed, owed && owed.reply_markup.inline_keyboard[0][0].callback_data], [true, 'held_ride_refund_pay-first-clash']);
check('and the guest is told the money comes back', rig.emails.slice(mark.mail).some((m) => m.body.includes('will be refunded in full')), true);
add('plain', 22);
r = await decideAs('plain', 'reject');
check('an ordinary decline owes nothing', [r.status, r.data.refund_owed], [200, false]);

console.log('\n— the same from Telegram —');
const press = (data, text = 'the card') => call(rig, telegram, { callback_query: { id: 'cq', data, message: { chat: { id: 1 }, message_id: 77, text } } }, null);
add('tg-confirm', 23, { payment_status: 'pending_confirmation', transaction_hash: pay('ref-tg-confirm', 'tg-confirm') });
r = await press('held_ride_confirm_tg-confirm', 'RIDE PAYMENT ON HOLD...');
const edited = rig.telegram.filter((m) => m.url.endsWith('/editMessageText')).at(-1);
check('"Confirm ride" on the alert confirms it', [r.status, state('tg-confirm')], [200, ['confirmed', 'paid', 'ref-tg-confirm']]);
check('and the alert says what happened, in plain text, without buttons', [edited.text.includes('CONFIRMED with this payment'), edited.text.includes('Assign a driver'), edited.parse_mode || null, !!edited.reply_markup], [true, true, null, false]);
add('tg-refund', 24, { payment_status: 'pending_confirmation', transaction_hash: 'ref-tg-refund' });
r = await press('held_ride_refund_tg-refund');
check('"Mark refunded" records the refund', state('tg-refund'), ['cancelled', 'refunded', 'ref-tg-refund']);
add('tg-approve', 25, { payment_status: 'pending_confirmation', transaction_hash: pay('ref-tg-approve', 'tg-approve') });
r = await press('ride_approve_tg-approve');
check('approving the request card of a held ride confirms it with the payment', state('tg-approve'), ['confirmed', 'paid', 'ref-tg-approve']);
add('tg-reject', 26, { payment_status: 'pending_confirmation', transaction_hash: 'ref-tg-reject' });
mark = told();
r = await press('ride_reject_tg-reject');
check('declining it from the card leaves a refund owed, and says so', [state('tg-reject'), rig.telegram.slice(mark.admin).some((m) => String(m.text || '').startsWith('REFUND OWED'))], [['cancelled', 'pending_confirmation', 'ref-tg-reject'], true]);

console.log('\n— the shared blocks are word for word the same —');
const src = (name) => fs.readFileSync(path.join(ROOT, 'base44', 'functions', name, 'entry.ts'), 'utf8');
const block = (text, from, to) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a);
  return a < 0 || b < 0 ? null : text.slice(a, b);
};
const rules = (name) => block(src(name), '// ── Ride payment rules', '// ── end of ride payment rules');
check('the ride payment rules: verifyRidePayment and paystackWebhook agree', [!!rules('verifyRidePayment'), rules('verifyRidePayment') === rules('paystackWebhook')], [true, true]);
const decisions = (name) => block(src(name), '// ── Held ride decisions', '// ── end of held ride decisions');
check('the held ride decisions: decideRideBooking and telegramWebhook agree', [!!decisions('decideRideBooking'), decisions('decideRideBooking') === decisions('telegramWebhook')], [true, true]);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
