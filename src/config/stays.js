// Stay pricing — the client-side mirror.
//
// MIRROR of priceForStay in base44/functions/checkAvailabilityWebhook/entry.ts.
// The server figure is the only one that is ever stored or charged; this copy
// exists so the checkout page can show the guest a number before they submit.
// Keep the two in lockstep — scripts/check-stay-price.mjs executes both and
// fails if they disagree by a naira.
//
// Why this exists at all: until this helper landed, the checkout page computed
// the total in the browser and POSTed it, and the server stored whatever
// arrived. A guest could request any apartment at ₦1, pay ₦1, and get a
// confirmed booking. The server now prices from the Property row and ignores
// the request body entirely.

export const SERVICE_FEE_RATE = 0.025;

const DAY_MS = 24 * 60 * 60 * 1000;

// The longest stay one request can ask for; the server refuses anything longer.
export const MAX_STAY_NIGHTS = 365;

// Whole nights between two YYYY-MM-DD strings. Dates are compared as UTC
// calendar days so a DST-free (WAT) or DST-observing browser gets the same
// answer. Returns 0 for a missing, malformed, or non-positive range.
export function nightsBetween(checkIn, checkOut) {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

// Returns the breakdown the checkout page renders, or null when the property
// has no nightly rate or the stay is shorter than one night.
export function estimateStayPrice(property, nights) {
  const rate = Number(property?.price_per_night) || 0;
  const n = Number(nights) || 0;
  if (!rate || n < 1) return null;
  const subtotal = rate * n;
  const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE);
  const cautionFee = Number(property?.caution_fee) || 0;
  return { nights: n, subtotal, serviceFee, cautionFee, total: subtotal + serviceFee + cautionFee };
}

// ── Booking options and seasonal rates ──────────────────────────────────────
// One property can be booked several ways (1 bedroom, 2 bedrooms, the whole
// house), each with its own nightly price and guest limit, and any of those
// prices can be different for a named stretch of dates. A property with no
// options listed has exactly one: the whole place at price_per_night.
//
// On a row WITH options, price_per_night and max_guests are still the whole
// place: the largest option's. So anything that knows nothing of options (an
// old browser tab, an old copy of this function, a list that prints one
// price) quotes and charges a real offer, and never a small option's price
// for the whole house. Naming no option means the same thing: the largest.

// The ways a property can be booked, smallest first. Bad rows are dropped,
// and a bedroom count listed twice counts once.
export function bookingOptionsOf(property) {
  const listed = property && Array.isArray(property.booking_options) ? property.booking_options : [];
  const out = [];
  for (const o of listed) {
    const bedrooms = Math.round(Number(o && o.bedrooms));
    const price = Math.round(Number(o && o.price_per_night));
    const guests = Math.round(Number(o && o.max_guests));
    if (!(bedrooms >= 1) || !(price > 0) || out.some((x) => x.bedrooms === bedrooms)) continue;
    out.push({ bedrooms, price_per_night: price, max_guests: guests >= 1 ? guests : 0 });
  }
  if (out.length === 0) {
    const price = Math.round(Number(property && property.price_per_night) || 0);
    if (price > 0) {
      out.push({
        bedrooms: Math.round(Number(property.bedrooms) || 0),
        price_per_night: price,
        max_guests: Math.round(Number(property.max_guests) || 0),
        whole: true,
      });
    }
  }
  return out.sort((a, b) => a.bedrooms - b.bedrooms);
}

// What one night costs for one option. `night` is YYYY-MM-DD. A season covers
// its start and end dates inclusive, and only changes an option it prices.
// A place with no options listed (`whole`) has one seasonal price: the one
// saved under its bedroom count, or, if that count has since changed, the
// highest the season lists.
export function nightlyRate(property, option, night) {
  const seasons = property && Array.isArray(property.seasonal_rates) ? property.seasonal_rates : [];
  for (const s of seasons) {
    if (!s || !(String(s.start_date) <= night && night <= String(s.end_date))) continue;
    const listed = (Array.isArray(s.prices) ? s.prices : []).filter((p) => !!p && Math.round(Number(p.price_per_night)) > 0);
    const row = listed.find((p) => Math.round(Number(p.bedrooms)) === option.bedrooms)
      || (option.whole ? listed.reduce((a, b) => (Number(b.price_per_night) > Number(a.price_per_night) ? b : a), listed[0]) : undefined);
    const price = Math.round(Number(row && row.price_per_night));
    if (price > 0) return { rate: price, season: String(s.name || 'Seasonal rate') };
  }
  return { rate: option.price_per_night, season: '' };
}

