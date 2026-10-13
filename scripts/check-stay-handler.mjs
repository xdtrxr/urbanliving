// Stay booking handler — run with: node scripts/check-stay-handler.mjs
//
// check-stay-price.mjs lifts the pure pricing functions out of
// checkAvailabilityWebhook and executes them. This script executes the
// HANDLER around them, start to finish: which option a request is priced as,
// what a refusal says, who writes the rows, what the admin is told. There is
// no Deno here and no sandbox for Base44 functions, so until this script
// existed the handler was only ever parse-checked before it met a guest.
//
// How: scripts/lib/function-rig.mjs bundles the shipped entry.ts as it is and
// runs it against an in-memory stand-in for the Base44 SDK. The stand-in
// enforces the create rule that is live since 2026-10-12: only an admin, or
// the server, may create a Booking or an AvailabilityRequest. Telegram is a
// stub that records what would have been sent.

import { createRig, stubTelegram, loadFunction, call } from './lib/function-rig.mjs';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const rig = createRig({ serverOnlyCreate: ['Booking', 'AvailabilityRequest'] });
stubTelegram(rig);
const handler = await loadFunction(rig, 'checkAvailabilityWebhook');
check('the bundled entry.ts handed over a handler', typeof handler, 'function');

let guestNo = 0;
const guest = () => { guestNo += 1; return { id: `u${guestNo}`, email: `guest${guestNo}@example.com`, full_name: `Guest ${guestNo}`, role: 'user', phone_number: '+2348012345678' }; };
const ask = (body, user = guest(), method = 'POST') => call(rig, handler, body, user, method);
const lastBooking = () => rig.db.Booking[rig.db.Booking.length - 1];
const bookings = () => (rig.db.Booking || []).length;

// ── Fixtures ────────────────────────────────────────────────────────────────
// The owner's example: one duplex, four ways to book it, one season.
rig.db.Property = [
  {
    id: 'duplex', title: 'Lekki 4BR Duplex', location: { city: 'Lagos', country: 'Nigeria' }, images: ['https://files.example/duplex.jpg'],
    bedrooms: 4, max_guests: 8, price_per_night: 210000, caution_fee: 50000,
    booking_options: [
      { bedrooms: 1, price_per_night: 100000, max_guests: 2 },
      { bedrooms: 2, price_per_night: 160000, max_guests: 4 },
      { bedrooms: 3, price_per_night: 190000, max_guests: 6 },
      { bedrooms: 4, price_per_night: 210000, max_guests: 8 },
    ],
    seasonal_rates: [{ name: 'December Peak', start_date: '2026-12-15', end_date: '2027-01-10', prices: [{ bedrooms: 2, price_per_night: 220000 }, { bedrooms: 4, price_per_night: 350000 }] }],
  },
  // A row from before options existed: neither new field.
  { id: 'legacy', title: 'Ikoyi 2BR', location: { city: 'Lagos', country: 'Nigeria' }, bedrooms: 2, max_guests: 4, price_per_night: 80000, caution_fee: 30000 },
  // Full property only, with a season.
  {
    id: 'whole', title: 'Abuja 4BR', location: { city: 'Abuja', country: 'Nigeria' }, bedrooms: 4, max_guests: 8, price_per_night: 210000, caution_fee: 50000, booking_options: [],
    seasonal_rates: [{ name: 'December Peak', start_date: '2026-12-15', end_date: '2027-01-10', prices: [{ bedrooms: 4, price_per_night: 350000 }] }],
  },
  { id: 'unpriced', title: 'No price yet', bedrooms: 2, max_guests: 4 },
];
const fee = (subtotal) => Math.round(subtotal * 0.025);

// ── The owner's example ─────────────────────────────────────────────────────
console.log('\n— a 4-bedroom stay that crosses into the season —');
let r = await ask({ property_id: 'duplex', check_in: '2026-12-13', check_out: '2026-12-17', guests: 8, bedrooms: 4 });
const peak = 2 * 210000 + 2 * 350000;
check('accepted', r.status, 200);
check('two normal nights and two peak nights, 2.5% fee, caution once', r.data && r.data.total_price, peak + fee(peak) + 50000);
check('the Booking row holds that total, the option, and starts pending and unpaid', [lastBooking().total_price, lastBooking().bedrooms_booked, lastBooking().status, lastBooking().payment_status], [peak + fee(peak) + 50000, 4, 'pending', 'unpaid']);
check('the request row tells the admin the same option and total', [rig.db.AvailabilityRequest[0].bedrooms_booked, rig.db.AvailabilityRequest[0].total_price], [4, peak + fee(peak) + 50000]);
check('both rows are written by the server, never as the guest', [lastBooking().created_by, rig.db.AvailabilityRequest[0].created_by], ['service', 'service']);
check('the guest can still read them: they carry the guest\'s email', [lastBooking().guest_email, rig.db.AvailabilityRequest[0].user_email], ['guest1@example.com', 'guest1@example.com']);
check('the request names its booking, so approving it acts on this booking and no other', rig.db.AvailabilityRequest[0].booking_id, lastBooking().id);
check('the answer carries the night-by-night lines', r.data.pricing.lines.map((l) => [l.season, l.rate, l.nights]), [['', 210000, 2], ['December Peak', 350000, 2]]);
check('Telegram names the option and the total', [/Booking: 4-bedroom option/.test(rig.sent[rig.sent.length - 1]), /1,198,000/.test(rig.sent[rig.sent.length - 1])], [true, true]);

