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
