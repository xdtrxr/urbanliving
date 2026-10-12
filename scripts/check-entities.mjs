// Entity schema checks — run with: node scripts/check-entities.mjs
//
// WHY THIS LIVES IN THE REPO
// A Base44 checkpoint applies whatever is in base44/entities/ to the live
// database. A typo in an access rule is therefore a production incident, not a
// failed build, and nothing else in this repo so much as parses these files.
// This script parses every schema and pins the rules that money and privacy
// depend on, so a careless edit fails CI instead of going live.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rides from '../src/config/rides.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'base44/entities');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  ${detail}`}`);
};

// The files are .jsonc, so comments are legal. Strip them without touching a
// "//" that sits inside a string (descriptions contain URLs).
function stripComments(src) {
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      i += 1;
    } else if (c === '"') {
      inString = true;
      out += c;
      i += 1;
    } else if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

// ── Every schema: parses, is named after its file, requires only real fields ─
console.log('\n— structure —');
const entities = {};
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonc')).sort()) {
  const stem = file.replace(/\.jsonc$/, '');
  let parsed;
  try {
    parsed = JSON.parse(stripComments(fs.readFileSync(path.join(DIR, file), 'utf8')));
  } catch (err) {
    check(`${file} parses`, false, err.message);
    continue;
  }
  entities[stem] = parsed;
  const missing = (parsed.required || []).filter((k) => !(k in (parsed.properties || {})));
  check(
    `${file}`,
    parsed.name === stem && missing.length === 0,
    parsed.name !== stem ? `name is "${parsed.name}"` : `required but not defined: ${missing.join(', ')}`,
  );
}

const ADMIN = JSON.stringify({ user_condition: { role: 'admin' } });
const adminOnly = (rule) => JSON.stringify(rule) === ADMIN;
const OWNER = JSON.stringify({ 'data.user_email': '{{user.email}}' });
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && b.every((v, i) => a[i] === v);
const prop = (entity, field) => entities[entity]?.properties?.[field];
const fieldNames = (entity) => Object.keys(entities[entity]?.properties || {});
const OPS = ['create', 'read', 'update', 'delete'];

// ── Driver wallet ──────────────────────────────────────────────────────────
console.log('\n— driver wallet —');
check('DriverEarning exists', !!entities.DriverEarning);
for (const f of [
  'driver_id', 'ride_booking_id', 'booking_reference', 'vehicle_name', 'service_date', 'end_at',
  'amount_ngn', 'basis', 'rate_ngn', 'units', 'status', 'on_hold', 'hold_reason', 'release_at',
  'held_at', 'released_at', 'reversed_at', 'adjusted_at', 'adjustment_reason', 'admin_notes',
]) {
  check(`DriverEarning.${f}`, !!prop('DriverEarning', f));
}
check('DriverEarning.status is held | released | reversed',
  sameList(prop('DriverEarning', 'status')?.enum, ['held', 'released', 'reversed']));
check('DriverEarning.status defaults to held', prop('DriverEarning', 'status')?.default === 'held');
check('DriverEarning.basis is hourly | daily | manual',
  sameList(prop('DriverEarning', 'basis')?.enum, ['hourly', 'daily', 'manual']));
// Rows carry admin notes, so not even the driver reads them through the API.
for (const op of OPS) {
  check(`DriverEarning ${op} is admin-only`, adminOnly(entities.DriverEarning?.rls?.[op]));
}

check('RideBooking.completed_at is a date-time', prop('RideBooking', 'completed_at')?.format === 'date-time');
check('RideBooking.completed_by is system | admin',
  sameList(prop('RideBooking', 'completed_by')?.enum, ['system', 'admin']));
// A guest can read their own RideBooking row, so the driver's pay must never
// become a column on it. The figure lives on DriverEarning only.
check('RideBooking carries no driver pay figure',
  !fieldNames('RideBooking').some((k) => /payout|driver_pay|driver_cost/.test(k)));
// Guests must never be able to write a ride row directly.
check('RideBooking update is admin-only', adminOnly(entities.RideBooking?.rls?.update));

check('WithdrawalRequest.wallet is referral | driver',
  sameList(prop('WithdrawalRequest', 'wallet')?.enum, ['referral', 'driver']));
check('WithdrawalRequest.wallet defaults to referral', prop('WithdrawalRequest', 'wallet')?.default === 'referral');
check('WithdrawalRequest.driver_id', prop('WithdrawalRequest', 'driver_id')?.type === 'string');
check('WithdrawalRequest.transfer_reference', prop('WithdrawalRequest', 'transfer_reference')?.type === 'string');
check('WithdrawalRequest update is admin-only', adminOnly(entities.WithdrawalRequest?.rls?.update));