// ── Which option is priced ──────────────────────────────────────────────────
console.log('\n— which option a request is priced as —');
const two = 2 * 210000;
r = await ask({ property_id: 'duplex', check_in: '2026-11-20', check_out: '2026-11-22', guests: 2 });
check('no option named (an old browser tab): the whole place, the largest option', [r.status, r.data && r.data.total_price, lastBooking().bedrooms_booked], [200, two + fee(two) + 50000, 4]);
for (const junk of [null, '', 'abc', 0, -1, [1, 2], {}]) {
  r = await ask({ property_id: 'duplex', check_in: '2026-11-10', check_out: '2026-11-12', guests: 2, bedrooms: junk });
  check(`a nonsense option (${JSON.stringify(junk)}) is charged as the whole place, never less`, [r.status, lastBooking().total_price], [200, two + fee(two) + 50000]);
}
r = await ask({ property_id: 'duplex', check_in: '2026-11-02', check_out: '2026-11-04', guests: 2, bedrooms: '2' });
check('"2" as text is the 2-bedroom option', [r.status, r.data && r.data.total_price, lastBooking().bedrooms_booked], [200, 320000 + fee(320000) + 50000, 2]);
let before = bookings();
r = await ask({ property_id: 'duplex', check_in: '2026-11-02', check_out: '2026-11-04', guests: 2, bedrooms: 5 });
check('an option the property does not offer is refused, with a sentence', [r.status, r.code, /reload/.test(r.error || '')], [400, 'OPTION_UNAVAILABLE', true]);
r = await ask({ property_id: 'legacy', check_in: '2026-11-02', check_out: '2026-11-04', guests: 2, bedrooms: 3 });
check('the same for a whole-place listing asked for an option', [r.status, r.code], [400, 'OPTION_UNAVAILABLE']);

// ── The guest limit belongs to the option ───────────────────────────────────
console.log('\n— guest limits —');
r = await ask({ property_id: 'duplex', check_in: '2026-11-02', check_out: '2026-11-04', guests: 5, bedrooms: 2 });
check('5 guests in the 2-bedroom option (limit 4), though the house takes 8: refused', [r.status, r.code, r.error], [400, 'TOO_MANY_GUESTS', 'The 2-bedroom option sleeps up to 4 guests']);
r = await ask({ property_id: 'duplex', check_in: '2026-11-02', check_out: '2026-11-04', guests: '5', bedrooms: '2' });
check('and as text', [r.status, r.code], [400, 'TOO_MANY_GUESTS']);
r = await ask({ property_id: 'legacy', check_in: '2026-11-02', check_out: '2026-11-04', guests: 5 });
check('a whole-place listing keeps its own limit and wording', [r.status, r.error], [400, 'This property sleeps up to 4 guests']);
check('no refusal wrote a row', bookings(), before);

// ── Rows from before this feature ───────────────────────────────────────────
console.log('\n— listings without options —');
r = await ask({ property_id: 'legacy', check_in: '2026-12-20', check_out: '2026-12-23', guests: 4 });
check('a legacy row prices as before: 3 nights, fee, caution', [r.status, r.data && r.data.total_price], [200, 240000 + fee(240000) + 30000]);
check('and records no option', 'bedrooms_booked' in lastBooking(), false);
check('Telegram does not invent an option line for it', /Booking:/.test(rig.sent[rig.sent.length - 1]), false);
r = await ask({ property_id: 'whole', check_in: '2026-12-14', check_out: '2026-12-16', guests: 8 });
check('full property only: one normal night, one peak night', [r.status, r.data && r.data.total_price], [200, 560000 + fee(560000) + 50000]);
r = await ask({ property_id: 'unpriced', check_in: '2026-12-14', check_out: '2026-12-16', guests: 2 });
check('a listing with no price cannot be booked', [r.status, r.code], [409, 'NO_PRICE']);

// ── The whole property is blocked whichever option is booked ────────────────
console.log('\n— one physical property —');
r = await ask({ property_id: 'duplex', check_in: '2026-12-14', check_out: '2026-12-15', guests: 1, bedrooms: 1 });
check('a 1-bedroom request over the 4-bedroom booking\'s dates is flagged as a conflict', [r.status, r.data && r.data.has_conflict], [200, true]);
const same = guest();
await ask({ property_id: 'whole', check_in: '2027-02-01', check_out: '2027-02-03', guests: 2 }, same);
r = await ask({ property_id: 'whole', check_in: '2027-03-01', check_out: '2027-03-03', guests: 2 }, same);
check('one guest cannot stack requests on a property', [r.status, r.code], [409, 'EXISTING_PENDING_APPROVAL']);

