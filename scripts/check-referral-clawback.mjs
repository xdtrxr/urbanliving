// Taking a referral reward back — run with: node scripts/check-referral-clawback.mjs
//
// A referral reward is paid the moment a referred guest pays. Decided on
// 2026-10-23: when an admin cancels a paid stay or ride, which is how a refund
// starts, the reward that booking earned is taken back (takeBackReferralReward
// in cancelBooking and cancelRideBooking). What the referrer has already
// withdrawn cannot be taken back; it is written down and the admin is told.
//
// Runs the shipped functions against scripts/lib/function-rig.mjs. The reward
// itself is paid by processReferralReward, the admin's tool, which runs the
// same block the payment functions run.

import fs from 'node:fs';
import path from 'node:path';
import { createRig, loadFunction, call, stubNetwork, ROOT } from './lib/function-rig.mjs';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const rig = createRig({ serverOnlyCreate: ['LoyaltyTransaction', 'Referral'] });
stubNetwork(rig);
const cancelStay = await loadFunction(rig, 'cancelBooking');
const cancelRide = await loadFunction(rig, 'cancelRideBooking');
const payReward = await loadFunction(rig, 'processReferralReward');

const admin = { id: 'root', email: 'root@example.com', role: 'admin' };
const rita = { id: 'rita', email: 'rita@example.com', role: 'user', referral_balance_ngn: 0, loyalty_points: 0 };
const gina = { id: 'gina', email: 'gina@example.com', role: 'user', full_name: 'Gina Guest' };
const sade = { id: 'sade', email: 'sade@example.com', role: 'user', referral_balance_ngn: 0, loyalty_points: 0 };
const tayo = { id: 'tayo', email: 'tayo@example.com', role: 'user', full_name: 'Tayo Guest' };
const omar = { id: 'omar', email: 'omar@example.com', role: 'user', full_name: 'Omar Guest' };
rig.db.User = [admin, rita, gina, sade, tayo, omar].map((u) => ({ ...u }));
const user = (id) => rig.db.User.find((u) => u.id === id);
rig.db.Referral = [
  { id: 'ref-gina', referrer_email: rita.email, referred_email: gina.email, status: 'signed_up', created_date: '2026-01-01T00:00:00.000Z' },
  { id: 'ref-tayo', referrer_email: sade.email, referred_email: tayo.email, status: 'signed_up', created_date: '2026-01-01T00:00:00.000Z' },
];
const referral = (id) => rig.db.Referral.find((r) => r.id === id);
rig.db.Property = [{ id: 'p1', title: 'Maitama Duplex' }];
rig.db.LoyaltyTransaction = [];
const PRICE = 1198000;
const REWARD = 59900;
const paidStay = (id, guest, fields = {}) => ({
  id, property_id: 'p1', guest_name: guest.full_name, guest_email: guest.email, check_in: '2027-02-01', check_out: '2027-02-05',
  total_price: PRICE, status: 'confirmed', payment_status: 'paid', transaction_hash: `ref-${id}`, paid_at: '2026-10-20T10:00:00.000Z', ...fields,
});
rig.db.Booking = [paidStay('s1', gina)];
const stay = (id) => rig.db.Booking.find((b) => b.id === id);
const reversals = (bookingId) => rig.db.LoyaltyTransaction.filter((x) => x.booking_id === bookingId && Number(x.points_earned) < 0);
const cancelNote = () => rig.sent.filter((t) => t.includes('CANCELLED')).at(-1) || '';

