// Driver wallet model — run with: node scripts/check-driver-wallet.mjs
//
// WHY THIS LIVES IN THE REPO
// Base44 function directories cannot import a shared module, so every helper
// the driver wallet depends on is copied into each function that needs it,
// and the pay table has one more copy on the client. Nothing but this file
// stops those copies drifting, and here a drift is money: a driver quoted one
// figure and paid another, or a balance that two functions disagree about.
//
// This file does not re-implement what it tests. It reads the shipped
// functions off disk and executes them, and where a helper has several
// copies it also demands they are identical character for character.
//
// On the new Function() below: the only input is this repo's own source, read
// from paths this file computes itself. Nothing here is reachable from user
// input, a request body or the network; it is a developer script that never
// ships to the browser or to Deno.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rides from '../src/config/rides.js';
import { fromResponse, fromThrown } from '../src/lib/fnResult.js';
import { withdrawalActions, showsUnderPending } from '../src/lib/withdrawalRow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN = (name) => path.join(ROOT, 'base44/functions', name, 'entry.ts');

let pass = 0;
let fail = 0;
const report = (ok, name, got, want) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
// Exact value.
const check = (name, got, want) => report(Object.is(got, want), name, got, want);
// Structural equality, for the small objects the helpers return.
const same = (name, got, want) => report(JSON.stringify(got) === JSON.stringify(want), name, got, want);

// Lift one top-level function out of a shipped entry.ts as plain JavaScript.
// The convention every wallet helper follows makes this exact: the signature
// is the whole first line, the closing brace is alone in column 0, and the
// body carries no type annotations. Only the first line is rewritten.
function liftSrc(fnDir, fnName, signature) {
  const file = FN(fnDir);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${fnName}(`) || l.startsWith(`async function ${fnName}(`));
  if (start === -1) throw new Error(`could not find ${fnName} in ${path.relative(ROOT, file)}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) throw new Error(`${fnName} in ${path.relative(ROOT, file)} has no closing brace in column 0`);
  const head = `${lines[start].startsWith('async ') ? 'async ' : ''}function ${fnName}(${signature}) {`;
  return [head, ...lines.slice(start + 1, end), '}'].join('\n');
}

// Evaluate lifted sources together and hand back one of them by name.
const make = (name, ...sources) => new Function(`${sources.join('\n')}\nreturn ${name};`)();

// The same helper must be textually identical in every function that carries it.
const identical = (fnName, signature, dirs) => {
  const [first, ...rest] = dirs.map((d) => liftSrc(d, fnName, signature));
  for (let i = 0; i < rest.length; i += 1) {
    check(`${fnName}: ${dirs[i + 1]} copy matches ${dirs[0]}`, rest[i] === first, true);
  }
};

// One shipped `const NAME = …;` line, so the helpers run against the real
// limits rather than against numbers retyped here.
function constLine(fnDir, name) {
  const file = FN(fnDir);
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`could not find const ${name} in ${path.relative(ROOT, file)}`);
  return line;
}

const TIME = 'const WAT_OFFSET = "+01:00"; const HOUR_MS = 3600000; const DAY_MS = 86400000; const MAX_HOURLY = 8;';
const PAY = `${TIME} ${constLine('assignRideDriver', 'RELEASE_BUFFER_MS')} ${constLine('assignRideDriver', 'MAX_PAYOUT_NGN')}`;

// ── Pay table: server vs the client mirror ─────────────────────────────────
// Admin sees the client figure in the Assign driver dialog; assignRideDriver
// writes the server figure to the ledger. They must be the same number.
console.log('\n— driver pay (server vs client mirror) —');
const driverPayoutFor = make('driverPayoutFor', PAY, liftSrc('assignRideDriver', 'driverPayoutFor', 'costing, tier, hours, days'));
const costing = { driver_cost_per_hour_ngn: 2500, driver_cost_per_day_ngn: 15000 };
const tiers = [
  ...rides.HOURLY_CHOICES.map((h) => ({ tier: 'hourly', hours: h, amount: 2500 * h, basis: 'hourly', units: h })),
  { tier: 'hourly', hours: undefined, amount: 2500, basis: 'hourly', units: 1 },
  { tier: 'hourly', hours: 20, amount: 20000, basis: 'hourly', units: 8 },
  { tier: '12hr', amount: 15000, basis: 'daily', units: 1 },
  { tier: '24hr', amount: 15000, basis: 'daily', units: 1 },
  { tier: 'multi_day', days: 3, amount: 45000, basis: 'daily', units: 3 },
  { tier: 'multi_day', days: 0, amount: 15000, basis: 'daily', units: 1 },
  { tier: 'weekly', amount: 105000, basis: 'daily', units: 7 },
  { tier: 'monthly', amount: 450000, basis: 'daily', units: 30 },
];
for (const c of tiers) {
  const label = `${c.tier}${c.hours !== undefined ? ` ${c.hours}h` : ''}${c.days !== undefined ? ` ${c.days}d` : ''}`;
  const server = driverPayoutFor(costing, c.tier, c.hours, c.days);
  const client = rides.driverPayoutFor(costing, c.tier, { hours: c.hours, days: c.days });
  check(`${label}: amount`, server?.amount, c.amount);
  check(`${label}: basis`, server?.basis, c.basis);
  check(`${label}: units`, server?.units, c.units);
  same(`${label}: client mirror agrees`, client, server);
}

console.log('\n— driver pay edges —');
check('no costing row gives no figure', driverPayoutFor(null, '24hr'), null);
check('no costing row, client', rides.driverPayoutFor(null, '24hr'), null);
check('unknown tier gives no figure', driverPayoutFor(costing, 'fortnight'), null);
check('unknown tier, client', rides.driverPayoutFor(costing, 'fortnight'), null);
check('hourly ride, no hourly driver cost', driverPayoutFor({ driver_cost_per_day_ngn: 15000 }, 'hourly', 3), null);
check('day ride, no daily driver cost', driverPayoutFor({ driver_cost_per_hour_ngn: 2500 }, '24hr'), null);
check('day ride, no daily driver cost, client', rides.driverPayoutFor({ driver_cost_per_hour_ngn: 2500 }, '24hr'), null);
check('zero rate is "not set", not free labour', driverPayoutFor({ driver_cost_per_hour_ngn: 0 }, 'hourly', 2), null);
check('negative rate is refused', driverPayoutFor({ driver_cost_per_day_ngn: -1 }, '24hr'), null);
check('rates stored as strings still work', driverPayoutFor({ driver_cost_per_hour_ngn: '2500' }, 'hourly', 2)?.amount, 5000);
// The duration is whatever the guest typed when booking. It must not be able
// to multiply the driver's pay into nonsense.
check('a duration of Infinity days gives no figure', driverPayoutFor(costing, 'multi_day', undefined, Infinity), null);
check('…client mirror', rides.driverPayoutFor(costing, 'multi_day', { days: Infinity }), null);
check('a duration that multiplies past the ceiling gives no figure', driverPayoutFor(costing, 'multi_day', undefined, 1e6), null);
check('…client mirror', rides.driverPayoutFor(costing, 'multi_day', { days: 1e6 }), null);
check('a mistyped rate past the ceiling gives no figure', driverPayoutFor({ driver_cost_per_day_ngn: 1e12 }, '24hr'), null);
check('…client mirror', rides.driverPayoutFor({ driver_cost_per_day_ngn: 1e12 }, '24hr'), null);
check('the ceiling itself is payable', driverPayoutFor({ driver_cost_per_day_ngn: 50000000 }, '24hr')?.amount, 50000000);
check('client ceiling is the server ceiling', rides.MAX_PAYOUT_NGN, make('MAX_PAYOUT_NGN', PAY));

// ── The booked duration, where the guest types it ──────────────────────────
// Everything above multiplies by a day count that arrives in a request body.
console.log('\n— booked duration —');
const multiDaysOk = make('multiDaysOk', constLine('checkRideAvailability', 'MAX_MULTI_DAYS'),
  liftSrc('checkRideAvailability', 'multiDaysOk', 'days'));
check('1 day is a booking', multiDaysOk(1), true);
check('30 days is the most the form offers', multiDaysOk(30), true);
check('31 days is refused', multiDaysOk(31), false);
check('a billion days is refused', multiDaysOk(1e9), false);
check('Infinity is refused', multiDaysOk(Infinity), false);
check('half days are refused', multiDaysOk(2.5), false);
check('zero is refused', multiDaysOk(0), false);
check('negative is refused', multiDaysOk(-3), false);
check('missing is refused', multiDaysOk(undefined), false);
check('a numeric string from a form still counts', multiDaysOk('7'), true);

// ── Release moment ─────────────────────────────────────────────────────────
console.log('\n— release moment —');
const releaseAtFor = make('releaseAtFor', PAY, liftSrc('assignRideDriver', 'releaseAtFor', 'endAtIso'));
check('two hours after the booked end', releaseAtFor('2026-08-10T10:00:00.000Z'), '2026-08-10T12:00:00.000Z');
// A ride ending 23:30 WAT releases the next calendar day; the instant must not wobble.
check('crosses midnight cleanly', releaseAtFor('2026-08-10T23:30:00+01:00'), '2026-08-11T00:30:00.000Z');
check('unreadable end gives no release time', releaseAtFor('not a date'), null);
check('missing end gives no release time', releaseAtFor(''), null);
// The last representable instant parses; two hours after it does not exist.
check('an end at the edge of the calendar gives none, without throwing', releaseAtFor('+275760-09-13T00:00:00.000Z'), null);
check('client constant agrees with the server buffer',
  (Date.parse(releaseAtFor('2026-08-10T10:00:00.000Z')) - Date.parse('2026-08-10T10:00:00.000Z')) / 3600000,
  rides.RELEASE_BUFFER_HOURS);

// ── The pay figure admin types ─────────────────────────────────────────────
// Review focus 3: nothing but a whole-naira amount in range may reach the ledger.
console.log('\n— typed pay figure —');
const parsePayoutOverride = make('parsePayoutOverride', PAY, liftSrc('assignRideDriver', 'parsePayoutOverride', 'raw'));
const NOTHING = { ok: true, value: null };
const REFUSED = { ok: false, value: null };
same('absent means "use the costing row"', parsePayoutOverride(undefined), NOTHING);
same('null means the same', parsePayoutOverride(null), NOTHING);
same('empty string means the same', parsePayoutOverride(''), NOTHING);
same('spaces only means the same', parsePayoutOverride('   '), NOTHING);
same('a number is taken as typed', parsePayoutOverride(25000), { ok: true, value: 25000 });
same('a numeric string is accepted', parsePayoutOverride(' 25000 '), { ok: true, value: 25000 });
same('zero is a real answer (pay arranged elsewhere)', parsePayoutOverride(0), { ok: true, value: 0 });
same('kobo are rounded away', parsePayoutOverride(2500.4), { ok: true, value: 2500 });
same('the ceiling itself is allowed', parsePayoutOverride(50000000), { ok: true, value: 50000000 });
same('one naira over the ceiling is refused', parsePayoutOverride(50000001), REFUSED);
same('"25,000" is refused, not read as 25', parsePayoutOverride('25,000'), REFUSED);
same('negative is refused', parsePayoutOverride(-5), REFUSED);
same('words are refused', parsePayoutOverride('abc'), REFUSED);
same('9e12 is refused', parsePayoutOverride(9e12), REFUSED);
same('"1e3" is refused, digits only', parsePayoutOverride('1e3'), REFUSED);
same('"0x10" is refused', parsePayoutOverride('0x10'), REFUSED);
same('"+5" is refused', parsePayoutOverride('+5'), REFUSED);
same('NaN is refused', parsePayoutOverride(NaN), REFUSED);
same('Infinity is refused', parsePayoutOverride(Infinity), REFUSED);
same('true is refused', parsePayoutOverride(true), REFUSED);
same('an array is refused', parsePayoutOverride([25000]), REFUSED);
same('an object is refused', parsePayoutOverride({ amount: 25000 }), REFUSED);

// ── Assignment ledger ──────────────────────────────────────────────────────
// holdEarning and reverseHeldEarnings are the only code that creates or
// cancels a driver's pay at assignment time, so they run here against an
// in-memory stand-in for the DriverEarning entity.

// Just enough of one Base44 entity for the ledger helpers: exact-match filter
// (plus { $in: [...] }), create, update, get.
function fakeEntity(seed = [], startMs = Date.UTC(2026, 0, 1)) {
  let n = 0;
  const rows = seed.map((r) => ({ ...r }));
  const matches = (row, query) => Object.entries(query || {}).every(([k, v]) => (
    v && typeof v === 'object' && Array.isArray(v.$in) ? v.$in.includes(row[k]) : row[k] === v
  ));
  return {
    rows,
    async filter(query, _sort, limit = 50, skip = 0) {
      return rows.filter((r) => matches(r, query)).slice(skip, skip + limit).map((r) => ({ ...r }));
    },
    async create(data) {
      n += 1;
      // Stamped one second apart from startMs, in the order they were made.
      const row = { id: `new${n}`, created_date: new Date(startMs + n * 1000).toISOString(), ...data };
      rows.push(row);
      return { ...row };
    },
    async update(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`no row ${id}`);
      Object.assign(row, patch);
      return { ...row };
    },
    async get(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
  };
}
// The shipped fetchAll carries type annotations in its body, so the lifted
// helpers get this equivalent instead. It is glue, not the code under test.
const FETCH_ALL = 'async function fetchAll(entity, query) { const out = []; for (let skip = 0; ; skip += 500) { const page = await entity.filter(query, undefined, 500, skip); out.push(...page); if (page.length < 500) break; } return out; }';

console.log('\n— assignment ledger —');
const holdEarning = make('holdEarning', PAY, FETCH_ALL,
  liftSrc('assignRideDriver', 'releaseAtFor', 'endAtIso'),
  liftSrc('assignRideDriver', 'holdEarning', 'sr, ride, driverId, payout, endAtIso, nowIso'));
const reverseHeldEarnings = make('reverseHeldEarnings', FETCH_ALL,
  liftSrc('assignRideDriver', 'reverseHeldEarnings', 'sr, rideId, keepDriverId, note, nowIso'));

const rideA = { id: 'ride1', booking_reference: 'UD-AAA111', vehicle_name: 'Prado', service_date: '2026-08-10' };
const END = '2026-08-10T10:00:00.000Z';
const NOW = '2026-08-09T09:00:00.000Z';
const dayPay = { amount: 15000, basis: 'daily', rate: 15000, units: 1 };
const heldRow = (id, driver, extra = {}) => ({
  id, created_date: '2025-12-31T00:00:00.000Z', ride_booking_id: 'ride1', driver_id: driver,
  amount_ngn: 15000, status: 'held', ...extra,
});

{
  const sr = { DriverEarning: fakeEntity() };
  const e = await holdEarning(sr, rideA, 'drvA', dayPay, END, NOW);
  check('first assignment writes one row', sr.DriverEarning.rows.length, 1);
  check('…held', e.status, 'held');
  check('…for the pay figure', e.amount_ngn, 15000);
  check('…with the audit trail', `${e.basis}/${e.rate_ngn}/${e.units}`, 'daily/15000/1');
  check('…releasable two hours after the booked end', e.release_at, '2026-08-10T12:00:00.000Z');
  check('…snapshotting the ride', `${e.booking_reference}/${e.vehicle_name}/${e.service_date}`, 'UD-AAA111/Prado/2026-08-10');
  const again = await holdEarning(sr, rideA, 'drvA', { ...dayPay, amount: 99999 }, END, NOW);
  check('assigning the same driver again writes no second row', sr.DriverEarning.rows.length, 1);
  check('…and the first figure stands', again.amount_ngn, 15000);
}
{
  const sr = { DriverEarning: fakeEntity() };
  check('a ₦0 figure holds nothing', await holdEarning(sr, rideA, 'drvA', { ...dayPay, amount: 0 }, END, NOW), null);
  check('no figure holds nothing', await holdEarning(sr, rideA, 'drvA', null, END, NOW), null);
  check('…and neither writes a row', sr.DriverEarning.rows.length, 0);
}
{
  // Reassignment: A was holding, B takes the ride.
  const sr = { DriverEarning: fakeEntity([heldRow('a1', 'drvA'), heldRow('x1', 'drvA', { ride_booking_id: 'other-ride' })]) };
  const b = await holdEarning(sr, rideA, 'drvB', dayPay, END, NOW);
  const out = await reverseHeldEarnings(sr, 'ride1', 'drvB', 'Reassigned to B', NOW);
  const row = (id) => sr.DriverEarning.rows.find((r) => r.id === id);
  check('reassignment holds pay for the new driver', b.status, 'held');
  check('…reverses the previous driver', row('a1').status, 'reversed');
  check('…stamps when and why', `${row('a1').reversed_at}|${row('a1').admin_notes}`, `${NOW}|Reassigned to B`);
  check('…leaves the new driver held', row(b.id).status, 'held');
  check('…never touches another ride', row('x1').status, 'held');
  same('…and reports what moved', { ...out, rows: out.rows.map((r) => r.id) },
    { reversed_ngn: 15000, released_ngn: 0, driver_ids: ['drvA'], rows: ['a1'] });
  check('…handing back the row as it was read, pay figure included', `${out.rows[0].status}/${out.rows[0].amount_ngn}`, 'held/15000');
}
{
  // The previous driver's pay had already been released: it is not clawed back
  // silently, it is reported so admin can decide.
  const sr = { DriverEarning: fakeEntity([heldRow('a1', 'drvA', { status: 'released' })]) };
  const out = await reverseHeldEarnings(sr, 'ride1', 'drvB', 'Reassigned to B', NOW);
  check('a released row is left alone on reassignment', sr.DriverEarning.rows[0].status, 'released');
  same('…and reported', out, { reversed_ngn: 0, released_ngn: 15000, driver_ids: [], rows: [] });
}
{
  // Cancellation passes '' and reverses everyone still holding.
  const sr = { DriverEarning: fakeEntity([heldRow('a1', 'drvA'), heldRow('b1', 'drvB', { amount_ngn: 20000, admin_notes: 'earlier note' })]) };
  const out = await reverseHeldEarnings(sr, 'ride1', '', 'Ride cancelled', NOW);
  check('cancel reverses every held row', sr.DriverEarning.rows.every((r) => r.status === 'reversed'), true);
  check('…keeping earlier notes', sr.DriverEarning.rows[1].admin_notes, 'earlier note | Ride cancelled');
  same('…and totals it', { ...out, rows: out.rows.map((r) => r.id) },
    { reversed_ngn: 35000, released_ngn: 0, driver_ids: ['drvA', 'drvB'], rows: ['a1', 'b1'] });
}
{
  // Two admins assign in the same second: this call's first read is stale, so
  // it creates a twin. The oldest row must stand and the twin be reversed.
  const base = fakeEntity([heldRow('old', 'drvB')]);
  let stale = true;
  const racy = { ...base, filter: async (...a) => { if (stale) { stale = false; return []; } return base.filter(...a); } };
  const kept = await holdEarning({ DriverEarning: racy }, rideA, 'drvB', dayPay, END, NOW);
  check('a simultaneous double assign keeps the oldest row', kept.id, 'old');
  check('…and reverses the twin', base.rows.filter((r) => r.status === 'held').length, 1);
  check('…saying why', base.rows.find((r) => r.id !== 'old').admin_notes, 'Duplicate of old');
}
{
  // A ride whose end is not a real date has no moment to release at.
  const sr = { DriverEarning: fakeEntity() };
  let threw = false;
  try { await holdEarning(sr, rideA, 'drvA', dayPay, 'not a date', NOW); } catch { threw = true; }
  check('an unreadable ride end is refused loudly', threw, true);
  check('…and writes nothing', sr.DriverEarning.rows.length, 0);
}
const safeIso = make('safeIso', liftSrc('assignRideDriver', 'safeIso', 'ms'));
check('safeIso: a real instant round-trips', safeIso(Date.parse(END)), END);
check('safeIso: Infinity is not a date', safeIso(Infinity), null);
check('safeIso: NaN is not a date', safeIso(NaN), null);

