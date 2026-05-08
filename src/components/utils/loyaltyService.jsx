import { base44 } from '@/api/base44Client';

const TIER_THRESHOLDS = [
  { name: 'Diamond', min: 10000 },
  { name: 'Platinum', min: 5000 },
  { name: 'Gold', min: 2500 },
  { name: 'Silver', min: 1000 },
  { name: 'Bronze', min: 0 },
];

function calculateTier(points) {
  for (const tier of TIER_THRESHOLDS) {
    if (points >= tier.min) return tier.name;
  }
  return 'Bronze';
}

function startOfCalendarMonthIso(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

async function fetchTransactions(userEmail) {
  try {
    return await base44.entities.LoyaltyTransaction.filter({ user_email: userEmail });
  } catch {
    return [];
  }
}

async function applyPoints({ user, points, transactionType, description, bookingId, log }) {
  const newTotal = (user.loyalty_points || 0) + points;
  const newTier = calculateTier(newTotal);
  await base44.auth.updateMe({ loyalty_points: newTotal, loyalty_tier: newTier });
  await base44.entities.LoyaltyTransaction.create({
    user_email: user.email,
    points_earned: points,
    transaction_type: transactionType,
    booking_id: bookingId,
    description,
  });
  if (log) console.log(`🎁 +${points} loyalty points: ${description} (total now ${newTotal}, tier ${newTier})`);
  return { points, newTotal, newTier };
}

/**
 * Awards all booking-time milestones at once for the current user, idempotent.
 * - 5% of booking total (booking transaction)
 * - First booking ever (+500)
 * - 3 confirmed bookings in calendar month (+1000)
 */
export async function awardBookingMilestones(bookingData) {
  if (!bookingData?.id) return [];
  const awarded = [];
  try {
    let user = await base44.auth.me();
    // Single fetch up-front; refresh ONCE between writes.
    let tx = await fetchTransactions(user.email);

    // 1. 5% of booking total (idempotent on booking_id)
    const alreadyForThisBooking = tx.some(
      (t) => t.transaction_type === 'booking' && t.booking_id === bookingData.id,
    );
    if (!alreadyForThisBooking) {
      const points = Math.floor((Number(bookingData.total_price) || 0) * 0.05);
      if (points > 0) {
        const r = await applyPoints({
          user,
          points,
          transactionType: 'booking',
          description: `Earned ${points} points from a booking`,
          bookingId: bookingData.id,
          log: true,
        });
        awarded.push({ kind: 'booking', ...r });
        user = await base44.auth.me();
        tx = await fetchTransactions(user.email);
      }
    }

    // 2. First booking ever bonus (+500), idempotent on description marker
    const alreadyFirst = tx.some(
      (t) => t.transaction_type === 'milestone' && t.description?.includes('FIRST_BOOKING'),
    );
    const hasBookingTx = tx.some((t) => t.transaction_type === 'booking');
    if (!alreadyFirst && hasBookingTx) {
      const r = await applyPoints({
        user,
        points: 500,
        transactionType: 'milestone',
        description: 'FIRST_BOOKING — Welcome bonus for your first booking',
        bookingId: bookingData.id,
        log: true,
      });
      awarded.push({ kind: 'first_booking', ...r });
      user = await base44.auth.me();
      tx = await fetchTransactions(user.email);
    }

    // 3. 3 bookings in this calendar month (+1000), once per month
    const monthStart = startOfCalendarMonthIso();
    const bookingTxThisMonth = tx.filter(
      (t) => t.transaction_type === 'booking' && t.created_date && t.created_date >= monthStart,
    );
    const monthlyBonusKey = `MONTHLY_3_${monthStart.slice(0, 7)}`; // YYYY-MM
    const alreadyMonthlyBonus = tx.some(
      (t) => t.transaction_type === 'milestone' && t.description?.includes(monthlyBonusKey),
    );
    if (bookingTxThisMonth.length >= 3 && !alreadyMonthlyBonus) {
      const r = await applyPoints({
        user,
        points: 1000,
        transactionType: 'milestone',
        description: `${monthlyBonusKey} — 3 bookings in a calendar month bonus`,
        bookingId: bookingData.id,
        log: true,
      });
      awarded.push({ kind: 'monthly_3', ...r });
    }
  } catch (err) {
    console.error('awardBookingMilestones failed:', err);
  }
  return awarded;
}

/**
 * Awards +100 once when the current user has filled out core profile fields.
 * Idempotent via PROFILE_COMPLETED marker.
 */
export async function awardProfileCompletion() {
  try {
    const user = await base44.auth.me();
    const required = ['full_name', 'phone_number', 'bio', 'travel_style'];
    const complete = required.every((k) => {
      const v = user[k];
      return typeof v === 'string' ? v.trim().length > 0 : Boolean(v);
    });
    if (!complete) return null;

    const tx = await fetchTransactions(user.email);
    const already = tx.some(
      (t) => t.transaction_type === 'milestone' && t.description?.includes('PROFILE_COMPLETED'),
    );
    if (already) return null;

    return await applyPoints({
      user,
      points: 100,
      transactionType: 'milestone',
      description: 'PROFILE_COMPLETED — Profile completion bonus',
      log: true,
    });
  } catch (err) {
    console.error('awardProfileCompletion failed:', err);
    return null;
  }
}

/**
 * Awards +50 once on the user's first wishlist add. Idempotent.
 */
export async function awardFirstWishlistAdd() {
  try {
    const user = await base44.auth.me();
    const tx = await fetchTransactions(user.email);
    const already = tx.some(
      (t) => t.transaction_type === 'milestone' && t.description?.includes('FIRST_WISHLIST'),
    );
    if (already) return null;
    return await applyPoints({
      user,
      points: 50,
      transactionType: 'milestone',
      description: 'FIRST_WISHLIST — First wishlist add bonus',
      log: true,
    });
  } catch (err) {
    console.error('awardFirstWishlistAdd failed:', err);
    return null;
  }
}