// ── A payment on hold keeps its claim on the dates ──────────────────────────
// A guest's booking ran out of time and was cancelled; their money landed a
// moment later and is on hold (check-stay-payment.mjs). The expiry email told
// them to book again. Until the admin settles the payment, a new request for
// that stay would be approved and paid for a second time.
console.log('\n— a payment on hold for the property —');
const late = guest();
rig.db.Booking.push({ id: 'late-and-held', property_id: 'legacy', guest_name: late.full_name, guest_email: late.email, check_in: '2027-06-10', check_out: '2027-06-14', guests: 2, total_price: 358000, status: 'cancelled', cancel_reason: 'payment_expired', approved_at: '2026-10-12T08:00:00.000Z', payment_status: 'pending_confirmation', transaction_hash: 'ref-late' });
before = bookings();
r = await ask({ property_id: 'legacy', check_in: '2027-06-10', check_out: '2027-06-14', guests: 2 }, late);
check('the guest whose payment is held cannot request it again: they are told the money is being held', [r.status, r.code, /holding a payment/.test(r.error), bookings() - before], [409, 'EXISTING_PAYMENT_HELD', true, 0]);
r = await ask({ property_id: 'legacy', check_in: '2027-07-01', check_out: '2027-07-03', guests: 2 }, late);
check('for other dates at that property either, until it is settled', [r.status, r.code], [409, 'EXISTING_PAYMENT_HELD']);
r = await ask({ property_id: 'duplex', check_in: '2027-06-10', check_out: '2027-06-14', guests: 2, bedrooms: 1 }, late);
check('another property is not affected', r.status, 200);
const sentBefore = rig.sent.length;
r = await ask({ property_id: 'legacy', check_in: '2027-06-12', check_out: '2027-06-16', guests: 2 });
check('somebody else asking for those dates is accepted, but flagged as a conflict with the held booking', [r.status, r.data && r.data.has_conflict, r.data && r.data.conflict_details && r.data.conflict_details.booking_id], [200, true, 'late-and-held']);
check('and the admin\'s card says a payment is on hold for it', rig.sent.slice(sentBefore).some((t) => t.includes('CONFLICT DETECTED') && t.includes('payment ON HOLD')), true);
r = await ask({ property_id: 'legacy', check_in: '2027-08-01', check_out: '2027-08-03', guests: 2 });
check('dates the held booking does not touch are not a conflict', [r.status, r.data && r.data.has_conflict], [200, false]);

// ── Requests that are not a stay ────────────────────────────────────────────
console.log('\n— bad requests —');
before = bookings();
const bad = async (name, body, want, user) => { const a = await ask(body, user); check(name, [a.status, a.code || null], want); };
await bad('check-out before check-in', { property_id: 'duplex', check_in: '2026-12-17', check_out: '2026-12-13', guests: 2, bedrooms: 2 }, [400, null]);
await bad('a stay longer than a year', { property_id: 'duplex', check_in: '2026-01-01', check_out: '2027-06-01', guests: 2, bedrooms: 1 }, [400, 'STAY_TOO_LONG']);
await bad('dates from the ends of time do not walk the calendar', { property_id: 'duplex', check_in: '-271821-04-20', check_out: '+275760-09-13', guests: 2, bedrooms: 1 }, [400, null]);
await bad('a month is not a date', { property_id: 'duplex', check_in: '2026-12', check_out: '2027-01', guests: 2, bedrooms: 1 }, [400, null]);
await bad('nor is 29 February in a year without one', { property_id: 'duplex', check_in: '2027-02-28', check_out: '2027-02-29', guests: 2, bedrooms: 1 }, [400, null]);
await bad('a property that is not there is a 404, not a crash', { property_id: 'nope', check_in: '2026-12-13', check_out: '2026-12-17', guests: 2 }, [404, null]);
await bad('an empty body', {}, [400, null]);
await bad('signed out', { property_id: 'duplex', check_in: '2026-12-13', check_out: '2026-12-17', guests: 2, bedrooms: 2 }, [401, null], null);
check('none of them wrote a row', bookings(), before);
r = await ask(undefined, guest(), 'OPTIONS');
check('the CORS preflight is answered', r.status, 204);

// ── What the create rule is for ─────────────────────────────────────────────
console.log('\n— a booking written by hand —');
rig.user = guest();
let handMade = 'created';
try {
  await rig.client().entities.Booking.create({ property_id: 'duplex', guest_email: rig.user.email, check_in: '2027-05-01', check_out: '2027-05-03', guests: 8, total_price: 1, status: 'confirmed', payment_status: 'paid' });
} catch (err) { handMade = err.status; }
check('with create kept for the server, a hand-made ₦1 "paid" booking is refused, and every request above still worked', handMade, 403);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