// ── Cancellation uses the same reversal as reassignment ────────────────────
console.log('\n— cancellation —');
identical('reverseHeldEarnings', 'sr, rideId, keepDriverId, note, nowIso', ['assignRideDriver', 'cancelRideBooking']);

// ── Completion ─────────────────────────────────────────────────────────────
// Review focus 4. Every assertion pins an exact UTC instant: a naive parse
// resolves to local time, which on a machine in Nigeria coincides with the
// pinned value, so a wrong implementation would pass there and nowhere else.
console.log('\n— completion (sweep) —');
identical('rideDurationMs', 'tier, days, hours', ['getRideBookings', 'assignRideDriver', 'autoCancelExpiredBookings']);
identical('windowOf', 'r', ['getRideBookings', 'assignRideDriver', 'autoCancelExpiredBookings']);
const SWEEP_TIME = ['HOUR_MS', 'WAT_OFFSET', 'DAY_MS', 'MAX_HOURLY']
  .map((name) => constLine('autoCancelExpiredBookings', name)).join(' ');
const sweepSrc = (name, signature) => liftSrc('autoCancelExpiredBookings', name, signature);
const rideEnded = make('rideEnded', SWEEP_TIME,
  sweepSrc('rideDurationMs', 'tier, days, hours'), sweepSrc('windowOf', 'r'), sweepSrc('rideEnded', 'ride, nowMs'));
const at = (iso) => Date.parse(iso);

const stored = { start_at: '2026-08-10T08:00:00.000Z', end_at: '2026-08-10T10:00:00.000Z' };
check('not over one millisecond before the booked end', rideEnded(stored, at('2026-08-10T09:59:59.999Z')), false);
check('over at the booked end', rideEnded(stored, at('2026-08-10T10:00:00.000Z')), true);
// A row written before start_at and end_at existed. 09:00 WAT is 08:00 UTC,
// so three hours later is 11:00 UTC.
const legacy = { service_date: '2026-08-10', start_time: '09:00', duration_tier: 'hourly', duration_hours: 3 };
check('legacy row: still running at 10:59:59.999 UTC', rideEnded(legacy, at('2026-08-10T10:59:59.999Z')), false);
check('legacy row: over at 11:00 UTC', rideEnded(legacy, at('2026-08-10T11:00:00.000Z')), true);
// 22:00 WAT for four hours ends at 02:00 WAT the next day: 01:00 UTC.
const overnight = { service_date: '2026-08-10', start_time: '22:00', duration_tier: 'hourly', duration_hours: 4 };
check('overnight ride: still running at 00:59:59.999 UTC', rideEnded(overnight, at('2026-08-11T00:59:59.999Z')), false);
check('overnight ride: over at 01:00 UTC', rideEnded(overnight, at('2026-08-11T01:00:00.000Z')), true);
// A 24-hour hire from midnight WAT starts on the previous UTC date.
const fromMidnight = { service_date: '2026-08-10', start_time: '00:00', duration_tier: '24hr' };
check('midnight start: still running at 22:59:59.999 UTC', rideEnded(fromMidnight, at('2026-08-10T22:59:59.999Z')), false);
check('midnight start: over at 23:00 UTC the same date', rideEnded(fromMidnight, at('2026-08-10T23:00:00.000Z')), true);
const FAR = at('2099-01-01T00:00:00.000Z');
check('a row with no time on it never completes by itself', rideEnded({}, FAR), false);
check('an unknown duration tier never completes by itself',
  rideEnded({ service_date: '2026-08-10', start_time: '09:00', duration_tier: 'fortnight' }, FAR), false);
check('a garbage date never completes by itself',
  rideEnded({ service_date: 'soon', start_time: 'late', duration_tier: '24hr' }, FAR), false);

// ── Release ────────────────────────────────────────────────────────────────
console.log('\n— release (sweep) —');
const isReleasable = make('isReleasable', sweepSrc('isReleasable', 'earning, nowMs'));
const releaseDecision = make('releaseDecision', sweepSrc('releaseDecision', 'earning, ride'));
const DUE = at('2026-08-10T12:00:00.000Z');
const due = (extra = {}) => ({
  id: 'e1', ride_booking_id: 'ride1', driver_id: 'drvA', amount_ngn: 15000,
  status: 'held', on_hold: false, release_at: '2026-08-10T12:00:00.000Z', ...extra,
});
const drivenRide = (extra = {}) => ({ id: 'ride1', driver_id: 'drvA', status: 'completed', payment_status: 'paid', ...extra });

check('releasable at the release moment', isReleasable(due(), DUE), true);
check('not one millisecond before', isReleasable(due(), DUE - 1), false);
check('not while admin has it on hold', isReleasable(due({ on_hold: true }), DUE), false);
check('not when already released', isReleasable(due({ status: 'released' }), DUE), false);
check('not when reversed', isReleasable(due({ status: 'reversed' }), DUE), false);
check('not without a release time', isReleasable(due({ release_at: '' }), DUE), false);
check('not for a row that is gone', isReleasable(null, DUE), false);

check('a paid ride with the same driver releases', releaseDecision(due(), drivenRide()), 'release');
check('…whether or not the sweep has completed it yet', releaseDecision(due(), drivenRide({ status: 'confirmed' })), 'release');
check('a cancelled ride reverses', releaseDecision(due(), drivenRide({ status: 'cancelled' })), 'reverse:ride cancelled');
check('a ride handed to another driver reverses', releaseDecision(due(), drivenRide({ driver_id: 'drvB' })), 'reverse:ride reassigned');
check('a ride that no longer exists reverses', releaseDecision(due(), null), 'reverse:ride no longer exists');
check('a refunded ride is put on hold for admin', releaseDecision(due(), drivenRide({ payment_status: 'refunded' })), 'hold:ride is not paid');

const settleDueEarning = make('settleDueEarning',
  sweepSrc('isReleasable', 'earning, nowMs'), sweepSrc('releaseDecision', 'earning, ride'),
  sweepSrc('hasOpenGuestReport', 'sr, rideBookingId, driverId'), sweepSrc('keepReversed', 'sr, earningId'),
  sweepSrc('settleDueEarning', 'sr, earningId, nowMs'));
// No reports on any ride here; scripts/check-ride-reports.mjs covers the cases with one.
const world = (earning, ride) => ({
  DriverEarning: fakeEntity([earning]), RideBooking: fakeEntity(ride ? [ride] : []), RideReport: fakeEntity([]),
});
{
  const sr = world(due(), drivenRide());
  check('a due earning is released', await settleDueEarning(sr, 'e1', DUE), 'released');
  check('…and stamped', sr.DriverEarning.rows[0].released_at, '2026-08-10T12:00:00.000Z');
  // The balance is derived from the ledger, so a second run has nothing to add.
  check('the next sweep tick skips it', await settleDueEarning(sr, 'e1', DUE + 300000), 'skipped');
  check('…leaving the first release time', sr.DriverEarning.rows[0].released_at, '2026-08-10T12:00:00.000Z');
}
{
  const sr = world(due(), drivenRide());
  check('an earning that is not due yet is skipped', await settleDueEarning(sr, 'e1', DUE - 1), 'skipped');
  check('…and stays held', sr.DriverEarning.rows[0].status, 'held');
}
{
  // The page was fetched, then admin paused the row before the sweep reached it.
  const sr = world(due({ on_hold: true, hold_reason: 'guest disputes the trip' }), drivenRide());
  check('a row paused since the page was read is skipped', await settleDueEarning(sr, 'e1', DUE), 'skipped');
  check('…and stays held', sr.DriverEarning.rows[0].status, 'held');
}
{
  const sr = world(due({ admin_notes: 'first note' }), drivenRide({ status: 'cancelled' }));
  check('pay on a cancelled ride is reversed, not released', await settleDueEarning(sr, 'e1', DUE), 'reversed');
  check('…with the reason appended', sr.DriverEarning.rows[0].admin_notes, 'first note | Sweep: ride cancelled');
}
{
  // Assignment stopped after step 2: the ride is the new driver's, the old row is still held.
  const sr = world(due(), drivenRide({ driver_id: 'drvB' }));
  check('pay for a driver no longer on the ride is reversed', await settleDueEarning(sr, 'e1', DUE), 'reversed');
}
{
  const sr = world(due(), drivenRide({ payment_status: 'refunded' }));
  check('pay on a refunded ride is put on hold', await settleDueEarning(sr, 'e1', DUE), 'held');
  check('…with the reason', `${sr.DriverEarning.rows[0].on_hold}/${sr.DriverEarning.rows[0].hold_reason}`, 'true/ride is not paid');
  check('…and is then left for admin', await settleDueEarning(sr, 'e1', DUE + 300000), 'skipped');
}
{
  // A read that fails is not the same as a ride that is gone.
  const sr = world(due(), drivenRide());
  sr.RideBooking.get = async () => { throw new Error('network'); };
  const warn = console.warn;
  console.warn = () => {}; // the helper logs the failed read; keep this output to results
  const outcome = await settleDueEarning(sr, 'e1', DUE);
  console.warn = warn;
  check('a failed ride read never reverses pay', outcome, 'skipped');
  check('…the row stays held for the next tick', sr.DriverEarning.rows[0].status, 'held');
}

// ── A paid ride stays paid ─────────────────────────────────────────────────
// Review focus 5. Both payment paths used to test "paid AND confirmed", which
// stopped being the same thing as "paid" the moment rides could be completed.
console.log('\n— paid stays paid —');
identical('rideAlreadyPaid', 'ride', ['verifyRidePayment', 'paystackWebhook']);
const rideAlreadyPaid = make('rideAlreadyPaid', liftSrc('verifyRidePayment', 'rideAlreadyPaid', 'ride'));
check('paid and confirmed', rideAlreadyPaid({ payment_status: 'paid', status: 'confirmed' }), true);
check('paid and completed: an old reference must not reopen it', rideAlreadyPaid({ payment_status: 'paid', status: 'completed' }), true);
check('paid then cancelled by admin: must not be resurrected', rideAlreadyPaid({ payment_status: 'paid', status: 'cancelled' }), true);
check('approved and unpaid is still payable', rideAlreadyPaid({ payment_status: 'unpaid', status: 'pending' }), false);
check('refunded is not "paid"', rideAlreadyPaid({ payment_status: 'refunded', status: 'cancelled' }), false);
check('a missing ride is not "paid"', rideAlreadyPaid(null), false);

// ── Driver sign-in ─────────────────────────────────────────────────────────
// Review focus 1: an email typed with capitals or a stray space must still
// find its driver, and changing a driver's login must keep the old address.
console.log('\n— driver sign-in —');
const FIND_DRIVER_SIG = 'sr, email';
const findDriverForUser = make('findDriverForUser', liftSrc('getDriverProfile', 'findDriverForUser', FIND_DRIVER_SIG));
const roster = (rows) => ({ Driver: fakeEntity(rows) });
{
  const sr = roster([{ id: 'd1', created_date: '2026-01-02T00:00:00.000Z', user_email: 'emeka@gmail.com' }]);
  check('a login with capitals and a trailing space finds its driver', (await findDriverForUser(sr, 'Emeka@Gmail.com '))?.id, 'd1');
  check('an exact login finds its driver', (await findDriverForUser(sr, 'emeka@gmail.com'))?.id, 'd1');
  check('someone else finds nothing', await findDriverForUser(sr, 'ada@gmail.com'), null);
  check('no email finds nothing', await findDriverForUser(sr, ''), null);
  check('an undefined email finds nothing', await findDriverForUser(sr, undefined), null);
}
{
  // A row typed straight into the data browser, capitals and all.
  const sr = roster([{ id: 'd2', created_date: '2026-01-02T00:00:00.000Z', user_email: 'Emeka@Gmail.com' }]);
  check('a row stored with capitals is still found by the same login', (await findDriverForUser(sr, 'Emeka@Gmail.com'))?.id, 'd2');
}
{
  // Two rows on one login is an admin mistake. The answer must not flip between calls.
  const sr = roster([
    { id: 'newer', created_date: '2026-03-01T00:00:00.000Z', user_email: 'emeka@gmail.com' },
    { id: 'older', created_date: '2026-01-01T00:00:00.000Z', user_email: 'emeka@gmail.com' },
  ]);
  check('two rows on one login: the oldest wins', (await findDriverForUser(sr, 'emeka@gmail.com'))?.id, 'older');
}

check('normaliseEmail trims and lower-cases', rides.normaliseEmail('  Emeka@Gmail.COM '), 'emeka@gmail.com');
check('normaliseEmail of nothing is empty', rides.normaliseEmail(undefined), '');
check('looksLikeEmail accepts an address', rides.looksLikeEmail('emeka@gmail.com'), true);
check('looksLikeEmail refuses a name', rides.looksLikeEmail('emeka'), false);
check('looksLikeEmail refuses a space inside', rides.looksLikeEmail('emeka okafor@gmail.com'), false);
same('first link: stored lower-cased, no history',
  rides.driverLoginPatch({}, ' Emeka@Gmail.com '), { user_email: 'emeka@gmail.com', previous_user_emails: [] });
same('same address retyped with capitals: nothing moves to history',
  rides.driverLoginPatch({ user_email: 'emeka@gmail.com' }, 'EMEKA@gmail.com'),
  { user_email: 'emeka@gmail.com', previous_user_emails: [] });
same('changed address: the old one is remembered',
  rides.driverLoginPatch({ user_email: 'emeka@gmail.com' }, 'emeka@work.ng'),
  { user_email: 'emeka@work.ng', previous_user_emails: ['emeka@gmail.com'] });
same('changed twice: both are remembered, once each',
  rides.driverLoginPatch({ user_email: 'emeka@work.ng', previous_user_emails: ['emeka@gmail.com'] }, 'e@new.ng'),
  { user_email: 'e@new.ng', previous_user_emails: ['emeka@gmail.com', 'emeka@work.ng'] });
same('unlinked: the address moves to history so past withdrawals still count',
  rides.driverLoginPatch({ user_email: 'emeka@gmail.com' }, ''),
  { user_email: '', previous_user_emails: ['emeka@gmail.com'] });
same('a new driver saved with no login',
  rides.driverLoginPatch(undefined, ''), { user_email: '', previous_user_emails: [] });

// ── What a driver is shown about a ride ────────────────────────────────────
console.log('\n— driver ride view —');
identical('findDriverForUser', FIND_DRIVER_SIG, ['getDriverProfile', 'getDriverRides']);
identical('rideDurationMs', 'tier, days, hours', ['getRideBookings', 'getDriverRides']);
identical('windowOf', 'r', ['getRideBookings', 'getDriverRides']);
identical('computeBucket', 'r, nowMs', ['getRideBookings', 'getDriverRides']);
identical('safeIso', 'ms', ['assignRideDriver', 'getDriverRides']);

const earningForRide = make('earningForRide', liftSrc('getDriverRides', 'earningForRide', 'rows'));
check('no earning rows: nothing to show', earningForRide([]), null);
check('a held row beats an older reversed one',
  earningForRide([
    { id: 'old', status: 'reversed', created_date: '2026-08-01T00:00:00.000Z' },
    { id: 'live', status: 'held', created_date: '2026-08-02T00:00:00.000Z' },
  ])?.id, 'live');
check('a released row beats a newer reversed duplicate',
  earningForRide([
    { id: 'paid', status: 'released', created_date: '2026-08-01T00:00:00.000Z' },
    { id: 'dup', status: 'reversed', created_date: '2026-08-02T00:00:00.000Z' },
  ])?.id, 'paid');
check('only reversed rows: the latest is shown',
  earningForRide([
    { id: 'r1', status: 'reversed', created_date: '2026-08-01T00:00:00.000Z' },
    { id: 'r2', status: 'reversed', created_date: '2026-08-02T00:00:00.000Z' },
  ])?.id, 'r2');

const driverRideView = make('driverRideView',
  liftSrc('getDriverRides', 'safeIso', 'ms'), liftSrc('getDriverRides', 'driverRideView', 'ride, bucket, win, earning, flags'));
