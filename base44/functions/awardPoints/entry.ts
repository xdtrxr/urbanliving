import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// awardPoints
// ----------------------------------------------------------------------------
// The only writer of loyalty points. Every award the app hands out — welcome
// bonus, profile completion, first wishlist add, booking milestones, social
// quests, the daily chat — comes through here, is checked against the
// caller's own history, and is written under the service role.
//
// Why: the browser used to compute the new balance and write it with
// auth.updateMe, and create the LoyaltyTransaction row itself. Any logged-in
// user could set their points and tier from the console, and the same
// mechanism reached referral_balance_ngn, which is paid out as cash. The
// User fields now carry a field-level write rule (admin only) and
// LoyaltyTransaction.create is admin-only, so this function is the only path.
//
// Quest points come from the registry below, never from the Quest row: users
// can create Quest rows, so a row's points_reward is not trustworthy.
//
// Body: { kind, booking_id?, quest_id? }
// kind ∈ welcome | profile_completed | first_wishlist | booking_milestones |
//        quest | daily_chat

const TIERS: Array<[string, number]> = [
    ['Diamond', 50000], ['Platinum', 25000], ['Gold', 12500], ['Silver', 5000], ['Bronze', 0],
];
const tierFor = (points: number): string => {
    for (const [name, min] of TIERS) if (points >= min) return name;
    return 'Bronze';
};

// Mirrors QUEST_REGISTRY in src/pages/Quests.jsx. Points live here on purpose.
const QUESTS: Record<string, { points: number; type: string; platform: string; daily: boolean; label: string }> = {
    follow_instagram: { points: 75, type: 'social_follow', platform: 'instagram', daily: false, label: 'Instagram' },
    follow_tiktok: { points: 70, type: 'social_follow', platform: 'tiktok', daily: false, label: 'TikTok' },
    daily_chat_agent: { points: 50, type: 'daily_engagement', platform: 'chat_agent', daily: true, label: 'Agent Nova' },
};

const WELCOME_POINTS = 100;
const PROFILE_POINTS = 100;
const WISHLIST_POINTS = 50;
const BOOKING_POINTS = 500;
const FIRST_BOOKING_POINTS = 1000;
const MONTHLY_3_POINTS = 3000;
const DAILY_CHAT_MIN_MESSAGES = 2;

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, '-created_date', PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);
const monthStartIso = () => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

