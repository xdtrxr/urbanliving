// Referral reward — run with: node scripts/check-referral-reward.mjs
//
// A referrer earns 5% of the first stay or ride their referred guest pays
// for, onto a balance that is paid out through Paystack. The rules live in
// one block, payReferralReward, copied into the four functions that can pay
// it. This script runs the block through processReferralReward, which the
// booking's own guest could once call. Until 2026-10-12
// it checked who was asking and nothing else, so an UNPAID request (up to a
// year at any listing's price) put real money on a balance: found by running
// the function, not by reading it. It also took the referrer from the code on
// the guest's own profile, so one paid stay could be rewarded again for every
// code the guest put there, their own included. This script runs the shipped
// handler against an in-memory backend (scripts/lib/function-rig.mjs) and
// pins what it may and may not pay for, and to whom.

import fs from 'node:fs';
import path from 'node:path';
import { createRig, loadFunction, call, ROOT } from './lib/function-rig.mjs';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const rig = createRig();
const handler = await loadFunction(rig, 'processReferralReward');

// Ada referred Bola: attributeReferral stamped Bola's profile and wrote the
// Referral row. Chidi signed up on his own. Dayo is a stranger. Hauwa has
// copied Ada's code onto her own profile and sits ahead of Ada in the table.
const hauwa = { id: 'hauwa', email: 'hauwa@example.com', role: 'user', referral_code: 'ADA1', referral_balance_ngn: 0 };
const ada = { id: 'ada', email: 'ada@example.com', role: 'user', referral_code: 'ADA1', referral_balance_ngn: 0, loyalty_points: 0 };
const bola = { id: 'bola', email: 'bola@example.com', role: 'user', referred_by_code: 'ADA1' };
const chidi = { id: 'chidi', email: 'chidi@example.com', role: 'user' };
const dayo = { id: 'dayo', email: 'dayo@example.com', role: 'user' };
// Eve is a second account of Bola's. Femi points his profile at his own code
// and nothing ever attributed him. Gbenga's referral was rewarded in May, when
// a reward left a second row beside the sign-up one (the live table has two
// such pairs). Ife's row names an account that no longer exists. Jide's row
// names Jide.
const eve = { id: 'eve', email: 'eve@example.com', role: 'user', referral_code: 'EVE1', referral_balance_ngn: 0 };
const femi = { id: 'femi', email: 'femi@example.com', role: 'user', referral_code: 'FEMI1', referred_by_code: 'FEMI1', referral_balance_ngn: 0 };
const gbenga = { id: 'gbenga', email: 'gbenga@example.com', role: 'user', referred_by_code: 'ADA1' };
const ife = { id: 'ife', email: 'ife@example.com', role: 'user', referred_by_code: 'GONE1' };
const jide = { id: 'jide', email: 'jide@example.com', role: 'user', referral_code: 'JIDE1', referred_by_code: 'JIDE1', referral_balance_ngn: 0 };
// Kemi was a customer before Lara referred her. Musa, Ngozi and Obi are
// ordinary referrals of Lara's, used for the races and the failed write.
const lara = { id: 'lara', email: 'lara@example.com', role: 'user', referral_code: 'LARA1', referral_balance_ngn: 1000, loyalty_points: 0 };
const kemi = { id: 'kemi', email: 'kemi@example.com', role: 'user', referred_by_code: 'LARA1' };
const musa = { id: 'musa', email: 'musa@example.com', role: 'user', referred_by_code: 'LARA1' };
const ngozi = { id: 'ngozi', email: 'ngozi@example.com', role: 'user', referred_by_code: 'LARA1' };
const obi = { id: 'obi', email: 'obi@example.com', role: 'user', referred_by_code: 'LARA1' };
const pat = { id: 'pat', email: 'pat@example.com', role: 'user', referred_by_code: 'LARA1' };
const quam = { id: 'quam', email: 'quam@example.com', role: 'user', referred_by_code: 'LARA1' };
// The admin, who is the only one allowed to ask this function for a reward.
const root = { id: 'root', email: 'root@example.com', role: 'admin' };
rig.db.User = [hauwa, ada, bola, chidi, dayo, eve, femi, gbenga, ife, jide, lara, kemi, musa, ngozi, obi, pat, quam, root].map((u) => ({ ...u }));
rig.db.Referral = [
  { id: 'ref-bola', referrer_email: ada.email, referred_email: bola.email, status: 'signed_up' },
  { id: 'ref-gbenga-signup', referrer_email: ada.email, referred_email: gbenga.email, status: 'signed_up' },
  { id: 'ref-gbenga-paid', referrer_email: ada.email, referred_email: gbenga.email, status: 'booking_completed', booking_id: 'gbenga-may', amount_earned_ngn: 36 },
  { id: 'ref-ife', referrer_email: 'gone@example.com', referred_email: ife.email, status: 'signed_up' },
  { id: 'ref-jide', referrer_email: jide.email, referred_email: jide.email, status: 'signed_up' },
  // created_date as the platform writes it: UTC, no zone letter, microseconds.
  { id: 'ref-kemi', referrer_email: lara.email, referred_email: kemi.email, status: 'signed_up', created_date: '2026-10-01T10:00:00.000000' },
  { id: 'ref-musa', referrer_email: lara.email, referred_email: musa.email, status: 'signed_up' },
  { id: 'ref-ngozi', referrer_email: lara.email, referred_email: ngozi.email, status: 'signed_up' },
  { id: 'ref-obi', referrer_email: lara.email, referred_email: obi.email, status: 'signed_up' },
  { id: 'ref-pat', referrer_email: lara.email, referred_email: pat.email, status: 'signed_up' },
  { id: 'ref-quam', referrer_email: lara.email, referred_email: quam.email, status: 'signed_up' },
];
const booking = (id, guest, fields) => ({ id, guest_email: guest.email, property_id: 'p1', check_in: '2026-12-13', check_out: '2026-12-17', total_price: 1198000, status: 'pending', payment_status: 'unpaid', ...fields });
rig.db.Booking = [
  booking('requested', bola, {}),
  booking('approved', bola, { approved_at: '2026-10-12T08:00:00Z' }),
  booking('refunded', bola, { status: 'cancelled', payment_status: 'paid' }),
  booking('paid', bola, { status: 'confirmed', payment_status: 'paid', approved_at: '2026-10-12T08:00:00Z' }),
  booking('solo', chidi, { status: 'confirmed', payment_status: 'paid' }),
  booking('paid-again', bola, { status: 'confirmed', payment_status: 'paid' }),
  booking('own-code', femi, { status: 'confirmed', payment_status: 'paid' }),
  booking('gbenga-oct', gbenga, { status: 'confirmed', payment_status: 'paid' }),
  booking('orphan', ife, { status: 'confirmed', payment_status: 'paid' }),
  booking('own-row', jide, { status: 'confirmed', payment_status: 'paid' }),
  booking('kemi-september', kemi, { status: 'confirmed', payment_status: 'paid', paid_at: '2026-09-01T09:00:00.000Z' }),
  booking('kemi-october', kemi, { status: 'confirmed', payment_status: 'paid', paid_at: '2026-10-05T09:00:00.000Z' }),
  booking('musa-stay', musa, { status: 'confirmed', payment_status: 'paid' }),
  booking('ngozi-stay', ngozi, { status: 'confirmed', payment_status: 'paid' }),
  booking('obi-stay', obi, { status: 'confirmed', payment_status: 'paid' }),
  booking('pat-stay', pat, { status: 'confirmed', payment_status: 'paid' }),
  booking('quam-free', quam, { status: 'confirmed', payment_status: 'paid', total_price: 0 }),
  booking('quam-stay', quam, { status: 'confirmed', payment_status: 'paid' }),
];
const balanceOf = (id) => rig.db.User.find((u) => u.id === id).referral_balance_ngn || 0;
const setUser = (id, patch) => Object.assign(rig.db.User.find((u) => u.id === id), patch);
const balance = () => rig.db.User.find((u) => u.id === 'ada').referral_balance_ngn;
const points = () => rig.db.User.find((u) => u.id === 'ada').loyalty_points;
const ask = (booking_id, user = root) => call(rig, handler, { booking_id }, user);

