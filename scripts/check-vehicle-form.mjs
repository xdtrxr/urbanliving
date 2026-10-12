// Admin vehicle form — run with: node scripts/check-vehicle-form.mjs
//
// WHY THIS LIVES IN THE REPO
// A Vehicle update is a partial merge: a field left out of the request keeps
// its old value, and a field that is sent is stored, null included. So what
// the form sends IS the change, and both ways of getting it wrong are silent.
// A box the admin emptied that is simply left out keeps its old value: clear
// the hourly rate to make a car day-hire only, and guests go on seeing hourly
// options. A box the form filled in by itself is saved as if someone chose
// it: the one live car, a van with no category, was one save away from being
// filed under Comfort / Sedan.
//
// This file does not re-implement the form. It opens rows with the loader the
// screen uses and saves them with the builder the screen uses, both in
// src/config/rides.js, and it reads VehiclesAdmin.jsx to make sure the screen
// really does go through that pair.
//
// On the new Function() below: the only input is this repo's own source, read
// from a path this file computes itself. It is a developer script that never
// ships to the browser or to Deno.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CITIES, POWERTRAINS, vehicleFormFrom, buildVehiclePayload, noCategoryLine,
  effectiveCategory, needsCategoryMigration, isElectric, powertrainLabel, energyPolicy,
  supportsHourly, extraHourRate, estimateRidePrice,
} from '../src/config/rides.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN = fs.readFileSync(path.join(ROOT, 'src/components/admin/VehiclesAdmin.jsx'), 'utf8');

let pass = 0;
let fail = 0;
const report = (ok, name, got, want) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
// Exact value.
const check = (name, got, want) => report(Object.is(got, want), name, got, want);
// Structural equality, whatever order the keys come in.
const canon = (value) => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
  : v));
const same = (name, got, want) => report(canon(got) === canon(want), name, got, want);

// The payload of a save that must go through. JSON is how it travels: a key
// holding undefined would vanish on the way and NaN would arrive as null, so
// neither may be in a payload at all. Counted here, checked at the end.
let unsendable = 0;
const save = (form, original) => {
  const built = buildVehiclePayload(form, original);
  if (!built.ok) throw new Error(`a save this file expects to go through was refused: ${built.message}`);
  for (const v of Object.values(built.payload)) {
    if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) unsendable += 1;
  }
  return built.payload;
};

// What an update does to a row: a partial merge. A key that is sent is
// stored, null included. A key that is not sent keeps its value.
const afterSave = (row, payload) => ({ ...row, ...payload });

// Sent on every save, new vehicle or edit, as the form shows them.
const ALWAYS = [
  'name', 'brand', 'category', 'images', 'videos', 'city', 'price_12hr_ngn', 'price_24hr_ngn',
  'amenities', 'pickup_locations', 'active', 'admin_approved', 'min_hours_per_booking',
  'turnaround_hours', 'driver_included',
];
// Sent only when the admin changed them. The value is what each is written as
// when the admin removes it from a car that had one.
const EMPTY = {
  powertrain: null, model_year: null, description: '', registration_number: '',
  price_per_hour_ngn: null, price_extra_hour_ngn: null, price_per_extra_day_ngn: null,
  max_passengers: null, fuel_policy: null, fuel_cap_daily_ngn: null, service_area: '',
};
const OPTIONAL = Object.keys(EMPTY);
// What a payload carries beyond the always-sent fields.
const extras = (payload) => Object.fromEntries(Object.entries(payload).filter(([k]) => !ALWAYS.includes(k)));

// The new-vehicle form and the fuel choices live in the screen. They are
// lifted out of its source rather than copied, so a change there is a change
// here.
const lift = (name, open, close, scope = {}) => {
  const m = SCREEN.match(new RegExp(`const ${name} = (\\${open}[\\s\\S]*?\\n\\${close});`));
  if (!m) throw new Error(`could not find ${name} in VehiclesAdmin.jsx`);
  return new Function(...Object.keys(scope), `return (${m[1]});`)(...Object.values(scope));
};
const EMPTY_FORM = lift('EMPTY_FORM', '{', '}', { CITIES });
const FUEL_POLICIES = lift('FUEL_POLICIES', '[', ']');
const NOT_SET = (SCREEN.match(/const NOT_SET = '([^']*)';/) || [])[1];

