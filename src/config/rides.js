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