console.log('\n— a reward is owed for a paid stay, and for nothing else —');
let r = await ask('requested');
check('a request nobody has paid for earns nothing', [r.status, r.code, balance()], [409, 'NOT_PAID', 0]);
r = await ask('approved');
check('nor does one the admin approved but the guest has not paid', [r.status, r.code, balance()], [409, 'NOT_PAID', 0]);
r = await ask('refunded');
check('nor a paid stay that was then cancelled', [r.status, r.code, balance()], [409, 'NOT_PAID', 0]);
check('none of those marked the referral as rewarded', rig.db.Referral.find((x) => x.id === 'ref-bola').status, 'signed_up');

r = await ask('paid');
check('a paid, confirmed stay pays the referrer 5% of its total', [r.status, r.data && r.data.amount_awarded_ngn, balance(), points()], [200, 59900, 59900, 250]);
check('and stamps the referral row attribution wrote, with the booking it was for', rig.db.Referral.filter((x) => x.referred_email === bola.email).map((x) => [x.id, x.status, x.booking_id, x.amount_earned_ngn]), [['ref-bola', 'booking_completed', 'paid', 59900]]);
check('to the account the row names, not to another account carrying the same code', [balanceOf('ada'), balanceOf('hauwa')], [59900, 0]);
r = await ask('paid');
check('once: a second call pays nothing more', [r.status, r.data && r.data.skipped, balance(), points()], [200, 'already_awarded', 59900, 250]);

