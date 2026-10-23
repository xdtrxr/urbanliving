// Who is whose referral, and what a referrer is shown — run with:
//   node scripts/check-referral-attribution.mjs
//
// attributeReferral writes the Referral row that every reward follows
// (scripts/check-referral-reward.mjs covers the paying). A referral code is
// made in the browser and nothing makes it unique, so the function has to
// stand up to a copied code, to the caller's own code, to text that is really
// a pattern, and to two requests at once. Since 2026-10-23 a code is for a
// new account only: a caller who has already booked a stay or a ride is
// refused, and nothing is written. getReferralStatistics is what the
// referrer then sees; until 2026-10-12 it read the friend's booking as the
// referrer, which the Booking read rule refuses, and showed 0 booked.
//
// Both run as shipped, against scripts/lib/function-rig.mjs.

import { createRig, loadFunction, call } from './lib/function-rig.mjs';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// The read rules that matter here, as base44/entities/*.jsonc has them: a
// booking is readable by its guest or an admin; a referral by either party.
const rig = createRig({
  userReads: {
    Booking: (row, user) => row.guest_email === user.email || user.role === 'admin',
    RideBooking: (row, user) => row.guest_email === user.email || user.role === 'admin',
    Referral: (row, user) => row.referrer_email === user.email || row.referred_email === user.email,
  },
});
const attribute = await loadFunction(rig, 'attributeReferral');
const statistics = await loadFunction(rig, 'getReferralStatistics');

// The platform, where the rig stops short. auth.me() THROWS for a signed-out
// caller (the rig answers null), so "signed out" below is the platform's.
// And every Booking and RideBooking read is noted with who made it (the
// caller, or the service role) and the limit it asked for.
const answersNull = rig.client;
const bookingReads = [];
const noted = (entities, as) => new Proxy({}, {
  get: (_, name) => {
    const table = entities[name];
    if (name !== 'Booking' && name !== 'RideBooking') return table;
    return {
      ...table,
      filter: (query, sort, limit, skip) => {
        bookingReads.push({ entity: name, as, limit });
        return table.filter(query, sort, limit, skip);
      },
    };
  },
});
rig.client = () => {
  const client = answersNull();
  return {
    ...client,
    auth: {
      ...client.auth,
      me: async () => {
        const user = await client.auth.me();
        if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
        return user;
      },
    },
    entities: noted(client.entities, 'caller'),
    asServiceRole: { ...client.asServiceRole, entities: noted(client.asServiceRole.entities, 'service') },
  };
};

// Ada owns ADA1. Hauwa has copied it onto her own profile. Lara owns LARA1,
// stored in lower case as some early rows were.
const ada = { id: 'ada', email: 'ada@example.com', role: 'user', referral_code: 'ADA1' };
const hauwa = { id: 'hauwa', email: 'hauwa@example.com', role: 'user', referral_code: 'ADA1' };
const lara = { id: 'lara', email: 'lara@example.com', role: 'user', referral_code: 'lara1' };
const tunde = { id: 'tunde', email: 'tunde@example.com', role: 'user', referral_code: 'TUNDE1' };
// Nkem's code is stored in lower case, as some early rows are. Obi has copied
// it onto his own profile in upper case, the form a link is turned into.
const nkem = { id: 'nkem', email: 'nkem@example.com', role: 'user', referral_code: 'nkem1' };
const obi = { id: 'obi', email: 'obi@example.com', role: 'user', referral_code: 'NKEM1' };
const guest = (id) => ({ id, email: `${id}@example.com`, role: 'user' });
const bola = guest('bola');
const chidi = guest('chidi');
const dayo = guest('dayo');
const eze = guest('eze');
const funke = guest('funke');
const root = { id: 'root', email: 'root@example.com', role: 'admin' };
rig.db.User = [ada, hauwa, lara, tunde, obi, nkem, bola, chidi, dayo, eze, funke, root].map((u) => ({ ...u }));
rig.db.Referral = [];