// The price of a stay, night by night, or null when it cannot be priced.
// `bedrooms` picks the option. Left out, it is the whole place: the largest.
// lines groups consecutive nights at the same rate, for the guest to read.
export function priceStay(property, checkIn, checkOut, bedrooms) {
  const options = bookingOptionsOf(property);
  const wanted = Math.round(Number(bedrooms));
  const option = wanted >= 1 ? options.find((o) => o.bedrooms === wanted) : options[options.length - 1];
  const nights = nightsBetween(checkIn, checkOut);
  if (!option || nights < 1 || nights > MAX_STAY_NIGHTS) return null;
  const first = Date.parse(`${checkIn}T00:00:00Z`);
  const lines = [];
  let subtotal = 0;
  for (let i = 0; i < nights; i += 1) {
    const night = new Date(first + i * DAY_MS).toISOString().slice(0, 10);
    const r = nightlyRate(property, option, night);
    const last = lines[lines.length - 1];
    if (last && last.rate === r.rate && last.season === r.season) last.nights += 1;
    else lines.push({ season: r.season, rate: r.rate, nights: 1, from: night });
    subtotal += r.rate;
  }
  const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE);
  const cautionFee = Number(property && property.caution_fee) || 0;
  return { nights, option, lines, subtotal, serviceFee, cautionFee, total: subtotal + serviceFee + cautionFee };
}

// The options of a property that fit a search: the bedroom count asked for
// (exactly, or four and up for the "4+" choice), a party of `guests`, and a
// nightly price range. Every part is optional. A property is a match when
// ONE option fits all of them at once: the largest option's guest count and
// the cheapest option's price say nothing about each other.
export function optionsForSearch(property, wanted) {
  const w = wanted || {};
  const n = Math.round(Number(w.bedrooms));
  const g = Math.round(Number(w.guests)) || 0;
  const min = Number(w.minPrice) > 0 ? Number(w.minPrice) : 0;
  const max = Number(w.maxPrice) > 0 ? Number(w.maxPrice) : Infinity;
  return bookingOptionsOf(property).filter((o) => (
    (!(n >= 1) || (n >= 4 ? o.bedrooms >= 4 : o.bedrooms === n))
    && !(g > 0 && o.max_guests > 0 && o.max_guests < g)
    && o.price_per_night >= min && o.price_per_night <= max
  ));
}

// What a listing card says about a property. A search (propertyService)
// attaches `matched_option` when it landed on one option and
// `fitting_options` when several fit; without either the card describes
// every option. `openOn` is the bedroom count to open the property page on.
export function cardPricing(property) {
  const options = bookingOptionsOf(property);
  if (options.length <= 1) {
    return {
      price: options[0] ? options[0].price_per_night : 0, from: false, matched: false, note: '', openOn: 0,
      guests: property && property.max_guests, bedrooms: (property && property.bedrooms) || 1,
    };
  }
  const matched = property.matched_option || null;
  if (matched) {
    return {
      price: matched.price_per_night, from: false, matched: true, openOn: matched.bedrooms,
      note: `${matched.bedrooms} bedroom option available${matched.max_guests > 0 ? `, up to ${matched.max_guests} guests` : ''}`,
      guests: matched.max_guests > 0 ? matched.max_guests : property.max_guests, bedrooms: matched.bedrooms,
    };
  }
  const fits = Array.isArray(property.fitting_options) && property.fitting_options.length > 0 ? property.fitting_options : options;
  const list = fits.map((o) => o.bedrooms).join(', ').replace(/, (\d+)$/, ' or $1');
  return {
    price: Math.min(...fits.map((o) => o.price_per_night)), from: true, matched: false,
    note: `Book ${list} bedrooms`, openOn: fits.length < options.length ? fits[0].bedrooms : 0,
    guests: Math.max(...fits.map((o) => o.max_guests)) || property.max_guests, bedrooms: property.bedrooms || fits[fits.length - 1].bedrooms,
  };
}