const fullRide = {
  id: 'ride1', booking_reference: 'UD-AAA111', vehicle_name: 'Prado', vehicle_image: 'https://x/p.jpg',
  service_date: '2026-08-10', start_time: '09:00', duration_tier: 'hourly', duration_hours: 3,
  pickup_location: { address: '4 Aso Drive', city: 'Abuja' }, pickup_instructions: 'Gate 2',
  passengers: 2, special_requests: 'Child seat', status: 'confirmed',
  guest_name: 'Ada Obi', guest_phone: '+2348010000000', guest_email: 'ada@example.com',
  total_price: 45000, estimated_price: 45000, transaction_hash: 'T123', admin_response: 'internal',
};
const fullEarning = {
  id: 'e1', amount_ngn: 7500, status: 'held', on_hold: false, release_at: '2026-08-10T13:00:00.000Z',
  admin_notes: 'internal', hold_reason: 'internal', adjustment_reason: 'internal', rate_ngn: 2500, units: 3,
};
const liveWin = { startMs: at('2026-08-10T08:00:00.000Z'), endMs: at('2026-08-10T11:00:00.000Z') };
const upcomingView = driverRideView(fullRide, 'upcoming', liveWin, fullEarning);
check('an upcoming ride shows the guest phone', upcomingView.guest_phone, '+2348010000000');
check('a ride in progress shows the guest phone', driverRideView(fullRide, 'current', liveWin, fullEarning).guest_phone, '+2348010000000');
check('a past ride no longer shows the guest phone', driverRideView(fullRide, 'past', liveWin, fullEarning).guest_phone, null);
check('a cancelled ride does not show the guest phone', driverRideView(fullRide, 'cancelled', liveWin, fullEarning).guest_phone, null);
check('the guest name stays, so a report has a subject', driverRideView(fullRide, 'past', liveWin, fullEarning).guest_name, 'Ada Obi');
check('instants are returned in UTC', `${upcomingView.start_at}|${upcomingView.end_at}`, '2026-08-10T08:00:00.000Z|2026-08-10T11:00:00.000Z');
// Allow-list, not a spread: what the guest paid and how to reach them by email
// are not the driver's to see, and neither are admin's notes on the pay.
same('exactly these ride fields reach the driver', Object.keys(upcomingView).sort(), [
  'already_reported', 'booking_reference', 'bucket', 'can_report', 'dropoff_location', 'duration_days', 'duration_hours', 'duration_tier',
  'earning', 'end_at', 'guest_name', 'guest_phone', 'id', 'passengers', 'pickup_instructions',
  'pickup_location', 'service_date', 'special_requests', 'start_at', 'start_time', 'status',
  'vehicle_image', 'vehicle_name',
]);
same('exactly these pay fields reach the driver', Object.keys(upcomingView.earning).sort(),
  ['amount_ngn', 'id', 'on_hold', 'release_at', 'released_at', 'status', 'under_review']);
check('a ride with no earning says so', driverRideView(fullRide, 'upcoming', liveWin, null).earning, null);
check('an unreadable window gives null instants, not a crash', driverRideView(fullRide, 'upcoming', null, null).start_at, null);

// ── Wallet arithmetic ──────────────────────────────────────────────────────
// A driver's balance is never stored. It is these three functions applied to
// the ledger, every time, in every function that needs the number.
console.log('\n— wallet arithmetic —');
identical('findDriverForUser', FIND_DRIVER_SIG, ['getDriverProfile', 'getDriverWallet']);
const WALLET_HOME = 'getDriverWallet';
const walletSrc = (name, signature) => liftSrc(WALLET_HOME, name, signature);
const driverEmails = make('driverEmails', walletSrc('driverEmails', 'driver'));
const driverWithdrawals = make('driverWithdrawals',
  walletSrc('driverEmails', 'driver'), walletSrc('driverWithdrawals', 'driver, rows'));
const walletTotals = make('walletTotals', walletSrc('walletTotals', 'earnings, withdrawals'));

// Review focus 1: logins are matched however they were typed.
same('current and previous logins, lower-cased, once each',
  driverEmails({ user_email: ' Emeka@Gmail.com ', previous_user_emails: ['OLD@x.ng', 'old@x.ng', '', null] }),
  ['emeka@gmail.com', 'old@x.ng']);
same('a driver with no login has no emails', driverEmails({ id: 'd1' }), []);
same('no driver has no emails', driverEmails(null), []);

const emeka = { id: 'drvA', user_email: 'emeka@work.ng', previous_user_emails: ['emeka@gmail.com'] };
const wd = (id, extra = {}) => ({
  id, wallet: 'driver', driver_id: 'drvA', user_email: 'emeka@work.ng', amount: 10000, status: 'completed', ...extra,
});
same('which withdrawal rows count against a driver',
  driverWithdrawals(emeka, [
    wd('current-login'),
    wd('capitals-in-email', { user_email: 'Emeka@Work.NG ' }),
    wd('made-under-the-old-login', { user_email: 'emeka@gmail.com' }),
    wd('another-driver', { driver_id: 'drvB' }),
    // Anyone signed in can create a WithdrawalRequest row for their own email
    // and write any driver_id on it. It must not touch this driver's balance.
    wd('forged-by-a-stranger', { user_email: 'mallory@evil.ng' }),
    wd('referral-wallet-row', { wallet: 'referral' }),
    wd('row-from-before-wallets-existed', { wallet: undefined }),
    null,
  ]).map((w) => w.id),
  ['current-login', 'capitals-in-email', 'made-under-the-old-login']);
same('no driver, no rows', driverWithdrawals(null, [wd('x')]), []);
same('no rows at all', driverWithdrawals(emeka, undefined), []);

const ZERO = { held: 0, released: 0, paid_out: 0, reserved: 0, available: 0, shortfall: 0 };
const earn = (status, amount_ngn) => ({ status, amount_ngn });
same('an empty wallet', walletTotals([], []), ZERO);
same('nothing at all', walletTotals(undefined, undefined), ZERO);
same('held is not available; reversed counts nowhere',
  walletTotals([earn('held', 15000), earn('released', 20000), earn('reversed', 9999)], []),
  { ...ZERO, held: 15000, released: 20000, available: 20000 });
same('paid out and in-flight withdrawals both come off the balance',
  walletTotals([earn('released', 30000)], [wd('a', { amount: 10000 }), wd('b', { amount: 12000, status: 'pending' })]),
  { ...ZERO, released: 30000, paid_out: 10000, reserved: 12000, available: 8000 });
same('a processing withdrawal is still in flight',
  walletTotals([earn('released', 30000)], [wd('b', { amount: 12000, status: 'processing' })]),
  { ...ZERO, released: 30000, reserved: 12000, available: 18000 });
// No refund step exists for the driver wallet: a failed transfer just stops counting.
same('failed and reversed transfers put the money back by themselves',
  walletTotals([earn('released', 30000)], [wd('f', { amount: 30000, status: 'failed' }), wd('r', { amount: 30000, status: 'reversed' })]),
  { ...ZERO, released: 30000, available: 30000 });
// Review focus 2: pay reversed after it was withdrawn.
same('pay reversed after it was withdrawn: ₦0 available, never negative, shortfall recorded',
  walletTotals([earn('reversed', 10000)], [wd('a', { amount: 10000 })]),
  { ...ZERO, paid_out: 10000, available: 0, shortfall: 10000 });
same('…and the next released pay nets against that shortfall',
  walletTotals([earn('reversed', 10000), earn('released', 15000)], [wd('a', { amount: 10000 })]),
  { ...ZERO, released: 15000, paid_out: 10000, available: 5000, shortfall: 0 });
same('amounts stored as strings still count',
  walletTotals([earn('released', '20000')], [wd('a', { amount: '5000' })]),
  { ...ZERO, released: 20000, paid_out: 5000, available: 15000 });
same('kobo are rounded away', walletTotals([earn('released', 15000.4)], []), { ...ZERO, released: 15000, available: 15000 });
same('garbage, negative and infinite amounts count as nothing, never as NaN',
  walletTotals(
    [earn('released', 'abc'), earn('released', -500), earn('released', Infinity), earn('released', 1000)],
    [wd('a', { amount: NaN }), wd('b', { amount: Infinity, status: 'pending' }), wd('c', { amount: -1 })],
  ),
  { ...ZERO, released: 1000, available: 1000 });

const ledgerView = make('ledgerView', walletSrc('ledgerView', 'earning, underReview'));
same('exactly these ledger fields reach the driver',
  Object.keys(ledgerView({
    id: 'e1', driver_id: 'drvA', ride_booking_id: 'ride1', booking_reference: 'UD-AAA111', vehicle_name: 'Prado',
    service_date: '2026-08-10', amount_ngn: 15000, status: 'held', on_hold: true, hold_reason: 'internal',
    admin_notes: 'internal', adjustment_reason: 'internal', rate_ngn: 15000, units: 1, basis: 'daily',
    release_at: '2026-08-10T12:00:00.000Z', held_at: '2026-08-09T09:00:00.000Z',
  })).sort(),
  ['amount_ngn', 'booking_reference', 'held_at', 'id', 'on_hold', 'release_at', 'released_at', 'reversed_at',
    'ride_booking_id', 'service_date', 'status', 'under_review', 'vehicle_name']);

// ── Withdrawals from the driver wallet ─────────────────────────────────────
console.log('\n— withdrawals —');
for (const dir of ['createWithdrawalRequest', 'processWithdrawal']) {
  identical('driverEmails', 'driver', [WALLET_HOME, dir]);
  identical('driverWithdrawals', 'driver, rows', [WALLET_HOME, dir]);
  identical('walletTotals', 'earnings, withdrawals', [WALLET_HOME, dir]);
  check(`one withdrawal minimum: ${dir} agrees with ${WALLET_HOME}`,
    constLine(dir, 'WITHDRAWAL_THRESHOLD_NGN'), constLine(WALLET_HOME, 'WITHDRAWAL_THRESHOLD_NGN'));
}
identical('findDriverForUser', FIND_DRIVER_SIG, ['getDriverProfile', 'createWithdrawalRequest']);
identical('refundsToBalance', 'withdrawal', ['processWithdrawal', 'paystackTransferWebhook']);

const parseWithdrawalAmount = make('parseWithdrawalAmount', liftSrc('createWithdrawalRequest', 'parseWithdrawalAmount', 'raw'));
check('a whole naira amount is taken as it is', parseWithdrawalAmount(15000), 15000);
check('kobo are refused, not rounded', parseWithdrawalAmount(15000.5), null);
check('a string is refused', parseWithdrawalAmount('15000'), null);
check('zero is refused', parseWithdrawalAmount(0), null);
check('negative is refused', parseWithdrawalAmount(-15000), null);
check('NaN is refused', parseWithdrawalAmount(NaN), null);
check('Infinity is refused', parseWithdrawalAmount(Infinity), null);
check('nothing is refused', parseWithdrawalAmount(undefined), null);

// A failed transfer credits a stored balance only if one was debited.
const refundsToBalance = make('refundsToBalance', liftSrc('processWithdrawal', 'refundsToBalance', 'withdrawal'));
check('a referral withdrawal is refunded to the referral balance', refundsToBalance({ wallet: 'referral' }), true);
check('a row from before wallets existed is a referral withdrawal', refundsToBalance({ amount: 10000 }), true);
check('a driver-wallet withdrawal is never credited to referral cash', refundsToBalance({ wallet: 'driver' }), false);
check('a missing row refunds nothing', refundsToBalance(null), false);

// processWithdrawal re-checks a driver-wallet request against the ledger just
// before it sends money. This is what makes a forged or stale row harmless.
const driverWithdrawalProblem = make('driverWithdrawalProblem',
  constLine('processWithdrawal', 'WITHDRAWAL_THRESHOLD_NGN'), FETCH_ALL,
  liftSrc('processWithdrawal', 'isId', 'value'),
  liftSrc('processWithdrawal', 'getOrNull', 'entity, id'),
  liftSrc('processWithdrawal', 'driverEmails', 'driver'),
  liftSrc('processWithdrawal', 'driverWithdrawals', 'driver, rows'),
  liftSrc('processWithdrawal', 'walletTotals', 'earnings, withdrawals'),
  liftSrc('processWithdrawal', 'driverWithdrawalProblem', 'sr, w'));
const bank = (requests, earnings, drivers = [{ id: 'drvA', user_email: 'emeka@work.ng', previous_user_emails: ['emeka@gmail.com'] }]) => ({
  Driver: fakeEntity(drivers), DriverEarning: fakeEntity(earnings), WithdrawalRequest: fakeEntity(requests),
});
const request = (extra = {}) => ({
  id: 'w1', wallet: 'driver', driver_id: 'drvA', user_email: 'emeka@work.ng', amount: 20000, status: 'pending', ...extra,
});
const releasedRow = (id, amount_ngn) => ({ id, driver_id: 'drvA', status: 'released', amount_ngn });
const problemFor = async (req, earnings, others = [], drivers) =>
  driverWithdrawalProblem(bank([req, ...others], earnings, drivers), req);

check('a request the ledger covers may be paid', await problemFor(request(), [releasedRow('e1', 20000)]), '');
check('…with the login typed in capitals', await problemFor(request({ user_email: 'Emeka@Work.NG' }), [releasedRow('e1', 20000)]), '');
// Hand-made in the browser console: half a million against ₦20,000 of earnings.
check('a request for more than was ever earned is refused',
  (await problemFor(request({ amount: 500000 }), [releasedRow('e1', 20000)])).includes('short by ₦480,000'), true);
check('held pay does not cover a withdrawal',
  (await problemFor(request(), [{ id: 'e1', driver_id: 'drvA', status: 'held', amount_ngn: 20000 }])).includes('short by ₦20,000'), true);
// Honest request, then admin reversed the ride's pay before processing it.
check('pay reversed after the request was made: refused',
  (await problemFor(request(), [{ id: 'e1', driver_id: 'drvA', status: 'reversed', amount_ngn: 20000 }])).includes('short by ₦20,000'), true);
check('money already paid out is not paid again',
  (await problemFor(request(), [releasedRow('e1', 20000)], [request({ id: 'w0', status: 'completed' })])).includes('short by ₦20,000'), true);
check('a failed earlier attempt does not block a retry',
  await problemFor(request(), [releasedRow('e1', 20000)], [request({ id: 'w0', status: 'failed' })]), '');
check('a stranger naming this driver is refused',
  await problemFor(request({ user_email: 'mallory@evil.ng' }), [releasedRow('e1', 20000)]),
  'This login is not the one linked to the driver profile.');
check('a login the driver was unlinked from cannot start a withdrawal',
  await problemFor(request({ user_email: 'emeka@gmail.com' }), [releasedRow('e1', 20000)]),
  'This login is not the one linked to the driver profile.');
check('a request naming no driver is refused',
  await problemFor(request({ driver_id: '' }), [releasedRow('e1', 20000)]), 'This request names no driver.');
check('a request for a driver who no longer exists is refused',
  await problemFor(request(), [releasedRow('e1', 20000)], [], []), 'The driver profile for this request no longer exists.');
for (const bad of [9999, 20000.5, 'abc', Infinity, -20000, null]) {
  check(`an amount of ${JSON.stringify(bad)} is refused`,
    await problemFor(request({ amount: bad }), [releasedRow('e1', 20000)]),
    'The amount on this request is not a valid withdrawal.');
}

// ── Reading what a function said ───────────────────────────────────────────
// A refusal is a 4xx with a sentence in it, and axios throws on a 4xx. These
// two functions are what stand between the user and "Request failed with
// status code 409".
console.log('\n— function results —');
{
  const r = fromResponse({ status: 200, data: { success: true, data: { rides: [] } } });
  same('a success carries its data', [r.ok, r.data, r.error], [true, { rides: [] }, null]);
}
{
  // createWithdrawalRequest answers { success, withdrawal_request, message } with no `data` key.
  const r = fromResponse({ status: 200, data: { success: true, message: 'Created', withdrawal_request: { id: 'w1' } } });
  same('an older success shape keeps its body', [r.ok, r.data, r.body.message], [true, null, 'Created']);
}
{
  const r = fromResponse({ status: 200, data: { success: false, error: 'Already decided', code: 'ALREADY_DECIDED' } });
  same('a 200 that says no is not ok', [r.ok, r.error, r.code], [false, 'Already decided', 'ALREADY_DECIDED']);
}
{
  const r = fromThrown({
    message: 'Request failed with status code 409',
    response: { status: 409, data: { success: false, error: 'No driver cost is set for this vehicle.', code: 'PAYOUT_REQUIRED' } },
  });
  same('a refusal gives the server sentence, not the axios one',
    [r.ok, r.error, r.code, r.status], [false, 'No driver cost is set for this vehicle.', 'PAYOUT_REQUIRED', 409]);
}
{
  const r = fromThrown({ message: 'Request failed with status code 400', response: { status: 400, data: { error: 'Minimum withdrawal amount is ₦10,000' } } });
  check('an older refusal shape is read too', r.error, 'Minimum withdrawal amount is ₦10,000');
}
{
  // What the platform itself answers when the workspace plan has no functions.
  const r = fromThrown({ message: 'Request failed with status code 402', response: { status: 402, data: { message: 'Functions are blocked - app owner lacks backend functions capability' } } });
  same('a platform refusal is shown as it was sent',
    [r.error, r.status], ['Functions are blocked - app owner lacks backend functions capability', 402]);
}
check('no response at all reads as a connection problem',
  fromThrown({ message: 'Network Error' }).error, 'Could not reach the server. Check your connection and try again.');
check('an error page instead of JSON falls back to the transport message',
  fromThrown({ message: 'Request failed with status code 502', response: { status: 502, data: '<html>Bad gateway</html>' } }).error,
  'Request failed with status code 502');
check('nothing at all still gives a sentence', typeof fromThrown(undefined).error, 'string');
check('a malformed success is not ok', fromResponse({ status: 200, data: null }).ok, false);

// ── Admin settlement ───────────────────────────────────────────────────────
console.log('\n— admin settlement —');
identical('releaseDecision', 'earning, ride', ['autoCancelExpiredBookings', 'settleDriverEarning']);
check('one pay ceiling: settleDriverEarning agrees with assignRideDriver',
  constLine('settleDriverEarning', 'MAX_PAYOUT_NGN'), constLine('assignRideDriver', 'MAX_PAYOUT_NGN'));
const nextEarningState = make('nextEarningState',
  constLine('settleDriverEarning', 'MAX_PAYOUT_NGN'), constLine('settleDriverEarning', 'MAX_REASON_LENGTH'),
  liftSrc('settleDriverEarning', 'nextEarningState', 'action, earning, input, nowIso'));
const AT = '2026-08-10T12:00:00.000Z';
const heldE = { id: 'e1', status: 'held', amount_ngn: 15000, on_hold: false };
const refusal = (code) => ({ ok: false, code });