const use = (ref_code, user) => call(rig, attribute, { ref_code }, user);
const rowsFor = (user) => rig.db.Referral.filter((r) => r.referred_email === user.email);
const stamp = (user) => rig.db.User.find((u) => u.id === user.id).referred_by_code || null;

console.log('\n— a code names one account —');
let r = await use('TUNDE1', bola);
check('a code one account holds attributes the caller to that account', [r.status, r.data && r.data.referrer_email, rowsFor(bola).map((x) => [x.referrer_email, x.status])], [200, tunde.email, [[tunde.email, 'signed_up']]]);
check('and stamps the profile, which only stops the app asking again', stamp(bola), 'TUNDE1');
r = await use('ADA1', chidi);
check('a code two other accounts hold attributes nobody', [r.status, r.code, rowsFor(chidi).length, stamp(chidi)], [409, 'AMBIGUOUS_CODE', 0, null]);
r = await use('ADA1', hauwa);
check('the copier using the code they copied is attributed to its other holder, not to themselves', [r.status, r.data && r.data.referrer_email], [200, ada.email]);
r = await use('TUNDE1', tunde);
check('your own code is refused', [r.status, r.code, rowsFor(tunde).length], [400, 'SELF_REFERRAL', 0]);
r = await use('lara1', dayo);
check('a code stored in lower case is still found', [r.status, r.data && r.data.referrer_email], [200, lara.email]);

r = await use('nkem1', chidi);
check('a code copied in another letter case does not take the owner\'s referral: it attributes nobody', [r.status, r.code, rowsFor(chidi).length], [409, 'AMBIGUOUS_CODE', 0]);

console.log('\n— the code is text, not a pattern —');
r = await use('.*', chidi);
check('".*" is not every account\'s code', [r.status, r.code, rowsFor(chidi).length], [404, 'INVALID_CODE', 0]);
r = await use('TUNDE.', chidi);
check('nor does a dot stand in for a letter', [r.status, r.code], [404, 'INVALID_CODE']);
r = await use('X'.repeat(65), chidi);
check('an absurdly long code is simply not found', [r.status, r.code], [404, 'INVALID_CODE']);
r = await use('NOBODY1', chidi);
check('a code nobody holds', [r.status, r.code], [404, 'INVALID_CODE']);
r = await use('', chidi);
check('no code', r.status, 400);
r = await use('TUNDE1', null);
check('signed out, where the platform throws rather than answering null, is a 401 and not a 500', [r.status, r.error], [401, 'Unauthorized']);

console.log('\n— one referrer per guest, for good —');
r = await use('lara1', bola);
check('a second code is refused', [r.status, r.code, rowsFor(bola).length, stamp(bola)], [409, 'ALREADY_ATTRIBUTED', 1, 'TUNDE1']);
const two = await Promise.all([use('TUNDE1', eze), use('lara1', eze)]);
check('two codes sent at the same moment leave one referral', [two.filter((x) => x.status === 200).length, two.filter((x) => x.code === 'ALREADY_ATTRIBUTED').length, rowsFor(eze).length], [1, 1, 1]);
check('and the one that stands is the one that was answered yes', rowsFor(eze)[0].referrer_email, two.find((x) => x.status === 200).data.referrer_email);

console.log('\n— the referral stands even if the profile stamp fails —');
rig.failOn = (entity, op, id) => entity === 'User' && op === 'update' && id === 'funke';
r = await use('TUNDE1', funke);
rig.failOn = null;
check('the answer is yes and the row is there', [r.status, rowsFor(funke).length, stamp(funke)], [200, 1, null]);
r = await use('TUNDE1', funke);
check('asking again is a plain "already"', [r.status, r.code, rowsFor(funke).length], [409, 'ALREADY_ATTRIBUTED', 1]);

