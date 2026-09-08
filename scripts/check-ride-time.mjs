// Ride time and pricing model — run with: node scripts/check-ride-time.mjs
//
// WHY THIS LIVES IN THE REPO
// Base44 function directories cannot import a shared module, so the duration
// helper is duplicated across three functions and the pricing helper has a
// fourth copy on the client. Nothing but this file stops those four drifting.
//
// WHY IT ASSERTS ABSOLUTE INSTANTS
// Every window is pinned to WAT (+01:00) because Deno runs UTC and an unpinned
// parse silently shifts every booking by an hour. This bug class is INVISIBLE
// when tested from Nigeria: a naive parse resolves to local time, which on a
// WAT machine coincides with the pinned value, so a wrong implementation
// passes. It already did once. Assertions therefore pin exact UTC instants
// ('2026-08-10T08:00:00.000Z'), never a comparison against local time.
//
// This file does not re-implement the logic it tests. It reads the shipped
// functions off disk and executes them, so drift fails the run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateRidePrice, extraHourRate, markupFor, HOURLY_CHOICES } from '../src/config/rides.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN = (name) => path.join(ROOT, 'base44/functions', name, 'entry.ts');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WAT_OFFSET = '+01:00';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = Object.is(got, want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// ── Lift the real implementations out of the shipped TypeScript ────────────
// Crude but deliberate: a hand-copied version of the function under test would
// pass even after the shipped copy drifted, which is the entire failure mode
// this file exists to catch.
//
// On the new Function() below: the only input is this repo's own source, read
// from a path this file computes itself. Nothing here is reachable from user
// input, a request body, or the network — it is a developer script that never
// ships to the browser or to Deno. Evaluating the real function is the point;
// a safe parser would only be re-implementing the code under test.
function lift(file, fnName, signature, preamble = '') {
  const src = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`function ${fnName}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${fnName} in ${file}`);
  const js = m[0].replace(/function \w+\([^)]*\)[^{]*\{/, `function ${fnName}(${signature}) {`);
  return new Function(`${preamble}\n${js}\nreturn ${fnName};`)();
}

const MAX_HOURLY_PREAMBLE = 'const MAX_HOURLY = 8; const HOUR_MS = 3600000; const DAY_MS = 86400000;';

const rideDurationMs = lift(FN('checkRideAvailability'), 'rideDurationMs', 'tier, days, hours', MAX_HOURLY_PREAMBLE);
const priceForTier = lift(FN('checkRideAvailability'), 'priceForTier', 'vehicle, tier, days, hours', MAX_HOURLY_PREAMBLE);
const turnaroundMsFor = lift(FN('checkRideAvailability'), 'turnaroundMsFor', 'vehicle', 'const HOUR_MS = 3600000; const DEFAULT_TURNAROUND_MS = 3600000;');
const extraHourRateFor = lift(FN('checkRideAvailability'), 'extraHourRateFor', 'vehicle');
const windowsOverlap = lift(FN('checkRideAvailability'), 'windowsOverlap', 'aStart, aEnd, bStart, bEnd, buffer');

const rideStartAt = (d, t) => Date.parse(`${d}T${t}:00${WAT_OFFSET}`);
const rideWindow = (b) => {
  const startMs = rideStartAt(b.service_date, b.start_time);
  const dur = rideDurationMs(b.duration_tier, b.duration_days, b.duration_hours);
  if (Number.isNaN(startMs) || Number.isNaN(dur)) return null;
  return { startMs, endMs: startMs + dur };
};

// ── Timezone pinning ───────────────────────────────────────────────────────
console.log('\n— timezone pinning —');
const s = rideStartAt('2026-08-10', '09:00');
check('09:00 WAT is 08:00 UTC', new Date(s).getUTCHours(), 8);
check('resolves to the exact UTC instant', new Date(s).toISOString(), '2026-08-10T08:00:00.000Z');
check('pinning shifts exactly 1h vs a UTC-naive parse',
  (Date.parse('2026-08-10T09:00:00Z') - s) / HOUR_MS, 1);