console.log('\n— a paid stay that earned a reward is cancelled by an admin —');
let r = await call(rig, payReward, { booking_id: 's1' }, admin);
check('the reward is paid first (the admin tool runs the payment path\'s block)', [r.status, user('rita').referral_balance_ngn, user('rita').loyalty_points, referral('ref-gina').status], [200, REWARD, 250, 'booking_completed']);
r = await call(rig, cancelStay, { booking_id: 's1' }, admin);
check('the cancellation goes through', [r.status, stay('s1').status], [200, 'cancelled']);
check('the reward is taken back from the balance and the points', [user('rita').referral_balance_ngn, user('rita').loyalty_points], [0, 0]);
check('the guest\'s referral row is open again', [referral('ref-gina').status, referral('ref-gina').booking_id, referral('ref-gina').amount_earned_ngn], ['signed_up', '', 0]);
check('a record of it is written for the referrer', [reversals('s1').length, reversals('s1')[0] && reversals('s1')[0].user_email, reversals('s1')[0] && reversals('s1')[0].points_earned], [1, rita.email, -250]);
check('and the admin is told in the cancellation message', cancelNote().includes(`Referral reward taken back: ₦${REWARD.toLocaleString()}`), true);
r = await call(rig, cancelStay, { booking_id: 's1' }, admin);
check('cancelling again takes nothing more', [r.data && r.data.already_cancelled, user('rita').referral_balance_ngn, reversals('s1').length], [true, 0, 1]);
r = await call(rig, payReward, { booking_id: 's1' }, admin);
check('the cancelled stay can never earn again: the admin tool refuses it', [r.status, r.code, user('rita').referral_balance_ngn], [409, 'NOT_PAID', 0]);

console.log('\n— the next stay the guest keeps still earns the one reward —');
rig.db.Booking.push(paidStay('s2', gina, { check_in: '2027-03-01', check_out: '2027-03-03', paid_at: '2026-10-22T10:00:00.000Z' }));
r = await call(rig, payReward, { booking_id: 's2' }, admin);
check('paid once', [r.status, user('rita').referral_balance_ngn, referral('ref-gina').booking_id], [200, REWARD, 's2']);

console.log('\n— the referrer has already withdrawn some of it —');
rig.db.Booking.push(paidStay('t1', tayo));
await call(rig, payReward, { booking_id: 't1' }, admin);
user('sade').referral_balance_ngn = 20000;
r = await call(rig, cancelStay, { booking_id: 't1' }, admin);
check('what is there is taken; the balance never goes below zero', user('sade').referral_balance_ngn, 0);
check('the shortfall is written on the record', reversals('t1')[0] && reversals('t1')[0].description.includes(`₦${(REWARD - 20000).toLocaleString()} could not be taken back`), true);
check('and the admin is told how much was already withdrawn', cancelNote().includes(`₦${(REWARD - 20000).toLocaleString()} was already withdrawn`), true);
check('with money not returned, the guest\'s one reward stays used', referral('ref-tayo').status, 'booking_completed');
rig.db.Booking.push(paidStay('t2', tayo, { check_in: '2027-03-10', check_out: '2027-03-12', paid_at: '2026-10-22T10:00:00.000Z' }));
r = await call(rig, payReward, { booking_id: 't2' }, admin);
check('so the next stay does not pay the referrer a second time', [r.data && r.data.skipped, user('sade').referral_balance_ngn], ['already_awarded', 0]);

console.log('\n— two admins cancel the same paid stay at once —');
rig.db.Booking.push(paidStay('s3', gina, { check_in: '2027-04-01', check_out: '2027-04-03' }));
// s2 holds the reward now; move it to s3 as if s3 had earned it.
Object.assign(referral('ref-gina'), { booking_id: 's3' });
rig.db.LoyaltyTransaction.push({ id: 'claim-s3', user_email: rita.email, points_earned: 250, transaction_type: 'referral', booking_id: 's3', created_date: '2026-10-22T11:00:00.000Z' });
const both = await Promise.all([call(rig, cancelStay, { booking_id: 's3' }, admin), call(rig, cancelStay, { booking_id: 's3' }, admin)]);
check('both answer, and the reward is taken back once', [both.map((x) => x.status), user('rita').referral_balance_ngn, reversals('s3').length], [[200, 200], 0, 1]);

console.log('\n— nothing to take back —');
rig.db.Booking.push(paidStay('o1', omar));
const before = rig.db.LoyaltyTransaction.length;
r = await call(rig, cancelStay, { booking_id: 'o1' }, admin);
check('a paid stay with no referral: cancelled, nothing written, no reward line', [r.status, rig.db.LoyaltyTransaction.length - before, cancelNote().includes('Referral reward')], [200, 0, false]);
rig.db.Booking.push({ ...paidStay('u1', gina), status: 'pending', payment_status: 'unpaid', transaction_hash: '' });
rig.db.Referral.push({ id: 'ref-stray', referrer_email: rita.email, referred_email: 'x@example.com', status: 'booking_completed', booking_id: 'u1', amount_earned_ngn: 100 });
r = await call(rig, cancelStay, { booking_id: 'u1' }, admin);
check('an unpaid stay is not looked at, whatever a row says', [r.status, referral('ref-stray').status], [200, 'booking_completed']);

