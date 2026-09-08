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
