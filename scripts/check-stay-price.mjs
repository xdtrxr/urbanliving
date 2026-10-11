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
import { estimateStayPrice, nightsBetween, SERVICE_FEE_RATE, MAX_STAY_NIGHTS, bookingOptionsOf, priceStay, optionsForSearch, cardPricing, pricingForAssistant, stayPricingFromProperty, stayPricingToSave, switchStayPricingMode, newOptionRow, removeOptionRow } from '../src/config/stays.js';

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

const PRE = `const SERVICE_FEE_RATE = ${SERVICE_FEE_RATE}; const DAY_MS = 86400000; const MAX_STAY_NIGHTS = ${MAX_STAY_NIGHTS};`;
const serverNights = lift('nightsBetween', 'checkIn, checkOut', PRE);
const serverPrice = lift('priceForStay', 'property, nights', PRE);

// ── Source guards ──────────────────────────────────────────────────────────
console.log('\n— source guards —');
// The names the handler takes off the request body, whatever order they are in.
const bodyFields = (SRC.match(/const \{([^}]*)\} = body;/) || [])[1] || '';
check('the handler takes its fields off the body in one place', /property_id/.test(bodyFields) && /bedrooms/.test(bodyFields), true);
check('server never destructures total_price from the body', /total_price|price/.test(bodyFields), false);
check('nothing else reads a price off the body', /body\s*(\?\.|\.|\[)\s*['"]?(total_price|price_per_night|subtotal|amount)/.test(SRC), false);
check('server-side stay cap matches the client constant', new RegExp(`const MAX_STAY_NIGHTS = ${MAX_STAY_NIGHTS};`).test(SRC), true);
check('the Booking and the request are written with the service role, never as the guest',
  /asServiceRole\.entities\.Booking\.create\(/.test(SRC) && /asServiceRole\.entities\.AvailabilityRequest\.create\(/.test(SRC)
  && !/base44\.entities\.(Booking|AvailabilityRequest)\.create\(/.test(SRC), true);
check('server stores the computed total on the Booking',
  /const total_price = pricing\.total;/.test(SRC) && /\n\s*total_price,\n[\s\S]{0,300}bedrooms_booked: options\.length > 1 \? pricing\.option\.bedrooms/.test(SRC), true);
check('the price comes from priceStay, night by night', /const pricing = priceStay\(property, check_in, check_out, bedrooms\);/.test(SRC), true);
check('server prices from the Property row', /const property = await getOrNull\(base44\.asServiceRole\.entities\.Property, property_id\);/.test(SRC), true);
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
check('a property with no options has one: the whole place', bookingOptionsOf({ bedrooms: 3, price_per_night: 90000, max_guests: 6 }), [{ bedrooms: 3, price_per_night: 90000, max_guests: 6, whole: true }]);
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
both('several options and none named is the whole place: the largest', [duplex, '2026-12-01', '2026-12-03', undefined], (p) => p.option.bedrooms === 4 && p.subtotal === 2 * 210000);
for (const junk of [null, '', 'abc', 0, -1, [1, 2], {}]) {
  both(`a nonsense option (${JSON.stringify(junk)}) can never buy a cheaper price than the whole place`, [duplex, '2026-12-01', '2026-12-03', junk], (p) => p.option.bedrooms === 4);
}
const wholeHouse = { bedrooms: 4, price_per_night: 210000, max_guests: 8, seasonal_rates: [{ name: 'Peak', start_date: '2026-12-15', end_date: '2027-01-10', prices: [{ bedrooms: 4, price_per_night: 350000 }] }] };
both('a whole-place season applies', [wholeHouse, '2026-12-20', '2026-12-21', undefined], (p) => p.subtotal === 350000);
both('and still applies after the row is given a different bedroom count', [{ ...wholeHouse, bedrooms: 5 }, '2026-12-20', '2026-12-21', undefined], (p) => p.subtotal === 350000);
both('a season priced for another option does not leak onto an option it does not list', [duplex, '2026-12-20', '2026-12-21', 3], (p) => p.subtotal === 190000);
both('one option needs no choosing', [{ bedrooms: 3, price_per_night: 90000 }, '2026-12-01', '2026-12-02', undefined], (p) => p.subtotal === 90000);
both('no nights, no price', [duplex, '2026-12-03', '2026-12-03', 4], (p) => p === null);
both('the fee on an odd subtotal is rounded to the naira, the same way in both copies', [{ bedrooms: 1, price_per_night: 33333, max_guests: 2 }, '2026-10-01', '2026-10-03', undefined], (p) => p.subtotal === 66666 && p.serviceFee === 1667);
const loose = (seasonal_rates) => ({ bedrooms: 4, price_per_night: 210000, max_guests: 8, seasonal_rates });
both('a season saved as date-times is read by its days', [loose([{ name: 'P', start_date: '2026-12-15T00:00:00.000Z', end_date: '2027-01-10T00:00:00.000Z', prices: [{ bedrooms: 4, price_per_night: 350000 }] }]), '2026-12-14', '2026-12-16', undefined], (p) => p.subtotal === 210000 + 350000);
both('a season with no end date never applies, rather than applying for ever', [loose([{ name: 'P', start_date: '2026-12-15', prices: [{ bedrooms: 4, price_per_night: 350000 }] }]), '2027-06-01', '2027-06-03', undefined], (p) => p.subtotal === 420000);
both('nor does one with no start date', [loose([{ name: 'P', start_date: '', end_date: '2027-01-10', prices: [{ bedrooms: 4, price_per_night: 350000 }] }]), '2026-06-01', '2026-06-03', undefined], (p) => p.subtotal === 420000);

// The four pricing functions are COPIES. Same text in both files once the
// TypeScript annotations, the export keyword and the indentation are gone, so
// a change to one that is not made to the other fails here by name.
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'src/config/stays.js'), 'utf8');
const textOf = (src, name) => {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`));
  if (!m) return `no ${name}`;
  return m[0]
    .replace(/\(([^)]*)\)[^{]*\{/, (all, args) => `(${args.replace(/:\s*\w+/g, '')}) {`)
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
};
for (const name of ['nightsBetween', 'bookingOptionsOf', 'nightlyRate', 'priceStay']) {
  check(`${name}: the server copy is the client copy, word for word`, textOf(SRC, name) === textOf(CLIENT_SRC, name), true);
}
check('the server counts a day as the client does', /const DAY_MS = 24 \* 60 \* 60 \* 1000;/.test(SRC) && /const DAY_MS = 24 \* 60 \* 60 \* 1000;/.test(CLIENT_SRC), true);
both('a year is the longest stay that can be priced', [duplex, '2026-01-01', '2027-01-01', 3], (p) => p.nights === 365 && p.subtotal === 365 * 190000);
both('a stay longer than that cannot be priced, however long', [duplex, '2026-01-01', '2027-01-02', 3], (p) => p === null);
both('absurd dates do not walk the calendar', [duplex, '0001-01-01', '9999-12-31', 3], (p) => p === null);

// ── search and the admin form (browser only) ────────────────────────────────
const beds = (list) => list.map((o) => o.bedrooms);
check('a 2-bedroom search finds the duplex by its 2-bedroom option', optionsForSearch(duplex, { bedrooms: 2 }).map((o) => o.price_per_night), [160000]);
check('a 4+ search finds the 4-bedroom option', beds(optionsForSearch(duplex, { bedrooms: 4 })), [4]);
check('a whole-house 4BR is not in a 2-bedroom search', optionsForSearch({ bedrooms: 4, price_per_night: 210000, max_guests: 8 }, { bedrooms: 2 }), []);
check('an option too small for the party does not match', optionsForSearch(duplex, { bedrooms: 1, guests: 3 }), []);
check('with no bedroom count, every option that fits the party matches', beds(optionsForSearch(duplex, { guests: 6 })), [3, 4]);
check('ONE option has to fit the party and the price: 6 guests under 120k is no match', optionsForSearch(duplex, { guests: 6, maxPrice: 120000 }), []);
check('the price range is tested on each option, not on the cheapest', beds(optionsForSearch(duplex, { minPrice: 150000, maxPrice: 200000 })), [2, 3]);
check('a 4+ search tries every option of four and up against the price', beds(optionsForSearch({ booking_options: [{ bedrooms: 4, price_per_night: 200000, max_guests: 8 }, { bedrooms: 5, price_per_night: 260000, max_guests: 10 }] }, { bedrooms: 4, minPrice: 250000 })), [5]);
check('a property with no price matches nothing', optionsForSearch({ bedrooms: 2, max_guests: 4 }, {}), []);

// What the chat assistant is told.
const told = pricingForAssistant(duplex, '2026-10-11');
check('the assistant is given every option with its own price and guests', told.booking_options, [
  { bedrooms: 1, price_per_night: 100000, max_guests: 2 }, { bedrooms: 2, price_per_night: 160000, max_guests: 4 },
  { bedrooms: 3, price_per_night: 190000, max_guests: 6 }, { bedrooms: 4, price_per_night: 210000, max_guests: 8 },
]);
check('and the season, priced per option, without the option it does not change', told.seasonal_rates.map((s) => [s.name, s.prices.map((p) => p.bedrooms)]), [['December Peak', [2, 4]]]);
check('a season that has ended is not mentioned', pricingForAssistant(duplex, '2027-02-01').seasonal_rates, undefined);
check('a whole-place listing gets one seasonal price and no options', pricingForAssistant(wholeHouse, '2026-10-11'), { seasonal_rates: [{ name: 'Peak', start_date: '2026-12-15', end_date: '2027-01-10', price_per_night: 350000 }] });
check('a plain listing adds nothing', pricingForAssistant({ bedrooms: 2, price_per_night: 80000, max_guests: 4 }, '2026-10-11'), {});

// What a card says.
const card = (p) => { const c = cardPricing(p); return [c.price, c.from, c.note, c.guests, c.bedrooms, c.openOn]; };
check('card, whole-place listing: its price, no note', card({ bedrooms: 2, price_per_night: 80000, max_guests: 4 }), [80000, false, '', 4, 2, 0]);
check('card, several options and no search: a "from" price and the list', card(duplex), [100000, true, 'Book 1, 2, 3 or 4 bedrooms', 8, 4, 0]);
check('card, a bedroom search: the matched option', card({ ...duplex, matched_option: { bedrooms: 2, price_per_night: 160000, max_guests: 4 } }), [160000, false, '2 bedroom option available, up to 4 guests', 4, 2, 2]);
const seasonOn = (p, stay, today) => { const c = cardPricing(p, stay, today); return c.season && [c.season.name, c.season.rate, c.season.nights, c.season.of]; };
check('card, searched dates inside a season: the seasonal rate for the option on the card', seasonOn({ ...duplex, matched_option: { bedrooms: 4, price_per_night: 210000, max_guests: 8 } }, { checkIn: '2026-12-20', checkOut: '2026-12-27' }), ['December Peak', 350000, 7, 7]);
check('card, dates that only touch the season: how many of the nights', seasonOn({ ...duplex, matched_option: { bedrooms: 4, price_per_night: 210000, max_guests: 8 } }, { checkIn: '2026-12-13', checkOut: '2026-12-17' }), ['December Peak', 350000, 2, 4]);
check('card, an option the season does not price: nothing to say', seasonOn({ ...duplex, matched_option: { bedrooms: 3, price_per_night: 190000, max_guests: 6 } }, { checkIn: '2026-12-20', checkOut: '2026-12-27' }), null);
check('card, no dates but a season is running today', seasonOn(wholeHouse, null, '2026-12-25'), ['Peak', 350000, 0, 0]);
check('card, no dates and no season today', seasonOn(wholeHouse, null, '2026-10-11'), null);
check('card, a party of 6: priced from the smallest option that fits them, and opens on it', card({ ...duplex, fitting_options: optionsForSearch(duplex, { guests: 6 }) }), [190000, true, 'Book 3 or 4 bedrooms', 8, 4, 3]);

const form = stayPricingFromProperty(duplex);
check('the form opens on "multiple" for a property with options', [form.option_mode, form.booking_options.length], ['multiple', 4]);
const saved = stayPricingToSave({ ...form, bedrooms: '4' });
check('saving the form gives back the same prices', priceStay({ ...duplex, ...saved.fields }, '2026-12-13', '2026-12-17', 4), priceStay(duplex, '2026-12-13', '2026-12-17', 4));
check('the row itself describes the whole place: the largest option\'s price and guests', [saved.fields.price_per_night, saved.fields.max_guests, saved.fields.bedrooms], [210000, 8, 4]);
check('so option-blind code prices the row as the largest option, to the naira', estimateStayPrice({ ...duplex, ...saved.fields }, 2).subtotal, priceStay({ ...duplex, ...saved.fields }, '2026-12-01', '2026-12-03', undefined).subtotal);
const season = (name, start_date, end_date) => ({ name, start_date, end_date, prices: { full: '90000' } });
const whole = { option_mode: 'full', price_per_night: '60000', max_guests: '4', bedrooms: '2', booking_options: [], seasonal_rates: [] };
check('a full-property season prices the whole place', stayPricingToSave({ ...whole, seasonal_rates: [season('Easter', '2027-03-26', '2027-03-29')] }).fields.seasonal_rates[0].prices, [{ bedrooms: 2, price_per_night: 90000 }]);
check('full property saves no options', stayPricingToSave(whole).fields.booking_options, []);
check('two seasons on the same night are refused', /overlaps/.test(stayPricingToSave({ ...whole, seasonal_rates: [season('A', '2027-03-26', '2027-03-29'), season('B', '2027-03-29', '2027-04-02')] }).error), true);
check('back-to-back seasons are fine', stayPricingToSave({ ...whole, seasonal_rates: [season('A', '2027-03-26', '2027-03-29'), season('B', '2027-03-30', '2027-04-02')] }).fields.seasonal_rates.length, 2);
check('a season that ends before it starts is refused', /ends before/.test(stayPricingToSave({ ...whole, seasonal_rates: [season('A', '2027-03-29', '2027-03-26')] }).error), true);
check('a season with no price is refused', /at least one price/.test(stayPricingToSave({ ...whole, seasonal_rates: [{ ...season('A', '2027-03-26', '2027-03-29'), prices: {} }] }).error), true);
check('one option is not "multiple"', /at least two/.test(stayPricingToSave({ ...whole, option_mode: 'multiple', booking_options: [{ bedrooms: '1', price_per_night: '1', max_guests: '2' }] }).error), true);
// Changing between "full property only" and "multiple options" in the form.
const toFull = switchStayPricingMode({ ...form, price_per_night: '100000', max_guests: '8', bedrooms: '4' }, 'full');
check('multiple to full: the whole place takes the LARGEST option\'s price, not the cheapest', [toFull.price_per_night, toFull.max_guests], ['210000', '8']);
check('multiple to full: the season price of the largest option carries across', toFull.seasonal_rates.map((s) => s.prices.full), ['350000']);
check('multiple to full keeps the option rows for a change of mind', toFull.booking_options.length, 4);
const toMany = switchStayPricingMode({ ...whole, bedrooms: '3', seasonal_rates: [season('Easter', '2027-03-26', '2027-03-29')] }, 'multiple');
check('full to multiple: the whole place becomes the largest option', toMany.booking_options, [{ id: 'o1', bedrooms: '1', price_per_night: '', max_guests: '' }, { id: 'o2', bedrooms: '3', price_per_night: '60000', max_guests: '4' }]);
check('full to multiple: its season price follows it', toMany.seasonal_rates[0].prices.o2, '90000');
check('full to multiple with no bedroom count yet starts from two blank rows', switchStayPricingMode({ ...whole, bedrooms: '' }, 'multiple').booking_options.map((o) => o.bedrooms), ['1', '2']);
check('choosing the mode already chosen changes nothing', switchStayPricingMode(whole, 'full'), whole);
check('there and back again saves what was there', stayPricingToSave(switchStayPricingMode(switchStayPricingMode({ ...form, bedrooms: '4' }, 'full'), 'multiple')).fields, saved.fields);

// Retyping an option's bedroom count: the seasonal price typed for that row stays with it.
const retyped = { ...form, bedrooms: '5', booking_options: form.booking_options.map((o) => (o.bedrooms === '2' ? { ...o, bedrooms: '5' } : o)) };
check('an option retyped from 2 to 5 bedrooms keeps its seasonal price', stayPricingToSave(retyped).fields.seasonal_rates[0].prices, [{ bedrooms: 4, price_per_night: 350000 }, { bedrooms: 5, price_per_night: 220000 }]);
// Remove the 4-bedroom row, then add a 5-bedroom one: it must not come up
// holding the December price typed for the 4-bedroom.
const without4 = removeOptionRow(form, 3);
check('removing an option takes its seasonal prices with it', without4.seasonal_rates.map((s) => Object.keys(s.prices).sort()), [['o2']]);
const readded = { ...without4, bedrooms: '5', booking_options: [...without4.booking_options, newOptionRow(without4.booking_options, { bedrooms: '5', price_per_night: '300000', max_guests: '10' }, without4.seasonal_rates)] };
check('a row added afterwards starts with no seasonal price of its own', stayPricingToSave(readded).fields.seasonal_rates[0].prices, [{ bedrooms: 2, price_per_night: 220000 }]);
check('an id still held by a season is not handed to a new row', newOptionRow([{ id: 'o1' }], {}, [{ prices: { o2: '1', o3: '1' } }]).id, 'o4');
check('each option row has an id of its own', new Set(form.booking_options.map((o) => o.id)).size, 4);
check('a season with a mistyped year is refused', /Check the year/.test(stayPricingToSave({ ...whole, seasonal_rates: [season('A', '0026-03-26', '0026-03-29')] }).error), true);

check('the same bedroom count twice is refused', /listed twice/.test(stayPricingToSave({ ...whole, option_mode: 'multiple', booking_options: [{ bedrooms: '1', price_per_night: '1', max_guests: '2' }, { bedrooms: '1', price_per_night: '2', max_guests: '2' }] }).error), true);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
