// Single source of truth for the Rides taxonomy.
//
// Cities are deliberately NOT an enum in the entity schemas. The client expects
// to keep adding them ("other cities as UrbanStays expands"), and an enum would
// make that a three-schema migration every time. Keeping the field a plain
// string and driving every dropdown from this file makes adding a city a
// one-line change here. The trade-off is that nothing stops a bad value being
// written directly through the API — acceptable because vehicle and driver rows
// are admin-only and always created through a Select bound to this list.

export const CITIES = ['Abuja', 'Lagos', 'Port Harcourt'];

// Price tiers, not body styles. This replaced the old vehicle_type enum
// (sedan / suv / luxury_sedan / luxury_suv / executive / van / minibus / coupe)
// because the client browses by budget, not by shape. Group hire is expressed
// through max_passengers instead, which the browse page already filters on.
export const CATEGORIES = [
  { value: 'economy', label: 'Economy', blurb: 'Clean, reliable, budget-friendly' },
  { value: 'comfort', label: 'Comfort / Sedan', blurb: 'Air-conditioned saloon cars' },
  { value: 'suv', label: 'SUV', blurb: 'Higher clearance, more room' },
  { value: 'executive', label: 'Executive', blurb: 'Business-class comfort' },
  { value: 'luxury', label: 'Luxury', blurb: 'Premium marques, top of the range' },
];

export const categoryLabel = (value) =>
  CATEGORIES.find((c) => c.value === value)?.label || value || '';

// The hourly choices the client asked for by name. Deliberately not every
// integer 1-8: offering 5 and 7 implies a precision the pricing doesn't have.
export const HOURLY_CHOICES = [1, 2, 3, 4, 6, 8];

// duration_tier keeps its original enum values — '12hr' was NOT renamed to
// 'full_day', because renaming would orphan every row already written for the
// sake of a label. The label is set here instead.
export const DURATION_OPTIONS = [
  ...HOURLY_CHOICES.map((h) => ({
    id: `hourly_${h}`,
    tier: 'hourly',
    hours: h,
    label: h === 1 ? '1 hour' : `${h} hours`,
  })),
  { id: '12hr', tier: '12hr', label: 'Full day (12 hours)' },
  { id: '24hr', tier: '24hr', label: '24 hours' },
  { id: 'multi_day', tier: 'multi_day', label: 'Multiple days' },
];

export const durationOptionId = (tier, hours) =>
  (tier === 'hourly' ? `hourly_${Number(hours) || 1}` : tier);

