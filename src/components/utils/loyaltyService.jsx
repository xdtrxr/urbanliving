import { base44 } from '@/api/base44Client';

// Loyalty points — client wrapper.
//
// Every award goes through the awardPoints function. The browser used to
// compute the new balance itself and write it with auth.updateMe, and create
// the LoyaltyTransaction row directly. That meant any logged-in user could
// set their own points, tier and referral cash balance from the console. The
// server now owns the arithmetic, the dedupe rules and the writes; the
// User fields are read-only to the client. These helpers keep the old call
// sites' signatures so the pages did not have to change.

export const TIER_THRESHOLDS = [
  { name: 'Diamond', min: 50000 },
  { name: 'Platinum', min: 25000 },
  { name: 'Gold', min: 12500 },
  { name: 'Silver', min: 5000 },
  { name: 'Bronze', min: 0 },
];

// Display only — the server computes the stored tier.
export function calculateTier(points) {
  for (const tier of TIER_THRESHOLDS) {
    if (points >= tier.min) return tier.name;
  }
  return 'Bronze';
}

// Returns { points, newTotal, newTier } for a fresh award, or null when
// nothing was awarded (already credited, not eligible, or the call failed).
export async function awardPoints(kind, extra = {}) {
  try {
    const res = await base44.functions.invoke('awardPoints', { kind, ...extra });
    const d = res?.data;
    if (!d?.success || !d.data || d.data.already || !d.data.points) return null;
    return { points: d.data.points, newTotal: d.data.total, newTier: d.data.tier };
  } catch (err) {
    console.warn(`awardPoints(${kind}) failed (non-fatal):`, err);
    return null;
  }
}

// Booking-time milestones: flat 500 per paid stay, +1000 first booking,
// +3000 for three in a calendar month. All decided server-side against the
// caller's own transactions.
export async function awardBookingMilestones(bookingData) {
  if (!bookingData?.id) return [];
  const r = await awardPoints('booking_milestones', { booking_id: bookingData.id });
  return r ? [r] : [];
}

export async function awardProfileCompletion() {
  return awardPoints('profile_completed');
}

export async function awardFirstWishlistAdd() {
  return awardPoints('first_wishlist');
}

export async function awardWelcomeBonus() {
  return awardPoints('welcome');
}

export async function awardQuest(questId) {
  return awardPoints('quest', { quest_id: questId });
}

export async function awardDailyChat() {
  return awardPoints('daily_chat');
}