const PHOTO = 'https://base44.app/api/apps/0123456789abcdef01234567/files/car.jpg';

// A car with every box filled.
const FULL = {
  id: 'v-full', name: 'Toyota Prado VXR', brand: 'Toyota', category: 'suv', powertrain: 'petrol', model_year: 2022,
  description: 'Spacious.', images: [PHOTO], videos: [], city: 'Lagos', registration_number: 'ABC-123-XY',
  price_per_hour_ngn: 15000, price_extra_hour_ngn: 18000, price_12hr_ngn: 60000, price_24hr_ngn: 100000,
  price_per_extra_day_ngn: 90000, max_passengers: 7, amenities: ['wifi'], fuel_policy: 'fuel_capped',
  fuel_cap_daily_ngn: 15000, pickup_locations: ['Ikeja', 'Lekki'], service_area: 'Anywhere in Lagos.',
  active: true, admin_approved: false, min_hours_per_booking: 2, turnaround_hours: 0, driver_included: true,
  rating: 4.5, reviews_count: 12,
};
// A car from before the price tiers, with none of the optional fields.
const LEGACY = {
  id: 'v-legacy', name: 'Hiace bus', brand: 'Toyota', vehicle_type: 'minibus', city: 'Abuja', images: [PHOTO],
  price_12hr_ngn: 200000, price_24hr_ngn: 350000, active: true, admin_approved: true,
};
// The same car with every optional field present but empty: null, the empty
// string, and the 0 that older saves wrote for a seat count left blank.
const HOLLOW = {
  ...LEGACY, powertrain: null, model_year: null, description: '', registration_number: null,
  price_per_hour_ngn: null, price_extra_hour_ngn: null, price_per_extra_day_ngn: null, max_passengers: 0,
  fuel_policy: null, fuel_cap_daily_ngn: null, service_area: '',
};
// The one live car on 2026-10-12, as the data browser shows it. The photo
// stands in for its real ones, which the form will not save without.
const LIVE = {
  name: 'Sprinter bus Short', brand: 'Mercedes benz', city: 'Abuja', vehicle_type: 'van',
  fuel_policy: 'fuel_included', price_12hr_ngn: 450000, price_24hr_ngn: 900000, max_passengers: 6,
  model_year: 2026, min_hours_per_booking: 12, price_per_extra_day_ngn: null, fuel_cap_daily_ngn: null,
  images: [PHOTO],
};

const fullForm = vehicleFormFrom(FULL);
const legacyForm = vehicleFormFrom(LEGACY);
const hollowForm = vehicleFormFrom(HOLLOW);
const liveForm = vehicleFormFrom(LIVE);

// ── The screen goes through the loader and the builder ─────────────────────
// Everything below runs the pair in rides.js. It is only worth running if the
// screen opens and saves through them and through nothing else.
console.log('\n— the screen goes through the loader and the builder —');
check('the edit form is opened with vehicleFormFrom', /setForm\(vehicleFormFrom\(vehicle\)\);/.test(SCREEN), true);
check('and the row it was opened on is kept, to compare the save with', /setEditingRow\(vehicle\);/.test(SCREEN), true);
check('a save is built by buildVehiclePayload from the form and that row',
  /const built = buildVehiclePayload\(form, editingRow\);/.test(SCREEN) && /const \{ payload \} = built;/.test(SCREEN), true);
check('what is sent is that payload, for an edit and for a new vehicle',
  /Vehicle\.update\(editingId, payload\)/.test(SCREEN) && /Vehicle\.create\(payload\)/.test(SCREEN), true);