// Midnight is the dangerous edge: WAT midnight is the previous day in UTC.
check('00:00 WAT rolls back a UTC day',
  new Date(rideStartAt('2026-08-10', '00:00')).toISOString(), '2026-08-09T23:00:00.000Z');
// Nigeria has no DST, so a January and a July booking must shift identically.
check('no DST drift in January',
  new Date(rideStartAt('2026-01-15', '09:00')).toISOString(), '2026-01-15T08:00:00.000Z');
check('no DST drift in July',
  new Date(rideStartAt('2026-07-15', '09:00')).toISOString(), '2026-07-15T08:00:00.000Z');

// ── Durations ──────────────────────────────────────────────────────────────
console.log('\n— durations —');
for (const h of HOURLY_CHOICES) {
  check(`hourly ${h}h`, rideDurationMs('hourly', undefined, h), h * HOUR_MS);
}
check('hourly clamps below 1', rideDurationMs('hourly', undefined, 0), 1 * HOUR_MS);
check('hourly clamps above 8', rideDurationMs('hourly', undefined, 99), 8 * HOUR_MS);
check('hourly defaults to 1 when absent', rideDurationMs('hourly'), 1 * HOUR_MS);
check('12hr', rideDurationMs('12hr'), 12 * HOUR_MS);
check('24hr', rideDurationMs('24hr'), DAY_MS);
check('multi_day 3', rideDurationMs('multi_day', 3), 3 * DAY_MS);
check('multi_day floors at 1', rideDurationMs('multi_day', 0), DAY_MS);
check('weekly', rideDurationMs('weekly'), 7 * DAY_MS);
check('monthly', rideDurationMs('monthly'), 30 * DAY_MS);
check('unknown tier is NaN', Number.isNaN(rideDurationMs('fortnight')), true);

console.log('\n— windows —');
const w1 = rideWindow({ service_date: '2026-08-10', start_time: '09:00', duration_tier: 'hourly', duration_hours: 3 });
check('3h from 09:00 WAT ends 12:00 WAT', new Date(w1.endMs).toISOString(), '2026-08-10T11:00:00.000Z');
const w2 = rideWindow({ service_date: '2026-08-10', start_time: '22:00', duration_tier: 'hourly', duration_hours: 4 });
check('an overnight hourly ride crosses the date line', new Date(w2.endMs).toISOString(), '2026-08-11T01:00:00.000Z');

// ── Turnaround ─────────────────────────────────────────────────────────────
console.log('\n— turnaround —');
check('defaults to 1h when unset', turnaroundMsFor({}), HOUR_MS);
check('reads the vehicle value', turnaroundMsFor({ turnaround_hours: 3 }), 3 * HOUR_MS);
check('zero is honoured, not treated as unset', turnaroundMsFor({ turnaround_hours: 0 }), 0);
check('garbage falls back to the default', turnaroundMsFor({ turnaround_hours: 'soon' }), HOUR_MS);

// A 1h booking 09:00-10:00 with a 1h buffer blocks anything starting before
// 11:00 and permits anything from 11:00 on. This is the case that made a flat
// 2h constant untenable once hourly hire existed.
const a = { s: rideStartAt('2026-08-10', '09:00'), e: rideStartAt('2026-08-10', '10:00') };
const buf = turnaroundMsFor({});
const at = (t) => rideStartAt('2026-08-10', t);
check('30 min after the end still conflicts',
  windowsOverlap(at('10:30'), at('11:30'), a.s, a.e, buf), true);
check('exactly 1h after the end is clear',
  windowsOverlap(at('11:00'), at('12:00'), a.s, a.e, buf), false);
check('90 min after the end is clear',
  windowsOverlap(at('11:30'), at('12:30'), a.s, a.e, buf), false);
check('30 min before the start conflicts',
  windowsOverlap(at('07:30'), at('08:30'), a.s, a.e, buf), true);
check('ending exactly 1h before the start is clear',
  windowsOverlap(at('07:00'), at('08:00'), a.s, a.e, buf), false);
check('a 3h turnaround pushes the boundary out',
  windowsOverlap(at('12:00'), at('13:00'), a.s, a.e, 3 * HOUR_MS), true);