// The referral balance's paper trail. Admin-only in every direction: it is
// the one record of a withdrawal that cannot be typed in from a browser.
check('WithdrawalLedger exists', !!entities.WithdrawalLedger);
for (const f of ['withdrawal_request_id', 'user_email', 'kind', 'state', 'amount_ngn']) {
  check(`WithdrawalLedger.${f}`, !!prop('WithdrawalLedger', f));
}
check('WithdrawalLedger.kind is debit | attempt | refund',
  sameList(prop('WithdrawalLedger', 'kind')?.enum, ['debit', 'attempt', 'refund']));
for (const op of OPS) {
  check(`WithdrawalLedger ${op} is admin-only`, adminOnly(entities.WithdrawalLedger?.rls?.[op]));
}

check('Driver.user_email', prop('Driver', 'user_email')?.type === 'string');
check('Driver.previous_user_emails is a string array',
  prop('Driver', 'previous_user_emails')?.type === 'array'
  && prop('Driver', 'previous_user_emails')?.items?.type === 'string');
for (const op of OPS) {
  check(`Driver ${op} is admin-only`, adminOnly(entities.Driver?.rls?.[op]));
}

// The available balance is derived from the ledger on demand. A stored number
// would need an atomic increment the platform does not have.
check('User has no stored driver balance', !fieldNames('User').some((k) => /driver_balance/.test(k)));
check('User.referral_balance_ngn is admin-write',
  adminOnly(prop('User', 'referral_balance_ngn')?.rls?.write));

const bankRead = entities.UserBankAccount?.rls?.read;
check('UserBankAccount read: owner or admin',
  Array.isArray(bankRead?.$or) && bankRead.$or.some(adminOnly)
  && bankRead.$or.some((r) => JSON.stringify(r) === OWNER));
for (const op of ['create', 'update', 'delete']) {
  check(`UserBankAccount ${op} stays owner-only`, JSON.stringify(entities.UserBankAccount?.rls?.[op]) === OWNER);
}

// ── Ride reports ───────────────────────────────────────────────────────────
console.log('\n— ride reports —');
check('RideReport exists', !!entities.RideReport);
for (const f of [
  'ride_booking_id', 'booking_reference', 'vehicle_name', 'service_date', 'reporter_email', 'reporter_role',
  'reporter_name', 'reported_email', 'reported_driver_id', 'reported_name', 'category', 'description',
  'evidence_urls', 'status', 'action_taken', 'admin_notes', 'resolved_at', 'resolved_by',
]) {
  check(`RideReport.${f}`, !!prop('RideReport', f));
}
check('RideReport.reporter_role is driver | guest', sameList(prop('RideReport', 'reporter_role')?.enum, ['driver', 'guest']));
check('RideReport.category has the seven categories',
  sameList(prop('RideReport', 'category')?.enum, ['rude', 'abusive', 'threatening', 'unsafe', 'no_show', 'damage', 'other']));
check('RideReport.status is open | reviewing | resolved | dismissed',
  sameList(prop('RideReport', 'status')?.enum, ['open', 'reviewing', 'resolved', 'dismissed']));
check('RideReport.status defaults to open', prop('RideReport', 'status')?.default === 'open');
check('RideReport.action_taken is none | warning | blocked',
  sameList(prop('RideReport', 'action_taken')?.enum, ['none', 'warning', 'blocked']));
check('RideReport.evidence_urls is a string array',
  prop('RideReport', 'evidence_urls')?.type === 'array' && prop('RideReport', 'evidence_urls')?.items?.type === 'string');
// Rows carry admin notes about real people. Not even the reporter reads them
// through the API; the ride lists tell them what they need to know.
for (const op of OPS) {
  check(`RideReport ${op} is admin-only`, adminOnly(entities.RideReport?.rls?.[op]));
}
check('User.ride_blocked is a boolean, off by default',
  prop('User', 'ride_blocked')?.type === 'boolean' && prop('User', 'ride_blocked')?.default === false);
// A guest must not be able to unblock themselves with auth.updateMe.
check('User.ride_blocked is admin-write', adminOnly(prop('User', 'ride_blocked')?.rls?.write));