export const durationLabel = (tier, { hours, days } = {}) => {
  if (tier === 'multi_day') {
    const d = Math.max(1, Number(days) || 1);
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  return DURATION_OPTIONS.find((o) => o.id === durationOptionId(tier, hours))?.label || tier;
};

// ─────────────────────────────────────────────────────────────────────────────
// Client-side price estimate.
//
// MIRROR of priceForTier in base44/functions/checkRideAvailability/entry.ts.
// The server figure is always authoritative — this exists only so the browse
// and checkout pages can show a number before anything is submitted, and it
// must stay in lockstep with the server copy or the guest will see one price
// and be charged another.
// ─────────────────────────────────────────────────────────────────────────────
export function estimateRidePrice(vehicle, { tier, hours, days } = {}) {
  if (!vehicle) return null;
  const perHour = Number(vehicle.price_per_hour_ngn) || 0;
  const p12 = Number(vehicle.price_12hr_ngn) || 0;
  const p24 = Number(vehicle.price_24hr_ngn) || 0;
  const extra = Number(vehicle.price_per_extra_day_ngn) || 0;
  const d = Math.max(1, Number(days) || 1);

  switch (tier) {
    case 'hourly': {
      const h = Math.max(1, Number(hours) || 1);
      return perHour ? perHour * h : null;
    }
    case '12hr': return p12 || null;
    case '24hr': return p24 || null;
    case 'multi_day': return p24 ? p24 + (d - 1) * (extra || p24) : null;
    case 'weekly': return Number(vehicle.price_per_week_ngn) || (p24 ? p24 * 7 : null);
    case 'monthly': return Number(vehicle.price_per_month_ngn) || (p24 ? p24 * 30 : null);
    default: return null;
  }
}

// A vehicle with no hourly rate cannot take short bookings at all. Used to grey
// out the hourly choices rather than letting the guest pick one and get a 409.
export const supportsHourly = (vehicle) => Number(vehicle?.price_per_hour_ngn) > 0;

export const minHours = (vehicle) => Math.max(1, Number(vehicle?.min_hours_per_booking) || 1);

// What each hour beyond the booked window costs. The client's rule is that
// every booking has one — "3 hours booked, 4 used, the fourth is charged" —
// so a vehicle without an explicit overage rate falls back to its standard
// hourly rate rather than to nothing. Null only for a day-hire-only car with
// neither figure set, in which case overage is a conversation with admin.
//
// MIRROR of extraHourRateFor in checkRideAvailability, which snapshots this
// onto the booking. Keep in lockstep; scripts/check-ride-time.mjs asserts it.
export const extraHourRate = (vehicle) =>
  Number(vehicle?.price_extra_hour_ngn) || Number(vehicle?.price_per_hour_ngn) || null;

// The additional charges the client listed by name. Offered as one-tap
// presets on the admin's price-adjustment reason so the wording the guest
// reads is consistent from one booking to the next.
export const ADJUSTMENT_REASONS = [
  'Extra hour(s)',
  'Out-of-city travel',
  'Airport pickup',
  'Toll fees',
  'Waiting time',
  'Overnight / multi-day arrangement',
  'Special request',
];

// Admin-only margin arithmetic over a VehicleCosting row. Returns null for a
// basis where either side is unknown, so the form shows "—" rather than a
// misleading 100% margin on a car whose partner cost was never entered.
export function markupFor(vehicle, costing) {
  const line = (price, partner, driver) => {
    const p = Number(price) || 0;
    if (!p || costing == null) return null;
    const cost = (Number(partner) || 0) + (Number(driver) || 0);
    if (!cost) return null;
    return { price: p, cost, markup: p - cost, pct: Math.round(((p - cost) / p) * 100) };
  };
  return {
    hourly: line(vehicle?.price_per_hour_ngn, costing?.partner_cost_per_hour_ngn, costing?.driver_cost_per_hour_ngn),
    daily: line(vehicle?.price_24hr_ngn, costing?.partner_cost_per_day_ngn, costing?.driver_cost_per_day_ngn),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What a driver is paid for a ride, read off the vehicle's VehicleCosting row.
//
// MIRROR of driverPayoutFor in base44/functions/assignRideDriver/entry.ts. The
// server figure is the one written to the driver's ledger; this exists only so
// the Assign driver dialog can show admin the number before they confirm.
// scripts/check-driver-wallet.mjs runs both and fails if they ever disagree.
// ─────────────────────────────────────────────────────────────────────────────
// Held pay becomes releasable this long after the booked end of the ride.
export const RELEASE_BUFFER_HOURS = 2;

// No single ride pays a driver more than this. Mirror of MAX_PAYOUT_NGN in
// assignRideDriver; the check script compares the two.
export const MAX_PAYOUT_NGN = 50000000;

const MAX_HOURLY_HOURS = 8;

export function driverPayoutFor(costing, tier, { hours, days } = {}) {
  if (!costing) return null;
  const perHour = Math.round(Number(costing.driver_cost_per_hour_ngn) || 0);
  const perDay = Math.round(Number(costing.driver_cost_per_day_ngn) || 0);
  let basis = 'daily';
  let rate = perDay;
  let units = 1;
  switch (tier) {
    case 'hourly':
      basis = 'hourly';
      rate = perHour;
      units = Math.min(MAX_HOURLY_HOURS, Math.max(1, Math.round(Number(hours) || 1)));
      break;
    case '12hr':
    case '24hr':
      break;
    case 'multi_day':
      units = Math.max(1, Math.round(Number(days) || 1));
      break;
    case 'weekly':
      units = 7;
      break;
    case 'monthly':
      units = 30;
      break;
    default:
      return null;
  }
  // Zero means "nobody entered a driver cost", never "this driver is free".
  if (rate <= 0) return null;
  // A booked duration or a mistyped rate that multiplies past the ceiling is
  // not a pay figure. Same rule as the server, so the dialog shows "enter the
  // pay" in exactly the cases the server would refuse.
  const amount = rate * units;
  if (!Number.isFinite(amount) || amount > MAX_PAYOUT_NGN) return null;
  return { amount, basis, rate, units };
}

// ── Legacy compatibility ────────────────────────────────────────────────────
// Vehicles created before the category taxonomy landed carry the old
// body-style `vehicle_type` and no `category`. Browse filters on category, so
// without this an unmigrated row matches nothing and disappears from the site
// entirely — the car is still bookable by direct link, but no one can find it.
//
// This is a READ-TIME shim, not a migration: it keeps existing stock visible
// between the schema deploy and an admin re-saving each vehicle. Once a real
// category is set it is used and this is bypassed.
//
// van and minibus have no honest home in a five-tier price taxonomy, which was
// the accepted cost of the swap. They map to suv here purely so a group
// vehicle stays reachable — the admin still has to make the real call.
const LEGACY_TYPE_TO_CATEGORY = {
  sedan: 'comfort',
  coupe: 'comfort',
  suv: 'suv',
  van: 'suv',
  minibus: 'suv',
  executive: 'executive',
  luxury_sedan: 'luxury',
  luxury_suv: 'luxury',
};

export const effectiveCategory = (vehicle) =>
  vehicle?.category || LEGACY_TYPE_TO_CATEGORY[vehicle?.vehicle_type] || null;

// True when a vehicle is only visible thanks to the shim above. Admin surfaces
// use this to show what still needs migrating.
export const needsCategoryMigration = (vehicle) =>
  !vehicle?.category && !!vehicle?.vehicle_type;

// ── Driver logins ───────────────────────────────────────────────────────────
// The server matches a driver to a login by exact string, so the address is
// stored one way only: trimmed and lower-cased.
export const normaliseEmail = (raw) => String(raw || '').trim().toLowerCase();

export const looksLikeEmail = (raw) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw || '').trim());

// What to write on a Driver row when admin sets or changes its login email.
// The address being replaced moves into previous_user_emails, because a
// withdrawal only counts against a driver's balance when it was made by a
// login that is, or was, linked to that driver. Forget the old address and
// the money already paid out under it would look withdrawable again.
export function driverLoginPatch(driver, typedEmail) {
  const next = normaliseEmail(typedEmail);
  const current = normaliseEmail(driver?.user_email);
  const previous = Array.isArray(driver?.previous_user_emails)
    ? driver.previous_user_emails.map(normaliseEmail).filter(Boolean)
    : [];
  const history = current && current !== next && !previous.includes(current)
    ? [...previous, current]
    : previous;
  return { user_email: next, previous_user_emails: history };
}

// What the Assign driver dialog sends as the pay figure.
//   { ok: true, value: undefined }  send nothing: either this driver has no
//                                    login (pay is not tracked), or the box is
//                                    empty and the vehicle's costing decides
//   { ok: true, value: 20000 }      admin typed a figure
//   { ok: false, message }          nothing to go on, or not a usable number
// The server checks all of this again; this exists so admin is told before
// the round trip, in the dialog, next to the box.
export function typedDriverPay(hasLogin, typed, computedAmount) {
  if (!hasLogin) return { ok: true, value: undefined };
  const text = String(typed ?? '').trim();
  if (text === '') {
    if (computedAmount == null) {
      return { ok: false, message: 'Enter the driver pay for this ride. No driver cost is set for this vehicle.' };
    }
    return { ok: true, value: undefined };
  }
  if (!/^\d{1,9}(\.\d+)?$/.test(text)) {
    return { ok: false, message: 'Driver pay must be a naira amount in digits only, for example 15000.' };
  }
  const value = Math.round(Number(text));
  if (value > MAX_PAYOUT_NGN) {
    return { ok: false, message: `Driver pay cannot be more than ₦${MAX_PAYOUT_NGN.toLocaleString()}.` };
  }
  return { ok: true, value };
}

// ── What the admin rides list points at ─────────────────────────────────────
// Days after a ride's end during which admin is still nudged to record pay
// for a driver who had none. Older rides were settled outside the app.
export const PAY_NUDGE_DAYS = 7;

// Whether this ride's driver has a login but no pay on record for it: a ride
// assigned before the driver was given a login, or before pay was tracked.
// Reads the two flags getRideBookings sends to admin. driver_pay_recorded is
// null when the ledger could not be read, and then no claim is made.
export function payMissing(ride, nowMs) {
  if (!ride || ride.payment_status !== 'paid' || ride.status === 'cancelled') return false;
  if (!ride.driver_assigned || !ride.driver_linked || ride.driver_pay_recorded !== false) return false;
  const endMs = Date.parse(ride.end_at || '');
  if (Number.isNaN(endMs)) return true;
  return nowMs <= endMs + PAY_NUDGE_DAYS * 24 * 60 * 60 * 1000;
}

// A paid ride nobody has been assigned to. A ride the sweep has already
// completed still counts: who drove it, and their pay, can be recorded after
// the fact.
export const needsDriver = (ride) => !!ride
  && ride.payment_status === 'paid'
  && (ride.status === 'confirmed' || ride.status === 'completed')
  && !ride.driver_assigned;

// Whether a driver profile may be deleted: only when both lookups answered
// and found nothing. Earnings and withdrawals hang off the profile's id, so a
// driver with either is switched to inactive instead.
export const mayDeleteDriver = (earnings, withdrawals) => Array.isArray(earnings)
  && Array.isArray(withdrawals)
  && earnings.length === 0
  && withdrawals.length === 0;

// ── What a driver is told about a ride with no pay on record ────────────────
// No earning row means the app is holding nothing for this ride: the driver
// had no login when it was assigned, or the figure was ₦0. Before the ride
// that is something to settle with the team first, so it is said plainly and
// in the warning colour. It never says pay has been arranged: the app does
// not know that.
export function noPayLine(bucket) {
  if (bucket === 'upcoming' || bucket === 'current') {
    return { tone: 'warn', text: 'No pay is recorded in the app for this ride. Confirm it with the team before you set off.' };
  }
  if (bucket === 'past') {
    return { tone: 'muted', text: 'No pay was recorded in the app for this ride. Ask the team if you were expecting some.' };
  }
  return { tone: 'muted', text: 'No pay is recorded in the app for this ride.' };
}

// ── Ride reports ────────────────────────────────────────────────────────────
// MIRROR of the limits in base44/functions/createRideReport/entry.ts. The
// server is the authority; these let the dialog stop a report it would refuse
// before the reporter has typed it twice. scripts/check-ride-reports.mjs
// compares them with the shipped constants.
export const REPORT_CATEGORIES = ['rude', 'abusive', 'threatening', 'unsafe', 'no_show', 'damage', 'other'];
export const REPORT_LIMITS = { minDescription: 10, maxDescription: 2000, maxPhotos: 3 };

// Where an uploaded file lives: this platform's file store, under an app id.
// MIRROR of UPLOAD_URL in base44/functions/createRideReport/entry.ts;
// scripts/check-ride-reports.mjs fails if the two differ.
export const UPLOAD_URL = /^https:\/\/base44\.app\/api\/apps\/[a-f0-9]{24}\/files\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:jpe?g|png|webp|gif|heic|heif)$/i;

// A stored report photo, if it may be used as an <img src>: a link to a file
// uploaded through this platform, and nothing else. Admin's browser fetches
// whatever this returns, so any other link would let the person who filed
// the report choose the server that learns admin opened it. The server
// applies the same rule when a report is filed; it is applied again here
// because a row can also be typed into the data browser. Anything else is
// simply not shown.
export const safePhotoUrl = (url) =>
  (typeof url === 'string' && url.length <= 600 && UPLOAD_URL.test(url) && !url.includes('..') ? url : null);