same('release: held becomes released and any pause is lifted',
  nextEarningState('release', { ...heldE, on_hold: true, hold_reason: 'dispute' }, {}, AT),
  { ok: true, patch: { status: 'released', released_at: AT, on_hold: false, hold_reason: '' } });
same('release: a released row cannot be released again', nextEarningState('release', { ...heldE, status: 'released' }, {}, AT), refusal('NOT_HELD'));
same('hold: needs a reason', nextEarningState('hold', heldE, { reason: '  ' }, AT), refusal('REASON_REQUIRED'));
same('hold: pauses with the reason',
  nextEarningState('hold', heldE, { reason: ' Guest disputes the trip ' }, AT),
  { ok: true, patch: { on_hold: true, hold_reason: 'Guest disputes the trip' } });
same('hold: only held pay can be paused', nextEarningState('hold', { ...heldE, status: 'released' }, { reason: 'x' }, AT), refusal('NOT_HELD'));
same('unhold: lifts the pause',
  nextEarningState('unhold', { ...heldE, on_hold: true }, {}, AT), { ok: true, patch: { on_hold: false, hold_reason: '' } });
same('adjust: changes the figure and records why',
  nextEarningState('adjust', heldE, { amount_ngn: 20000.4, reason: 'Two extra hours' }, AT),
  { ok: true, patch: { amount_ngn: 20000, basis: 'manual', rate_ngn: 20000, units: 1, adjustment_reason: 'Two extra hours', adjusted_at: AT } });
same('adjust: zero is allowed', nextEarningState('adjust', heldE, { amount_ngn: 0, reason: 'Driver did not show' }, AT).ok, true);
same('adjust: needs a reason', nextEarningState('adjust', heldE, { amount_ngn: 20000 }, AT), refusal('REASON_REQUIRED'));
for (const bad of [-1, 50000001, NaN, Infinity, '20000', null, undefined]) {
  same(`adjust: an amount of ${JSON.stringify(bad) ?? String(bad)} is refused`,
    nextEarningState('adjust', heldE, { amount_ngn: bad, reason: 'x' }, AT), refusal('INVALID_AMOUNT'));
}
same('adjust: released pay cannot be repriced', nextEarningState('adjust', { ...heldE, status: 'released' }, { amount_ngn: 1, reason: 'x' }, AT), refusal('NOT_HELD'));
same('reverse: held pay is reversed with the reason on record',
  nextEarningState('reverse', heldE, { reason: 'Ride did not happen' }, AT),
  { ok: true, patch: { status: 'reversed', reversed_at: AT, on_hold: false, admin_notes: 'Ride did not happen' } });
same('reverse: released pay can be reversed too, keeping earlier notes',
  nextEarningState('reverse', { ...heldE, status: 'released', admin_notes: 'Reassigned to Ada' }, { reason: 'Paid in error' }, AT),
  { ok: true, patch: { status: 'reversed', reversed_at: AT, on_hold: false, admin_notes: 'Reassigned to Ada | Paid in error' } });
same('reverse: needs a reason', nextEarningState('reverse', heldE, {}, AT), refusal('REASON_REQUIRED'));
for (const action of ['release', 'hold', 'unhold', 'adjust', 'reverse']) {
  same(`${action}: nothing can be done to reversed pay`,
    nextEarningState(action, { ...heldE, status: 'reversed' }, { reason: 'x', amount_ngn: 1 }, AT), refusal('ALREADY_REVERSED'));
}
same('an unknown action is refused', nextEarningState('delete', heldE, { reason: 'x' }, AT), refusal('INVALID_ACTION'));
same('a reason is cut at 500 characters',
  nextEarningState('hold', heldE, { reason: 'x'.repeat(900) }, AT).patch.hold_reason.length, 500);

identical('rideDurationMs', 'tier, days, hours', ['getRideBookings', 'completeRide']);
identical('windowOf', 'r', ['getRideBookings', 'completeRide']);
const completionProblem = make('completionProblem',
  ['HOUR_MS', 'WAT_OFFSET', 'DAY_MS', 'MAX_HOURLY'].map((n) => constLine('completeRide', n)).join(' '),
  liftSrc('completeRide', 'rideDurationMs', 'tier, days, hours'), liftSrc('completeRide', 'windowOf', 'r'),
  liftSrc('completeRide', 'completionProblem', 'ride, nowMs'));
const live = { status: 'confirmed', payment_status: 'paid', start_at: '2026-08-10T08:00:00.000Z', end_at: '2026-08-10T10:00:00.000Z' };
check('a paid ride that has started can be completed', completionProblem(live, at('2026-08-10T08:30:00.000Z')), '');
check('…or one that is already over', completionProblem(live, at('2026-08-11T00:00:00.000Z')), '');
check('a ride that has not started cannot', completionProblem(live, at('2026-08-10T07:59:59.999Z')), 'NOT_STARTED');
check('a ride with no readable time can: this is what admin is for', completionProblem({ status: 'confirmed', payment_status: 'paid' }, FAR), '');
check('an already completed ride says so', completionProblem({ ...live, status: 'completed' }, FAR), 'ALREADY');
check('a cancelled ride cannot be completed', completionProblem({ ...live, status: 'cancelled' }, FAR), 'CANCELLED');
check('an unpaid ride cannot be completed', completionProblem({ ...live, status: 'pending', payment_status: 'unpaid' }, FAR), 'NOT_PAID');

// ── The pay box in the Assign driver dialog ────────────────────────────────
// Decides what the dialog sends. An empty box sends nothing, so the server
// computes the figure and records its real basis rather than "manual".
console.log('\n— assign dialog pay —');
const NOT_SENT = { ok: true, value: undefined };
same('a driver with no login: nothing is sent, whatever is typed', rides.typedDriverPay(false, '15000', 15000), NOT_SENT);
same('empty box with a costing figure: nothing is sent, the server computes it', rides.typedDriverPay(true, '', 15000), NOT_SENT);
same('spaces count as empty', rides.typedDriverPay(true, '   ', 15000), NOT_SENT);
check('empty box and no costing figure: admin is stopped', rides.typedDriverPay(true, '', null).ok, false);
same('a typed figure is sent', rides.typedDriverPay(true, ' 20000 ', 15000), { ok: true, value: 20000 });
same('zero is a real answer', rides.typedDriverPay(true, '0', null), { ok: true, value: 0 });
same('kobo are rounded', rides.typedDriverPay(true, '20000.4', null), { ok: true, value: 20000 });
for (const bad of ['25,000', '-5', '1e3', 'abc', '99999999999', '50000001']) {
  check(`"${bad}" is stopped before it is sent`, rides.typedDriverPay(true, bad, 15000).ok, false);
}
check('the ceiling itself can be typed', rides.typedDriverPay(true, '50000000', null).value, 50000000);

// ── Per-driver summaries for admin ─────────────────────────────────────────
console.log('\n— admin earnings summary —');
const SUMMARY_HOME = 'getDriverEarningsAdmin';
identical('driverEmails', 'driver', [WALLET_HOME, SUMMARY_HOME]);
identical('driverWithdrawals', 'driver, rows', [WALLET_HOME, SUMMARY_HOME]);
identical('walletTotals', 'earnings, withdrawals', [WALLET_HOME, SUMMARY_HOME]);
const SUMMARY_SIG = 'drivers, earnings, withdrawals';
const driverWalletSummaries = make('driverWalletSummaries',
  liftSrc(SUMMARY_HOME, 'driverEmails', 'driver'),
  liftSrc(SUMMARY_HOME, 'driverWithdrawals', 'driver, rows'),
  liftSrc(SUMMARY_HOME, 'walletTotals', 'earnings, withdrawals'),
  liftSrc(SUMMARY_HOME, 'driverWalletSummaries', SUMMARY_SIG));
{
  const drivers = [
    { id: 'drvA', full_name: 'Emeka', user_email: 'emeka@work.ng' },
    { id: 'drvB', full_name: 'Ada', user_email: '' },
    { id: 'drvC', full_name: 'Idle', user_email: 'idle@x.ng' },
  ];
  const earnings = [
    { driver_id: 'drvA', status: 'held', amount_ngn: 15000 },
    { driver_id: 'drvA', status: 'released', amount_ngn: 30000 },
    { driver_id: 'drvB', status: 'reversed', amount_ngn: 10000 },
    { driver_id: 'gone', status: 'held', amount_ngn: 99999 },
  ];
  const withdrawals = [
    { wallet: 'driver', driver_id: 'drvA', user_email: 'emeka@work.ng', amount: 10000, status: 'completed' },
    { wallet: 'driver', driver_id: 'drvA', user_email: 'mallory@evil.ng', amount: 20000, status: 'completed' },
    { wallet: 'referral', driver_id: 'drvA', user_email: 'emeka@work.ng', amount: 5000, status: 'completed' },
  ];
  const out = driverWalletSummaries(drivers, earnings, withdrawals);
  same('one line per driver who has pay on record, most owed first', out.map((s) => s.driver_id), ['drvA', 'drvB']);
  same('the line is the driver wallet arithmetic', out[0],
    { driver_id: 'drvA', full_name: 'Emeka', has_login: true, held: 15000, available: 20000, paid_out: 10000, reserved: 0, shortfall: 0 });
  check('a driver with no login is marked', out[1].has_login, false);
}
{
  // A driver who withdrew pay that was later reversed sorts to the top.
  const drivers = [
    { id: 'drvA', full_name: 'Emeka', user_email: 'emeka@work.ng' },
    { id: 'drvB', full_name: 'Ada', user_email: 'ada@x.ng' },
  ];
  const out = driverWalletSummaries(drivers,
    [{ driver_id: 'drvA', status: 'held', amount_ngn: 900000 }, { driver_id: 'drvB', status: 'reversed', amount_ngn: 10000 }],
    [{ wallet: 'driver', driver_id: 'drvB', user_email: 'ada@x.ng', amount: 10000, status: 'completed' }]);
  same('a shortfall sorts first, whatever else is owed', out.map((s) => `${s.driver_id}:${s.shortfall}`), ['drvB:10000', 'drvA:0']);
}
same('no drivers, no lines', driverWalletSummaries([], [], []), []);
same('nothing at all, no lines', driverWalletSummaries(undefined, undefined, undefined), []);

// ── The admin overview uses the same arithmetic ────────────────────────────
console.log('\n— admin overview —');
identical('driverEmails', 'driver', [WALLET_HOME, 'getDashboardStats']);
identical('driverWithdrawals', 'driver, rows', [WALLET_HOME, 'getDashboardStats']);
identical('walletTotals', 'earnings, withdrawals', [WALLET_HOME, 'getDashboardStats']);
identical('driverWalletSummaries', SUMMARY_SIG, [SUMMARY_HOME, 'getDashboardStats']);

// ── Payouts: sent once, never stuck, always on the ledger ──────────────────
console.log('\n— payout safety —');
const PW = 'processWithdrawal';
const pw = (name, signature) => liftSrc(PW, name, signature);
const isId = make('isId', pw('isId', 'value'));
check('a row id is an id', isId('6a431f7ed4c9964e10f5a1b3'), true);
// entity.get(id) is a GET on …/<id>. Each of these would fetch a row other
// than the one every equality check in the function is looking at.
for (const bad of ['6a431f7ed4c9964e10f5a1b3#', '6a431f7ed4c9964e10f5a1b3?x=1', '../User/6a431f7ed4c9964e10f5a1b3', 'a/b', 'a b', '', 'x'.repeat(65), 42, null, undefined, { $ne: '' }]) {
  check(`${JSON.stringify(bad) ?? String(bad)} is not an id`, isId(bad), false);
}
identical('isId', 'value', [PW, 'createWithdrawalRequest']);

// A real driver forges a row for far more than they earned and appends "#"
// to their own id. get() drops the "#" and returns their driver row; before
// this fix the request then went missing from its own ledger check.
{
  const sr = bank([request({ amount: 2000000, driver_id: 'drvA#' })], [releasedRow('e1', 20000)]);
  const realGet = sr.Driver.get;
  sr.Driver.get = (id) => realGet(String(id).split('#')[0].split('?')[0]);
  check('a driver id with "#" on the end is refused',
    await driverWithdrawalProblem(sr, request({ amount: 2000000, driver_id: 'drvA#' })), 'This request names no driver.');
}
{
  // Whatever get() returns, it must be the row the request names.
  const sr = bank([request({ driver_id: 'drvZ' })], [releasedRow('e1', 20000)]);
  sr.Driver.get = async () => ({ id: 'drvA', user_email: 'emeka@work.ng' });
  check('a lookup that answers with a different driver is refused',
    await driverWithdrawalProblem(sr, request({ driver_id: 'drvZ' })), 'This request names no driver.');
}
{
  // The request must be one of the rows the arithmetic counts.
  const sr = bank([], [releasedRow('e1', 20000)]);
  check('a request that is not on the driver\'s ledger is refused',
    await driverWithdrawalProblem(sr, request()), 'This request is not on the driver\'s ledger.');
}

const transferReferenceFor = make('transferReferenceFor', pw('transferReferenceFor', 'withdrawalId'));
const ROW_ID = '6a431f7ed4c9964e10f5a1b3';
const REF = transferReferenceFor(ROW_ID);
check('one withdrawal, one reference, every time', REF, transferReferenceFor(ROW_ID.toUpperCase()));
check('…in the form Paystack accepts', /^[a-z0-9_-]{16,50}$/.test(REF), true);
check('…and never shared between withdrawals', REF === transferReferenceFor('6a431f7ed4c9964e10f5a1b4'), false);
const withdrawalIdFromReference = make('withdrawalIdFromReference',
  liftSrc('paystackTransferWebhook', 'withdrawalIdFromReference', 'reference'));
check('the webhook can get the row id back out of it', withdrawalIdFromReference(REF), ROW_ID);
check('an old-style reference names no row', withdrawalIdFromReference('WD-6a431f7e-1760000000000'), null);
check('…nor does it if it comes back in lower case', withdrawalIdFromReference('wd-6a431f7e-1760000000000'), null);
check('…and nothing but a row id after wd- does', withdrawalIdFromReference('wd-../User/6a431f7ed4c9964e10f5a1b3'), null);
check('no reference names no row', withdrawalIdFromReference(undefined), null);

const canSend = make('canSend', pw('canSend', 'withdrawal'));
check('a pending row can be sent', canSend({ status: 'pending' }), true);
check('a row marked processing that never got a transfer code can be retried', canSend({ status: 'processing' }), true);
check('a row Paystack has acknowledged cannot be sent again', canSend({ status: 'processing', transfer_code: 'TRF_1' }), false);
for (const status of ['completed', 'failed', 'reversed']) {
  check(`a ${status} row cannot be sent`, canSend({ status }), false);
}
check('no row cannot be sent', canSend(null), false);

const bankBelongsTo = make('bankBelongsTo', pw('bankBelongsTo', 'bankAccount, withdrawal'));
check('the requester\'s own account', bankBelongsTo({ user_email: 'ada@mail.ng' }, { user_email: 'Ada@Mail.ng ' }), true);
check('someone else\'s account', bankBelongsTo({ user_email: 'ada@mail.ng' }, { user_email: 'mallory@evil.ng' }), false);
check('an account with no owner belongs to nobody', bankBelongsTo({}, { user_email: '' }), false);

// What Paystack holds for a reference. A transfer, null for a definite
// "nothing", undefined for "could not tell". Only null may lead to a refund.
const lookupFromResponse = make('lookupFromResponse', pw('lookupFromResponse', 'httpStatus, body'));
check('a transfer that exists',
  lookupFromResponse(200, { status: true, data: { transfer_code: 'TRF_1', status: 'success' } })?.transfer_code, 'TRF_1');
check('"Transfer not found" is a definite nothing', lookupFromResponse(404, { status: false, message: 'Transfer not found' }), null);
check('…whichever 4xx carries it', lookupFromResponse(400, { status: false, message: 'Transfer not found' }), null);
for (const http of [0, 401, 403, 408, 429, 500, 502, 503]) {
  check(`HTTP ${http} says nothing about whether the transfer exists`, lookupFromResponse(http, { status: false }), undefined);
}
check('a 200 with no transfer in it says nothing either', lookupFromResponse(200, { status: true, data: {} }), undefined);
check('…nor does a 200 that was not JSON', lookupFromResponse(200, null), undefined);

const refusalMessage = make('refusalMessage', pw('refusalMessage', 'httpStatus, body, fallback'));
check('a refusal carries Paystack\'s reason',
  refusalMessage(400, { status: false, message: 'Your balance is not enough to fulfil this request' }, 'x'),
  'Your balance is not enough to fulfil this request');
check('…or the fallback when it gave none', refusalMessage(400, { status: false }, 'Transfer initiation failed'), 'Transfer initiation failed');
for (const http of [0, 200, 408, 429, 500, 503]) {
  check(`HTTP ${http} is no answer, not a refusal`, refusalMessage(http, { message: 'x' }, 'y'), null);
}
check('a 400 that was not JSON is no answer', refusalMessage(400, null, 'y'), null);

// What to do after asking Paystack to send.
const transferOutcome = make('transferOutcome', pw('transferOutcome', 'accepted, message, lookup'));
check('accepted: sent', transferOutcome(true, '', null), 'sent');
check('refused, but Paystack already holds this transfer: someone else sent it first',
  transferOutcome(false, 'Please provide a unique reference. Reference already exists on a transfer', { transfer_code: 'TRF_1' }), 'already_sent');
check('refused for a stated reason and nothing is held: failed, so a referral is refunded',
  transferOutcome(false, 'Your balance is not enough to fulfil this request', null), 'failed');
// The cases where refunding would be a guess. A wrong guess pays twice.
check('refused, and Paystack could not be asked: do not refund', transferOutcome(false, 'Invalid key', undefined), 'unconfirmed');
check('no answer, and nothing held yet: do not refund', transferOutcome(false, null, null), 'unconfirmed');
check('refused over the reference but nothing found: do not refund',
  transferOutcome(false, 'Please provide a unique reference. Reference already exists on a transfer', null), 'unconfirmed');

const rowStatusFor = make('rowStatusFor', pw('rowStatusFor', 'transferStatus'));
check('a transfer the bank paid', rowStatusFor('success'), 'completed');
check('a transfer the bank refused', rowStatusFor('failed'), 'failed');
check('a transfer the bank sent back', rowStatusFor('reversed'), 'reversed');
for (const status of ['pending', 'processing', 'queued', 'otp', 'received', '', undefined]) {
  check(`a transfer that is ${JSON.stringify(status)} is not settled`, rowStatusFor(status), '');
}