// ── Rules staged for the next publish ──────────────────────────────────────
// docs/entity-rules-pending-publish/ is where a stricter copy of a schema
// waits when its rule cannot go live before a publish (empty or absent when
// nothing is waiting). On publish day each copy replaces the live file. A staged copy that is
// missing a field the live schema has since gained would DELETE that field
// from production, so the two must always list the same fields.
console.log('\n— staged rules —');
const STAGED = path.join(ROOT, 'docs/entity-rules-pending-publish');
const stagedFiles = fs.existsSync(STAGED) ? fs.readdirSync(STAGED).filter((f) => f.endsWith('.jsonc')).sort() : [];
for (const file of stagedFiles) {
  const stem = file.replace(/\.jsonc$/, '');
  let staged;
  try {
    staged = JSON.parse(stripComments(fs.readFileSync(path.join(STAGED, file), 'utf8')));
  } catch (err) {
    check(`staged ${file} parses`, false, err.message);
    continue;
  }
  const live = entities[stem];
  const stagedFields = Object.keys(staged.properties || {}).sort();
  const liveFields = Object.keys(live?.properties || {}).sort();
  const dropped = liveFields.filter((k) => !stagedFields.includes(k));
  const invented = stagedFields.filter((k) => !liveFields.includes(k));
  check(`staged ${file} lists exactly the live fields`, !!live && dropped.length === 0 && invented.length === 0,
    !live ? 'no live schema of that name' : `would drop: [${dropped.join(', ')}] would add: [${invented.join(', ')}]`);
  check(`staged ${file} requires the same fields`, JSON.stringify(staged.required || []) === JSON.stringify(live?.required || []));
}
// The strict rules were applied on 2026-10-10, after the functions that make
// them safe were published. They are pinned here so nobody loosens them.
check('WithdrawalRequest: only the server may create a row', adminOnly(entities.WithdrawalRequest?.rls?.create));
check('RideBooking: only the server may create a row', adminOnly(entities.RideBooking?.rls?.create));
check('LoyaltyTransaction: only the server may create a row', adminOnly(entities.LoyaltyTransaction?.rls?.create));
// Applied on 2026-10-12, once checkAvailabilityWebhook wrote both rows with
// the service role. Until then a signed-in guest could write a Booking by
// hand: any total_price, or already approved, confirmed or paid.
check('Booking: only the server may create a row', adminOnly(entities.Booking?.rls?.create));
check('AvailabilityRequest: only the server may create a row', adminOnly(entities.AvailabilityRequest?.rls?.create));
check('Booking delete is admin-only', adminOnly(entities.Booking?.rls?.delete));
for (const op of ['update', 'delete']) {
  check(`AvailabilityRequest ${op} is admin-only`, adminOnly(entities.AvailabilityRequest?.rls?.[op]));
}
check('Booking: only admin may update a row', adminOnly(entities.Booking?.rls?.update));
for (const f of ['loyalty_points', 'loyalty_tier', 'referral_balance_ngn', 'ride_blocked']) {
  check(`User.${f} is admin-write`, adminOnly(prop('User', f)?.rls?.write));
}
// Locked on the live database on 2026-10-12. Every admin-only rule in the app
// rests on `role`, and nobody had tested whether the platform itself refuses
// a user changing their own. `referred_by_code` named who a referral reward
// was paid to; the reward no longer reads it, and this is the second lock.
for (const f of ['role', 'referred_by_code']) {
  check(`User.${f} is admin-write`, adminOnly(prop('User', f)?.rls?.write));
}
// The browser writes these with auth.updateMe. A write rule on one of them
// would fail the whole call it travels in (Dashboard saves referral_code and
// nft_tokens together), so they must stay open until that code has moved.
for (const f of ['referral_code', 'nft_tokens', 'referral_prompt_seen', 'wishlist', 'phone_number', 'profile_picture']) {
  check(`User.${f} is still written by the browser, so it carries no write rule`, prop('User', f)?.rls?.write === undefined);
}

// An "only the server may create" rule only works if nothing
// creates that row as the signed-in user: no function (it must go through
// asServiceRole) and nothing in the browser.
const filesUnder = (dir, exts) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const full = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'node_modules' ? [] : filesUnder(full, exts);
  return exts.some((e) => d.name.endsWith(e)) ? [full] : [];
});
const functionFiles = filesUnder(path.join(ROOT, 'base44/functions'), ['.ts']);
const browserFiles = filesUnder(path.join(ROOT, 'src'), ['.js', '.jsx']);
const rel = (file) => path.relative(ROOT, file);
for (const stem of ['WithdrawalRequest', 'RideBooking', 'LoyaltyTransaction', 'Booking', 'AvailabilityRequest']) {
  const asCaller = new RegExp(`(?<!asServiceRole)\\.entities\\.${stem}\\.(create|bulkCreate)\\(`);
  const inBrowser = new RegExp(`\\b${stem}\\.(create|bulkCreate)\\(`);
  const offenders = [
    ...functionFiles.filter((f) => asCaller.test(fs.readFileSync(f, 'utf8'))),
    ...browserFiles.filter((f) => inBrowser.test(fs.readFileSync(f, 'utf8'))),
  ].map(rel);
  check(`nothing creates a ${stem} as the signed-in user`, offenders.length === 0, offenders.join(', '));
}