console.log('\n— codes are for new accounts —');
// Each of these has booked with us in one way: Gina a paid stay, Hadiza a
// paid ride, Ike a payment on hold, Jide a payment given back. Lola signed up
// with capitals in her email and her stay was typed in lower case. Mide has
// asked for sixty stays and paid for one, the first, which a read of the
// default page of 50, newest first, would never reach. Kemi has only asked:
// an unpaid request, one cancelled before she paid, an unpaid ride. Tunde,
// a referrer, has paid for a stay too.
const gina = guest('gina');
const hadiza = guest('hadiza');
const ike = guest('ike');
const jide = guest('jide');
const kemi = guest('kemi');
const mide = guest('mide');
const lola = { id: 'lola', email: 'Lola@Example.com', role: 'user' };
rig.db.User.push(...[gina, hadiza, ike, jide, kemi, mide, lola].map((u) => ({ ...u })));
rig.db.Booking = [
  { id: 'gina-stay', guest_email: gina.email, status: 'confirmed', payment_status: 'paid' },
  { id: 'ike-stay', guest_email: ike.email, status: 'cancelled', payment_status: 'pending_confirmation', transaction_hash: 'ref-ike' },
  { id: 'jide-stay', guest_email: jide.email, status: 'cancelled', payment_status: 'refunded' },
  { id: 'kemi-asked', guest_email: kemi.email, status: 'pending', payment_status: 'unpaid' },
  { id: 'kemi-dropped', guest_email: kemi.email, status: 'cancelled', payment_status: 'unpaid' },
  { id: 'lola-stay', guest_email: 'lola@example.com', status: 'completed', payment_status: 'paid' },
  { id: 'tunde-stay', guest_email: tunde.email, status: 'confirmed', payment_status: 'paid' },
  { id: 'bola-stay', guest_email: bola.email, status: 'confirmed', payment_status: 'paid' },
  { id: 'mide-paid', guest_email: mide.email, status: 'completed', payment_status: 'paid', created_date: '2026-01-01T00:00:00.000Z' },
  ...Array.from({ length: 60 }, (_, i) => ({
    id: `mide-ask-${i}`, guest_email: mide.email, status: 'cancelled', payment_status: 'unpaid',
    created_date: new Date(Date.UTC(2026, 1, 1) + i * 86400000).toISOString(),
  })),
];
rig.db.RideBooking = [
  { id: 'hadiza-ride', guest_email: hadiza.email, status: 'completed', payment_status: 'paid' },
  { id: 'kemi-ride', guest_email: kemi.email, status: 'pending', payment_status: 'unpaid' },
];
const SENTENCE = 'Referral codes are for new accounts. This account has already booked with us.';
const refused = async (who, label) => {
  const before = rig.db.Referral.length;
  const answer = await use('TUNDE1', who);
  check(`${label}: refused, in the server's own words, and nothing written`,
    [answer.status, answer.code, answer.error, rowsFor(who).length, rig.db.Referral.length - before, stamp(who)],
    [409, 'EXISTING_CUSTOMER', SENTENCE, 0, 0, null]);
};
bookingReads.length = 0;
await refused(gina, 'a paid stay');
await refused(hadiza, 'a paid ride');
await refused(ike, 'a payment on hold, on a booking since cancelled');
await refused(jide, 'a payment given back');
await refused(lola, 'a paid stay under the same email in another letter case');
await refused(mide, 'one paid stay behind sixty unpaid requests');
r = await use('TUNDE1', kemi);
check('only unpaid and cancelled-unpaid requests: still a new account, and attributed',
  [r.status, r.data && r.data.referrer_email, rowsFor(kemi).length, stamp(kemi)], [200, tunde.email, 1, 'TUNDE1']);
check('every booking read was made with the service role, with a limit of its own',
  [bookingReads.length > 0, bookingReads.every((x) => x.as === 'service' && Number.isInteger(x.limit) && x.limit > 0 && x.limit <= 50)], [true, true]);
check('both stays and rides were looked at', [...new Set(bookingReads.map((x) => x.entity))].sort(), ['Booking', 'RideBooking']);