console.log('\n— a paid ride —');
rig.db.RideBooking = [{ id: 'ride1', guest_email: tayo.email, guest_name: 'Tayo Guest', vehicle_name: 'Prado', start_at: '2027-05-01T08:00:00.000Z', total_price: 120000, status: 'confirmed', payment_status: 'paid', transaction_hash: 'ref-ride1' }];
Object.assign(referral('ref-tayo'), { status: 'booking_completed', booking_id: 'ride1', amount_earned_ngn: 6000 });
rig.db.LoyaltyTransaction.push({ id: 'claim-ride1', user_email: sade.email, points_earned: 250, transaction_type: 'referral', booking_id: 'ride1', created_date: '2026-10-22T12:00:00.000Z' });
user('sade').referral_balance_ngn = 6000;
user('sade').loyalty_points = 250;
rig.db.DriverEarning = [];
r = await call(rig, cancelRide, { ride_booking_id: 'ride1' }, admin);
const rideNote = rig.sent.filter((t) => t.includes('RIDE CANCELLED')).at(-1) || '';
check('cancelled by an admin, the ride\'s reward is taken back', [r.status, user('sade').referral_balance_ngn, user('sade').loyalty_points, referral('ref-tayo').status], [200, 0, 0, 'signed_up']);
check('and the admin is told', rideNote.includes('Referral reward taken back: ₦6,000'), true);

console.log('\n— when taking it back fails —');
rig.db.Booking.push(paidStay('s4', gina, { check_in: '2027-06-01', check_out: '2027-06-03' }));
Object.assign(referral('ref-gina'), { status: 'booking_completed', booking_id: 's4', amount_earned_ngn: REWARD });
user('rita').referral_balance_ngn = REWARD;
rig.failOn = (entity, op, id) => entity === 'User' && op === 'update' && id === 'rita';
r = await call(rig, cancelStay, { booking_id: 's4' }, admin);
rig.failOn = null;
check('the cancellation still stands', [r.status, stay('s4').status], [200, 'cancelled']);
check('and the admin is told to check the balance', cancelNote().includes('could NOT be taken back'), true);
check('nothing was half done: the balance, the referral row and no reversal record', [user('rita').referral_balance_ngn, referral('ref-gina').status, reversals('s4').length], [REWARD, 'booking_completed', 0]);

console.log('\n— the write lands but reports a failure, and the balance was already empty —');
rig.db.Booking.push(paidStay('s5', gina, { check_in: '2027-07-01', check_out: '2027-07-03' }));
Object.assign(referral('ref-gina'), { status: 'booking_completed', booking_id: 's5', amount_earned_ngn: REWARD });
Object.assign(user('rita'), { referral_balance_ngn: 0, loyalty_points: 500 });
rig.failAfter = (entity, op, id) => entity === 'User' && op === 'update' && id === 'rita';
r = await call(rig, cancelStay, { booking_id: 's5' }, admin);
rig.failAfter = null;
check('the points did move, so the record of it is kept, and it can never be taken twice', [r.status, user('rita').loyalty_points, reversals('s5').length], [200, 250, 1]);

console.log('\n— the shared block is word for word the same —');
const src = (name) => fs.readFileSync(path.join(ROOT, 'base44', 'functions', name, 'entry.ts'), 'utf8');
const block = (text) => {
  const a = text.indexOf('// ── Taking a referral reward back');
  const b = text.indexOf('// ── end of taking a referral reward back', a);
  return a < 0 || b < 0 ? null : text.slice(a, b);
};
check('cancelBooking and cancelRideBooking agree', [!!block(src('cancelBooking')), block(src('cancelBooking')) === block(src('cancelRideBooking'))], [true, true]);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
