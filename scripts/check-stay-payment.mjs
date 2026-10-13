// Paying for a stay — run with: node scripts/check-stay-payment.mjs
//
// Money reaches a booking two ways: the payment page reports back
// (verifyPaystackPayment) and Paystack calls the webhook (paystackWebhook).
// Until 2026-10-12 either one confirmed ANY booking the payment matched: a
// request the admin had never approved, or one already cancelled whose dates
// may have gone to someone else. Now such a payment is put on hold for the
// admin, who confirms the booking with it or refunds it.
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

const rig = createRig({ serverOnlyCreate: ['Booking', 'AvailabilityRequest', 'LoyaltyTransaction', 'Referral'] });
stubNetwork(rig);
rig.env.INTERNAL_FUNCTION_SECRET = 'internal-check-secret';
const verify = await loadFunction(rig, 'verifyPaystackPayment');
const webhook = await loadFunction(rig, 'paystackWebhook');
const openPaymentPage = await loadFunction(rig, 'startStayPayment');
const decide = await loadFunction(rig, 'decideAvailabilityRequest');
const telegram = await loadFunction(rig, 'telegramWebhook');
const markRefunded = await loadFunction(rig, 'markHeldPaymentRefunded');
const cancel = await loadFunction(rig, 'cancelBooking');
const sweep = await loadFunction(rig, 'autoCancelExpiredBookings');
const listBookings = await loadFunction(rig, 'getBookings');

const guest = { id: 'gina', email: 'gina@example.com', role: 'user', full_name: 'Gina Guest', phone_number: '08030000000', loyalty_points: 0 };
const other = { id: 'otto', email: 'otto@example.com', role: 'user' };
const admin = { id: 'root', email: 'root@example.com', role: 'admin' };
// Rita referred Gina, and Sade referred Tayo: attributeReferral wrote the rows.
const rita = { id: 'rita', email: 'rita@example.com', role: 'user', referral_balance_ngn: 0, loyalty_points: 0 };
const sade = { id: 'sade', email: 'sade@example.com', role: 'user', referral_balance_ngn: 0, loyalty_points: 0 };
const tayo = { id: 'tayo', email: 'tayo@example.com', role: 'user', full_name: 'Tayo Guest', loyalty_points: 0 };
// Vera referred Uche, who pays without ever coming back to the payment page.
const vera = { id: 'vera', email: 'vera@example.com', role: 'user', referral_balance_ngn: 0, loyalty_points: 0 };
const uche = { id: 'uche', email: 'uche@example.com', role: 'user', full_name: 'Uche Guest', loyalty_points: 0 };
rig.db.User = [guest, other, admin, rita, sade, tayo, vera, uche].map((u) => ({ ...u }));
rig.db.Referral = [
  { id: 'ref-gina', referrer_email: rita.email, referred_email: guest.email, status: 'signed_up' },
  { id: 'ref-tayo', referrer_email: sade.email, referred_email: tayo.email, status: 'signed_up' },
  { id: 'ref-uche', referrer_email: vera.email, referred_email: uche.email, status: 'signed_up' },
];
const balanceOf = (id) => rig.db.User.find((u) => u.id === id).referral_balance_ngn || 0;
rig.db.Property = [{ id: 'p1', title: 'Maitama Duplex', host_phone: '08011111111', host_name: 'Hadiza', arrival_instructions: 'Ring the bell.', location: { address: '1 Aso Drive', city: 'Abuja', country: 'Nigeria' } }];

const TOTAL = 1198000;
const stay = (id, fields) => ({ id, property_id: 'p1', guest_name: 'Gina Guest', guest_email: guest.email, check_in: '2026-12-13', check_out: '2026-12-17', guests: 2, total_price: TOTAL, status: 'pending', payment_status: 'unpaid', ...fields });
const APPROVED = { approved_at: '2026-10-12T08:00:00.000Z' };
rig.db.Booking = [];
const add = (id, fields) => { rig.db.Booking.push(stay(id, fields)); return id; };
const row = (id) => rig.db.Booking.find((b) => b.id === id);
const state = (id) => [row(id).status, row(id).payment_status, row(id).transaction_hash || null];