console.log('\n— one reward for one referred guest, whatever the guest does to their profile —');
const rowsBefore = rig.db.Referral.length;
setUser('bola', { referred_by_code: 'EVE1' });
r = await ask('paid');
check('pointing the profile at another code does not pay that booking again', [r.status, r.data && r.data.skipped, balanceOf('eve'), balance()], [200, 'already_awarded', 0, 59900]);
setUser('bola', { referred_by_code: 'BOLA1', referral_code: 'BOLA1' });
r = await ask('paid');
check('nor does pointing it at their own code', [r.status, r.data && r.data.skipped, balanceOf('bola'), balance()], [200, 'already_awarded', 0, 59900]);
r = await ask('paid-again');
check('a second paid stay by the same guest earns nothing more', [r.status, r.data && r.data.skipped, balance()], [200, 'already_awarded', 59900]);
setUser('bola', { referred_by_code: 'EVE1' });
r = await ask('paid-again');
check('not for another code either', [r.status, r.data && r.data.skipped, balanceOf('eve'), balance()], [200, 'already_awarded', 0, 59900]);
check('and none of that wrote a new referral row', rig.db.Referral.length, rowsBefore);

r = await ask('gbenga-oct');
check('a guest already rewarded in an older row is not rewarded again through the sign-up row', [r.status, r.data && r.data.skipped, balance()], [200, 'already_awarded', 59900]);
check('and the sign-up row is left alone', rig.db.Referral.find((x) => x.id === 'ref-gbenga-signup').status, 'signed_up');

console.log('\n— the referral row is the record; a profile is not —');
r = await ask('own-code');
check('a guest whose profile names their own code, with no referral row, is nobody\'s referral', [r.status, r.data && r.data.skipped, balanceOf('femi')], [200, 'no_referrer', 0]);
r = await ask('own-row');
check('a row that names the guest as their own referrer pays nothing', [r.status, r.data && r.data.skipped, balanceOf('jide')], [200, 'self_referral', 0]);
check('and is not stamped', rig.db.Referral.find((x) => x.id === 'ref-jide').status, 'signed_up');
r = await ask('orphan');
check('a row whose referrer account is gone pays nothing', [r.status, r.data && r.data.skipped], [200, 'referrer_not_found']);
check('and is not stamped, so nothing is marked paid that was not', rig.db.Referral.find((x) => x.id === 'ref-ife').status, 'signed_up');
check('all of the above left every other balance at zero', ['hauwa', 'eve', 'femi', 'bola', 'jide'].map(balanceOf), [0, 0, 0, 0, 0]);

console.log('\n— a stay paid for before the guest was referred —');
r = await ask('kemi-september');
check('earns the referrer nothing', [r.status, r.data && r.data.skipped, balanceOf('lara')], [200, 'paid_before_referral', 1000]);
r = await ask('kemi-october');
check('the first stay paid for after it does', [r.status, r.data && r.data.amount_awarded_ngn, balanceOf('lara')], [200, 59900, 60900]);

console.log('\n— two writers, one payment, nothing to lock —');
const claimsFor = (id) => (rig.db.LoyaltyTransaction || []).filter((x) => x.transaction_type === 'referral' && x.booking_id === id);
// The payment page and Paystack's webhook both reach the reward for the same
// payment. Each await is a point where the other one runs.
const pair = await Promise.all([ask('musa-stay'), ask('musa-stay')]);
check('two calls at the same moment pay once', [pair.filter((x) => x.data && x.data.amount_awarded_ngn).length, pair.filter((x) => x.data && x.data.skipped === 'already_awarded').length, balanceOf('lara')], [1, 1, 120800]);
check('and leave one line in the referrer\'s audit trail', claimsFor('musa-stay').length, 1);
// A writer that is part-way through: its claim is written, the row not yet stamped.
rig.db.LoyaltyTransaction.push({ id: 'claim-of-the-other-writer', created_date: '2026-10-12T11:00:00.000Z', user_email: lara.email, points_earned: 250, transaction_type: 'referral', booking_id: 'ngozi-stay' });
r = await ask('ngozi-stay');
check('a call that finds an older claim stands down', [r.status, r.data && r.data.skipped, balanceOf('lara')], [200, 'already_awarded', 120800]);
check('and takes its own claim back', claimsFor('ngozi-stay').map((x) => x.id), ['claim-of-the-other-writer']);
check('without stamping the row the other writer is about to stamp', rig.db.Referral.find((x) => x.id === 'ref-ngozi').status, 'signed_up');

