// Stay pricing model — run with: node scripts/check-stay-price.mjs
//
// The guest is quoted by estimateStayPrice (client) and charged what
// priceForStay (server) stores on the Booking. If the two disagree by a naira
// the guest sees one number and pays another. Like check-ride-time.mjs this
// lifts the real server function off disk rather than re-implementing it, so
// drift fails the run.
//
// It also asserts, from the source text, that the server never reads
// total_price off the request body again. That was the ₦1-booking hole.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateStayPrice, nightsBetween, SERVICE_FEE_RATE, bookingOptionsOf, priceStay } from '../src/config/stays.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN = path.join(ROOT, 'base44/functions/checkAvailabilityWebhook/entry.ts');
const SRC = fs.readFileSync(FN, 'utf8');

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// Lift a function out of the shipped TypeScript and evaluate it. Developer
// script only; the input is this repo's own source.
function lift(fnName, signature, preamble = '') {
  const re = new RegExp(`function ${fnName}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`);
  const m = SRC.match(re);
  if (!m) throw new Error(`could not find ${fnName} in ${FN}`);
  const js = m[0].replace(/function \w+\([^)]*\)[^{]*\{/, `function ${fnName}(${signature}) {`);
  return new Function(`${preamble}\n${js}\nreturn ${fnName};`)();
}

const PRE = `const SERVICE_FEE_RATE = ${SERVICE_FEE_RATE}; const DAY_MS = 86400000;`;
const serverNights = lift('nightsBetween', 'checkIn, checkOut', PRE);
const serverPrice = lift('priceForStay', 'property, nights', PRE);

// ── Source guards ──────────────────────────────────────────────────────────
console.log('\n— source guards —');
check('server never destructures total_price from the body',
  /total_price,?\s*\n\s*special_requests,?\s*\n\s*\} = body/.test(SRC), false);
check('server stores the computed total on the Booking',
  /const total_price = pricing\.total;/.test(SRC) && /\n\s*total_price,\n[\s\S]{0,300}bedrooms_booked: pricing\.option\.bedrooms/.test(SRC), true);
check('the price comes from priceStay, night by night', /const pricing = priceStay\(property, check_in, check_out, bedrooms\);/.test(SRC), true);
check('server prices from the Property row', /entities\.Property\.get\(property_id\)/.test(SRC), true);
check('server-side fee rate matches the client constant',
  new RegExp(`SERVICE_FEE_RATE = ${SERVICE_FEE_RATE};`).test(SRC), true);

// ── Nights ─────────────────────────────────────────────────────────────────
console.log('\n— nights (server vs client) —');
const nightCases = [
  ['one night', '2026-10-01', '2026-10-02', 1],
  ['three nights', '2026-10-01', '2026-10-04', 3],
  ['month boundary', '2026-10-30', '2026-11-02', 3],
  ['year boundary', '2026-12-30', '2027-01-02', 3],
  ['leap day', '2028-02-28', '2028-03-01', 2],
  ['same day is zero', '2026-10-01', '2026-10-01', 0],
  ['reversed is zero', '2026-10-04', '2026-10-01', 0],
  ['garbage is zero', 'soon', '2026-10-01', 0],
];
for (const [name, a, b, want] of nightCases) {
  check(`${name} (server)`, serverNights(a, b), want);
  check(`${name} (client)`, nightsBetween(a, b), want);
}

// ── Price ──────────────────────────────────────────────────────────────────
console.log('\n— price (server vs client) —');
const withCaution = { price_per_night: 45000, caution_fee: 50000 };
const noCaution = { price_per_night: 45000 };
const priceCases = [
  ['1 night with caution', withCaution, 1],
  ['3 nights with caution', withCaution, 3],
  ['3 nights no caution', noCaution, 3],
  ['7 nights', noCaution, 7],
  ['odd rate rounds the fee', { price_per_night: 33333 }, 1],
];
for (const [name, p, n] of priceCases) {
  const s = serverPrice(p, n);
  const c = estimateStayPrice(p, n);
  check(`${name} agree`, c, s);
}
check('3 nights at 45k + 2.5% + 50k caution',
  serverPrice(withCaution, 3), { nights: 3, subtotal: 135000, serviceFee: 3375, cautionFee: 50000, total: 188375 });
check('fee is rounded to the naira', serverPrice({ price_per_night: 33333 }, 1).serviceFee, 833);

