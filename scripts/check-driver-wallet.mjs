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
function fakeEntity(seed = []) {
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
      const row = { id: `new${n}`, created_date: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), ...data };
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
  same('…and reports what moved', out, { reversed_ngn: 15000, released_ngn: 0, driver_ids: ['drvA'] });
}
{
  // The previous driver's pay had already been released: it is not clawed back
  // silently, it is reported so admin can decide.
  const sr = { DriverEarning: fakeEntity([heldRow('a1', 'drvA', { status: 'released' })]) };
  const out = await reverseHeldEarnings(sr, 'ride1', 'drvB', 'Reassigned to B', NOW);
  check('a released row is left alone on reassignment', sr.DriverEarning.rows[0].status, 'released');
  same('…and reported', out, { reversed_ngn: 0, released_ngn: 15000, driver_ids: [] });
}
{
  // Cancellation passes '' and reverses everyone still holding.
  const sr = { DriverEarning: fakeEntity([heldRow('a1', 'drvA'), heldRow('b1', 'drvB', { amount_ngn: 20000, admin_notes: 'earlier note' })]) };
  const out = await reverseHeldEarnings(sr, 'ride1', '', 'Ride cancelled', NOW);
  check('cancel reverses every held row', sr.DriverEarning.rows.every((r) => r.status === 'reversed'), true);
  check('…keeping earlier notes', sr.DriverEarning.rows[1].admin_notes, 'earlier note | Ride cancelled');
  same('…and totals it', out, { reversed_ngn: 35000, released_ngn: 0, driver_ids: ['drvA', 'drvB'] });
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
  sweepSrc('settleDueEarning', 'sr, earningId, nowMs'));
const world = (earning, ride) => ({ DriverEarning: fakeEntity([earning]), RideBooking: fakeEntity(ride ? [ride] : []) });
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
  liftSrc('getDriverRides', 'safeIso', 'ms'), liftSrc('getDriverRides', 'driverRideView', 'ride, bucket, win, earning'));
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
  'booking_reference', 'bucket', 'dropoff_location', 'duration_days', 'duration_hours', 'duration_tier',
  'earning', 'end_at', 'guest_name', 'guest_phone', 'id', 'passengers', 'pickup_instructions',
  'pickup_location', 'service_date', 'special_requests', 'start_at', 'start_time', 'status',
  'vehicle_image', 'vehicle_name',
]);
same('exactly these pay fields reach the driver', Object.keys(upcomingView.earning).sort(),
  ['amount_ngn', 'id', 'on_hold', 'release_at', 'released_at', 'status']);
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

const ledgerView = make('ledgerView', walletSrc('ledgerView', 'earning'));
same('exactly these ledger fields reach the driver',
  Object.keys(ledgerView({
    id: 'e1', driver_id: 'drvA', ride_booking_id: 'ride1', booking_reference: 'UD-AAA111', vehicle_name: 'Prado',
    service_date: '2026-08-10', amount_ngn: 15000, status: 'held', on_hold: true, hold_reason: 'internal',
    admin_notes: 'internal', adjustment_reason: 'internal', rate_ngn: 15000, units: 1, basis: 'daily',
    release_at: '2026-08-10T12:00:00.000Z', held_at: '2026-08-09T09:00:00.000Z',
  })).sort(),
  ['amount_ngn', 'booking_reference', 'held_at', 'id', 'on_hold', 'release_at', 'released_at', 'reversed_at',
    'ride_booking_id', 'service_date', 'status', 'vehicle_name']);

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

// ---- result ----
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