console.log('\n— the money fails to move —');
rig.failOn = (entity, op, id) => entity === 'User' && op === 'update' && id === 'lara';
r = await ask('obi-stay');
rig.failOn = null;
check('the call fails and the balance is untouched', [r.status, balanceOf('lara')], [500, 120800]);
check('the referral row is as it was', [rig.db.Referral.find((x) => x.id === 'ref-obi').status, rig.db.Referral.find((x) => x.id === 'ref-obi').booking_id], ['signed_up', null]);
check('and no claim is left standing in the way', claimsFor('obi-stay').length, 0);
r = await ask('obi-stay');
check('so a retry pays', [r.status, r.data && r.data.amount_awarded_ngn, balanceOf('lara')], [200, 59900, 180700]);

console.log('\n— a write that lands and then reports a failure —');
rig.failAfter = (entity, op, id) => entity === 'User' && op === 'update' && id === 'lara';
r = await ask('pat-stay');
rig.failAfter = null;
check('the call fails, but the money had moved', [r.status, balanceOf('lara')], [500, 240600]);
check('so the row stays stamped', [rig.db.Referral.find((x) => x.id === 'ref-pat').status, rig.db.Referral.find((x) => x.id === 'ref-pat').booking_id], ['booking_completed', 'pat-stay']);
r = await ask('pat-stay');
check('and a retry pays nothing more', [r.status, r.data && r.data.skipped, balanceOf('lara')], [200, 'already_awarded', 240600]);

console.log('\n— nothing to pay —');
r = await ask('quam-free');
check('a stay with a total of zero pays nothing', [r.status, r.data && r.data.skipped, balanceOf('lara')], [200, 'no_amount', 240600]);
check('and does not use the guest\'s one reward up', rig.db.Referral.find((x) => x.id === 'ref-quam').status, 'signed_up');
r = await ask('quam-stay');
check('the next stay they pay for earns it', [r.status, r.data && r.data.amount_awarded_ngn, balanceOf('lara')], [200, 59900, 300500]);

console.log('\n— who may ask —');
r = await ask('solo');
check('a guest nobody referred is skipped, not paid', [r.status, r.data && r.data.skipped, balance()], [200, 'no_referrer', 59900]);
r = await ask('paid', bola);
check('a guest is refused, their own booking included: the reward is paid when the payment is confirmed', [r.status, r.code, balance()], [403, 'ADMIN_ONLY', 59900]);
r = await ask('paid', dayo);
check('and so is anybody else', r.status, 403);
r = await ask('paid', null);
check('signed out', r.status, 401);
r = await ask('');
check('no booking named', r.status, 400);
r = await ask('no-such-booking');
check('a booking that does not exist is a plain refusal, not a crash', r.status, 404);
r = await ask('../RideBooking/musa-stay');
check('an id that is really a path to another table is refused', r.status, 404);

console.log('\n— every writer of the reward carries the same rules —');
// Functions cannot import from each other, so the block is copied. A copy
// that drifts is how the first hole stayed open in one writer after it was
// closed in the others.
const WRITERS = ['processReferralReward', 'verifyPaystackPayment', 'paystackWebhook', 'verifyRidePayment'];
const rewardBlock = (name) => {
  const src = fs.readFileSync(path.join(ROOT, 'base44/functions', name, 'entry.ts'), 'utf8');
  const start = src.indexOf('async function payReferralReward(');
  if (start < 0) return null;
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
};
const blocks = WRITERS.map(rewardBlock);
check('each of the four functions has the reward block', blocks.map((b) => !!b), [true, true, true, true]);
check('and the four copies are the same, word for word', blocks.map((b) => b === blocks[0]), [true, true, true, true]);
for (const name of WRITERS) {
  const src = fs.readFileSync(path.join(ROOT, 'base44/functions', name, 'entry.ts'), 'utf8');
  check(`${name} never looks a referrer up by a code`, /filter\(\{\s*referral_code\s*:/.test(src), false);
  check(`${name} writes a referral balance only inside the reward block`, (src.match(/referral_balance_ngn\s*:/g) || []).length, 1);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