// An id goes into the URL of the row it fetches ("../Booking/abc" would fetch
// a row of another entity, and every check that follows would then be made on
// the wrong kind of row), so only a plain id is ever used. Lockstep copy, see
// createWithdrawalRequest.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// entity.get() rejects for a row that is not there. Unguarded, a stale or
// mistyped id is answered with a 500 instead of "not found".
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
    }
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });
    const already = (kind: string, why: string) =>
        json({ success: true, data: { kind, already: true, points: 0, reason: why } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const body = await req.json().catch(() => ({}));
        let kind = String(body.kind || '');
        if (kind === 'daily_chat') { kind = 'quest'; body.quest_id = 'daily_chat_agent'; }

        const svc = base44.asServiceRole.entities;
        const rows = await svc.User.filter({ email: user.email });
        const userRow = rows[0];
        if (!userRow) return json({ success: false, error: 'User record not found' }, 404);

        const tx = await fetchAll(svc.LoyaltyTransaction, { user_email: user.email });
        const has = (pred: (t: any) => boolean) => tx.some(pred);
        const marker = (m: string) => (t: any) => typeof t.description === 'string' && t.description.includes(m);

        // One credit = one User update + one transaction row, both service role.
        let running = Number(userRow.loyalty_points) || 0;
        const awards: Array<{ label: string; points: number }> = [];
        const credit = async (points: number, type: string, description: string, extra: Record<string, unknown> = {}) => {
            running += points;
            await svc.User.update(userRow.id, { loyalty_points: running, loyalty_tier: tierFor(running) });
            await svc.LoyaltyTransaction.create({
                user_email: user.email, points_earned: points, transaction_type: type, description, ...extra,
            });
            awards.push({ label: description, points });
        };

        switch (kind) {
            case 'welcome': {
                if (has((t) => t.transaction_type === 'bonus' && /welcome bonus/i.test(t.description || ''))) {
                    return already(kind, 'welcome bonus already credited');
                }
                await credit(WELCOME_POINTS, 'bonus', 'Welcome bonus for joining Urban Stays');
                break;
            }

            case 'profile_completed': {
                const required = ['full_name', 'phone_number', 'bio', 'travel_style'];
                const complete = required.every((k) => {
                    const v = userRow[k];
                    return typeof v === 'string' ? v.trim().length > 0 : Boolean(v);
                });
                if (!complete) return json({ success: false, error: 'Profile is not complete yet', code: 'NOT_ELIGIBLE' }, 409);
                if (has(marker('PROFILE_COMPLETED'))) return already(kind, 'profile bonus already credited');
                await credit(PROFILE_POINTS, 'milestone', 'PROFILE_COMPLETED — Profile completion bonus');
                break;
            }

            case 'first_wishlist': {
                if (!Array.isArray(userRow.wishlist) || userRow.wishlist.length === 0) {
                    return json({ success: false, error: 'Wishlist is empty', code: 'NOT_ELIGIBLE' }, 409);
                }
                if (has(marker('FIRST_WISHLIST'))) return already(kind, 'wishlist bonus already credited');
                await credit(WISHLIST_POINTS, 'milestone', 'FIRST_WISHLIST — First wishlist add bonus');
                break;
            }

            case 'booking_milestones': {
                const bookingId = String(body.booking_id || '').trim();
                if (!bookingId) return json({ success: false, error: 'booking_id is required' }, 400);
                const booking = isId(bookingId) ? await getOrNull(svc.Booking, bookingId) : null;
                if (!booking || booking.guest_email !== user.email) {
                    return json({ success: false, error: 'Booking not found', code: 'NOT_FOUND' }, 404);
                }
                if (booking.payment_status !== 'paid') {
                    return json({ success: false, error: 'Points are awarded once the booking is paid', code: 'NOT_ELIGIBLE' }, 409);
                }

                // 1. Flat award per paid booking. The payment paths also do
                //    this under the service role; both dedupe on booking_id.
                if (!has((t) => t.transaction_type === 'booking' && t.booking_id === bookingId)) {
                    await credit(BOOKING_POINTS, 'booking', `Earned ${BOOKING_POINTS} points from a booking`, { booking_id: bookingId });
                    tx.unshift({ transaction_type: 'booking', booking_id: bookingId, created_date: new Date().toISOString() });
                }
                // 2. First booking ever.
                if (!has(marker('FIRST_BOOKING')) && has((t) => t.transaction_type === 'booking')) {
                    await credit(FIRST_BOOKING_POINTS, 'milestone', 'FIRST_BOOKING — Welcome bonus for your first booking', { booking_id: bookingId });
                }
                // 3. Three paid bookings in the calendar month, once per month.
                const monthStart = monthStartIso();
                const key = `MONTHLY_3_${monthStart.slice(0, 7)}`;
                const thisMonth = tx.filter((t) => t.transaction_type === 'booking' && t.created_date && t.created_date >= monthStart);
                if (thisMonth.length >= 3 && !has(marker(key))) {
                    await credit(MONTHLY_3_POINTS, 'milestone', `${key} — 3 bookings in a calendar month bonus`, { booking_id: bookingId });
                }
                if (awards.length === 0) return already(kind, 'no new milestone for this booking');
                break;
            }

            case 'quest': {
                const questId = String(body.quest_id || '');
                const q = QUESTS[questId];
                if (!q) return json({ success: false, error: 'Unknown quest', code: 'BAD_QUEST' }, 400);
                const today = todayUtc();
                const questMarker = `QUEST:${questId}`;

                // Legacy rows were written with prose descriptions; match those too.
                const legacy = q.daily ? 'Daily chat with Agent Nova' : `Follow us on ${q.label}`;
                const doneBefore = has((t) => {
                    const d = String(t.description || '');
                    if (!d.includes(questMarker) && !d.includes(legacy)) return false;
                    return q.daily ? String(t.created_date || '').slice(0, 10) === today : true;
                });
                if (doneBefore) return already(kind, q.daily ? 'already claimed today' : 'already claimed');

                if (q.daily && questId === 'daily_chat_agent') {
                    const since = `${today}T00:00:00.000Z`;
                    const msgs = await svc.ChatHistory.filter(
                        { user_email: user.email, role: 'user', created_date: { $gte: since } }, '-created_date', 50,
                    );
                    if (!Array.isArray(msgs) || msgs.length < DAILY_CHAT_MIN_MESSAGES) {
                        return json({
                            success: false,
                            error: `Send at least ${DAILY_CHAT_MIN_MESSAGES} messages to Agent Nova today first`,
                            code: 'NOT_ELIGIBLE',
                        }, 409);
                    }
                }

                // Keep the Quest row in step so the Quests page reads the same state.
                const existing = await svc.Quest.filter({ user_email: user.email, quest_id: questId });
                let row = existing[0];
                const claimed = {
                    status: 'claimed',
                    completion_date: new Date().toISOString(),
                    last_completed_date: today,
                    verification_data: { timestamp: Date.now(), platform: q.label, auto_completed: true, by: 'awardPoints' },
                };
                if (!row) {
                    row = await svc.Quest.create({
                        quest_id: questId, quest_type: q.type, platform: q.platform, points_reward: q.points,
                        verification_method: 'automatic', is_daily: q.daily, user_email: user.email, ...claimed,
                    });
                } else {
                    await svc.Quest.update(row.id, { points_reward: q.points, ...claimed });
                }

                await credit(
                    q.points,
                    q.daily ? 'engagement' : 'quest',
                    q.daily ? `${questMarker} — Daily chat with Agent Nova` : `${questMarker} — Completed quest: Follow us on ${q.label}`,
                    { quest_id: row.id },
                );
                break;
            }

            default:
                return json({ success: false, error: 'Unknown kind', code: 'BAD_KIND' }, 400);
        }

        return json({
            success: true,
            data: {
                kind,
                already: false,
                points: awards.reduce((s, a) => s + a.points, 0),
                total: running,
                tier: tierFor(running),
                awards,
            },
        });
    } catch (error) {
        console.error('awardPoints error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