// ── Pricing: server vs the client mirror ───────────────────────────────────
// The guest is quoted by estimateRidePrice and charged by priceForTier. If
// these disagree by even one naira the guest sees one number and pays another.
console.log('\n— pricing (server vs client mirror) —');
const vehicle = {
  price_per_hour_ngn: 15000,
  price_12hr_ngn: 120000,
  price_24hr_ngn: 200000,
  price_per_extra_day_ngn: 150000,
};
const cases = [
  ...HOURLY_CHOICES.map((h) => ({ tier: 'hourly', hours: h })),
  { tier: '12hr' }, { tier: '24hr' },
  { tier: 'multi_day', days: 1 }, { tier: 'multi_day', days: 2 }, { tier: 'multi_day', days: 5 },
  { tier: 'weekly' }, { tier: 'monthly' },
];
for (const c of cases) {
  const server = priceForTier(vehicle, c.tier, c.days, c.hours);
  const client = estimateRidePrice(vehicle, c);
  check(`${c.tier}${c.hours ? ` ${c.hours}h` : ''}${c.days ? ` ${c.days}d` : ''} agree`, client, server);
}
check('3h at 15k', priceForTier(vehicle, 'hourly', undefined, 3), 45000);
check('2 days = 24h rate + one extra day', priceForTier(vehicle, 'multi_day', 2), 350000);

console.log('\n— pricing edges —');
const noHourly = { price_12hr_ngn: 120000, price_24hr_ngn: 200000 };
check('no hourly rate returns null server-side', priceForTier(noHourly, 'hourly', undefined, 3), null);
check('no hourly rate returns null client-side', estimateRidePrice(noHourly, { tier: 'hourly', hours: 3 }), null);
check('multi_day falls back to the daily rate when no extra-day price',
  priceForTier(noHourly, 'multi_day', 3), 200000 * 3);
check('weekly falls back to 7x daily', priceForTier(noHourly, 'weekly'), 200000 * 7);

// ── Extra-hour rate: server snapshot vs client disclosure ──────────────────
// The guest reads extraHourRate on the vehicle page; checkRideAvailability
// snapshots extraHourRateFor onto the booking. A mismatch means the guest was
// told one overage rate and bound to another.
console.log('\n— extra-hour rate (server vs client mirror) —');
const overageCases = [
  ['explicit rate wins', { price_per_hour_ngn: 15000, price_extra_hour_ngn: 18000 }, 18000],
  ['falls back to the hourly rate', { price_per_hour_ngn: 15000 }, 15000],
  ['zero explicit rate is treated as unset', { price_per_hour_ngn: 15000, price_extra_hour_ngn: 0 }, 15000],
  ['day-hire-only car has no rule', { price_12hr_ngn: 120000, price_24hr_ngn: 200000 }, null],
  ['garbage falls through to hourly', { price_per_hour_ngn: 15000, price_extra_hour_ngn: 'call us' }, 15000],
];
for (const [name, v, want] of overageCases) {
  check(`${name} (server)`, extraHourRateFor(v), want);
  check(`${name} (client)`, extraHourRate(v), want);
}

// ── Markup: admin-only margin over VehicleCosting ──────────────────────────
console.log('\n— markup —');
const priced = { price_per_hour_ngn: 20000, price_24hr_ngn: 200000 };
const costed = {
  partner_cost_per_hour_ngn: 12000, driver_cost_per_hour_ngn: 3000,
  partner_cost_per_day_ngn: 120000, driver_cost_per_day_ngn: 30000,
};
const m = markupFor(priced, costed);
check('hourly markup is price minus partner minus driver', m.hourly.markup, 5000);
check('hourly percentage rounds', m.hourly.pct, 25);
check('daily markup', m.daily.markup, 50000);
check('no costing row gives no hourly line', markupFor(priced, null).hourly, null);
check('unpriced basis gives no line', markupFor({ price_24hr_ngn: 200000 }, costed).hourly, null);
check('costs above price show a negative markup',
  markupFor({ price_per_hour_ngn: 10000 }, { partner_cost_per_hour_ngn: 12000 }).hourly.markup, -2000);

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