// A stand-in for Paystack that keeps the one promise the fix relies on: it
// never holds two transfers with the same reference.
function fakePaystack(opts = {}) {
  const transfers = new Map();
  const calls = { find: 0, recipient: 0, send: 0 };
  return {
    transfers,
    calls,
    async find(reference) {
      calls.find += 1;
      if (opts.cannotAsk) return undefined;
      // The other call's transfer landed just after this look.
      if (opts.staleFirstFind && calls.find === 1) return null;
      return transfers.get(reference) || null;
    },
    async createRecipient() {
      calls.recipient += 1;
      if (opts.recipientRefusal !== undefined) return { ok: false, message: opts.recipientRefusal, details: null };
      return { ok: true, code: 'RCP_1' };
    },
    async send(payload) {
      calls.send += 1;
      if (transfers.has(payload.reference)) {
        // Paystack's documented answer to a repeated reference is a refusal.
        // duplicateAnswers2xx is the other possibility: a 2xx carrying the
        // transfer it already holds.
        if (opts.duplicateAnswers2xx) return { ok: true, transfer: transfers.get(payload.reference) };
        return { ok: false, message: 'Please provide a unique reference. Reference already exists on a transfer', details: null };
      }
      // refusal: a string is Paystack's stated reason; null is no answer at all.
      // refuseFirst: the same, for the first send it is asked for and no other.
      if (opts.refusal !== undefined) return { ok: false, message: opts.refusal, details: { message: opts.refusal } };
      if (opts.refuseFirst !== undefined && calls.send === 1) {
        return { ok: false, message: opts.refuseFirst, details: { message: opts.refuseFirst } };
      }
      const transfer = {
        id: 900 + transfers.size, transfer_code: `TRF_${transfers.size + 1}`, status: opts.sendStatus || 'pending',
        amount: payload.amount, reference: payload.reference, recipient: payload.recipient,
      };
      transfers.set(payload.reference, transfer);
      // Paystack took the transfer, and its answer was lost on the way back.
      if (opts.answerLost) return { ok: false, message: null, details: null };
      return { ok: true, transfer };
    },
  };
}
const PAYOUT = [
  constLine(PW, 'WITHDRAWAL_THRESHOLD_NGN'), constLine(PW, 'STALE_ATTEMPT_MS'), FETCH_ALL,
  pw('isId', 'value'), pw('getOrNull', 'entity, id'), pw('driverEmails', 'driver'), pw('driverWithdrawals', 'driver, rows'),
  pw('walletTotals', 'earnings, withdrawals'), pw('refundsToBalance', 'withdrawal'),
  pw('debitOnRecord', 'entries, withdrawal'), pw('madeRecently', 'entry, nowIso'),
  pw('attemptBlocksRefund', 'entry, nowIso'), pw('claimIsLive', 'entry, nowIso'),
  pw('transferReferenceFor', 'withdrawalId'), pw('canSend', 'withdrawal'), pw('canRecheck', 'withdrawal'),
  pw('canCredit', 'withdrawal'), pw('bankBelongsTo', 'bankAccount, withdrawal'),
  pw('transferOutcome', 'accepted, message, lookup'), pw('rowStatusFor', 'transferStatus'),
  pw('driverWithdrawalProblem', 'sr, w'), pw('refundReferralOnce', 'sr, withdrawal, nowIso, unsent'),
  pw('sendWithdrawal', 'sr, paystack, withdrawalId, allowUnrecorded, nowIso'),
];
// The shipped function is handed an id and reads the row itself. The checks
// below were written around a row object, so this passes its id along.
const sendWithdrawalById = make('sendWithdrawal', ...PAYOUT);
const sendWithdrawal = (sr, paystack, row, nowIso, allowUnrecorded = false) =>
  sendWithdrawalById(sr, paystack, row.id, allowUnrecorded, nowIso);
const refundReferralOnce = make('refundReferralOnce', ...PAYOUT);
const SENT_AT = '2026-08-10T12:00:00.000Z';
const minutesBefore = (m) => new Date(Date.parse(SENT_AT) - m * 60000).toISOString();
const referralRow = (extra = {}) => ({
  id: ROW_ID, wallet: 'referral', user_email: 'ada@mail.ng', amount: 15000, status: 'pending', bank_account_id: 'bank1', ...extra,
});
const driverRow = (extra = {}) => request({ bank_account_id: 'bank1', ...extra });
// What createWithdrawalRequest writes when it takes a referral amount off the balance.
const debitFor = (row) => ({
  id: 'debit1', created_date: minutesBefore(60), kind: 'debit', state: 'recorded',
  withdrawal_request_id: row.id, user_email: row.user_email, amount_ngn: row.amount,
});
// Everything a payout reads and writes. The person asking starts with ₦5,000
// of referral balance, so a credit back shows as 5,000 + the amount. A
// referral request made through the app has its debit on record; pass
// ledger: [] for one that has not. Ledger rows made during a check are
// stamped in the two minutes before SENT_AT, so they count as recent.
const payWorld = (row, extra = {}) => ({
  WithdrawalRequest: fakeEntity([row]),
  UserBankAccount: fakeEntity([{
    id: 'bank1', user_email: row.user_email, account_name: 'Ada Obi', account_number: '0123456789', bank_code: '058',
    recipient_code: 'RCP_0', ...(extra.bank || {}),
  }]),
  User: fakeEntity([{ id: 'u1', email: row.user_email, referral_balance_ngn: 5000 }]),
  Driver: fakeEntity([{ id: 'drvA', user_email: 'emeka@work.ng', previous_user_emails: [] }]),
  DriverEarning: fakeEntity(extra.earnings || []),
  WithdrawalLedger: fakeEntity(extra.ledger || (row.wallet === 'driver' ? [] : [debitFor(row)]), Date.parse(SENT_AT) - 120000),
});
const rowOf = (sr) => sr.WithdrawalRequest.rows[0];
const balanceOf = (sr) => sr.User.rows[0].referral_balance_ngn;

{
  const sr = payWorld(referralRow());
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a pending withdrawal is sent', r.status === 200 && r.body.success === true && !r.body.already_sent, true);
  check('…as one transfer', ps.transfers.size, 1);
  check('…for the amount in kobo', ps.transfers.get(REF)?.amount, 1500000);
  check('…to the account\'s recipient', ps.transfers.get(REF)?.recipient, 'RCP_0');
  check('…and the row is processing', rowOf(sr).status, 'processing');
  check('…carrying its reference', rowOf(sr).transfer_reference, REF);
  check('…and Paystack\'s transfer code', rowOf(sr).transfer_code, 'TRF_1');
}
{
  // The finding. Both calls read the row while it was still pending.
  const sr = payWorld(referralRow());
  const ps = fakePaystack();
  const [a, b] = await Promise.all([
    sendWithdrawal(sr, ps, referralRow(), SENT_AT),
    sendWithdrawal(sr, ps, referralRow(), SENT_AT),
  ]);
  check('two calls at the same moment: one transfer', ps.transfers.size, 1);
  check('…both asked Paystack to send, and the reference stopped the second', ps.calls.send, 2);
  check('…one is told it had already been sent', [a, b].filter((r) => r.body.already_sent).length, 1);
  check('…neither is told it failed', [a, b].every((r) => r.status === 200 && r.body.success === true), true);
  check('…the row is processing with the transfer code', `${rowOf(sr).status}/${rowOf(sr).transfer_code}`, 'processing/TRF_1');
  check('…and nobody was refunded', balanceOf(sr), 5000);
}
{
  const sr = payWorld(referralRow());
  const ps = fakePaystack();
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  // A second tab that loaded the list before the first press.
  const again = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a second press from a stale tab asks first, and sends nothing', ps.calls.send, 1);
  check('…and says so', again.body.already_sent, true);
}
{
  const sr = payWorld(referralRow());
  const ps = fakePaystack({ answerLost: true });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('Paystack took the transfer but its answer was lost: found by reference', r.body.already_sent, true);
  check('…the row has the transfer code', rowOf(sr).transfer_code, 'TRF_1');
  check('…and nobody was refunded', balanceOf(sr), 5000);
}
{
  const sr = payWorld(referralRow());
  const r = await sendWithdrawal(sr, fakePaystack({ refusal: null }), referralRow(), SENT_AT);
  check('no answer from Paystack: not confirmed', `${r.status}/${r.body.code}`, '502/UNCONFIRMED');
  check('…the row waits as processing, with its reference and no transfer code',
    `${rowOf(sr).status}/${rowOf(sr).transfer_reference}/${rowOf(sr).transfer_code || ''}`, `processing/${REF}/`);
  check('…which is the state admin can retry', canSend(rowOf(sr)), true);
  check('…and nobody was refunded', balanceOf(sr), 5000);
  const ps = fakePaystack();
  const retry = await sendWithdrawal(sr, ps, { ...rowOf(sr) }, SENT_AT);
  check('the retry sends it, once', `${retry.body.success}/${ps.transfers.size}`, 'true/1');
}
{
  const sr = payWorld(referralRow());
  const ps = fakePaystack({ cannotAsk: true });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('Paystack cannot be asked what it holds: nothing is sent', `${r.body.code}/${ps.calls.send}`, 'UNCONFIRMED/0');
  check('…and the row is left as it was', rowOf(sr).status, 'pending');
}
{
  const sr = payWorld(referralRow());
  const r = await sendWithdrawal(sr, fakePaystack({ refusal: 'Your balance is not enough to fulfil this request' }), referralRow(), SENT_AT);
  check('refused by Paystack for a stated reason: failed', `${r.status}/${rowOf(sr).status}`, '400/failed');
  check('…with the reason on the row', rowOf(sr).error_message, 'Your balance is not enough to fulfil this request');
  check('…and in the answer admin sees', `${r.body.error}: ${r.body.details?.message}`, 'Transfer failed: Your balance is not enough to fulfil this request');
  check('…a referral withdrawal is credited back', balanceOf(sr), 20000);
  check('…and stamped', rowOf(sr).refunded_at, SENT_AT);
  check('a second refund attempt credits nothing',
    `${await refundReferralOnce(sr, { ...rowOf(sr) }, SENT_AT, true)}/${balanceOf(sr)}`, 'already/20000');
}
{
  const sr = payWorld(driverRow(), { earnings: [releasedRow('e1', 20000)] });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, driverRow(), SENT_AT);
  check('a driver-wallet request the ledger covers is sent', `${r.body.success}/${ps.transfers.size}`, 'true/1');
}
{
  const sr = payWorld(driverRow(), { earnings: [releasedRow('e1', 20000)] });
  await sendWithdrawal(sr, fakePaystack({ refusal: 'Your balance is not enough to fulfil this request' }), driverRow(), SENT_AT);
  check('a refused driver-wallet payout is failed', rowOf(sr).status, 'failed');
  check('…and credits no referral cash: failing the row is its refund', balanceOf(sr), 5000);
}
{
  const sr = payWorld(driverRow({ amount: 500000 }), { earnings: [releasedRow('e1', 20000)] });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, driverRow({ amount: 500000 }), SENT_AT);
  check('a driver-wallet request the ledger does not cover is closed', `${r.status}/${r.body.code}/${rowOf(sr).status}`, '409/NOT_COVERED/failed');
  check('…and nothing is sent', ps.calls.send, 0);
}
{
  // Stuck as processing, the pay behind it reversed since, and the first
  // attempt DID reach the bank. Failing the row here would free the money
  // to be withdrawn a second time.
  const stuck = driverRow({ status: 'processing' });
  const sr = payWorld(stuck, { earnings: [] });
  const ps = fakePaystack();
  ps.transfers.set(transferReferenceFor(stuck.id), { id: 8, transfer_code: 'TRF_8', status: 'pending' });
  await sendWithdrawal(sr, ps, stuck, SENT_AT);
  check('a payout that already went out is never failed, whatever the ledger says now',
    `${rowOf(sr).status}/${rowOf(sr).transfer_code}`, 'processing/TRF_8');
}
{
  const sr = payWorld(referralRow({ status: 'processing' }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  const r = await sendWithdrawal(sr, ps, referralRow({ status: 'processing' }), SENT_AT);
  check('a stuck row whose transfer the bank has paid is completed by Retry',
    `${rowOf(sr).status}/${rowOf(sr).transfer_code}/${r.body.status}`, 'completed/TRF_7/completed');
  check('…and nothing is sent', ps.calls.send, 0);
}
{
  const sr = payWorld(referralRow({ status: 'processing' }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'failed' });
  await sendWithdrawal(sr, ps, referralRow({ status: 'processing' }), SENT_AT);
  check('a stuck row whose transfer the bank refused is failed and credited back',
    `${rowOf(sr).status}/${balanceOf(sr)}`, 'failed/20000');
}
{
  const sr = payWorld(referralRow(), { bank: { user_email: 'someone@else.ng' } });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a request naming someone else\'s bank account is not sent', `${r.status}/${r.body.code}/${ps.calls.send}`, '409/BANK_MISMATCH/0');
  check('…and is left exactly as it was, for a person to look at', `${rowOf(sr).status}/${balanceOf(sr)}`, 'pending/5000');
}
{
  const sr = payWorld(referralRow({ bank_account_id: 'bank1#' }));
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow({ bank_account_id: 'bank1#' }), SENT_AT);
  check('a bank account id that is not a plain id is never looked up', `${r.status}/${r.body.code}/${ps.calls.send}`, '404/NO_BANK/0');
}
{
  const sr = payWorld(referralRow(), { bank: { recipient_code: '' } });
  const ps = fakePaystack();
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a first payout to an account creates its Paystack recipient', sr.UserBankAccount.rows[0].recipient_code, 'RCP_1');
  check('…and sends to it', ps.transfers.get(REF)?.recipient, 'RCP_1');
}
{
  const sr = payWorld(referralRow(), { bank: { recipient_code: '' } });
  const ps = fakePaystack({ recipientRefusal: 'Account number is invalid' });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('an account Paystack will not accept: failed and credited back',
    `${r.body.error}/${rowOf(sr).status}/${balanceOf(sr)}/${ps.calls.send}`, 'Failed to create transfer recipient/failed/20000/0');
}
{
  const sr = payWorld(referralRow(), { bank: { recipient_code: '' } });
  const r = await sendWithdrawal(sr, fakePaystack({ recipientRefusal: null }), referralRow(), SENT_AT);
  check('no answer while creating the recipient: not confirmed, not refunded',
    `${r.body.code}/${rowOf(sr).status}/${balanceOf(sr)}`, 'UNCONFIRMED/processing/5000');
}