console.log('\n— price edges —');
check('zero nights is null (server)', serverPrice(withCaution, 0), null);
check('zero nights is null (client)', estimateStayPrice(withCaution, 0), null);
check('no nightly rate is null (server)', serverPrice({ caution_fee: 50000 }, 2), null);
check('no nightly rate is null (client)', estimateStayPrice({ caution_fee: 50000 }, 2), null);
check('garbage rate is null', serverPrice({ price_per_night: 'call' }, 2), null);
check('a client-supplied total cannot leak in', serverPrice({ price_per_night: 45000, total_price: 1 }, 1).total, 46125);

// ── Booking options and seasonal rates: server and client agree ────────────
console.log('\n— booking options and seasons —');
const liftRaw = (name) => SRC.match(new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`))[0].replace(/\(([^)]*)\)[^{]*\{/, (m, a) => `(${a.replace(/:\s*\w+/g, '')}) {`);
const serverPriceStay = new Function(`${PRE}\n${liftRaw('nightsBetween')}\n${liftRaw('bookingOptionsOf')}\n${liftRaw('nightlyRate')}\n${liftRaw('priceStay')}\nreturn priceStay;`)();
const duplex = {
  bedrooms: 4, price_per_night: 210000, max_guests: 8, caution_fee: 50000,
  booking_options: [
    { bedrooms: 4, price_per_night: 210000, max_guests: 8 }, { bedrooms: 1, price_per_night: 100000, max_guests: 2 },
    { bedrooms: 2, price_per_night: 160000, max_guests: 4 }, { bedrooms: 3, price_per_night: 190000, max_guests: 6 },
    { bedrooms: 2, price_per_night: 1, max_guests: 4 }, { bedrooms: 0, price_per_night: 5 }, null,
  ],
  seasonal_rates: [{ name: 'December Peak', start_date: '2026-12-15', end_date: '2027-01-10', prices: [{ bedrooms: 4, price_per_night: 350000 }, { bedrooms: 2, price_per_night: 220000 }] }],
};
check('options come out smallest first, once each, bad rows dropped', bookingOptionsOf(duplex).map((o) => o.bedrooms), [1, 2, 3, 4]);
check('a property with no options has one: the whole place', bookingOptionsOf({ bedrooms: 3, price_per_night: 90000, max_guests: 6 }), [{ bedrooms: 3, price_per_night: 90000, max_guests: 6 }]);
const both = (name, args, want) => {
  check(`${name} (client)`, want(priceStay(...args)), true);
  check(`${name} (server agrees to the naira)`, serverPriceStay(...args), priceStay(...args));
};
both('normal dates: 2 nights of 4BR at 210k', [duplex, '2026-12-01', '2026-12-03', 4], (p) => p.subtotal === 420000 && p.lines.length === 1);
both('14 Dec is normal, 15 Dec is peak', [duplex, '2026-12-14', '2026-12-16', 4], (p) => p.subtotal === 210000 + 350000);
both('13 to 17 Dec: two normal nights, two peak nights', [duplex, '2026-12-13', '2026-12-17', 4], (p) => p.subtotal === 2 * 210000 + 2 * 350000 && p.lines.length === 2);
both('10 Jan is peak, 11 Jan is normal again', [duplex, '2027-01-10', '2027-01-12', 4], (p) => p.subtotal === 350000 + 210000);
both('the season prices each option separately', [duplex, '2026-12-20', '2026-12-21', 2], (p) => p.subtotal === 220000);
both('an option the season does not price keeps its normal rate', [duplex, '2026-12-20', '2026-12-21', 3], (p) => p.subtotal === 190000);
both('service fee and caution fee are added once', [duplex, '2026-12-01', '2026-12-03', 1], (p) => p.total === 200000 + 5000 + 50000);
both('an option the property does not offer cannot be priced', [duplex, '2026-12-01', '2026-12-03', 5], (p) => p === null);
both('several options and none chosen cannot be priced', [duplex, '2026-12-01', '2026-12-03', undefined], (p) => p === null);
both('one option needs no choosing', [{ bedrooms: 3, price_per_night: 90000 }, '2026-12-01', '2026-12-02', undefined], (p) => p.subtotal === 90000);
both('no nights, no price', [duplex, '2026-12-03', '2026-12-03', 4], (p) => p === null);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