// What the chat assistant is told about how a property is priced: its
// options when there are several, and the seasonal rates that have not ended
// by `today` (YYYY-MM-DD). A place with one way of booking gets one seasonal
// price_per_night; a place with several gets prices per option. Nothing here
// is trusted for charging: the booking card and the server price the stay.
export function pricingForAssistant(property, today) {
  const options = bookingOptionsOf(property);
  const out = {};
  if (options.length > 1) {
    out.booking_options = options.map((o) => ({ bedrooms: o.bedrooms, price_per_night: o.price_per_night, max_guests: o.max_guests }));
  }
  const seasons = [];
  for (const s of property && Array.isArray(property.seasonal_rates) ? property.seasonal_rates : []) {
    if (!s || !(String(s.end_date) >= String(today || ''))) continue;
    const season = { name: String(s.name || 'Seasonal rate'), start_date: s.start_date, end_date: s.end_date };
    const priced = options
      .map((o) => ({ bedrooms: o.bedrooms, price_per_night: nightlyRate({ seasonal_rates: [s] }, o, String(s.start_date)) }))
      .filter((p) => p.price_per_night.season)
      .map((p) => ({ bedrooms: p.bedrooms, price_per_night: p.price_per_night.rate }));
    if (priced.length === 0) continue;
    if (options.length > 1) season.prices = priced;
    else season.price_per_night = priced[0].price_per_night;
    seasons.push(season);
  }
  if (seasons.length > 0) out.seasonal_rates = seasons;
  return out;
}

// ── The admin form ──────────────────────────────────────────────────────────
// Browser only: the server never sees the form, it prices from the saved row.
// The form keeps every figure as the text the admin typed. Each option row
// has an id of its own, and a season's prices are kept under those ids (or
// under 'full' when the place has one option), NOT under the bedroom count:
// retyping a row's bedrooms must not lose the seasonal prices typed for it.

export const EMPTY_STAY_PRICING = { option_mode: 'full', booking_options: [], seasonal_rates: [] };

const rowId = (row, index) => (row && row.id) || `row${index}`;

// A new option row for the form, with an id no other row has.
export function newOptionRow(rows, fields) {
  const used = (rows || []).map((r, i) => rowId(r, i));
  let n = used.length + 1;
  while (used.includes(`o${n}`)) n += 1;
  return { id: `o${n}`, bedrooms: '', price_per_night: '', max_guests: '', ...(fields || {}) };
}

export function stayPricingFromProperty(property) {
  const options = bookingOptionsOf(property);
  const listed = Array.isArray(property?.booking_options) && property.booking_options.length > 0;
  const multiple = listed && options.length > 0;
  const seasons = Array.isArray(property?.seasonal_rates) ? property.seasonal_rates : [];
  return {
    option_mode: multiple ? 'multiple' : 'full',
    booking_options: multiple
      ? options.map((o, i) => ({ id: `o${i + 1}`, bedrooms: String(o.bedrooms), price_per_night: String(o.price_per_night), max_guests: o.max_guests ? String(o.max_guests) : '' }))
      : [],
    seasonal_rates: seasons.filter(Boolean).map((s) => {
      const prices = {};
      const listed = (Array.isArray(s.prices) ? s.prices : []).filter((p) => p && Number(p.price_per_night) > 0);
      if (multiple) {
        for (const p of listed) {
          const at = options.findIndex((o) => o.bedrooms === Math.round(Number(p.bedrooms)));
          if (at >= 0) prices[`o${at + 1}`] = String(p.price_per_night);
        }
      } else if (listed.length > 0) {
        // The same pick nightlyRate makes for a place with one option.
        const own = options[0] && listed.find((p) => Math.round(Number(p.bedrooms)) === options[0].bedrooms);
        const pick = own || listed.reduce((a, b) => (Number(b.price_per_night) > Number(a.price_per_night) ? b : a), listed[0]);
        prices.full = String(pick.price_per_night);
      }
      return { name: s.name || '', start_date: s.start_date || '', end_date: s.end_date || '', prices };
    }),
  };
}