{
  // The settlement webhook got there first: the row is already completed.
  const sr = payWorld(referralRow({ status: 'completed', transfer_code: 'TRF_7', transfer_reference: REF }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a completed row is not touched and nothing is sent',
    `${rowOf(sr).status}/${r.body.code}/${ps.calls.send}`, 'completed/NOT_SENDABLE/0');
}
{
  const sr = payWorld(referralRow({ status: 'reversed', transfer_code: 'TRF_7', refunded_at: SENT_AT }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('…nor is a row the bank reversed', `${rowOf(sr).status}/${balanceOf(sr)}`, 'reversed/5000');
}

// ── Every order two calls could run in ─────────────────────────────────────
// Nothing on the platform locks a row, so two calls interleave at every
// database or Paystack request. Each request is one step here, and a schedule
// says whose step runs next. everySchedule walks all of them, each against a
// fresh world. Task R02 uses the same walker for assignments.
const viaGate = (target, gate, ops) => {
  const view = { ...target };
  for (const op of ops) view[op] = async (...args) => { await gate(); return target[op](...args); };
  return view;
};
const gatedWorld = (world, gate) => Object.fromEntries(Object.entries(world)
  .map(([name, entity]) => [name, viaGate(entity, gate, ['filter', 'create', 'update', 'get'])]));

// Run the actors to the end, with `choose` picking whose step goes next.
async function interleave(actors, choose) {
  const pending = actors.map(() => null);
  const done = actors.map(() => false);
  const results = actors.map(() => undefined);
  let wake = () => {};
  const parked = () => pending.every((p, i) => p || done[i]);
  const sleep = () => new Promise((r) => { wake = r; });
  actors.forEach((run, i) => {
    const gate = () => new Promise((go) => { pending[i] = go; wake(); });
    Promise.resolve().then(() => run(gate)).then(
      (r) => { results[i] = r; },
      (e) => { results[i] = { threw: String((e && e.message) || e) }; },
    ).then(() => { done[i] = true; wake(); });
  });
  for (;;) {
    // Wait until every actor is parked at a step or has finished.
    while (!parked()) await sleep();
    const ready = pending.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    if (ready.length === 0) return results;
    const pick = choose(ready);
    const go = pending[pick];
    pending[pick] = null;
    go();
  }
}

// Depth-first over schedules. `maxSwitches` bounds how often the turn may pass
// to another actor while the current one could still go on; Infinity walks
// every schedule there is. setup() answers { world, actors }, where an actor
// is (gate) => promise. Answers { runs, problem, schedule }.
async function everySchedule(setup, verdict, maxSwitches = Infinity) {
  const stack = [[]];
  let runs = 0;
  while (stack.length > 0) {
    const prefix = stack.pop();
    const decisions = [];
    let last = -1;
    let switches = 0;
    const { world, actors } = setup();
    const results = await interleave(actors, (ready) => {
      if (ready.length === 1) { [last] = ready; return last; }
      const stay = ready.includes(last) ? last : -1;
      const i = decisions.length;
      const pick = i < prefix.length ? prefix[i] : (stay >= 0 ? stay : ready[0]);
      decisions.push({ ready, stay, pick, switches });
      if (stay >= 0 && pick !== stay) switches += 1;
      last = pick;
      return pick;
    });
    // Every decision made past the prefix has siblings nobody has tried yet.
    for (let i = prefix.length; i < decisions.length; i += 1) {
      const d = decisions[i];
      for (const alt of d.ready) {
        if (alt === d.pick) continue;
        const cost = d.stay >= 0 && alt !== d.stay ? 1 : 0;
        if (d.switches + cost <= maxSwitches) stack.push([...decisions.slice(0, i).map((x) => x.pick), alt]);
      }
    }
    runs += 1;
    const problem = await verdict(world, results);
    if (problem) return { runs, problem, schedule: decisions.map((d) => d.pick).join('') };
  }
  return { runs, problem: '', schedule: '' };
}

// Two presses on one withdrawal, in every order their requests could arrive.
const twoPresses = (row, extra) => () => {
  const sr = payWorld(row, extra);
  const ps = fakePaystack();
  const press = (gate) => sendWithdrawal(
    gatedWorld(sr, gate), viaGate(ps, gate, ['find', 'createRecipient', 'send']), { ...row }, SENT_AT);
  return { world: { sr, ps }, actors: [press, press] };
};
const oneTransfer = ({ sr, ps }, results) => {
  if (ps.transfers.size !== 1) return `${ps.transfers.size} transfers left the account`;
  if (results.some((r) => !r || r.status !== 200 || r.body.success !== true)) {
    return `a press was told ${JSON.stringify(results.map((r) => (r && r.body ? r.body.code || r.status : r)))}`;
  }
  if (rowOf(sr).status !== 'processing' || rowOf(sr).transfer_code !== 'TRF_1') {
    return `the row ended ${rowOf(sr).status}/${rowOf(sr).transfer_code}`;
  }
  if (balanceOf(sr) !== 5000) return `the referral balance ended at ${balanceOf(sr)}`;
  return '';
};
{
  const out = await everySchedule(twoPresses(referralRow()), oneTransfer, 3);
  check(`two presses at once (${out.runs} orders): one transfer, both told the truth, no refund`, `${out.problem}${out.schedule}`, '');
  const more = await randomSchedules(twoPresses(referralRow()), oneTransfer, 1000, 10);
  check(`…and in ${more.runs} random orders with no limit on changes of turn`, `${more.problem}${more.schedule}`, '');
  check('…and that was more than one order', out.runs > 100, true);
}
{
  const out = await everySchedule(twoPresses(referralRow(), { bank: { recipient_code: '' } }), oneTransfer, 3);
  check(`…the same when the account has no Paystack recipient yet (${out.runs})`, `${out.problem}${out.schedule}`, '');
}
{
  // A driver-wallet payout reads the ledger first, so each press has more
  // steps. Every order in which the turn changes hands at most four times.
  const out = await everySchedule(twoPresses(driverRow(), { earnings: [releasedRow('e1', 20000)] }), oneTransfer, 4);
  check(`…and for a driver-wallet payout (${out.runs})`, `${out.problem}${out.schedule}`, '');
}

const webhookShouldAct = make('webhookShouldAct', liftSrc('paystackTransferWebhook', 'webhookShouldAct', 'eventName, row'));
const inState = (status) => ({ id: ROW_ID, status });
check('success on a processing row', webhookShouldAct('transfer.success', inState('processing')), true);
check('failure on a processing row', webhookShouldAct('transfer.failed', inState('processing')), true);
check('a second success on a completed row is ignored', webhookShouldAct('transfer.success', inState('completed')), false);
check('a second failure on a failed row is ignored', webhookShouldAct('transfer.failed', inState('failed')), false);
// The bank sent the money back after the transfer had succeeded.
check('a reversal after success is acted on', webhookShouldAct('transfer.reversed', inState('completed')), true);
check('a second reversal is ignored', webhookShouldAct('transfer.reversed', inState('reversed')), false);
check('nothing acts on a pending row', webhookShouldAct('transfer.success', inState('pending')), false);
// A second press that lost a race wrote "failed" on a stale reading, and the
// transfer it lost to went out.
check('a success for a row marked failed is acted on: the money left', webhookShouldAct('transfer.success', inState('failed')), true);
check('a failure for a completed row is not', webhookShouldAct('transfer.failed', inState('completed')), false);
check('no row, nothing to do', webhookShouldAct('transfer.success', null), false);

// ── Assignment: two at once, the same driver again, and at rollout ─────────
console.log('\n— assignment under concurrency —');
const AR = 'assignRideDriver';
const ar = (name, signature) => liftSrc(AR, name, signature);
identical('isId', 'value', [PW, AR]);
identical('isRideBlocked', 'account', ['checkRideAvailability', AR]);
identical('busyWindow', 'ride, w', [AR, 'checkRideAvailability']);

const guestIsBlocked = make('guestIsBlocked', ar('isRideBlocked', 'account'), ar('guestIsBlocked', 'accounts, email'));
check('a blocked guest is blocked', guestIsBlocked([{ email: 'tunde@mail.ng', ride_blocked: true }], 'Tunde@Mail.ng'), true);
check('a guest who is not blocked is not', guestIsBlocked([{ email: 'tunde@mail.ng', ride_blocked: false }], 'tunde@mail.ng'), false);
check('the word "true" does not block', guestIsBlocked([{ email: 'tunde@mail.ng', ride_blocked: 'true' }], 'tunde@mail.ng'), false);
// A ride row with no guest email makes the lookup answer with whoever comes first.
check('a ride with no guest email matches nobody', guestIsBlocked([{ email: 'someone@else.ng', ride_blocked: true }], ''), false);
check('…and another account that happens to be blocked is not this guest',
  guestIsBlocked([{ email: 'someone@else.ng', ride_blocked: true }], 'tunde@mail.ng'), false);

// A ride keeps its driver and its car busy for its booked window. One that
// was completed early frees them from that moment.
const busyWindow = make('busyWindow', ar('busyWindow', 'ride, w'));
const windowsOverlap = make('windowsOverlap', ar('windowsOverlap', 'aStart, aEnd, bStart, bEnd, buffer'));
const W = { startMs: at('2026-08-10T08:00:00.000Z'), endMs: at('2026-08-10T16:00:00.000Z') };
same('a confirmed ride is busy for its whole booked window', busyWindow({ status: 'confirmed' }, W), W);
same('a ride the sweep completed at its end: the whole window',
  busyWindow({ status: 'completed', completed_at: '2026-08-10T16:05:00.000Z' }, W), W);
same('a ride admin completed early: until that moment',
  busyWindow({ status: 'completed', completed_at: '2026-08-10T11:00:00.000Z' }, W), { startMs: W.startMs, endMs: at('2026-08-10T11:00:00.000Z') });
same('a completed ride with no completion time keeps its whole window', busyWindow({ status: 'completed' }, W), W);
same('a completion stamped before the start cannot make a window run backwards',
  busyWindow({ status: 'completed', completed_at: '2026-08-10T07:00:00.000Z' }, W), { startMs: W.startMs, endMs: W.startMs });
check('a ride with no readable time has no window', busyWindow({ status: 'completed' }, null), null);
// The same thing as the functions use it, with the default one-hour turnaround.
const clashes = (ride, startIso, endIso) => {
  const b = busyWindow(ride, W);
  return windowsOverlap(at(startIso), at(endIso), b.startMs, b.endMs, 3600000);
};
const sweptAtEnd = { status: 'completed', completed_at: '2026-08-10T16:00:30.000Z' };
check('closed by the sweep at 16:00: a 16:30 pickup is still inside the turnaround',
  clashes(sweptAtEnd, '2026-08-10T16:30:00.000Z', '2026-08-10T18:30:00.000Z'), true);
check('…and a 17:00 pickup is clear', clashes(sweptAtEnd, '2026-08-10T17:00:00.000Z', '2026-08-10T19:00:00.000Z'), false);
const doneEarly = { status: 'completed', completed_at: '2026-08-10T11:00:00.000Z' };
check('completed early at 11:00: free for a 12:30 pickup',
  clashes(doneEarly, '2026-08-10T12:30:00.000Z', '2026-08-10T14:30:00.000Z'), false);
check('…which the booked window alone would have refused',
  clashes({ status: 'confirmed' }, '2026-08-10T12:30:00.000Z', '2026-08-10T14:30:00.000Z'), true);

const assignmentNotices = make('assignmentNotices', ar('assignmentNotices', 'sameDriver, rideOver, payIsNew'));
same('a new driver for a ride still to come: guest and driver are told',
  assignmentNotices(false, false, true), { guest: true, driver: 'assigned' });
same('the same driver again: the guest is not told twice, the driver hears about the pay',
  assignmentNotices(true, false, true), { guest: false, driver: 'pay' });
same('the same driver again with nothing new: nobody is told', assignmentNotices(true, false, false), { guest: false, driver: '' });
same('a driver attached after the ride is over: the guest is not told someone is coming',
  assignmentNotices(false, true, true), { guest: false, driver: 'pay' });
same('…and with no pay recorded, nobody is told', assignmentNotices(false, true, false), { guest: false, driver: '' });

const ASSIGN = [
  PAY, FETCH_ALL, constLine(AR, 'MAX_REALIGN_PASSES'),
  ar('releaseAtFor', 'endAtIso'),
  ar('holdEarning', 'sr, ride, driverId, payout, endAtIso, nowIso'),
  ar('reverseHeldEarnings', 'sr, rideId, keepDriverId, note, nowIso'),
  ar('payoutOf', 'earning'),
  ar('realignLedger', 'sr, ride, driverId, payout, endAtIso, note, nowIso, heldBefore'),
  ar('writeAssignment', 'sr, ride, driverId, payout, endAtIso, patch, note, nowIso'),
];
const writeAssignment = make('writeAssignment', ...ASSIGN);
const ASSIGNED_EARLIER = '2026-08-01T00:00:00.000Z';
const rideWorld = (driverId = '', earnings = []) => ({
  RideBooking: fakeEntity([{
    ...rideA, status: 'confirmed', payment_status: 'paid', driver_id: driverId,
    driver_assigned_at: driverId ? ASSIGNED_EARLIER : '',
  }]),
  DriverEarning: fakeEntity(earnings),
});
const assignTo = (sr, driver, payout = dayPay) => writeAssignment(
  sr, rideA, driver, payout, END, { driver_id: driver, driver_assigned_at: NOW }, `Reassigned to ${driver}`, NOW);
const heldBy = (sr) => sr.DriverEarning.rows.filter((e) => e.status === 'held').map((e) => e.driver_id).join(',');
const onRide = (sr) => sr.RideBooking.rows[0].driver_id;

{
  const sr = rideWorld();
  const r = await assignTo(sr, 'drvA');
  check('a first assignment: the driver is on the ride with one held row', `${onRide(sr)}/${heldBy(sr)}`, 'drvA/drvA');
  check('…and the call is told so', `${r.superseded}/${r.ledger_error}/${r.earning.status}/${r.earning.amount_ngn}`, 'false//held/15000');
}
{
  const sr = rideWorld('drvA', [heldRow('a1', 'drvA')]);
  const r = await assignTo(sr, 'drvB');
  check('a change of driver: the new one holds, the old one does not', `${onRide(sr)}/${heldBy(sr)}`, 'drvB/drvB');
  check('…the old row is reversed, not deleted', sr.DriverEarning.rows.find((e) => e.id === 'a1').status, 'reversed');
  check('…and nothing had been released', r.released_ngn, 0);
}
{
  const sr = rideWorld('drvA', [heldRow('a1', 'drvA', { status: 'released' })]);
  const r = await assignTo(sr, 'drvB');
  check('a change of driver after the old one was paid: reported, not clawed back',
    `${r.released_ngn}/${sr.DriverEarning.rows[0].status}`, '15000/released');
}
{
  // Rollout: the driver was put on this ride before pay was tracked. The same
  // driver is submitted again, with nothing to change on the ride itself.
  const sr = rideWorld('drvA');
  const r = await writeAssignment(sr, rideA, 'drvA', dayPay, END, {}, 'Reassigned to drvA', NOW);
  check('the same driver again records their pay', `${heldBy(sr)}/${r.earning.amount_ngn}/${r.earning.held_at}`, `drvA/15000/${NOW}`);
  check('…without rewriting the ride', sr.RideBooking.rows[0].driver_assigned_at, ASSIGNED_EARLIER);
  const again = await writeAssignment(sr, rideA, 'drvA', { ...dayPay, amount: 99999 }, END, {}, 'Reassigned to drvA', '2026-08-09T10:00:00.000Z');
  check('…and a second time changes nothing: the first figure stands',
    `${sr.DriverEarning.rows.length}/${again.earning.amount_ngn}/${again.earning.held_at}`, `1/15000/${NOW}`);
}
{
  // A driver with no login: nothing is recorded, as before.
  const sr = rideWorld('drvA', [heldRow('a1', 'drvA')]);
  const r = await assignTo(sr, 'drvU', null);
  check('a driver with no login is assigned with no pay row', `${onRide(sr)}/${heldBy(sr)}/${r.earning}`, 'drvU//null');
}
{
  // The ledger cannot be read. A driver with no login has nothing to record,
  // so the assignment still goes through and says what it could not do.
  const sr = rideWorld();
  sr.DriverEarning.filter = async () => { throw new Error('ledger unavailable'); };
  const r = await assignTo(sr, 'drvU', null);
  check('ledger down, driver with no login: assigned, and admin is warned', `${onRide(sr)}/${r.ledger_error}`, 'drvU/ledger unavailable');
}
{
  // The same failure for a driver whose pay must be recorded: nothing happens.
  const sr = rideWorld();
  sr.DriverEarning.filter = async () => { throw new Error('ledger unavailable'); };
  let threw = '';
  try { await assignTo(sr, 'drvA'); } catch (err) { threw = err.message; }
  check('ledger down, driver with a login: refused before the ride is touched', `${threw}/${onRide(sr)}`, 'ledger unavailable/');
}
{
  // Another assignment lands just after this call writes the ride row.
  const sr = rideWorld();
  const realUpdate = sr.RideBooking.update;
  sr.RideBooking.update = async (id, patch) => { await realUpdate(id, patch); return realUpdate(id, { driver_id: 'drvB' }); };
  const r = await assignTo(sr, 'drvA');
  check('overtaken by another assignment: this call is told it lost', `${r.superseded}/${r.current_driver_id}/${r.earning}`, 'true/drvB/null');
  check('…and leaves no pay held for its driver', heldBy(sr), '');
}

// Two assignments for one ride at the same moment. Each actor is the shipped
// writeAssignment; the walker from the payout section tries the orders their
// database requests could arrive in. Whoever the ride ends with must hold
// exactly one row, nobody else may hold any, and the call whose driver is on
// the ride must not have been told it lost.
//
// An assignment makes more requests than a payout, so walking every order
// would take minutes. Each race below walks every order in which the turn
// changes hands at most a set number of times, which is where two real calls
// overlap, and a random sample with no such limit covers the long tail.
const assignActors = (sr, calls) => calls.map(([driver, payout]) => (gate) => writeAssignment(
  gatedWorld(sr, gate), rideA, driver, payout, END, { driver_id: driver, driver_assigned_at: NOW }, `Reassigned to ${driver}`, NOW));
const assignRace = (calls, driverId = '', earnings = []) => () => {
  const sr = rideWorld(driverId, earnings);
  return { world: { sr, calls }, actors: assignActors(sr, calls) };
};
const ledgerAgrees = ({ sr, calls }, results) => {
  const final = onRide(sr);
  const winners = calls.map(([driver], i) => (driver === final ? i : -1)).filter((i) => i >= 0);
  if (winners.length === 0) return `the ride ended with "${final}"`;
  const tracked = !!calls[winners[0]][1];
  const held = sr.DriverEarning.rows.filter((e) => e.status === 'held');
  const theirs = held.filter((e) => e.driver_id === final);
  if (theirs.length !== (tracked ? 1 : 0)) return `${final} is on the ride with ${theirs.length} held rows`;
  if (held.length !== theirs.length) return `pay is still held for a driver who is not on the ride (${heldBy(sr)})`;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (!r || r.threw) return `a call threw: ${r && r.threw}`;
    if (r.ledger_error) return `a call could not settle the ledger: ${r.ledger_error}`;
    if (winners.includes(i) && r.superseded) return 'the call whose driver is on the ride was told it lost';
    if (winners.includes(i) && tracked && !(r.earning && r.earning.status === 'held')) return 'the winning call was handed no held row';
  }
  return '';
};
// A fixed pseudo-random sequence, so a failing schedule can be run again.
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
async function randomSchedules(setup, verdict, count, seed) {
  const rand = seeded(seed);
  for (let n = 1; n <= count; n += 1) {
    const { world, actors } = setup();
    const trace = [];
    const results = await interleave(actors, (ready) => {
      const pick = ready[Math.floor(rand() * ready.length)];
      trace.push(pick);
      return pick;
    });
    const problem = await verdict(world, results);
    if (problem) return { runs: n, problem, schedule: trace.join('') };
  }
  return { runs: count, problem: '', schedule: '' };
}
const A_PAY = ['drvA', dayPay];
const B_PAY = ['drvB', { ...dayPay, amount: 20000, rate: 20000 }];
{
  const out = await everySchedule(assignRace([A_PAY, B_PAY]), ledgerAgrees, 4);
  check(`two drivers assigned at once (${out.runs} orders): whoever is on the ride holds one row, the other none`, `${out.problem}${out.schedule}`, '');
  check('…and that was more than a handful of orders', out.runs > 500, true);
}
{
  const out = await everySchedule(assignRace([A_PAY, B_PAY], 'drvC', [heldRow('c1', 'drvC')]), ledgerAgrees, 4);
  check(`…the same when a third driver was on the ride before (${out.runs})`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await everySchedule(assignRace([A_PAY, A_PAY]), ledgerAgrees, 6);
  check(`the same driver submitted twice at once (${out.runs}): one row, not two`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await everySchedule(assignRace([A_PAY, ['drvU', null]]), ledgerAgrees, 5);
  check(`a driver with a login against one without (${out.runs}): pay is held only if the first is on the ride`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await randomSchedules(assignRace([A_PAY, B_PAY], 'drvC', [heldRow('c1', 'drvC')]), ledgerAgrees, 1500, 7);
  check(`two drivers at once, ${out.runs} random orders with no limit on changes of turn`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await randomSchedules(assignRace([A_PAY, B_PAY, ['drvC', dayPay]]), ledgerAgrees, 500, 20261010);
  check(`three drivers assigned at once, ${out.runs} random orders`, `${out.problem}${out.schedule}`, '');
}

// ── What the rides list tells admin ────────────────────────────────────────
console.log('\n— rides list flags —');
const livePayKeys = make('livePayKeys', liftSrc('getRideBookings', 'livePayKeys', 'earnings'));
same('pay that still stands is keyed by ride and driver', livePayKeys([
  { ride_booking_id: 'r1', driver_id: 'drvA', status: 'held' },
  { ride_booking_id: 'r2', driver_id: 'drvB', status: 'released' },
  { ride_booking_id: 'r3', driver_id: 'drvA', status: 'reversed' },
  null,
]), ['r1:drvA', 'r2:drvB', 'r3:drvA']);
same('no ledger, no keys', livePayKeys(undefined), []);

const T0 = at('2026-08-10T12:00:00.000Z');
const unpaidDriver = {
  payment_status: 'paid', status: 'confirmed', driver_assigned: true, driver_linked: true, driver_pay_recorded: false,
  end_at: '2026-08-10T10:00:00.000Z',
};
check('a driver with a login and no pay on record: flagged', rides.payMissing(unpaidDriver, T0), true);
check('…not once pay is recorded', rides.payMissing({ ...unpaidDriver, driver_pay_recorded: true }, T0), false);
check('…not when the ledger could not be read: no claim is made', rides.payMissing({ ...unpaidDriver, driver_pay_recorded: null }, T0), false);
check('…not for a driver with no login', rides.payMissing({ ...unpaidDriver, driver_linked: false }, T0), false);
check('…not for a ride with no driver', rides.payMissing({ ...unpaidDriver, driver_assigned: false }, T0), false);
check('…not for an unpaid ride', rides.payMissing({ ...unpaidDriver, payment_status: 'unpaid' }, T0), false);
check('…not for a cancelled ride', rides.payMissing({ ...unpaidDriver, status: 'cancelled' }, T0), false);
check('a completed ride is flagged the same way', rides.payMissing({ ...unpaidDriver, status: 'completed' }, T0), true);
check('still flagged a week after the ride ended', rides.payMissing(unpaidDriver, at('2026-08-17T10:00:00.000Z')), true);
check('…but not older history, which was settled outside the app', rides.payMissing(unpaidDriver, at('2026-08-17T10:00:01.000Z')), false);
check('the week is the shipped constant', rides.PAY_NUDGE_DAYS, 7);

const driverless = { payment_status: 'paid', status: 'confirmed', driver_assigned: false };
check('a paid, confirmed ride with no driver needs one', rides.needsDriver(driverless), true);
check('…and still does after the sweep completed it', rides.needsDriver({ ...driverless, status: 'completed' }), true);
check('…not once it has one', rides.needsDriver({ ...driverless, driver_assigned: true }), false);
check('an unpaid ride does not', rides.needsDriver({ ...driverless, payment_status: 'unpaid' }), false);
check('a cancelled ride does not', rides.needsDriver({ ...driverless, status: 'cancelled' }), false);

check('a driver with nothing on record may be deleted', rides.mayDeleteDriver([], []), true);
check('a driver with an earning may not', rides.mayDeleteDriver([{ id: 'e1' }], []), false);
check('a driver with a withdrawal may not', rides.mayDeleteDriver([], [{ id: 'w1' }]), false);
check('a lookup that did not answer is not "nothing on record"', rides.mayDeleteDriver(undefined, []), false);

// ── A reversal always wins ─────────────────────────────────────────────────
console.log('\n— a reversal always wins —');
const SE = 'settleDriverEarning';
identical('isId', 'value', [PW, SE]);
identical('isId', 'value', [PW, 'completeRide']);
identical('keepReversed', 'sr, earningId', ['autoCancelExpiredBookings', SE]);

// The arithmetic first: it is what stands between a lost race and money. A
// release that landed on top of a reversal leaves this row behind.
const overwritten = { id: 'e1', status: 'released', amount_ngn: 20000, released_at: AT, reversed_at: AT };
same('a released row that carries a reversal time counts nowhere', walletTotals([overwritten], []), ZERO);
same('…nor a held one', walletTotals([{ ...overwritten, status: 'held' }], []), ZERO);
same('…and it covers nothing already paid out: that is a shortfall',
  walletTotals([overwritten], [wd('a', { amount: 20000 })]), { ...ZERO, paid_out: 20000, shortfall: 20000 });
same('a row that was never reversed counts as before',
  walletTotals([{ ...overwritten, reversed_at: undefined }], []), { ...ZERO, released: 20000, available: 20000 });

check('a row that carries a reversal time is never releasable', isReleasable(due({ reversed_at: AT }), DUE), false);
same('a release on a row that carries a reversal time is refused',
  nextEarningState('release', { ...heldE, reversed_at: AT }, {}, AT), refusal('ALREADY_REVERSED'));
same('…and so is an adjustment',
  nextEarningState('adjust', { ...heldE, reversed_at: AT }, { reason: 'extra hour', amount_ngn: 18000 }, AT), refusal('ALREADY_REVERSED'));
check('…but reversing it again is allowed, which puts its status right',
  nextEarningState('reverse', overwritten, { reason: 'guest never showed' }, AT).patch.status, 'reversed');

const keepReversed = make('keepReversed', liftSrc(SE, 'keepReversed', 'sr, earningId'));
{
  const sr = { DriverEarning: fakeEntity([overwritten]) };
  const row = await keepReversed(sr, 'e1');
  check('a release that landed on a reversal is put back', `${sr.DriverEarning.rows[0].status}/${row.status}`, 'reversed/reversed');
  check('…keeping the time it was reversed', sr.DriverEarning.rows[0].reversed_at, AT);
}
{
  const sr = { DriverEarning: fakeEntity([{ ...overwritten, reversed_at: undefined }]) };
  let writes = 0;
  const realUpdate = sr.DriverEarning.update;
  sr.DriverEarning.update = async (...args) => { writes += 1; return realUpdate(...args); };
  const row = await keepReversed(sr, 'e1');
  check('an ordinary released row is left alone', `${row.status}/${writes}`, 'released/0');
}
{
  const sr = { DriverEarning: fakeEntity([]) };
  check('a row that no longer exists is not an error', await keepReversed(sr, 'gone'), null);
}

// The race itself, in every order. Each actor is shipped code: the sweep's
// settleDueEarning, and what settleDriverEarning does for one action (read
// the row, decide with nextEarningState, write with writeEarningChange).
const writeEarningChange = make('writeEarningChange',
  liftSrc(SE, 'keepReversed', 'sr, earningId'), liftSrc(SE, 'writeEarningChange', 'sr, earning, patch'));
const adminMove = (w, action, input = {}) => async (gate) => {
  const sr = gatedWorld(w, gate);
  const e = await sr.DriverEarning.get('e1');
  const next = nextEarningState(action, e, input, AT);
  if (!next.ok) return next.code;
  const row = await writeEarningChange(sr, e, next.patch);
  return row.status;
};
const sweepRelease = (w) => (gate) => settleDueEarning(gatedWorld(w, gate), 'e1', DUE);
const reversalStands = (w) => {
  const row = w.DriverEarning.rows[0];
  if (row.status !== 'reversed' || !row.reversed_at) return `the row ended ${row.status}`;
  if (walletTotals([row], []).available !== 0) return 'reversed pay is still available';
  return '';
};
const WHY = { reason: 'guest never showed' };
{
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    return { world: w, actors: [sweepRelease(w), adminMove(w, 'reverse', WHY)] };
  }, reversalStands);
  check(`the sweep releases while admin reverses, every order (${out.runs}): the pay ends reversed`, `${out.problem}${out.schedule}`, '');
  check('…and that was more than one order', out.runs > 10, true);
}
{
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    return { world: w, actors: [adminMove(w, 'release'), adminMove(w, 'reverse', WHY)] };
  }, reversalStands);
  check(`one admin releases while another reverses, every order (${out.runs})`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    return { world: w, actors: [sweepRelease(w), adminMove(w, 'release'), adminMove(w, 'reverse', WHY)] };
  }, reversalStands, 4);
  check(`the sweep and an admin both release while another admin reverses (${out.runs})`, `${out.problem}${out.schedule}`, '');
}
{
  // A release that was told the truth: when the sweep says "released", the
  // row was not reversed underneath it at that moment, and when a reversal
  // did get in first the sweep says so and sends the driver no "available" push.
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    return { world: w, actors: [sweepRelease(w), adminMove(w, 'reverse', WHY)] };
  }, (w, results) => (['released', 'reversed', 'skipped'].includes(results[0]) ? '' : `the sweep answered ${results[0]}`));
  check('…and the sweep only ever answers released, reversed or skipped', `${out.problem}${out.schedule}`, '');
}
{
  // The ride is handed to another driver while the sweep is releasing the
  // first driver's pay. Either the reassignment reversed the row and it stays
  // reversed, or the release got there first and the reassignment reports
  // pay that was already released. Never both.
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    const reassign = async (gate) => {
      const sr = gatedWorld(w, gate);
      await sr.RideBooking.update('ride1', { driver_id: 'drvB' });
      return reverseHeldEarnings(sr, 'ride1', 'drvB', 'Reassigned to drvB', AT);
    };
    return { world: w, actors: [sweepRelease(w), reassign] };
  }, (w, results) => {
    const row = w.DriverEarning.rows[0];
    const moved = results[1];
    if (row.reversed_at && row.status !== 'reversed') return `reversed, then overwritten as ${row.status}`;
    if (row.status === 'released' && moved.reversed_ngn > 0) return 'the reassignment believes it reversed pay that ended released';
    if (row.status === 'held') return 'the pay was neither released nor reversed';
    return '';
  });
  check(`the sweep releases while the ride is reassigned, every order (${out.runs})`, `${out.problem}${out.schedule}`, '');
}

