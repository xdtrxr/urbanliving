// Referral reward — run with: node scripts/check-referral-reward.mjs
//
// processReferralReward credits 5% of a booking's total to the referrer's
// withdrawable balance. The booking's own guest may call it. Until 2026-10-12
// it checked who was asking and nothing else, so an UNPAID request (up to a
// year at any listing's price) put real money on a balance: found by running
// the function, not by reading it. This script runs the shipped handler
// against an in-memory backend (scripts/lib/function-rig.mjs) and pins what
// it may and may not pay for.

import { createRig, loadFunction, call } from './lib/function-rig.mjs';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const rig = createRig();
const handler = await loadFunction(rig, 'processReferralReward');

// Ada referred Bola. Chidi signed up on his own. Dayo is a stranger.
const ada = { id: 'ada', email: 'ada@example.com', role: 'user', referral_code: 'ADA1', referral_balance_ngn: 0, loyalty_points: 0 };
const bola = { id: 'bola', email: 'bola@example.com', role: 'user', referred_by_code: 'ADA1' };
const chidi = { id: 'chidi', email: 'chidi@example.com', role: 'user' };
const dayo = { id: 'dayo', email: 'dayo@example.com', role: 'user' };
rig.db.User = [ada, bola, chidi, dayo].map((u) => ({ ...u }));
const booking = (id, guest, fields) => ({ id, guest_email: guest.email, property_id: 'p1', check_in: '2026-12-13', check_out: '2026-12-17', total_price: 1198000, status: 'pending', payment_status: 'unpaid', ...fields });
rig.db.Booking = [
  booking('requested', bola, {}),
  booking('approved', bola, { approved_at: '2026-10-12T08:00:00Z' }),
  booking('refunded', bola, { status: 'cancelled', payment_status: 'paid' }),
  booking('paid', bola, { status: 'confirmed', payment_status: 'paid', approved_at: '2026-10-12T08:00:00Z' }),
  booking('solo', chidi, { status: 'confirmed', payment_status: 'paid' }),
];
const balance = () => rig.db.User.find((u) => u.id === 'ada').referral_balance_ngn;
const points = () => rig.db.User.find((u) => u.id === 'ada').loyalty_points;
const ask = (booking_id, user) => call(rig, handler, { booking_id }, user);

console.log('\n— a reward is owed for a paid stay, and for nothing else —');
let r = await ask('requested', bola);
check('a request nobody has paid for earns nothing', [r.status, r.code, balance()], [409, 'NOT_PAID', 0]);
r = await ask('approved', bola);
check('nor does one the admin approved but the guest has not paid', [r.status, r.code, balance()], [409, 'NOT_PAID', 0]);
r = await ask('refunded', bola);
check('nor a paid stay that was then cancelled', [r.status, r.code, balance()], [409, 'NOT_PAID', 0]);
check('none of those marked the referral as rewarded', (rig.db.Referral || []).filter((x) => x.status === 'booking_completed').length, 0);

r = await ask('paid', bola);
check('a paid, confirmed stay pays the referrer 5% of its total', [r.status, r.data && r.data.amount_awarded_ngn, balance(), points()], [200, 59900, 59900, 250]);
check('and stamps the referral with the booking it was for', rig.db.Referral.map((x) => [x.status, x.booking_id, x.amount_earned_ngn]), [['booking_completed', 'paid', 59900]]);
r = await ask('paid', bola);
check('once: a second call pays nothing more', [r.status, r.data && r.data.skipped, balance(), points()], [200, 'already_awarded', 59900, 250]);

console.log('\n— who may ask —');
r = await ask('paid', dayo);
check('somebody else\'s booking is refused', r.status, 403);
r = await ask('solo', chidi);
check('a guest nobody referred is skipped, not paid', [r.status, r.data && r.data.skipped, balance()], [200, 'no_referrer', 59900]);
r = await ask('paid', null);
check('signed out', r.status, 401);
r = await ask('', bola);
check('no booking named', r.status, 400);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
