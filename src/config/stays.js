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
      });
    }
  }
  return out.sort((a, b) => a.bedrooms - b.bedrooms);
}

// What one night costs for one option. `night` is YYYY-MM-DD. A season covers
// its start and end dates inclusive, and only changes an option it prices.
export function nightlyRate(property, option, night) {
  const seasons = property && Array.isArray(property.seasonal_rates) ? property.seasonal_rates : [];
  for (const s of seasons) {
    if (!s || !(String(s.start_date) <= night && night <= String(s.end_date))) continue;
    const row = (Array.isArray(s.prices) ? s.prices : []).find((p) => !!p && Math.round(Number(p.bedrooms)) === option.bedrooms);
    const price = Math.round(Number(row && row.price_per_night));
    if (price > 0) return { rate: price, season: String(s.name || 'Seasonal rate') };
  }
  return { rate: option.price_per_night, season: '' };
}

// The price of a stay, night by night, or null when it cannot be priced.
// `bedrooms` picks the option; it may be left out when there is only one.
// lines groups consecutive nights at the same rate, for the guest to read.
export function priceStay(property, checkIn, checkOut, bedrooms) {
  const options = bookingOptionsOf(property);
  const wanted = Math.round(Number(bedrooms));
  const option = options.length === 1 && !(wanted >= 1) ? options[0] : options.find((o) => o.bedrooms === wanted);
  const nights = nightsBetween(checkIn, checkOut);
  if (!option || nights < 1) return null;
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

// The option a bedroom search lands on: exactly that many bedrooms, or four
// and up for the "4+" choice. Null when the property cannot be booked that
// way, or when `guests` is given and the option is too small for them.
export function optionForSearch(property, bedrooms, guests) {
  const n = Math.round(Number(bedrooms));
  if (!(n >= 1)) return null;
  const g = Math.round(Number(guests)) || 0;
  return bookingOptionsOf(property).find((o) => (n >= 4 ? o.bedrooms >= 4 : o.bedrooms === n) && !(g > 0 && o.max_guests > 0 && o.max_guests < g)) || null;
}

// ── The admin form ──────────────────────────────────────────────────────────
// Browser only: the server never sees the form, it prices from the saved row.
// The form keeps every figure as the text the admin typed. A season's prices
// are keyed by bedroom count, or by 'full' when the place has one option.

export const EMPTY_STAY_PRICING = { option_mode: 'full', booking_options: [], seasonal_rates: [] };

export function stayPricingFromProperty(property) {
  const options = bookingOptionsOf(property);
  const listed = Array.isArray(property?.booking_options) && property.booking_options.length > 0;
  const multiple = listed && options.length > 0;
  const seasons = Array.isArray(property?.seasonal_rates) ? property.seasonal_rates : [];
  return {
    option_mode: multiple ? 'multiple' : 'full',
    booking_options: multiple
      ? options.map((o) => ({ bedrooms: String(o.bedrooms), price_per_night: String(o.price_per_night), max_guests: o.max_guests ? String(o.max_guests) : '' }))
      : [],
    seasonal_rates: seasons.filter(Boolean).map((s) => {
      const prices = {};
      for (const p of Array.isArray(s.prices) ? s.prices : []) {
        if (!p || !(Number(p.price_per_night) > 0)) continue;
        if (multiple) prices[String(Math.round(Number(p.bedrooms)))] = String(p.price_per_night);
        else if (!prices.full) prices.full = String(p.price_per_night);
      }
      return { name: s.name || '', start_date: s.start_date || '', end_date: s.end_date || '', prices };
    }),
  };
}

// Turns the form into the fields to save, or { error } naming what to fix.
// price_per_night and max_guests stay on the row as the cheapest price and
// the largest guest count, so lists and filters that read them keep working.
export function stayPricingToSave(form) {
  const multiple = form.option_mode === 'multiple';
  let options = [];
  let bedrooms = Math.round(Number(form.bedrooms)) || 1;
  let price = Math.round(Number(form.price_per_night)) || 0;
  let guests = Math.round(Number(form.max_guests)) || 1;
  if (multiple) {
    for (const row of form.booking_options || []) {
      const o = {
        bedrooms: Math.round(Number(row.bedrooms)),
        price_per_night: Math.round(Number(row.price_per_night)),
        max_guests: Math.round(Number(row.max_guests)),
      };
      if (!(o.bedrooms >= 1)) return { error: 'Every booking option needs a number of bedrooms.' };
      if (!(o.price_per_night > 0)) return { error: `Enter a price per night for the ${o.bedrooms}-bedroom option.` };
      if (!(o.max_guests >= 1)) return { error: `Enter the maximum guests for the ${o.bedrooms}-bedroom option.` };
      if (options.some((x) => x.bedrooms === o.bedrooms)) return { error: `The ${o.bedrooms}-bedroom option is listed twice.` };
      options.push(o);
    }
    if (options.length < 2) return { error: 'Add at least two booking options, or choose "Full property only".' };
    options = options.sort((a, b) => a.bedrooms - b.bedrooms);
    bedrooms = Math.max(bedrooms, options[options.length - 1].bedrooms);
    price = Math.min(...options.map((o) => o.price_per_night));
    guests = Math.max(...options.map((o) => o.max_guests));
  } else if (!(price > 0)) {
    return { error: 'Enter a price per night.' };
  }

  const seasons = [];
  for (const s of form.seasonal_rates || []) {
    const name = String(s.name || '').trim();
    if (!name) return { error: 'Every seasonal rate needs a name.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.end_date || '')) return { error: `Choose the start and end dates for "${name}".` };
    if (s.end_date < s.start_date) return { error: `"${name}" ends before it starts.` };
    const clash = seasons.find((x) => x.start_date <= s.end_date && s.start_date <= x.end_date);
    if (clash) return { error: `"${name}" overlaps "${clash.name}". Two seasonal rates cannot cover the same night.` };
    const prices = [];
    const keys = multiple ? options.map((o) => ({ key: String(o.bedrooms), bedrooms: o.bedrooms })) : [{ key: 'full', bedrooms }];
    for (const k of keys) {
      const p = Math.round(Number(s.prices && s.prices[k.key]));
      if (p > 0) prices.push({ bedrooms: k.bedrooms, price_per_night: p });
    }
    if (prices.length === 0) return { error: `Enter at least one price for "${name}".` };
    seasons.push({ name, start_date: s.start_date, end_date: s.end_date, prices });
  }
  seasons.sort((a, b) => (a.start_date < b.start_date ? -1 : 1));

  return { fields: { price_per_night: price, max_guests: guests, bedrooms, booking_options: options, seasonal_rates: seasons } };
}