// ── Ride rows are written by the server ────────────────────────────────────
console.log('\n— ride rows —');
identical('isId', 'value', [PW, 'checkRideAvailability']);
identical('isId', 'value', [PW, 'startRidePayment']);
identical('isRideBlocked', 'account', ['checkRideAvailability', 'startRidePayment']);
identical('guestIsBlocked', 'accounts, email', [AR, 'startRidePayment']);

// What a driver is told about a ride with no pay on record. It is the only
// warning they get that the app is not holding anything for them.
check('before the ride: confirm with the team first', rides.noPayLine('upcoming').text.includes('before you set off'), true);
check('…and it stands out', rides.noPayLine('upcoming').tone, 'warn');
check('…the same while the ride is running', rides.noPayLine('current').tone, 'warn');
check('after the ride: ask if some was expected', rides.noPayLine('past').text.includes('Ask the team'), true);
check('…quietly', rides.noPayLine('past').tone, 'muted');
check('a cancelled ride promises nothing either way', rides.noPayLine('cancelled').text, 'No pay is recorded in the app for this ride.');
check('no sentence claims pay has been arranged',
  ['upcoming', 'current', 'past', 'cancelled'].some((b) => /arranged/i.test(rides.noPayLine(b).text)), false);

// ── Payouts, second review ─────────────────────────────────────────────────
console.log('\n— payouts: credited back once, never sent stale, never left unsettled —');
const WH = 'paystackTransferWebhook';
const LEDGER_FNS = [
  ['refundsToBalance', 'withdrawal'], ['debitOnRecord', 'entries, withdrawal'], ['madeRecently', 'entry, nowIso'],
  ['attemptBlocksRefund', 'entry, nowIso'], ['claimIsLive', 'entry, nowIso'],
  ['refundReferralOnce', 'sr, withdrawal, nowIso, unsent'],
];
for (const [name, signature] of LEDGER_FNS) identical(name, signature, [PW, WH]);
check('one staleness window in both functions', constLine(PW, 'STALE_ATTEMPT_MS'), constLine(WH, 'STALE_ATTEMPT_MS'));

// The platform rejects a read of a row that is not there. It does not answer null.
const getOrNull = make('getOrNull', pw('getOrNull', 'entity, id'));
const answering = (status) => ({ get: async () => { throw Object.assign(new Error('Entity Driver with ID x not found'), { status }); } });
check('a row that is not there is null, not an error', await getOrNull(answering(404), 'x'), null);
{
  let threw = '';
  try { await getOrNull(answering(500), 'x'); } catch (err) { threw = String(err.status); }
  check('any other failure is still a failure', threw, '500');
}
check('a row that is there comes back', (await getOrNull({ get: async (id) => ({ id }) }, 'x')).id, 'x');
check('an answer of nothing is passed on', await getOrNull({ get: async () => null }, 'x'), null);
{
  // The driver's profile was deleted, and the read is rejected the way the real platform rejects it.
  const sr = bank([request()], [releasedRow('e1', 20000)]);
  sr.Driver.get = answering(404).get;
  check('a driver profile that no longer exists is a reason, not a crash',
    await driverWithdrawalProblem(sr, request()), 'The driver profile for this request no longer exists.');
}
check('a request another call has just closed reserves nothing, and is refused for that',
  await problemFor(request({ status: 'failed' }), [releasedRow('e1', 20000)]), 'This request is no longer waiting to be paid.');

const debitOnRecord = make('debitOnRecord', pw('debitOnRecord', 'entries, withdrawal'));
const asked = referralRow();
const debit = (extra = {}) => ({ ...debitFor(asked), ...extra });
check('a request the app debited has its debit on record', debitOnRecord([debit()], asked), true);
check('…whatever case the address was typed in', debitOnRecord([debit({ user_email: 'Ada@Mail.NG' })], asked), true);
check('a debit for another request is not this one\'s', debitOnRecord([debit({ withdrawal_request_id: 'other' })], asked), false);
check('a debit for another amount is not', debitOnRecord([debit({ amount_ngn: 10000 })], asked), false);
check('a debit for another person is not', debitOnRecord([debit({ user_email: 'mallory@evil.ng' })], asked), false);
check('a claim on the refund is not a debit', debitOnRecord([debit({ kind: 'refund' })], asked), false);
check('no entries, no debit', debitOnRecord([], asked), false);
check('nothing at all, no debit', debitOnRecord(undefined, asked), false);

const RECENT = [constLine(PW, 'STALE_ATTEMPT_MS'), pw('madeRecently', 'entry, nowIso')];
const attemptBlocksRefund = make('attemptBlocksRefund', ...RECENT, pw('attemptBlocksRefund', 'entry, nowIso'));
const claimIsLive = make('claimIsLive', ...RECENT, pw('claimIsLive', 'entry, nowIso'));
const attemptRow = (state, minutes = 1) => ({ kind: 'attempt', state, created_date: minutesBefore(minutes) });
check('an attempt that sent blocks a refusal being credited back, however old', attemptBlocksRefund(attemptRow('sent', 600), SENT_AT), true);
check('an attempt still open a minute ago blocks it', attemptBlocksRefund(attemptRow('open'), SENT_AT), true);
check('an attempt left unconfirmed a minute ago blocks it', attemptBlocksRefund(attemptRow('unconfirmed'), SENT_AT), true);
check('an attempt left open eleven minutes ago died with its function', attemptBlocksRefund(attemptRow('open', 11), SENT_AT), false);
check('a refused attempt blocks nothing', attemptBlocksRefund(attemptRow('refused'), SENT_AT), false);
check('an abandoned attempt blocks nothing', attemptBlocksRefund(attemptRow('abandoned'), SENT_AT), false);
check('a row with no readable time counts as recent', attemptBlocksRefund({ kind: 'attempt', state: 'open' }, SENT_AT), true);
check('a claim is not an attempt', attemptBlocksRefund({ kind: 'refund', state: 'claimed', created_date: minutesBefore(1) }, SENT_AT), false);
const claimRow = (state, minutes = 1) => ({ kind: 'refund', state, created_date: minutesBefore(minutes) });
check('a claim that credited stands for good', claimIsLive(claimRow('credited', 600), SENT_AT), true);
check('a claim in the middle of crediting stands', claimIsLive(claimRow('crediting', 600), SENT_AT), true);
check('a claim made a minute ago stands', claimIsLive(claimRow('claimed'), SENT_AT), true);
check('a claim made eleven minutes ago and never decided does not', claimIsLive(claimRow('claimed', 11), SENT_AT), false);
for (const state of ['duplicate', 'held_back', 'no_user']) {
  check(`a ${state} claim does not stand`, claimIsLive(claimRow(state), SENT_AT), false);
}

const canRecheck = make('canRecheck', pw('canRecheck', 'withdrawal'));
const canCredit = make('canCredit', pw('refundsToBalance', 'withdrawal'), pw('canCredit', 'withdrawal'));
for (const status of ['abandoned', 'blocked', 'rejected']) {
  check(`a transfer Paystack reports as ${status} never left: failed`, rowStatusFor(status), 'failed');
}
// The screen offers exactly what the server would do.
for (const row of [
  { status: 'pending' }, { status: 'processing' }, { status: 'processing', transfer_code: 'TRF_1' },
  { status: 'processing', transfer_code: 'TRF_1', transfer_reference: REF },
  { status: 'completed', transfer_code: 'TRF_1', transfer_reference: REF },
  { status: 'failed' }, { status: 'failed', refunded_at: SENT_AT }, { status: 'failed', wallet: 'driver' },
  { status: 'reversed' }, { status: 'reversed', wallet: 'driver' },
]) {
  const offered = withdrawalActions(row);
  const label = JSON.stringify(row);
  check(`Process or Retry is offered for ${label} exactly when the server would send`, offered.send || offered.retry, canSend(row));
  check('…Check with Paystack exactly when the server would ask', offered.recheck, canRecheck(row));
  check('…Credit back exactly when the server would look', offered.credit, canCredit(row));
}
check('a stuck row is listed with the pending ones', showsUnderPending({ status: 'processing' }), true);
check('a row that was sent is not', showsUnderPending({ status: 'processing', transfer_code: 'TRF_1' }), false);
check('a first send is not a retry', `${withdrawalActions({ status: 'pending' }).send}/${withdrawalActions({ status: 'pending' }).retry}`, 'true/false');

