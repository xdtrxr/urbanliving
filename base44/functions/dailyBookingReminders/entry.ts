import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// dailyBookingReminders
// ----------------------------------------------------------------------------
// One sweep, fires push notifications for:
//   - Guests whose check_in is today  → "Welcome to <property>"
//   - Guests whose check_out is today → "Check-out by 12:00 PM"
//
// Designed to be invoked by a once-a-day scheduler (Base44 dashboard
// schedule or external cron POSTing here as an admin user). The same
// pattern as autoCancelExpiredBookings — Base44 functions don't support
// Deno.cron because the runtime needs a request to derive the SDK client.
//
// Idempotency: each push stamps a per-event timestamp on the Booking
// (checkin_reminder_pushed_at / checkout_reminder_pushed_at). The sweep
// skips bookings that already have today's stamp, so re-runs within the
// same UTC day are no-ops. We also restrict to confirmed + paid bookings
// — no point reminding someone whose booking lapsed.
//
// Timezone caveat: "today" is defined in UTC. Nigeria runs UTC+1 with no
// DST, so a UTC-midnight cron fires at 1 AM Lagos time. That's actually
// the right window for "morning of check-in" pushes — guests get woken
// only after sunrise wherever the cron runs.

async function tryPush(sdk: any, opts: {
    user_email: string;
    title: string;
    body?: string;
    url?: string;
    tag?: string;
}) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

// Returns YYYY-MM-DD in UTC. Booking.check_in / check_out are stored as
// date-only strings in this format, so direct equality works.
function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
}

// Best-effort property title lookup — only used to make pushes feel
// personal. Failure is silent; we just fall back to "your stay".
async function getPropertyTitle(sdk: any, propertyId: string | undefined): Promise<string | null> {
    if (!propertyId) return null;
    try {
        const p = await sdk.asServiceRole.entities.Property.get(propertyId);
        return p?.title || null;
    } catch {
        return null;
    }
}

// Base44's .filter() returns 50 rows by default — page through so a busy
// check-in day doesn't silently drop reminders past the 50th booking.
const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown> = {}): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, undefined, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

async function runSweep(sdk: any): Promise<{ checkin: number; checkout: number; scanned: number }> {
    const today = todayUtc();

    // One filter for each side. We only ever care about paid + confirmed
    // rows — pending / cancelled / payment-expired bookings shouldn't
    // trigger arrival reminders.
    const todayCheckIns = await fetchAll(sdk.asServiceRole.entities.Booking, {
        check_in: today,
        status: 'confirmed',
        payment_status: 'paid',
    });
    const todayCheckOuts = await fetchAll(sdk.asServiceRole.entities.Booking, {
        check_out: today,
        status: 'confirmed',
        payment_status: 'paid',
    });

    let checkinSent = 0;
    let checkoutSent = 0;

    for (const b of todayCheckIns) {
        if (b.checkin_reminder_pushed_at) continue;
        try {
            const title = await getPropertyTitle(sdk, b.property_id);
            await sdk.asServiceRole.entities.Booking.update(b.id, {
                checkin_reminder_pushed_at: new Date().toISOString(),
            });
            await tryPush(sdk, {
                user_email: b.guest_email,
                title: '🏠 Check-in today',
                body: title
                    ? `Welcome to "${title}". Check-in opens at 2:00 PM — tap for arrival details.`
                    : 'Welcome to your stay! Check-in opens at 2:00 PM — tap for arrival details.',
                url: `/Bookings#booking-${b.id}`,
                tag: `booking-checkin-${b.id}`,
            });
            checkinSent += 1;
        } catch (err) {
            console.warn(`Check-in reminder failed for ${b.id}:`, err);
        }
    }

    for (const b of todayCheckOuts) {
        if (b.checkout_reminder_pushed_at) continue;
        try {
            const title = await getPropertyTitle(sdk, b.property_id);
            await sdk.asServiceRole.entities.Booking.update(b.id, {
                checkout_reminder_pushed_at: new Date().toISOString(),
            });
            await tryPush(sdk, {
                user_email: b.guest_email,
                title: '🧳 Check-out today',
                body: title
                    ? `Please check out of "${title}" by 12:00 PM. Thanks for staying with us.`
                    : 'Please check out by 12:00 PM. Thanks for staying with us.',
                url: `/Bookings#booking-${b.id}`,
                tag: `booking-checkout-${b.id}`,
            });
            checkoutSent += 1;
        } catch (err) {
            console.warn(`Check-out reminder failed for ${b.id}:`, err);
        }
    }

    return {
        checkin: checkinSent,
        checkout: checkoutSent,
        scanned: todayCheckIns.length + todayCheckOuts.length,
    };
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), { status: 405, headers });
    }

    // Admin-only when invoked via HTTP. Mirrors the auth pattern used by
    // autoCancelExpiredBookings — the scheduler must POST as an admin user.
    let sdk: any;
    try {
        sdk = createClientFromRequest(req);
        const user = await sdk.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
        }
        if (user.role !== 'admin') {
            return new Response(JSON.stringify({ success: false, error: 'Admin role required' }), { status: 403, headers });
        }
    } catch {
        return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
    }

    try {
        const result = await runSweep(sdk);
        return new Response(JSON.stringify({ success: true, data: result }), { status: 200, headers });
    } catch (error) {
        console.error('dailyBookingReminders error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
