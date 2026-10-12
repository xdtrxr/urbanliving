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

const guest = { id: 'gina', email: 'gina@example.com', role: 'user', full_name: 'Gina Guest', phone_number: '08030000000', loyalty_points: 0 };
const other = { id: 'otto', email: 'otto@example.com', role: 'user' };
const admin = { id: 'root', email: 'root@example.com', role: 'admin' };
// Rita referred Gina, and Sade referred Tayo: attributeReferral wrote the rows.
const rita = { id: 'rita', email: 'rita@example.com', role: 'user', referral_balance_ngn: 0, loyalty_points: 0 };
const sade = { id: 'sade', email: 'sade@example.com', role: 'user', referral_balance_ngn: 0, loyalty_points: 0 };
const tayo = { id: 'tayo', email: 'tayo@example.com', role: 'user', full_name: 'Tayo Guest', loyalty_points: 0 };
rig.db.User = [guest, other, admin, rita, sade, tayo].map((u) => ({ ...u }));
rig.db.Referral = [
  { id: 'ref-gina', referrer_email: rita.email, referred_email: guest.email, status: 'signed_up' },
  { id: 'ref-tayo', referrer_email: sade.email, referred_email: tayo.email, status: 'signed_up' },
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

console.log('\n— the two functions carry the same rules —');
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