const REFUSAL = 'Your balance is not enough to fulfil this request';
{
  // A referral request with no debit on record: made before the ledger
  // existed, or typed into the database by hand.
  const sr = payWorld(referralRow(), { ledger: [] });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a referral request with no debit on record is not sent on the first press',
    `${r.status}/${r.body.code}/${ps.calls.send}/${rowOf(sr).status}`, '409/UNRECORDED/0/pending');
  const again = await sendWithdrawal(sr, ps, referralRow(), SENT_AT, true);
  check('…it is sent when admin says so a second time', `${again.body.success}/${ps.transfers.size}`, 'true/1');
}
{
  const sr = payWorld(referralRow(), { ledger: [] });
  const r = await sendWithdrawal(sr, fakePaystack({ refusal: REFUSAL }), referralRow(), SENT_AT, true);
  check('…and if Paystack refuses it, it is failed but never credited back',
    `${rowOf(sr).status}/${balanceOf(sr)}/${r.body.refund}`, 'failed/5000/no_debit');
  check('…and the row says why', rowOf(sr).error_message.includes('no record of taking this amount'), true);
}
{
  // Typed in to look half-processed, so that the screen shows Retry.
  const sr = payWorld(referralRow({ status: 'processing' }), { ledger: [] });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a hand-made "processing" row is not sent by Retry either', `${r.body.code}/${ps.calls.send}`, 'UNRECORDED/0');
}
{
  // Sent and acknowledged, and then the settlement event never arrived.
  const sent = referralRow({ status: 'processing', transfer_code: 'TRF_7', transfer_reference: REF });
  const settle = async (transferStatus) => {
    const sr = payWorld(sent);
    const ps = fakePaystack();
    ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: transferStatus });
    const r = await sendWithdrawal(sr, ps, sent, SENT_AT);
    return `${rowOf(sr).status}/${balanceOf(sr)}/${ps.calls.send}/${r.body.status}`;
  };
  check('asking Paystack about a sent row the bank paid completes it', await settle('success'), 'completed/5000/0/completed');
  check('…one the bank did not pay is failed and credited back', await settle('failed'), 'failed/20000/0/failed');
  check('…one Paystack abandoned is failed and credited back', await settle('abandoned'), 'failed/20000/0/failed');
  check('…one the bank sent back is reversed and credited back', await settle('reversed'), 'reversed/20000/0/reversed');
  check('…one still with the bank is left as it is', await settle('pending'), 'processing/5000/0/processing');
}
{
  const sent = referralRow({ status: 'processing', transfer_code: 'TRF_7', transfer_reference: REF });
  const sr = payWorld(sent);
  const none = await sendWithdrawal(sr, fakePaystack(), sent, SENT_AT);
  check('Paystack holds nothing for a row that says it was sent: nothing changes, and admin is told',
    `${none.body.code}/${rowOf(sr).status}`, 'NO_TRANSFER/processing');
  const deaf = await sendWithdrawal(sr, fakePaystack({ cannotAsk: true }), sent, SENT_AT);
  check('…and if Paystack cannot be asked, nothing changes either', `${deaf.body.code}/${rowOf(sr).status}`, 'UNCONFIRMED/processing');
}
{
  // Refused, while another attempt to send it was still in flight.
  const inFlight = { id: 'att0', kind: 'attempt', state: 'open', withdrawal_request_id: ROW_ID, created_date: minutesBefore(1) };
  const sr = payWorld(referralRow(), { ledger: [debitFor(referralRow()), inFlight] });
  const r = await sendWithdrawal(sr, fakePaystack({ refusal: REFUSAL }), referralRow(), SENT_AT);
  check('refused while another attempt is in flight: failed, and not credited back yet',
    `${rowOf(sr).status}/${balanceOf(sr)}/${r.body.refund}`, 'failed/5000/held_back');
  check('…the row says what to press', rowOf(sr).error_message.includes('Press Credit back'), true);
  // The other attempt ended in a refusal too. Admin presses Credit back.
  sr.WithdrawalLedger.rows.find((e) => e.id === 'att0').state = 'refused';
  const later = await sendWithdrawal(sr, fakePaystack(), { ...rowOf(sr) }, SENT_AT);
  check('Credit back then credits it', `${later.body.credited}/${balanceOf(sr)}/${rowOf(sr).refunded_at}`, `true/20000/${SENT_AT}`);
  const again = await sendWithdrawal(sr, fakePaystack(), { ...rowOf(sr) }, SENT_AT);
  check('…and a second press finds nothing to do', `${again.body.code}/${balanceOf(sr)}`, 'NOT_SENDABLE/20000');
}
{
  // Marked failed on a stale reading while the transfer it lost to went out.
  const failed = referralRow({ status: 'failed' });
  const sr = payWorld(failed);
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  const r = await sendWithdrawal(sr, ps, failed, SENT_AT);
  check('Credit back on a row whose transfer in fact went out credits nothing and corrects the row',
    `${rowOf(sr).status}/${balanceOf(sr)}/${r.body.already_sent}`, 'completed/5000/true');
}
{
  const failed = referralRow({ status: 'failed' });
  const halfDone = { id: 'c0', kind: 'refund', state: 'crediting', withdrawal_request_id: ROW_ID, created_date: minutesBefore(30) };
  const sr = payWorld(failed, { ledger: [debitFor(failed), halfDone] });
  const r = await sendWithdrawal(sr, fakePaystack(), failed, SENT_AT);
  check('a credit that was interrupted is never repeated blindly', `${r.body.refund}/${balanceOf(sr)}`, 'interrupted/5000');
}
{
  const failed = referralRow({ status: 'failed' });
  const sr = payWorld(failed, { ledger: [] });
  const r = await sendWithdrawal(sr, fakePaystack(), failed, SENT_AT);
  check('Credit back on a row with no debit on record credits nothing', `${r.body.refund}/${balanceOf(sr)}`, 'no_debit/5000');
}
{
  const failed = driverRow({ status: 'failed' });
  const sr = payWorld(failed, { earnings: [releasedRow('e1', 20000)] });
  const r = await sendWithdrawal(sr, fakePaystack(), failed, SENT_AT);
  check('a failed driver-wallet row has nothing to credit: failing it was its refund', `${r.body.code}/${balanceOf(sr)}`, 'NOT_SENDABLE/5000');
}
{
  // Paystack answers a repeat of a reference with a 2xx carrying the transfer
  // it already holds, and that transfer has already failed at the bank.
  const sr = payWorld(referralRow());
  const ps = fakePaystack({ staleFirstFind: true, duplicateAnswers2xx: true });
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'failed' });
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a repeat answered with a transfer that already failed settles the row, it does not leave it processing',
    `${rowOf(sr).status}/${balanceOf(sr)}/${ps.transfers.size}`, 'failed/20000/1');
}
{
  const sr = payWorld(referralRow());
  const r = await sendWithdrawal(sr, fakePaystack({ sendStatus: 'otp' }), referralRow(), SENT_AT);
  check('a transfer Paystack is holding for a one-time code is not reported as on its way',
    `${r.body.warning}/${rowOf(sr).status}/${rowOf(sr).transfer_code}`, 'NEEDS_OTP/processing/TRF_1');
}

// The races. Each press is the shipped sendWithdrawal, handed an id the way
// the function is really called, so each one reads the row for itself.
const pressing = (row, extra, paystackOptions, count = 2) => () => {
  const sr = payWorld(row, extra);
  const ps = fakePaystack(paystackOptions);
  const press = (gate) => sendWithdrawalById(
    gatedWorld(sr, gate), viaGate(ps, gate, ['find', 'createRecipient', 'send']), row.id, false, SENT_AT);
  return { world: { sr, ps, row }, actors: Array.from({ length: count }, () => press) };
};
const creditedClaims = (sr) => sr.WithdrawalLedger.rows.filter((e) => e.kind === 'refund' && e.state === 'credited').length;
const wentOut = (ps) => [...ps.transfers.values()].filter((t) => rowStatusFor(t.status) !== 'failed' && rowStatusFor(t.status) !== 'reversed').length;
// What must be true of a referral withdrawal of ₦15,000 whatever happened.
const moneyIsRight = ({ sr, ps }, results) => {
  const broken = results.find((r) => !r || r.threw);
  if (broken !== undefined) return `a call threw: ${JSON.stringify(broken)}`;
  if (ps.transfers.size > 1) return `${ps.transfers.size} transfers left the account`;
  const credited = balanceOf(sr) - 5000;
  if (credited !== 0 && credited !== 15000) return `the balance moved by ${credited}`;
  if (creditedClaims(sr) !== (credited ? 1 : 0)) return `${creditedClaims(sr)} credited claim(s) for a balance that moved by ${credited}`;
  if (credited && wentOut(ps) > 0) return 'the withdrawal was both sent and credited back';
  if (credited && !rowOf(sr).refunded_at) return 'credited back, but the row does not say so';
  return '';
};
// One press of Credit back after the race, when nobody credited during it.
const creditBackAfterwards = async ({ sr }) => {
  const later = await sendWithdrawalById(sr, fakePaystack(), rowOf(sr).id, false, SENT_AT);
  if (!later.body.credited || balanceOf(sr) !== 20000 || creditedClaims(sr) !== 1) {
    return `Credit back afterwards did not credit once: ${JSON.stringify(later.body)}`;
  }
  return '';
};
{
  // The high finding. The earnings do not cover the request; the first call
  // closes it, and the second must not send it on the copy it read before.
  const uncovered = pressing(driverRow({ amount: 500000 }), { earnings: [releasedRow('e1', 20000)] });
  const out = await everySchedule(uncovered, ({ sr, ps }, results) => {
    if (results.some((r) => !r || r.threw)) return `a call threw: ${JSON.stringify(results)}`;
    if (ps.transfers.size !== 0) return `${ps.transfers.size} transfer(s) left for a request the earnings do not cover`;
    if (rowOf(sr).status !== 'failed') return `the row ended ${rowOf(sr).status}`;
    const told = results.map((r) => r.body.code);
    return told.every((c) => c === 'NOT_COVERED' || c === 'NOT_SENDABLE') ? '' : `the presses were told ${JSON.stringify(told)}`;
  }, Infinity);
  check(`two presses on a driver-wallet request the earnings do not cover (${out.runs} orders): nothing is sent`, `${out.problem}${out.schedule}`, '');
  check('…and that was more than a handful of orders', out.runs > 500, true);
}
{
  // Both presses are refused for a stated reason. Before, each credited the balance.
  const verdict = async (world, results) => {
    const wrong = moneyIsRight(world, results);
    if (wrong) return wrong;
    if (world.ps.transfers.size !== 0 || rowOf(world.sr).status !== 'failed') {
      return `a refused withdrawal ended ${rowOf(world.sr).status} with ${world.ps.transfers.size} transfer(s)`;
    }
    // Credited at once, or both stood down for each other and one more press does it.
    return balanceOf(world.sr) === 20000 ? '' : creditBackAfterwards(world);
  };
  const out = await everySchedule(pressing(referralRow(), undefined, { refusal: REFUSAL }), verdict, 3);
  check(`two presses both refused (${out.runs} orders): credited back exactly once`, `${out.problem}${out.schedule}`, '');
  const more = await randomSchedules(pressing(referralRow(), undefined, { refusal: REFUSAL }), verdict, 1000, 11);
  check(`…and in ${more.runs} random orders with no limit on changes of turn`, `${more.problem}${more.schedule}`, '');
  const three = await randomSchedules(pressing(referralRow(), undefined, { refusal: REFUSAL }, 3), verdict, 1000, 12);
  check(`…and with three presses, ${three.runs} random orders`, `${three.problem}${three.schedule}`, '');
}
{
  // The first send is refused for a stated reason and the next one, a moment
  // later, is accepted. Before, one call credited the balance and the other
  // sent the transfer.
  const verdict = async (world, results) => {
    const wrong = moneyIsRight(world, results);
    if (wrong) return wrong;
    if (wentOut(world.ps) > 0 || balanceOf(world.sr) === 20000) return '';
    return rowOf(world.sr).status === 'failed' ? creditBackAfterwards(world) : `nothing was sent or credited and the row ended ${rowOf(world.sr).status}`;
  };
  const out = await everySchedule(pressing(referralRow(), undefined, { refuseFirst: REFUSAL }), verdict, 3);
  check(`refused, then accepted a moment later (${out.runs} orders): sent or credited back, never both`, `${out.problem}${out.schedule}`, '');
  const more = await randomSchedules(pressing(referralRow(), undefined, { refuseFirst: REFUSAL }), verdict, 1000, 13);
  check(`…and in ${more.runs} random orders`, `${more.problem}${more.schedule}`, '');
}

// The bank's event arriving while a press is in flight. The actor is the
// webhook's own steps for one event: read the row, webhookShouldAct, write,
// and for a failure the webhook's copy of refundReferralOnce.
const webhookRefund = make('refundReferralOnce', constLine(WH, 'STALE_ATTEMPT_MS'), FETCH_ALL,
  ...LEDGER_FNS.map(([name, signature]) => liftSrc(WH, name, signature)));
const bankEvent = (world, eventName, transferStatus) => async (gate) => {
  const { sr, ps, row } = world;
  const w = gatedWorld(sr, gate);
  await gate(); // the moment the event arrives
  const transfer = ps.transfers.get(transferReferenceFor(row.id));
  if (!transfer) return 'no event'; // nothing was sent, so Paystack has nothing to report
  transfer.status = transferStatus; // the bank settled it
  const current = await w.WithdrawalRequest.get(row.id);
  if (!webhookShouldAct(eventName, current)) return 'skipped';
  if (eventName === 'transfer.success') {
    await w.WithdrawalRequest.update(row.id, { status: 'completed', processed_at: SENT_AT });
    return 'completed';
  }
  const status = eventName === 'transfer.reversed' ? 'reversed' : 'failed';
  await w.WithdrawalRequest.update(row.id, { status, processed_at: SENT_AT });
  return `${status}:${await webhookRefund(w, current, SENT_AT, false)}`;
};
const withEvent = (setup, eventName, transferStatus, prepare = () => {}) => () => {
  const made = setup();
  prepare(made.world);
  return { world: made.world, actors: [...made.actors, bankEvent(made.world, eventName, transferStatus)] };
};
{
  // Two presses and the bank's success. Before, a press holding a stale copy
  // could write "processing" over the webhook's "completed" and leave it there.
  const verdict = (world, results) => {
    const wrong = moneyIsRight(world, results.slice(0, 2));
    if (wrong) return wrong;
    const { sr, ps } = world;
    if (ps.transfers.size !== 1 || balanceOf(sr) !== 5000) return `${ps.transfers.size} transfer(s), balance ${balanceOf(sr)}`;
    if (results[2] === 'completed' && rowOf(sr).status !== 'completed') return `the webhook completed the row and it ended ${rowOf(sr).status}`;
    return ['completed', 'processing'].includes(rowOf(sr).status) ? '' : `the row ended ${rowOf(sr).status}`;
  };
  const out = await everySchedule(withEvent(pressing(referralRow()), 'transfer.success', 'success'), verdict, 3);
  check(`two presses while the bank's success arrives (${out.runs} orders): a completed row stays completed`, `${out.problem}${out.schedule}`, '');
  const more = await randomSchedules(withEvent(pressing(referralRow()), 'transfer.success', 'success'), verdict, 1000, 14);
  check(`…and in ${more.runs} random orders`, `${more.problem}${more.schedule}`, '');
}
{
  // Retry on a stuck row at the moment the bank's failure arrives: two
  // different pieces of code both want to credit it back.
  const stuck = referralRow({ status: 'processing', transfer_reference: REF });
  const failedAtBank = (world) => world.ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'failed' });
  const verdict = (world, results) => moneyIsRight(world, results.slice(0, 1))
    || (rowOf(world.sr).status === 'failed' ? '' : `the row ended ${rowOf(world.sr).status}`)
    || (balanceOf(world.sr) === 20000 ? '' : `the balance ended at ${balanceOf(world.sr)}`);
  const out = await everySchedule(withEvent(pressing(stuck, undefined, undefined, 1), 'transfer.failed', 'failed', failedAtBank), verdict, 3);
  check(`Retry while the bank's failure arrives (${out.runs} orders): credited back exactly once`, `${out.problem}${out.schedule}`, '');
  check('…and that was more than a handful of orders', out.runs > 200, true);
  const more = await randomSchedules(withEvent(pressing(stuck, undefined, undefined, 1), 'transfer.failed', 'failed', failedAtBank), verdict, 1000, 15);
  check(`…and in ${more.runs} random orders`, `${more.problem}${more.schedule}`, '');
}

// ── A payment reference pays for one booking ───────────────────────────────
console.log('\n— payment reference —');
identical('paymentIsFor', 'metadata, kind, id', ['verifyRidePayment', 'verifyPaystackPayment']);
const paymentIsFor = make('paymentIsFor', liftSrc('verifyRidePayment', 'paymentIsFor', 'metadata, kind, id'));
check('a ride payment for this ride', paymentIsFor({ ride_booking_id: 'r1' }, 'ride', 'r1'), true);
check('a ride payment replayed on another ride of the same price', paymentIsFor({ ride_booking_id: 'r1' }, 'ride', 'r2'), false);
check('a stay payment handed in for a ride', paymentIsFor({ booking_id: 'b1' }, 'ride', 'r1'), false);
check('a ride payment handed in for a stay', paymentIsFor({ ride_booking_id: 'r1' }, 'stay', 'b1'), false);
check('a stay payment for this stay', paymentIsFor({ booking_id: 'b1' }, 'stay', 'b1'), true);
check('a stay payment replayed on another stay', paymentIsFor({ booking_id: 'b1' }, 'stay', 'b2'), false);
check('metadata that came back as text is read', paymentIsFor('{"ride_booking_id":"r1"}', 'ride', 'r1'), true);
check('no metadata says nothing either way', paymentIsFor('', 'ride', 'r1'), null);
check('unreadable metadata says nothing either way', paymentIsFor('{oops', 'stay', 'b1'), null);

// ── An assignment that overlaps a cancellation ─────────────────────────────
{
  const out = await everySchedule(() => {
    const sr = rideWorld('drvC', [heldRow('c1', 'drvC')]);
    const cancel = async (gate) => {
      const w = gatedWorld(sr, gate);
      await w.RideBooking.update('ride1', { status: 'cancelled' });
      return reverseHeldEarnings(w, 'ride1', '', 'Ride cancelled', NOW);
    };
    return { world: { sr }, actors: [...assignActors(sr, [A_PAY]), cancel] };
  }, ({ sr }, results) => {
    if (results.some((r) => !r || r.threw)) return `a call threw: ${JSON.stringify(results)}`;
    return heldBy(sr) ? `pay is still held on a cancelled ride (${heldBy(sr)})` : '';
  }, 5);
  check(`a driver assigned while the ride is cancelled (${out.runs} orders): no pay is left held`, `${out.problem}${out.schedule}`, '');
}

// ---- result ----
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