// ── Vehicles: powertrain ───────────────────────────────────────────────────
// What drives a car is an attribute of the car, kept apart from its category:
// an electric car can be an Economy saloon or a Luxury SUV. Guests see one
// thing from it for now, the Electric badge.
console.log('\n— vehicle powertrain —');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const powertrain = prop('Vehicle', 'powertrain');
check('Vehicle.powertrain offers exactly what the admin form offers',
  sameList(powertrain?.enum, (rides.POWERTRAINS || []).map((p) => p.value)), JSON.stringify(powertrain?.enum));
check('there are four: petrol, diesel, hybrid, electric', sameList(powertrain?.enum, ['petrol', 'diesel', 'hybrid', 'electric']));
check('it is optional and has no default: unset means nobody has said',
  !!powertrain && !(entities.Vehicle?.required || []).includes('powertrain') && powertrain.default === undefined);
check('electric is a powertrain, never a category',
  !(prop('Vehicle', 'category')?.enum || []).some((c) => /electric|hybrid|petrol|diesel/.test(c))
  && !rides.CATEGORIES.some((c) => /electric|\bev\b/i.test(`${c.value} ${c.label}`)));
const badge = (v) => (typeof rides.isElectric === 'function' ? rides.isElectric(v) : 'no isElectric');
check('only an electric car gets the badge',
  same([{ powertrain: 'electric' }, { powertrain: 'hybrid' }, { powertrain: 'petrol' }, { powertrain: 'diesel' }, {}, null].map(badge), [true, false, false, false, false, false]));
const label = (v) => (typeof rides.powertrainLabel === 'function' ? rides.powertrainLabel(v) : 'no powertrainLabel');
check('a powertrain reads as a word, and an unknown one as nothing',
  same(['electric', 'hybrid', 'petrol', 'diesel', '', undefined, 'steam'].map(label), ['Electric', 'Hybrid', 'Petrol', 'Diesel', '', '', '']));
// An electric car has no fuel: the same three policies are about charging.
const policy = (v) => (typeof rides.energyPolicy === 'function' ? rides.energyPolicy(v) : 'no energyPolicy');
check('a petrol car\'s fuel policy reads as before',
  same(['fuel_included', 'guest_pays_fuel', 'fuel_capped'].map((fuel_policy) => policy({ fuel_policy }).label),
    ['Fuel included', 'Guest pays for fuel', 'Fuel capped daily']));
check('an electric car\'s reads as charging',
  same(['fuel_included', 'guest_pays_fuel', 'fuel_capped'].map((fuel_policy) => policy({ fuel_policy, powertrain: 'electric' }).label),
    ['Charging included', 'Guest pays for charging', 'Charging capped daily']));
const cap = (15000).toLocaleString(); // "15,000" here; whatever this machine writes
check('a daily cap is spelled out, in fuel or in charging',
  same([policy({ fuel_policy: 'fuel_capped', fuel_cap_daily_ngn: 15000 }).detail, policy({ fuel_policy: 'fuel_capped', fuel_cap_daily_ngn: 15000, powertrain: 'electric' }).detail],
    [`Fuel covered up to ₦${cap}/day. Anything over is on you.`, `Charging covered up to ₦${cap}/day. Anything over is on you.`]));
check('no cap figure, no cap sentence; no policy, nothing at all',
  same([policy({ fuel_policy: 'fuel_capped' }).detail, policy({ fuel_policy: 'fuel_included', fuel_cap_daily_ngn: 15000 }).detail, policy({}), policy(null)], ['', '', null, null]));
check('a hybrid still burns fuel', policy({ fuel_policy: 'fuel_included', powertrain: 'hybrid' }).label === 'Fuel included');
// The helpers above are only worth pinning if the screens use them.
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
check('the vehicle card shows the badge from isElectric', /\{isElectric\(vehicle\) && \(/.test(source('src/components/ride/VehicleCard.jsx')));
check('the vehicle page shows the badge from isElectric and the fuel line from energyPolicy',
  /\{isElectric\(vehicle\) && \(/.test(source('src/pages/Vehicle.jsx')) && /const energy = energyPolicy\(vehicle\);/.test(source('src/pages/Vehicle.jsx')) && /\{energy\.label\}/.test(source('src/pages/Vehicle.jsx')));
check('the admin form sends a powertrain only once one is chosen, never an empty one',
  /const built = buildVehiclePayload\(form, editingRow\);/.test(source('src/components/admin/VehiclesAdmin.jsx'))
  && !/^\s*powertrain: form\.powertrain,/m.test(source('src/components/admin/VehiclesAdmin.jsx')));
check('Vehicle.powertrain is a string', powertrain?.type === 'string');

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