// A Paystack transaction as the payment page starts one: the amount in kobo,
// and metadata naming the booking.
const pay = (reference, bookingId, fields = {}) => {
  rig.paystack[reference] = { status: 'success', amount: TOTAL * 100, currency: 'NGN', metadata: { booking_id: bookingId }, ...fields };
  return reference;
};
const report = (booking_id, reference, user = guest) => call(rig, verify, { booking_id, reference }, user);
// The event Paystack sends, signed as Paystack signs it.
const deliver = (reference, bookingId, fields = {}) => {
  const rawBody = JSON.stringify({ event: 'charge.success', data: { reference, amount: TOTAL * 100, currency: 'NGN', metadata: { booking_id: bookingId }, ...fields } });
  const signature = crypto.createHmac('sha512', rig.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  return call(rig, webhook, null, null, 'POST', { rawBody, headers: { 'x-paystack-signature': signature } });
};
const told = () => ({ admin: rig.telegram.length, guestMail: rig.emails.length });
const sinceThen = (before) => ({ admin: rig.telegram.length - before.admin, guestMail: rig.emails.length - before.guestMail });
const points = () => rig.db.User.find((u) => u.id === 'gina').loyalty_points;

console.log('\n— an approved booking is paid for —');
add('approved', APPROVED);
let mark = told();
let r = await report('approved', pay('ref-approved', 'approved'));
check('the payment page reporting back confirms it', [r.status, state('approved')], [200, ['confirmed', 'paid', 'ref-approved']]);
check('the admin gets the payment card and the guest the arrival email and points', [sinceThen(mark), rig.sent.at(-1).includes('PAYMENT RECEIVED'), rig.emails.at(-1).subject.includes('arrival details'), points()], [{ admin: 1, guestMail: 1 }, true, true, 500]);
check('and the friend who referred the guest is paid 5% of it, through the payment path itself', [balanceOf('rita'), rig.db.Referral.find((x) => x.id === 'ref-gina').booking_id], [59900, 'approved']);
mark = told();
r = await report('approved', 'ref-approved');
check('reporting it again changes nothing and tells nobody', [r.status, r.data && r.data.already_paid, sinceThen(mark)], [200, true, { admin: 0, guestMail: 0 }]);
r = await deliver('ref-approved', 'approved');
check('nor does Paystack\'s own event for it', [r.json.skipped, sinceThen(mark)], ['already_paid', { admin: 0, guestMail: 0 }]);

add('approved-webhook', APPROVED);
r = await deliver('ref-hook', 'approved-webhook');
check('Paystack\'s event alone confirms an approved booking too', [r.json.processed, state('approved-webhook')], [true, ['confirmed', 'paid', 'ref-hook']]);

check('the guest\'s second stay earns the referrer nothing more', balanceOf('rita'), 59900);

rig.db.Booking.push({ ...stay('webhook-only', APPROVED), guest_name: 'Uche Guest', guest_email: uche.email });
r = await deliver('ref-webhook-only', 'webhook-only');
check('a guest who never comes back to the page: the webhook alone confirms, awards points and pays the referrer', [state('webhook-only'), rig.db.User.find((u) => u.id === 'uche').loyalty_points, balanceOf('vera'), rig.db.Referral.find((x) => x.id === 'ref-uche').status], [['confirmed', 'paid', 'ref-webhook-only'], 500, 59900, 'booking_completed']);

console.log('\n— the payment page and Paystack arrive together —');
rig.db.Booking.push({ ...stay('together', APPROVED), guest_name: 'Tayo Guest', guest_email: tayo.email });
pay('ref-together', 'together');
const both = await Promise.all([report('together', 'ref-together', tayo), deliver('ref-together', 'together')]);
check('the booking is confirmed once', [both[0].status, both[1].status, state('together')], [200, 200, ['confirmed', 'paid', 'ref-together']]);
check('and the referrer is paid once, not twice', [balanceOf('sade'), rig.db.LoyaltyTransaction.filter((x) => x.transaction_type === 'referral' && x.booking_id === 'together').length], [59900, 1]);

console.log('\n— a request the admin never approved —');
const paymentCards = () => rig.sent.filter((t) => t.includes('PAYMENT RECEIVED')).length;
const cardsBeforeHolds = paymentCards();
add('unapproved', {});
mark = told();
r = await report('unapproved', pay('ref-early', 'unapproved'));
check('the payment is put on hold, not confirmed', [r.status, r.code, state('unapproved')], [409, 'PAYMENT_HELD', ['pending', 'pending_confirmation', 'ref-early']]);
check('the guest is told what happens next, with the reference', [r.error.includes('has not been approved yet'), r.error.includes('refund you in full'), r.error.includes('ref-early'), r.data.hold_reason], [true, true, true, 'not_approved']);
check('no paid-at time is written: that is the confirmation time', row('unapproved').paid_at || null, null);
const alert = rig.telegram.at(-1);
check('the admin is told once, in plain text, with what to do', [sinceThen(mark).admin, alert.parse_mode || null, alert.text.includes('PAYMENT ON HOLD'), alert.text.includes('NOT confirmed'), alert.text.includes('Maitama Duplex'), alert.text.includes('ref-early')], [1, null, true, true, true, true]);
check('and given the two buttons', alert.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['held_confirm_unapproved', 'held_refund_unapproved']);
check('the guest gets one email saying so, and no arrival details', [sinceThen(mark).guestMail, rig.emails.at(-1).subject, rig.emails.at(-1).body.includes('1 Aso Drive')], [1, 'We have your payment. Your booking is not confirmed yet', false]);
check('and no points: the guest still has only those of the two stays that were confirmed', points(), 1000);
const pointsAfterHold = points();
mark = told();
r = await report('unapproved', 'ref-early');
check('the same payment reported again is still on hold, and nobody is told twice', [r.status, r.code, sinceThen(mark)], [409, 'PAYMENT_HELD', { admin: 0, guestMail: 0 }]);
r = await deliver('ref-early', 'unapproved');
check('the same goes for Paystack\'s event for it', [r.json.held, r.json.outcome, sinceThen(mark)], [true, 'again', { admin: 0, guestMail: 0 }]);
check('nothing a paid booking gets has happened: no points, no payment card', [points() === pointsAfterHold, paymentCards() - cardsBeforeHolds], [true, 0]);

add('unapproved-webhook', {});
mark = told();
r = await deliver('ref-early-hook', 'unapproved-webhook');
check('Paystack\'s event alone holds it the same way', [r.json.held, r.json.reason, state('unapproved-webhook'), sinceThen(mark)], [true, 'not_approved', ['pending', 'pending_confirmation', 'ref-early-hook'], { admin: 1, guestMail: 1 }]);

console.log('\n— a booking that was cancelled —');
add('expired', { ...APPROVED, status: 'cancelled', cancel_reason: 'payment_expired' });
r = await report('expired', pay('ref-late', 'expired'));
check('one that ran out of time: held, and it stays cancelled', [r.status, r.code, r.data.hold_reason, state('expired')], [409, 'PAYMENT_HELD', 'expired', ['cancelled', 'pending_confirmation', 'ref-late']]);
add('rejected', { status: 'cancelled' });
r = await deliver('ref-rejected', 'rejected');
check('one the admin turned down: held', [r.json.held, r.json.reason, state('rejected')], [true, 'cancelled', ['cancelled', 'pending_confirmation', 'ref-rejected']]);

console.log('\n— paid is paid —');
add('paid-then-cancelled', { ...APPROVED, status: 'cancelled', payment_status: 'paid', transaction_hash: 'ref-old', paid_at: '2026-10-01T10:00:00.000Z' });
pay('ref-old', 'paid-then-cancelled');
mark = told();
r = await report('paid-then-cancelled', 'ref-old');
check('a paid stay the admin cancelled is not confirmed again by its old reference', [r.status, r.data && r.data.already_paid, state('paid-then-cancelled'), sinceThen(mark)], [200, true, ['cancelled', 'paid', 'ref-old'], { admin: 0, guestMail: 0 }]);
r = await deliver('ref-old', 'paid-then-cancelled');
check('nor by Paystack sending its event again', [r.json.skipped, state('paid-then-cancelled')], ['already_paid', ['cancelled', 'paid', 'ref-old']]);

console.log('\n— a second payment for a booking that already holds one —');
mark = told();
r = await report('unapproved', pay('ref-early-2', 'unapproved'));
check('is held too, and the first reference stays on the booking', [r.status, r.code, r.data.hold_reason, state('unapproved')], [409, 'PAYMENT_HELD', 'holding', ['pending', 'pending_confirmation', 'ref-early']]);
check('the admin is told there are two', [sinceThen(mark).admin, rig.telegram.at(-1).text.includes('SECOND PAYMENT'), rig.telegram.at(-1).text.includes('ref-early-2'), !!rig.telegram.at(-1).reply_markup], [1, true, true, false]);

console.log('\n— the payment has to be this booking\'s —');
add('mine', APPROVED);
add('yours', APPROVED);
r = await report('mine', pay('ref-yours', 'yours'));
check('a payment made for another booking is refused', [r.status, r.code, state('mine')], [400, 'REFERENCE_MISMATCH', ['pending', 'unpaid', null]]);
rig.paystack['ref-nameless'] = { status: 'success', amount: TOTAL * 100, currency: 'NGN', metadata: {} };
r = await report('mine', 'ref-nameless');
check('so is one that names no booking at all', [r.status, r.code, state('mine')], [400, 'REFERENCE_MISMATCH', ['pending', 'unpaid', null]]);
r = await report('mine', pay('ref-short', 'mine', { amount: TOTAL * 100 - 100 }));
check('and one for the wrong amount', [r.status, state('mine')], [400, ['pending', 'unpaid', null]]);
r = await report('mine', 'ref-never-happened');
check('a reference Paystack does not know', [r.status, state('mine')], [402, ['pending', 'unpaid', null]]);
r = await report('mine', pay('ref-mine', 'mine'), other);
check('somebody else cannot report a payment on your booking', r.status, 403);
r = await report('../RideBooking/mine', 'ref-mine');
check('an id that is really a path to another table is not found', r.status, 404);
r = await report('no-such-booking', 'ref-mine');
check('a booking that does not exist is a plain refusal, not a crash', r.status, 404);
r = await deliver('ref-mine', 'no-such-booking');
check('the webhook answers Paystack calmly for a booking that does not exist', [r.status, r.json.skipped], [200, 'booking_not_found']);
{
  const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-forged', amount: TOTAL * 100, currency: 'NGN', metadata: { booking_id: 'mine' } } });
  r = await call(rig, webhook, null, null, 'POST', { rawBody, headers: { 'x-paystack-signature': 'not-paystack' } });
  check('an event that Paystack did not sign changes nothing', [r.json.skipped, state('mine')], ['invalid_signature', ['pending', 'unpaid', null]]);
}

// ── What the admin does about a payment on hold ─────────────────────────────
// A request row beside each booking, as checkAvailabilityWebhook leaves them.
rig.db.AvailabilityRequest = [];
const request = (id, bookingId, fields = {}) => {
  const b = row(bookingId);
  rig.db.AvailabilityRequest.push({ id, booking_id: bookingId, property_id: b.property_id, property_title: 'Maitama Duplex', user_email: b.guest_email, user_name: b.guest_name, check_in: b.check_in, check_out: b.check_out, guests: 2, total_price: b.total_price, status: 'pending', ...fields });
  return id;
};
const req = (id) => rig.db.AvailabilityRequest.find((x) => x.id === id);
// A held booking with its request: the guest paid before anyone decided.
const held = async (id, fields = {}, dates = {}) => {
  add(id, { ...fields, ...dates });
  request(`req-${id}`, id);
  const answer = await report(id, pay(`ref-${id}`, id));
  if (answer.code !== 'PAYMENT_HELD') throw new Error(`setup: ${id} was not held (${answer.status} ${answer.code})`);
  return id;
};
// The admin pressing a button on a Telegram card.
const press = (data, text = 'the card') => call(rig, telegram, { callback_query: { id: 'cq', data, message: { chat: { id: 1 }, message_id: 77, text } } }, null);
const adminDecides = (request_id, action) => call(rig, decide, { request_id, action }, admin);
const mailsTo = (email, from) => rig.emails.slice(from).filter((m) => m.to === email).map((m) => m.subject);

console.log('\n— a payment on hold, and the admin approves the request in the Admin screen —');
await held('h-approve', {}, { check_in: '2027-01-04', check_out: '2027-01-08' });
let mailMark = rig.emails.length;
r = await adminDecides('req-h-approve', 'approve');
check('approving confirms the booking with the money that is already there', [r.status, r.data.confirmed_with_payment, state('h-approve'), req('req-h-approve').status], [200, true, ['confirmed', 'paid', 'ref-h-approve'], 'approved']);
check('the booking is stamped approved and paid', [!!row('h-approve').approved_at, !!row('h-approve').paid_at], [true, true]);
check('the guest gets arrival details, and is not told they have an hour to pay', [mailsTo(guest.email, mailMark).some((x) => x.includes('arrival details')), mailsTo(guest.email, mailMark).some((x) => x.startsWith('Approved'))], [true, false]);

console.log('\n— the same, from the Telegram card of the request —');
await held('h-tg-approve', {}, { check_in: '2027-01-11', check_out: '2027-01-15' });
mailMark = rig.emails.length;
r = await press('approve_req-h-tg-approve');
check('approving there confirms it too', [state('h-tg-approve'), req('req-h-tg-approve').status], [['confirmed', 'paid', 'ref-h-tg-approve'], 'approved']);
check('and the guest gets arrival details, not a request to pay', [mailsTo(guest.email, mailMark).some((x) => x.includes('arrival details')), mailsTo(guest.email, mailMark).some((x) => x.startsWith('Approved'))], [true, false]);

console.log('\n— the buttons on the payment-on-hold alert —');
await held('h-confirm', {}, { check_in: '2027-01-18', check_out: '2027-01-22' });
r = await press('held_confirm_h-confirm', 'PAYMENT ON HOLD. ref_with_an_underscore');
check('Confirm booking confirms it and settles the request', [state('h-confirm'), req('req-h-confirm').status], [['confirmed', 'paid', 'ref-h-confirm'], 'approved']);
const edited = rig.telegram.filter((m) => m.url.endsWith('/editMessageText')).at(-1);
check('the alert is rewritten in plain text, so the buttons cannot be pressed twice', [edited.text.includes('CONFIRMED with this payment'), edited.parse_mode || null, !!edited.reply_markup], [true, null, false]);
r = await press('held_confirm_h-confirm');
check('pressing an old copy of it again changes nothing', state('h-confirm'), ['confirmed', 'paid', 'ref-h-confirm']);

await held('h-refund', {}, { check_in: '2027-01-25', check_out: '2027-01-29' });
mailMark = rig.emails.length;
r = await press('held_refund_h-refund');
check('Mark refunded records the refund, closes the booking and the request', [state('h-refund'), row('h-refund').cancel_reason, req('req-h-refund').status], [['cancelled', 'refunded', 'ref-h-refund'], 'admin_rejected', 'rejected']);
check('and tells the guest', mailsTo(guest.email, mailMark), ['Your payment has been refunded']);
r = await report('h-refund', 'ref-h-refund');
check('a refunded payment handed in again is refused', [r.status, r.code, state('h-refund')], [409, 'PAYMENT_REFUNDED', ['cancelled', 'refunded', 'ref-h-refund']]);
r = await call(rig, openPaymentPage, { booking_id: 'h-refund' }, guest);
check('and its payment page says it was refunded', [r.status, r.code], [409, 'PAYMENT_REFUNDED']);

console.log('\n— a payment on hold, and the admin rejects the request —');
await held('h-reject', {}, { check_in: '2027-02-01', check_out: '2027-02-05' });
mailMark = rig.emails.length;
let tgMark = rig.telegram.length;
r = await adminDecides('req-h-reject', 'reject');
check('the booking is cancelled and the money stays on hold: a refund is owed', [r.status, r.data.refund_owed, state('h-reject'), row('h-reject').cancel_reason, req('req-h-reject').status], [200, true, ['cancelled', 'pending_confirmation', 'ref-h-reject'], 'admin_rejected', 'rejected']);
const owed = rig.telegram.slice(tgMark).find((m) => (m.text || '').startsWith('REFUND OWED'));
check('the admin is reminded, with the amount, the reference and the Mark refunded button', [!!owed, owed.text.includes('1,198,000'), owed.text.includes('ref-h-reject'), owed.reply_markup.inline_keyboard[0][0].callback_data], [true, true, true, 'held_refund_h-reject']);
check('the guest is told their payment will be refunded', rig.emails.slice(mailMark).some((m) => m.to === guest.email && m.body.includes('It will be refunded in full') && m.body.includes('ref-h-reject')), true);
r = await call(rig, markRefunded, { booking_id: 'h-reject' }, admin);
check('marking it refunded in the Admin screen settles it', [r.status, state('h-reject')], [200, ['cancelled', 'refunded', 'ref-h-reject']]);
r = await call(rig, markRefunded, { booking_id: 'h-reject' }, admin);
check('twice is the same as once', [r.status, r.data.already], [200, true]);

console.log('\n— before a held payment is confirmed, Paystack and the calendar are asked again —');
await held('h-gone', { status: 'cancelled', cancel_reason: 'payment_expired', ...APPROVED }, { check_in: '2027-02-08', check_out: '2027-02-12' });
add('took-the-dates', { ...APPROVED, status: 'confirmed', payment_status: 'paid', check_in: '2027-02-10', check_out: '2027-02-14', guest_email: other.email });
r = await call(rig, verify, { booking_id: 'h-gone', confirm_held: true }, admin);
check('dates that have gone to another booking are not double-booked', [r.status, r.code, r.error.includes('took-the-dates'), state('h-gone')], [409, 'DATES_TAKEN', true, ['cancelled', 'pending_confirmation', 'ref-h-gone']]);
row('took-the-dates').status = 'cancelled';
r = await call(rig, verify, { booking_id: 'h-gone', confirm_held: true }, admin);
check('once the dates are free, the cancelled booking is confirmed with its payment', [r.status, state('h-gone')], [200, ['confirmed', 'paid', 'ref-h-gone']]);

await held('h-refunded-already', {}, { check_in: '2027-02-15', check_out: '2027-02-19' });
rig.paystack['ref-h-refunded-already'].status = 'reversed';
r = await adminDecides('req-h-refunded-already', 'approve');
check('a payment Paystack no longer calls successful confirms nothing', [r.status, r.code, state('h-refunded-already'), req('req-h-refunded-already').status], [409, 'PAYMENT_NOT_VERIFIED', ['pending', 'pending_confirmation', 'ref-h-refunded-already'], 'pending']);
rig.paystack['ref-h-refunded-already'].status = 'success';

console.log('\n— who may confirm or mark refunded —');
r = await call(rig, verify, { booking_id: 'h-refunded-already', confirm_held: true }, guest);
check('not the guest', [r.status, r.code, state('h-refunded-already')[1]], [403, 'ADMIN_ONLY', 'pending_confirmation']);
r = await call(rig, verify, { booking_id: 'h-refunded-already', confirm_held: true, internal_secret: 'a-guess' }, null);
check('not a caller with the wrong secret', [r.status, state('h-refunded-already')[1]], [403, 'pending_confirmation']);
r = await call(rig, markRefunded, { booking_id: 'h-refunded-already' }, guest);
check('nor may the guest mark it refunded', [r.status, state('h-refunded-already')[1]], [403, 'pending_confirmation']);
const realSecret = rig.env.INTERNAL_FUNCTION_SECRET;
rig.env.INTERNAL_FUNCTION_SECRET = '';
r = await call(rig, verify, { booking_id: 'h-refunded-already', confirm_held: true, internal_secret: '' }, null);
check('with no secret configured, a caller without a session is refused: it does not fail open', [r.status, state('h-refunded-already')[1]], [403, 'pending_confirmation']);
tgMark = rig.telegram.length;
r = await press('held_confirm_h-refunded-already');
check('so the Telegram button says to use the Admin screen, and changes nothing', [rig.telegram.slice(tgMark).some((m) => (m.text || '').includes('Open Admin')), state('h-refunded-already')[1]], [true, 'pending_confirmation']);
r = await call(rig, verify, { booking_id: 'h-refunded-already', confirm_held: true }, admin);
check('the admin\'s own login still works without it', [r.status, state('h-refunded-already')], [200, ['confirmed', 'paid', 'ref-h-refunded-already']]);
rig.env.INTERNAL_FUNCTION_SECRET = realSecret;
r = await call(rig, verify, { booking_id: 'approved', confirm_held: true }, admin);
check('a booking that is already paid is simply reported as confirmed', [r.status, r.data.already_paid], [200, true]);
r = await call(rig, verify, { booking_id: 'mine', confirm_held: true }, admin);
check('and one with nothing on hold is refused', [r.status, r.code, state('mine')], [409, 'NOT_HELD', ['pending', 'unpaid', null]]);

console.log('\n— a held booking is left alone by everything else —');
await held('h-wait', {}, { check_in: '2027-03-01', check_out: '2027-03-05' });
r = await call(rig, openPaymentPage, { booking_id: 'h-wait' }, guest);
check('its payment page does not take a second payment', [r.status, r.code, r.error.includes('do not pay again')], [409, 'PAYMENT_HELD', true]);
r = await call(rig, cancel, { booking_id: 'h-wait' }, guest);
check('the guest cannot cancel it away: there is money on it', [r.status, r.code, state('h-wait')], [409, 'PAYMENT_HELD', ['pending', 'pending_confirmation', 'ref-h-wait']]);
// Approved long ago, deadline long past, and holding a payment.
Object.assign(row('h-wait'), { approved_at: '2026-01-01T00:00:00.000Z' });
add('unpaid-and-late', { approved_at: '2026-01-01T00:00:00.000Z', check_in: '2027-03-08', check_out: '2027-03-12' });
mailMark = rig.emails.length;
r = await call(rig, sweep, {}, admin);
check('the expiry sweep cancels the booking nobody paid for', [r.status, state('unpaid-and-late')[0], row('unpaid-and-late').cancel_reason], [200, 'cancelled', 'payment_expired']);
check('and leaves the one that holds a payment, telling its guest nothing', [state('h-wait'), rig.emails.slice(mailMark).some((m) => m.body.includes('h-wait')), rig.emails.slice(mailMark).some((m) => m.body.includes('unpaid-and-late'))], [['pending', 'pending_confirmation', 'ref-h-wait'], false, true]);
r = await call(rig, listBookings, { scope: 'mine' }, guest);
const bucketOf = (id) => (r.data.find((b) => b.id === id) || {}).bucket || null;
check('the guest finds a held booking under what is still waiting, even a cancelled one', [bucketOf('h-wait'), bucketOf('expired')], ['pending-approval', 'pending-approval']);
tgMark = rig.telegram.length;
r = await call(rig, cancel, { booking_id: 'h-wait' }, admin);
check('the admin can cancel it, and is reminded that money is on hold', [r.status, state('h-wait'), rig.telegram.slice(tgMark).some((m) => (m.text || '').includes('ON HOLD'))], [200, ['cancelled', 'pending_confirmation', 'ref-h-wait'], true]);

console.log('\n— a request acts on its own booking —');
add('twin-a', { check_in: '2027-04-01', check_out: '2027-04-05' });
add('twin-b', { check_in: '2027-04-01', check_out: '2027-04-05' });
request('req-twin-a', 'twin-a');
request('req-twin-b', 'twin-b');
r = await adminDecides('req-twin-b', 'approve');
check('two requests from a double tap: approving the second approves the second booking', [!!row('twin-b').approved_at, !!row('twin-a').approved_at, req('req-twin-a').status], [true, false, 'pending']);
r = await adminDecides('req-twin-a', 'reject');
check('and rejecting the first cancels the first', [state('twin-a')[0], row('twin-a').cancel_reason, state('twin-b')[0]], ['cancelled', 'admin_rejected', 'pending']);

add('withdrawn', { status: 'cancelled', cancel_reason: 'user_cancelled', check_in: '2027-04-08', check_out: '2027-04-12' });
request('req-withdrawn', 'withdrawn');
mailMark = rig.emails.length;
r = await adminDecides('req-withdrawn', 'approve');
check('a request the guest already cancelled cannot be approved; it leaves the list', [r.status, r.code, req('req-withdrawn').status, state('withdrawn')[0]], [409, 'BOOKING_CANCELLED', 'rejected', 'cancelled']);
check('and the guest is not emailed a link to pay for it', mailsTo(guest.email, mailMark), []);

// A row from before payments were held: paid and confirmed, request never answered.
add('paid-unanswered', { status: 'confirmed', payment_status: 'paid', transaction_hash: 'ref-long-ago', paid_at: '2026-09-01T10:00:00.000Z', check_in: '2027-05-01', check_out: '2027-05-05' });
request('req-paid-unanswered', 'paid-unanswered');
mailMark = rig.emails.length;
r = await adminDecides('req-paid-unanswered', 'reject');
check('a request whose booking is already paid and confirmed cannot be rejected', [r.status, r.code, state('paid-unanswered'), req('req-paid-unanswered').status, mailsTo(guest.email, mailMark)], [409, 'ALREADY_PAID', ['confirmed', 'paid', 'ref-long-ago'], 'pending', []]);
r = await adminDecides('req-paid-unanswered', 'approve');
check('approving it only clears the request: no "you have an hour to pay" for a paid stay', [r.status, req('req-paid-unanswered').status, state('paid-unanswered'), mailsTo(guest.email, mailMark)], [200, 'approved', ['confirmed', 'paid', 'ref-long-ago'], []]);

add('old-style', { check_in: '2027-04-15', check_out: '2027-04-19' });
request('req-old-style', 'old-style', { booking_id: undefined });
r = await press('approve_req-old-style');
check('a request from before the id existed is still matched by property, dates and guest', [!!row('old-style').approved_at, req('req-old-style').status], [true, 'approved']);

add('not-yours', { check_in: '2027-04-22', check_out: '2027-04-26', guest_email: other.email });
add('yours-really', { check_in: '2027-04-22', check_out: '2027-04-26' });
request('req-crossed', 'yours-really', { booking_id: 'not-yours' });
r = await adminDecides('req-crossed', 'approve');
check('a request whose id points at somebody else\'s booking does not touch that booking', [!!row('not-yours').approved_at, req('req-crossed').status], [false, 'approved']);

console.log('\n— a decision that stops halfway is finished by the next press —');
// A decision is two writes: the booking, then the request. Each case fails
// the request write once and presses again.
const failRequestWriteOnce = () => { let failed = false; rig.failOn = (entity, op) => { if (entity === 'AvailabilityRequest' && op === 'update' && !failed) { failed = true; return true; } return false; }; };
add('half-reject', { check_in: '2027-06-01', check_out: '2027-06-05' });
request('req-half-reject', 'half-reject');
failRequestWriteOnce();
mailMark = rig.emails.length;
r = await adminDecides('req-half-reject', 'reject');
rig.failOn = null;
check('reject: the booking is cancelled, the request write fails, and the admin is shown a failure', [r.status, state('half-reject')[0], row('half-reject').cancel_reason, req('req-half-reject').status, mailsTo(guest.email, mailMark)], [500, 'cancelled', 'admin_rejected', 'pending', []]);
r = await adminDecides('req-half-reject', 'reject');
check('pressing Reject again finishes it, and the guest is told it was declined', [r.status, req('req-half-reject').status, mailsTo(guest.email, mailMark).some((x) => x.startsWith('Update on your booking request'))], [200, 'rejected', true]);

add('half-approve', { check_in: '2027-06-08', check_out: '2027-06-12' });
request('req-half-approve', 'half-approve');
failRequestWriteOnce();
mailMark = rig.emails.length;
tgMark = rig.telegram.length;
r = await press('approve_req-half-approve');
rig.failOn = null;
check('approve from Telegram: when it fails part-way the admin is told, not left to think it was done', [!!row('half-approve').approved_at, req('req-half-approve').status, rig.telegram.slice(tgMark).some((m) => (m.text || '').includes('Press the button again')), mailsTo(guest.email, mailMark)], [true, 'pending', true, []]);
r = await press('approve_req-half-approve');
check('pressing Approve again finishes it, and the guest is told to pay', [req('req-half-approve').status, mailsTo(guest.email, mailMark).some((x) => x.startsWith('Approved'))], ['approved', true]);

// The same, but nobody pressed again in time and the sweep cancelled the booking.
add('half-approve-late', { check_in: '2027-06-15', check_out: '2027-06-19', status: 'cancelled', cancel_reason: 'payment_expired', approved_at: '2026-01-01T00:00:00.000Z' });
request('req-half-approve-late', 'half-approve-late');
r = await adminDecides('req-half-approve-late', 'approve');
check('approving a booking that ran out of time says so, and does not blame the guest', [r.status, r.code, /ran out of time/.test(r.error), /guest cancelled/.test(r.error), req('req-half-approve-late').status], [409, 'BOOKING_CANCELLED', true, false, 'rejected']);

await held('half-confirm', {}, { check_in: '2027-06-22', check_out: '2027-06-26' });
failRequestWriteOnce();
r = await adminDecides('req-half-confirm', 'approve');
rig.failOn = null;
check('approve with a payment on hold: the request is closed here, not left to a write that may be skipped', [r.status, state('half-confirm'), req('req-half-confirm').status], [200, ['confirmed', 'paid', 'ref-half-confirm'], 'approved']);

await held('no-secret', {}, { check_in: '2027-06-29', check_out: '2027-07-03' });
rig.env.INTERNAL_FUNCTION_SECRET = '';
tgMark = rig.telegram.length;
r = await press('approve_req-no-secret');
rig.env.INTERNAL_FUNCTION_SECRET = realSecret;
check('with no secret set, Approve on the Telegram card points the admin at the Admin screen', [rig.telegram.slice(tgMark).some((m) => (m.text || '').includes('Open Admin')), rig.telegram.slice(tgMark).some((m) => (m.text || '').includes('Only an admin')), state('no-secret')[1], req('req-no-secret').status], [true, false, 'pending_confirmation', 'pending']);

console.log('\n— the two functions carry the same rules —');
const decideRules = (name) => {
  const src = fs.readFileSync(path.join(ROOT, 'base44/functions', name, 'entry.ts'), 'utf8');
  const start = src.indexOf('// ── Deciding a stay request');
  const end = src.indexOf('// ── end of deciding a stay request');
  return start < 0 || end < 0 ? null : src.slice(start, end);
};
check('decideAvailabilityRequest and telegramWebhook decide a request by the same text', [!!decideRules('decideAvailabilityRequest'), decideRules('decideAvailabilityRequest') === decideRules('telegramWebhook')], [true, true]);
const rules = (name) => {
  const src = fs.readFileSync(path.join(ROOT, 'base44/functions', name, 'entry.ts'), 'utf8');
  const start = src.indexOf('// ── Stay payment rules');
  const end = src.indexOf('// ── end of stay payment rules');
  return start < 0 || end < 0 ? null : src.slice(start, end);
};
check('verifyPaystackPayment and paystackWebhook each have the block', [!!rules('verifyPaystackPayment'), !!rules('paystackWebhook')], [true, true]);
check('and it is the same in both, word for word', rules('verifyPaystackPayment') === rules('paystackWebhook'), true);
for (const name of ['verifyPaystackPayment', 'paystackWebhook']) {
  const src = fs.readFileSync(path.join(ROOT, 'base44/functions', name, 'entry.ts'), 'utf8');
  check(`${name} no longer asks for "paid and confirmed" before it calls a stay paid`, /payment_status === 'paid' && booking\.status === 'confirmed'/.test(src), false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