// Changing the answer to "can guests book part of this property?" keeps what
// was typed. The whole place is taken to be the largest option, so its price,
// guest limit and seasonal prices follow the admin across, in both directions.
// Only the answer on screen can be edited, so what is on screen wins.
export function switchStayPricingMode(form, mode) {
  if (mode === form.option_mode) return form;
  const rows = form.booking_options || [];
  const largestOf = (list) => list.reduce((a, b) => (Number(b.bedrooms) > Number(a.bedrooms) ? b : a), list[0]);
  const keyOf = (list, row) => rowId(row, list.indexOf(row));
  const carry = (from, to) => (form.seasonal_rates || []).map((s) => {
    const prices = s.prices || {};
    return prices[from] ? { ...s, prices: { ...prices, [to]: prices[from] } } : s;
  });
  if (mode === 'multiple') {
    let booking_options = rows;
    if (booking_options.length === 0) {
      const whole = Math.round(Number(form.bedrooms));
      const first = newOptionRow([], { bedrooms: '1' });
      booking_options = whole >= 2
        ? [first, newOptionRow([first], { bedrooms: String(whole), price_per_night: String(form.price_per_night || ''), max_guests: String(form.max_guests || '') })]
        : [first, newOptionRow([first], { bedrooms: '2' })];
    }
    return { ...form, option_mode: 'multiple', booking_options, seasonal_rates: carry('full', keyOf(booking_options, largestOf(booking_options))) };
  }
  if (rows.length === 0) return { ...form, option_mode: 'full' };
  const largest = largestOf(rows);
  return {
    ...form,
    option_mode: 'full',
    price_per_night: largest.price_per_night || form.price_per_night,
    max_guests: largest.max_guests || form.max_guests,
    seasonal_rates: carry(keyOf(rows, largest), 'full'),
  };
}

// Turns the form into the fields to save, or { error } naming what to fix.
// With several options, price_per_night and max_guests on the row are the
// whole place: the largest option's price and the most guests any takes.
export function stayPricingToSave(form) {
  const multiple = form.option_mode === 'multiple';
  let options = [];
  const keys = [];
  let bedrooms = Math.round(Number(form.bedrooms)) || 1;
  let price = Math.round(Number(form.price_per_night)) || 0;
  let guests = Math.round(Number(form.max_guests)) || 1;
  if (multiple) {
    (form.booking_options || []).forEach((row, index) => {
      options.push({
        bedrooms: Math.round(Number(row.bedrooms)),
        price_per_night: Math.round(Number(row.price_per_night)),
        max_guests: Math.round(Number(row.max_guests)),
      });
      keys.push({ key: rowId(row, index), bedrooms: options[index].bedrooms });
    });
    for (let i = 0; i < options.length; i += 1) {
      const o = options[i];
      if (!(o.bedrooms >= 1)) return { error: 'Every booking option needs a number of bedrooms.' };
      if (!(o.price_per_night > 0)) return { error: `Enter a price per night for the ${o.bedrooms}-bedroom option.` };
      if (!(o.max_guests >= 1)) return { error: `Enter the maximum guests for the ${o.bedrooms}-bedroom option.` };
      if (options.findIndex((x) => x.bedrooms === o.bedrooms) !== i) return { error: `The ${o.bedrooms}-bedroom option is listed twice.` };
    }
    if (options.length < 2) return { error: 'Add at least two booking options, or choose "Full property only".' };
    options = options.sort((a, b) => a.bedrooms - b.bedrooms);
    bedrooms = Math.max(bedrooms, options[options.length - 1].bedrooms);
    price = options[options.length - 1].price_per_night;
    guests = Math.max(...options.map((o) => o.max_guests));
  } else {
    if (!(price > 0)) return { error: 'Enter a price per night.' };
    keys.push({ key: 'full', bedrooms });
  }

  const seasons = [];
  for (const s of form.seasonal_rates || []) {
    const name = String(s.name || '').trim();
    if (!name) return { error: 'Every seasonal rate needs a name.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.end_date || '')) return { error: `Choose the start and end dates for "${name}".` };
    if (s.end_date < s.start_date) return { error: `"${name}" ends before it starts.` };
    // A date field accepts a mistyped year (0026, 20266) without complaint.
    if (Number(s.start_date.slice(0, 4)) < 2020 || Number(s.end_date.slice(0, 4)) > 2100) return { error: `Check the year in the dates for "${name}".` };
    const clash = seasons.find((x) => x.start_date <= s.end_date && s.start_date <= x.end_date);
    if (clash) return { error: `"${name}" overlaps "${clash.name}". Two seasonal rates cannot cover the same night.` };
    const prices = [];
    for (const k of keys) {
      const p = Math.round(Number(s.prices && s.prices[k.key]));
      if (p > 0) prices.push({ bedrooms: k.bedrooms, price_per_night: p });
    }
    if (prices.length === 0) return { error: `Enter at least one price for "${name}".` };
    prices.sort((a, b) => a.bedrooms - b.bedrooms);
    seasons.push({ name, start_date: s.start_date, end_date: s.end_date, prices });
  }
  seasons.sort((a, b) => (a.start_date < b.start_date ? -1 : 1));

  return { fields: { price_per_night: price, max_guests: guests, bedrooms, booking_options: options, seasonal_rates: seasons } };
}