check('a refusal goes to the form\'s error area',
  /if \(!built\.ok\) \{[\s\S]{0,300}?throw new Error\(built\.message\);/.test(SCREEN)
  && /setError\(err\?\.message \|\| 'Failed to save vehicle'\);/.test(SCREEN), true);
check('after a save, the row to compare with is the row as saved',
  /setEditingRow\(vehicleId \? \{ \.\.\.editingRow, \.\.\.payload, id: vehicleId \} : null\);/.test(SCREEN), true);
check('leaving an edit forgets that row, so the next new vehicle is not saved over it',
  /const resetForm = \(\) => \{[\s\S]{0,200}?setEditingRow\(null\);\n {2}\};/.test(SCREEN) && /const editingId = editingRow\?\.id \|\| null;/.test(SCREEN), true);
check('the screen builds no vehicle payload of its own',
  /price_12hr_ngn: Number\(|fuel_policy: form\.fuel_policy|category: form\.category|powertrain: form\.powertrain/.test(SCREEN), false);
check('and fills in no value of its own when it opens a row', /\bvehicle\.[a-z_0-9]+ (\|\||\?\?) /.test(SCREEN), false);
check('"Not set" has a value of its own: not empty, and not one of the real choices',
  !!NOT_SET && ![...POWERTRAINS, ...FUEL_POLICIES].some((c) => c.value === NOT_SET), true);
check('the Powertrain and fuel policy selects both offer it',
  (SCREEN.match(/<SelectItem value=\{NOT_SET\}>Not set<\/SelectItem>/g) || []).length, 2);
check('both show it for a choice nobody has made',
  ['powertrain', 'fuel_policy'].every((f) => SCREEN.includes(`value={form.${f} || NOT_SET}`)), true);
check('and both keep it in the form as the empty string, never as itself',
  ['powertrain', 'fuel_policy'].every((f) => SCREEN.includes(`setForm({ ...form, ${f}: value === NOT_SET ? '' : value })`)), true);
check('the Category select can show that nothing is chosen, with a line under it saying why',
  /<SelectValue placeholder="Choose a category" \/>/.test(SCREEN)
  && /const noCategory = noCategoryLine\(editingRow\);/.test(SCREEN) && /\{noCategory\}<\/p>/.test(SCREEN), true);

// ── A new vehicle ──────────────────────────────────────────────────────────
console.log('\n— a new vehicle: blanks are left out —');
const YEAR = new Date().getFullYear();
const fresh = {
  ...EMPTY_FORM, name: '  Toyota Prado VXR ', brand: ' Toyota ', images: [PHOTO],
  price_12hr_ngn: '60000', price_24hr_ngn: '100000',
};
const freshPayload = save(fresh, null);
same('only the required boxes filled: the always-sent fields and the three choices the form opens on', freshPayload, {
  name: 'Toyota Prado VXR', brand: 'Toyota', category: 'comfort', images: [PHOTO], videos: [], city: CITIES[0],
  price_12hr_ngn: 60000, price_24hr_ngn: 100000, amenities: [], pickup_locations: [], active: true,
  admin_approved: true, min_hours_per_booking: 1, turnaround_hours: 1, driver_included: true,
  model_year: YEAR, max_passengers: 4, fuel_policy: 'fuel_included',
});
same('none of the boxes left blank is sent',
  ['powertrain', 'description', 'registration_number', 'price_per_hour_ngn', 'price_extra_hour_ngn', 'price_per_extra_day_ngn', 'fuel_cap_daily_ngn', 'service_area'].filter((k) => k in freshPayload), []);
const blanked = save({ ...fresh, model_year: '', max_passengers: '', fuel_policy: '' }, null);
same('with the year and seats emptied and the fuel policy put to Not set, no optional field is sent at all',
  Object.keys(blanked).sort(), [...ALWAYS].sort());
check('nothing a new vehicle sends is null or an empty string',
  [...Object.values(freshPayload), ...Object.values(blanked)].some((v) => v === null || v === ''), false);
const filled = save({
  ...fresh, powertrain: 'electric', model_year: '2024', description: ' Quiet. ', registration_number: ' ABC-123-XY ',
  price_per_hour_ngn: '15000', price_extra_hour_ngn: '18000', price_per_extra_day_ngn: '90000', max_passengers: '7',
  fuel_policy: 'fuel_capped', fuel_cap_daily_ngn: '15000', pickup_locations: 'Maitama, Wuse , ,NAIA Airport',
  service_area: ' Abuja and Suleja. ',
}, null);
same('what is typed is sent: numbers as numbers, text trimmed', extras(filled), {
  powertrain: 'electric', model_year: 2024, description: 'Quiet.', registration_number: 'ABC-123-XY',
  price_per_hour_ngn: 15000, price_extra_hour_ngn: 18000, price_per_extra_day_ngn: 90000, max_passengers: 7,
  fuel_policy: 'fuel_capped', fuel_cap_daily_ngn: 15000, service_area: 'Abuja and Suleja.',
});
same('pickup areas are split on the commas', filled.pickup_locations, ['Maitama', 'Wuse', 'NAIA Airport']);
check('a cap typed and then hidden by choosing another policy is not sent',
  'fuel_cap_daily_ngn' in save({ ...fresh, fuel_policy: 'guest_pays_fuel', fuel_cap_daily_ngn: '15000' }, null), false);
check('a new vehicle still opens on Comfort / Sedan, this year, 4 seats and fuel included',
  [EMPTY_FORM.category, EMPTY_FORM.model_year, EMPTY_FORM.max_passengers, EMPTY_FORM.fuel_policy].join(), `comfort,${YEAR},4,fuel_included`);
same('no photo is refused, as before', buildVehiclePayload({ ...fresh, images: [] }, null), { ok: false, message: 'Add at least one image.' });
same('a missing 12-hour or 24-hour price is refused, as before',
  [buildVehiclePayload({ ...fresh, price_12hr_ngn: '' }, null), buildVehiclePayload({ ...fresh, price_24hr_ngn: '' }, null)],
  [{ ok: false, message: 'Both 12-hour and 24-hour prices are required.' }, { ok: false, message: 'Both 12-hour and 24-hour prices are required.' }]);

// ── Opening a row ──────────────────────────────────────────────────────────
// Whatever the form shows, a save may write. So it shows what the row has.
console.log('\n— opening a row: the form shows what the row has —');
same('a car with every box filled opens on every one of them',
  OPTIONAL.map((k) => String(fullForm[k])), OPTIONAL.map((k) => String(FULL[k])));
same('a car with none of the optional fields opens with every one of those boxes blank',
  OPTIONAL.map((k) => legacyForm[k]), OPTIONAL.map(() => ''));
same('so does one that holds them as null, as the empty string or as 0 seats',
  OPTIONAL.map((k) => hollowForm[k]), OPTIONAL.map(() => ''));
check('no fuel policy opens as Not set, not as Fuel included', legacyForm.fuel_policy, '');
check('no year opens blank, not as this year', legacyForm.model_year, '');
check('no seat count opens blank, not as 4', legacyForm.max_passengers, '');
check('no category opens with none chosen, not as Comfort / Sedan', legacyForm.category, '');
check('a car that has a category opens on it', fullForm.category, 'suv');

// ── An edit nobody touched ─────────────────────────────────────────────────
console.log('\n— an edit nobody touched writes nothing new —');
const untouched = save(fullForm, FULL);
same('a full car, opened and saved: the always-sent fields and nothing else', Object.keys(untouched).sort(), [...ALWAYS].sort());
same('and the row is exactly what it was', afterSave(FULL, untouched), FULL);
const legacySaved = save({ ...legacyForm, category: 'suv' }, LEGACY);
same('a legacy car, given a category and nothing else, gains no powertrain, fuel policy, year or seats',
  ['powertrain', 'fuel_policy', 'model_year', 'max_passengers'].filter((k) => k in legacySaved), []);
same('nor any other optional field', extras(legacySaved), {});
same('one that holds them empty has none of them rewritten', extras(save({ ...hollowForm, category: 'suv' }, HOLLOW)), {});
// A number field can hold anything if the row was typed into the data
// browser. Every reader takes that as "not set"; so does the form, and it
// neither rewrites it nor sends the NaN it would turn into.
const GARBLED = { ...FULL, price_extra_hour_ngn: 'call us', model_year: 'soon' };
same('a number field holding words is left as it is', extras(save(vehicleFormFrom(GARBLED), GARBLED)), {});
check('and words in a number box of a new vehicle are not sent', 'price_per_hour_ngn' in save({ ...fresh, price_per_hour_ngn: 'call us' }, null), false);

// ── An edit that empties a box ─────────────────────────────────────────────
console.log('\n— an edit that empties a box writes an explicit empty value —');
for (const key of OPTIONAL) {
  // Putting the policy to Not set takes the cap box off the form with it.
  const want = key === 'fuel_policy' ? { fuel_policy: null, fuel_cap_daily_ngn: null } : { [key]: EMPTY[key] };
  same(`${key}, emptied on a car that had it, is sent as ${JSON.stringify(EMPTY[key])} and nothing else is`,
    extras(save({ ...fullForm, [key]: '' }, FULL)), want);
}
const allEmptied = save({ ...fullForm, ...Object.fromEntries(OPTIONAL.map((k) => [k, ''])) }, FULL);
same('every box emptied at once: null for each number and choice, the empty string for each free text', extras(allEmptied), EMPTY);
check('before: the car takes hourly bookings', supportsHourly(FULL), true);
check('after the hourly rate is emptied and saved: it is day-hire only',
  supportsHourly(afterSave(FULL, save({ ...fullForm, price_per_hour_ngn: '' }, FULL))), false);
same('a box emptied on a car that never had a value there sends nothing',
  extras(save({ ...legacyForm, category: 'suv', ...Object.fromEntries(OPTIONAL.map((k) => [k, ''])) }, LEGACY)), {});
same('a new figure is sent, alone', extras(save({ ...fullForm, price_per_hour_ngn: '20000' }, FULL)), { price_per_hour_ngn: 20000 });
same('the same figure typed again is not', extras(save({ ...fullForm, price_per_hour_ngn: '15000' }, FULL)), {});
same('a year and a seat count typed on a car that had neither are sent',
  extras(save({ ...legacyForm, category: 'suv', model_year: '2019', max_passengers: '14' }, LEGACY)), { model_year: 2019, max_passengers: 14 });

// The cap box is on the form only while the policy is "capped".
const STALE = { ...FULL, fuel_policy: 'guest_pays_fuel' };
same('moving a car off the capped policy takes its cap along',
  extras(save({ ...fullForm, fuel_policy: 'fuel_included' }, FULL)), { fuel_policy: 'fuel_included', fuel_cap_daily_ngn: null });
same('a cap left on a car that is not capped is not on the form, and is left alone',
  extras(save(vehicleFormFrom(STALE), STALE)), {});
same('and it is what the box shows if that car is then capped',
  extras(save({ ...vehicleFormFrom(STALE), fuel_policy: 'fuel_capped' }, STALE)), { fuel_policy: 'fuel_capped' });

// ── Not set ────────────────────────────────────────────────────────────────
// The selects keep "Not set" in the form as the empty string (pinned above).
console.log('\n— choosing Not set —');
const unpowered = save({ ...fullForm, powertrain: '' }, FULL);
check('on a car that had a powertrain: null is sent', unpowered.powertrain, null);
check('on a car that never had one: nothing is sent', 'powertrain' in save({ ...legacyForm, category: 'suv', powertrain: '' }, LEGACY), false);
same('picking one is sent', extras(save({ ...legacyForm, category: 'suv', powertrain: 'hybrid' }, LEGACY)), { powertrain: 'hybrid' });
same('changing one is sent', extras(save({ ...fullForm, powertrain: 'electric' }, FULL)), { powertrain: 'electric' });
same('the fuel policy, on a car that had one: null is sent',
  extras(save({ ...liveForm, category: 'suv', fuel_policy: '' }, LIVE)), { fuel_policy: null });
check('the fuel policy, on a car that never had one: nothing is sent',
  'fuel_policy' in save({ ...legacyForm, category: 'suv', fuel_policy: '' }, LEGACY), false);
const cleared = afterSave(FULL, unpowered);
same('a powertrain set back to Not set reads as none: no badge, no label', [isElectric(cleared), powertrainLabel(cleared.powertrain)], [false, '']);
check('a fuel policy set back to Not set reads as none', energyPolicy(afterSave(LIVE, save({ ...liveForm, category: 'suv', fuel_policy: '' }, LIVE))), null);

// ── A car with no category ─────────────────────────────────────────────────
console.log('\n— a car with no category —');
check('the live car has none, and guests see it under SUV through the fallback',
  [LIVE.category, effectiveCategory(LIVE), needsCategoryMigration(LIVE)].join(), ',suv,true');
check('the line under the select says so', noCategoryLine(LIVE), 'This car has no category yet. Guests see it under SUV today.');
check('it names wherever the fallback puts the car', noCategoryLine({ vehicle_type: 'luxury_sedan' }), 'This car has no category yet. Guests see it under Luxury today.');
check('a car the fallback cannot place is said to be unfindable', noCategoryLine({ name: 'Mystery' }), 'This car has no category yet, so guests cannot find it by browsing.');
same('no line for a car that has a category, or for a new vehicle', [noCategoryLine(FULL), noCategoryLine(null)], ['', '']);
same('saving it without choosing one is refused, and says what to do',
  buildVehiclePayload(liveForm, LIVE), { ok: false, message: 'Choose a category. This car does not have one yet.' });
check('whatever else was changed', buildVehiclePayload({ ...liveForm, powertrain: 'diesel', price_per_hour_ngn: '50000' }, LIVE).ok, false);
check('a value that is not one of the five is refused too', buildVehiclePayload({ ...liveForm, category: 'van' }, LIVE).ok, false);
check('once one is chosen the save goes through', buildVehiclePayload({ ...liveForm, category: 'executive' }, LIVE).ok, true);

// ── The live car ───────────────────────────────────────────────────────────
console.log('\n— the live car, saved with only a category and a powertrain chosen —');
const livePayload = save({ ...liveForm, category: 'suv', powertrain: 'diesel' }, LIVE);
same('the whole request', livePayload, {
  name: 'Sprinter bus Short', brand: 'Mercedes benz', category: 'suv', images: [PHOTO], videos: [], city: 'Abuja',
  price_12hr_ngn: 450000, price_24hr_ngn: 900000, amenities: [], pickup_locations: [], active: true,
  admin_approved: true, min_hours_per_booking: 12, turnaround_hours: 1, driver_included: true,
  powertrain: 'diesel',
});
same('beyond the always-sent fields, only the powertrain is written', extras(livePayload), { powertrain: 'diesel' });
same('every always-sent field the row already had goes back as it was',
  ALWAYS.filter((k) => k in LIVE && canon(livePayload[k]) !== canon(LIVE[k])), []);
same('its fuel policy, seats, year, extra-day rate and fuel cap are not rewritten',
  ['fuel_policy', 'max_passengers', 'model_year', 'price_per_extra_day_ngn', 'fuel_cap_daily_ngn'].filter((k) => k in livePayload), []);
check('its old body style is not touched', 'vehicle_type' in livePayload, false);
const liveSaved = afterSave(LIVE, livePayload);
same('afterwards it has the category the admin chose and no longer needs one',
  [liveSaved.category, effectiveCategory(liveSaved), needsCategoryMigration(liveSaved), noCategoryLine(liveSaved)], ['suv', 'suv', false, '']);
same('and everything else about it reads as before',
  [liveSaved.fuel_policy, energyPolicy(liveSaved).label, liveSaved.max_passengers, liveSaved.model_year, liveSaved.min_hours_per_booking, liveSaved.price_per_extra_day_ngn, liveSaved.fuel_cap_daily_ngn, supportsHourly(liveSaved)],
  ['fuel_included', 'Fuel included', 6, 2026, 12, null, null, false]);

// ── A save that is retried ─────────────────────────────────────────────────
// When the costing write fails the form stays open, and the screen keeps the
// row as just saved. The second save is compared with that.
console.log('\n— a save that is retried —');
const firstTry = save({ ...liveForm, category: 'suv', price_per_hour_ngn: '50000' }, LIVE);
const savedOnce = afterSave(LIVE, firstTry);
same('the same form saved again writes nothing optional', extras(save({ ...liveForm, category: 'suv', price_per_hour_ngn: '50000' }, savedOnce)), {});
same('an hourly rate saved a moment ago and now emptied is removed',
  extras(save({ ...liveForm, category: 'suv', price_per_hour_ngn: '' }, savedOnce)), { price_per_hour_ngn: null });
same('the same for a vehicle that was new a moment ago',
  extras(save({ ...fresh, model_year: '' }, afterSave({ id: 'v-new' }, freshPayload))), { model_year: null });

// ── What the empty values read as ──────────────────────────────────────────
// The screens read these fields through the helpers below; a null or an empty
// string written by the form must read exactly as a field that was never set.
console.log('\n— null and the empty string read as "not set" —');
same('no powertrain: no Electric badge and no label',
  [isElectric({ powertrain: null }), isElectric({ powertrain: '' }), powertrainLabel(null), powertrainLabel('')], [false, false, '', '']);
same('no fuel policy: no fuel line at all', [energyPolicy({ fuel_policy: null }), energyPolicy({ fuel_policy: '' })], [null, null]);
check('a capped policy with the cap removed has no cap sentence', energyPolicy({ fuel_policy: 'fuel_capped', fuel_cap_daily_ngn: null }).detail, '');
same('no hourly rate: no hourly options and no hourly price',
  [supportsHourly({ price_per_hour_ngn: null }), estimateRidePrice({ ...FULL, price_per_hour_ngn: null }, { tier: 'hourly', hours: 3 })], [false, null]);
check('no extra-hour rate: the hourly rate applies', extraHourRate({ price_per_hour_ngn: 15000, price_extra_hour_ngn: null }), 15000);
check('neither rate: no overage rule', extraHourRate({ price_per_hour_ngn: null, price_extra_hour_ngn: null }), null);
check('no extra-day rate: each further day costs the 24-hour price',
  estimateRidePrice({ price_24hr_ngn: 100000, price_per_extra_day_ngn: null }, { tier: 'multi_day', days: 3 }), 300000);
const emptied = afterSave(FULL, allEmptied);
same('a car with every optional field emptied reads like one that never had them',
  [isElectric(emptied), energyPolicy(emptied), supportsHourly(emptied), extraHourRate(emptied), estimateRidePrice(emptied, { tier: 'multi_day', days: 2 })],
  [isElectric(LEGACY), energyPolicy(LEGACY), supportsHourly(LEGACY), extraHourRate(LEGACY), 200000]);

// ── The schema ─────────────────────────────────────────────────────────────
console.log('\n— against the Vehicle schema —');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'base44/entities/Vehicle.jsonc'), 'utf8')
  .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'));
same('every field the form writes is a field of Vehicle', [...ALWAYS, ...OPTIONAL].filter((k) => !(k in schema.properties)), []);
same('the two lists above are everything the form writes: nothing is in both',
  [ALWAYS.filter((k) => OPTIONAL.includes(k)), Object.keys(filled).filter((k) => !ALWAYS.includes(k) && !OPTIONAL.includes(k))], [[], []]);
same('a removed number or choice is written as null, removed free text as the empty string',
  OPTIONAL.map((k) => EMPTY[k]), OPTIONAL.map((k) => (schema.properties[k].type === 'string' && !schema.properties[k].enum ? '' : null)));
check('no optional field is required, so a new vehicle may leave any of them out',
  OPTIONAL.some((k) => schema.required.includes(k)), false);
same('the fuel policy select offers exactly what the schema allows', FUEL_POLICIES.map((f) => f.value), schema.properties.fuel_policy.enum);

check('no payload in this run carried undefined or NaN', unsendable, 0);

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