// The code is judged before the account: each of these is the more specific
// answer, and none writes anything either.
r = await use('NOBODY1', gina);
check('a customer with a code nobody holds is told it was not found', [r.status, r.code, rowsFor(gina).length], [404, 'INVALID_CODE', 0]);
r = await use('TUNDE1', tunde);
check('a customer opening their own link is told it is their own code', [r.status, r.code, rowsFor(tunde).length], [400, 'SELF_REFERRAL', 0]);
r = await use('ADA1', gina);
check('a customer with a copied code is told it cannot be used right now', [r.status, r.code, rowsFor(gina).length], [409, 'AMBIGUOUS_CODE', 0]);
r = await use('lara1', bola);
check('a referred guest who has since booked is told they already used a code', [r.status, r.code, rowsFor(bola).length], [409, 'ALREADY_ATTRIBUTED', 1]);

console.log('\n— what the referrer is shown —');
// Tunde referred Bola, Eze (maybe) and Funke. Bola has paid for a stay; the
// reward left a second row beside the sign-up one, as the rewards of May 2026
// did. Funke paid for a ride. Gbenga's row is stamped with a booking that is
// not his.
rig.db.Referral = rig.db.Referral.filter((x) => x.referrer_email !== tunde.email || [bola.email, funke.email].includes(x.referred_email));
rig.db.Referral.push(
  { id: 'bola-paid', referrer_email: tunde.email, referred_email: bola.email, status: 'booking_completed', booking_id: 'stay1', amount_earned_ngn: 59900 },
  { id: 'gbenga', referrer_email: tunde.email, referred_email: 'gbenga@example.com', status: 'booking_completed', booking_id: 'stay-of-someone-else', amount_earned_ngn: 100 },
);
Object.assign(rig.db.Referral.find((x) => x.referred_email === funke.email), { status: 'booking_completed', booking_id: 'ride1', amount_earned_ngn: 4500 });
rig.db.Booking = [
  { id: 'stay1', guest_email: bola.email, total_price: 1198000, status: 'confirmed', payment_status: 'paid' },
  { id: 'stay-of-someone-else', guest_email: 'stranger@example.com', total_price: 5000000, status: 'confirmed', payment_status: 'paid' },
];
rig.db.RideBooking = [{ id: 'ride1', guest_email: funke.email, total_price: 90000, status: 'confirmed', payment_status: 'paid' }];
const stats = (user_email, user) => call(rig, statistics, { user_email }, user);

r = await stats(tunde.email, tunde);
check('each person counts once, however many rows they have', [r.status, r.data && r.data.totalReferrals, r.data && r.data.successfulReferrals], [200, 3, 3]);
check('the friend\'s stay and the friend\'s ride are both counted, though the referrer cannot read either', r.data && r.data.totalBookedByReferrals, 1198000 + 90000);
check('a booking that is not the friend\'s adds nothing to it', r.data && r.data.totalBookedByReferrals < 5000000, true);
check('earned is the sum of what the rows say was paid', r.data && r.data.totalAmountEarnedFromReferralsNGN, 59900 + 4500 + 100);
r = await stats(undefined, tunde);
check('with no email named, it is your own', [r.status, r.data && r.data.totalReferrals], [200, 3]);
r = await stats(tunde.email, ada);
check('somebody else\'s figures are refused', r.status, 403);
r = await stats(tunde.email, root);
check('an admin may look', [r.status, r.data && r.data.totalReferrals], [200, 3]);
r = await stats(lara.email, lara);
check('a referrer whose friend has not paid yet', [r.data && r.data.totalReferrals, r.data && r.data.successfulReferrals, r.data && r.data.totalBookedByReferrals], [1, 0, 0]);
// getReferralStatistics does not catch the throw from auth.me() (a 500 on
// the platform, not a 401). That is a separate function, left as it is in
// this round, so its signed-out case is asked of the rig's null as before.
rig.client = answersNull;
r = await stats(tunde.email, null);
check('signed out', r.status, 401);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
