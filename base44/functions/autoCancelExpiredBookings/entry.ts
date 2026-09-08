import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// The platform's 5-minute sweep. Despite the name it now covers three things:
//
//   1. Stays  — auto-cancel past the payment deadline, plus a 5-minute warning.
//   2. Rides  — the same two passes against RideBooking.
//   3. Rides  — a driver-arriving-soon push ~30 minutes before pickup.
//
// The name is kept deliberately. It is the identifier the Base44 dashboard
// schedule points at, and renaming it would silently detach the cron — which
// for rides means approved bookings holding vehicles forever.
//
// Runs on a schedule and is also exposed as a manual POST for admin re-runs.

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const bookingLink = (bookingId: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(bookingId)}#booking-${encodeURIComponent(bookingId)}`;

const HOUR_MS = 60 * 60 * 1000;
const PAYMENT_WINDOW_MS = 1 * HOUR_MS;
const APPROVAL_CAP_MS = 3 * HOUR_MS;

function computeDeadlineMs(b: any): number | null {
    const approvedAt = Date.parse(b.approved_at || '');
    if (Number.isNaN(approvedAt)) return null;
    const startedAt = Date.parse(b.payment_started_at || '');
    const fromOpen = Number.isNaN(startedAt) ? 0 : startedAt + PAYMENT_WINDOW_MS;
    const fromApproval = approvedAt + PAYMENT_WINDOW_MS;
    const cap = approvedAt + APPROVAL_CAP_MS;
    return Math.min(cap, Math.max(fromApproval, fromOpen));
}

// Fire-and-forget push. Swallows errors so a push outage can't block the
// cancellation sweep. Stable tag prevents duplicate pushes if the same
// booking somehow runs through the sweep twice.
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

async function notifyAdmin(b: any) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const message =
        `⏰ *PAYMENT TIMER EXPIRED*\n\n` +
        `Booking \`${b.id}\` was auto-cancelled.\n` +
        `• Guest: ${b.guest_name} (${b.guest_email})\n` +
        `• Property: \`${b.property_id}\`\n` +
        `• Dates: ${b.check_in} → ${b.check_out}\n` +
        `• Total: ₦${(b.total_price || 0).toLocaleString()}`;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Telegram expiry notify failed:', err);
    }
}

// How close to the deadline before we warn the user. With the cron firing
// every ~5 minutes, a 6-minute window guarantees at least one fire inside
// the warning band even if the cron is a minute late.
const WARNING_WINDOW_MS = 6 * 60 * 1000;

// Base44's .filter() returns 50 rows by default. A bare filter here meant the
// sweep only ever saw the first 50 pending bookings, so with a backlog larger
// than that the rest would never expire or get warned. Page through instead.
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

// ── Rides ───────────────────────────────────────────────────────────────────
// RideBooking stores payment_deadline directly rather than recomputing it from
// approved_at like stays do, so there is one authoritative value here and no
// formula to keep in sync across files.

// Fires the "driver arriving soon" push at a nominal 30 minutes out. The
// window is 35 so a cron tick running a few minutes late still catches the
// ride rather than skipping straight past it — same reasoning as the
// 6-minute payment warning band above.
const ARRIVAL_WINDOW_MS = 35 * 60 * 1000;

async function notifyAdminRideExpired(ride: any) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const text = `⏰ *RIDE PAYMENT EXPIRED*\n\n` +
        `Ride \`${ride.id}\` was auto-cancelled.\n` +
        `• Vehicle: ${ride.vehicle_name}\n` +
        `• Guest: ${ride.guest_name} (${ride.guest_email})\n` +
        `• Value: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n\n` +
        `The vehicle is free again for that window.`;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Ride expiry notify failed:', err);
    }
}

async function runRideSweep(sdk: any): Promise<{ scanned: number; cancelled: number; warned: number; arriving: number }> {
    const now = Date.now();
    let cancelled = 0;
    let warned = 0;
    let arriving = 0;

    // Pass 1 + 2 — unpaid rides that have been approved are on the clock.
    const pending = await fetchAll(sdk.asServiceRole.entities.RideBooking, { status: 'pending' });
    for (const r of pending) {
        if (!r.approved_at || !r.payment_deadline) continue;
        const deadlineMs = Date.parse(r.payment_deadline);
        if (Number.isNaN(deadlineMs)) continue;
        const remaining = deadlineMs - now;

        if (remaining > 0 && remaining <= WARNING_WINDOW_MS && !r.payment_warning_pushed_at) {
            const minutesLeft = Math.max(1, Math.ceil(remaining / 60000));
            try {
                // Stamp before pushing: a push failure must not cause a retry
                // loop that spams the guest on every subsequent tick.
                await sdk.asServiceRole.entities.RideBooking.update(r.id, {
                    payment_warning_pushed_at: new Date().toISOString(),
                });
                await tryPush(sdk, {
                    user_email: r.guest_email,
                    title: `⏰ ${minutesLeft} min to pay`,
                    body: `Your ${r.vehicle_name} booking is about to be released.`,
                    url: `/Bookings#ride-${r.id}`,
                    tag: `ride-warn-${r.id}`,
                });
                warned += 1;
            } catch (err) {
                console.warn(`Ride warning failed for ${r.id} (non-fatal):`, err);
            }
        }

        if (remaining > 0) continue;

        try {
            await sdk.asServiceRole.entities.RideBooking.update(r.id, {
                status: 'cancelled',
                cancel_reason: 'payment_expired',
            });
            await notifyAdminRideExpired(r);
            await tryPush(sdk, {
                user_email: r.guest_email,
                title: '⏰ Ride released',
                body: `Payment wasn't completed, so the ${r.vehicle_name} is back in the pool. Tap to rebook.`,
                url: '/PlanTrip',
                tag: `ride-expired-${r.id}`,
            });
            cancelled += 1;
            console.log(`⏰ Auto-cancelled expired ride ${r.id}`);
        } catch (err) {
            console.error(`Failed to auto-cancel ride ${r.id}:`, err);
        }
    }

    // Pass 3 — driver arriving soon, for paid rides with a driver assigned.
    const confirmed = await fetchAll(sdk.asServiceRole.entities.RideBooking, {
        status: 'confirmed', payment_status: 'paid',
    });
    for (const r of confirmed) {
        if (!r.driver_id || r.driver_arrival_push_sent_at) continue;
        const startMs = Date.parse(r.start_at || '');
        if (Number.isNaN(startMs)) continue;
        const until = startMs - now;
        if (until <= 0 || until > ARRIVAL_WINDOW_MS) continue;
        try {
            await sdk.asServiceRole.entities.RideBooking.update(r.id, {
                driver_arrival_push_sent_at: new Date().toISOString(),
            });
            const mins = Math.max(1, Math.round(until / 60000));
            await tryPush(sdk, {
                user_email: r.guest_email,
                title: '🚗 Your ride is soon',
                body: `Your ${r.vehicle_name} is due in about ${mins} minutes. Tap for your driver's details.`,
                url: `/Bookings#ride-${r.id}`,
                tag: `ride-arriving-${r.id}`,
            });
            arriving += 1;
        } catch (err) {
            console.warn(`Arrival push failed for ride ${r.id} (non-fatal):`, err);
        }
    }

    return { scanned: pending.length + confirmed.length, cancelled, warned, arriving };
}

async function runSweep(sdk: any): Promise<{ scanned: number; cancelled: number; warned: number }> {
    const pending = await fetchAll(sdk.asServiceRole.entities.Booking, { status: 'pending' });
    const now = Date.now();
    let cancelled = 0;
    let warned = 0;

    for (const b of pending) {
        const deadlineMs = computeDeadlineMs(b);
        if (deadlineMs === null) continue; // not approved yet

        const remaining = deadlineMs - now;

        // Warning band: deadline within ~5 min and we haven't pushed yet.
        // Stamp payment_warning_pushed_at to make this idempotent across
        // cron re-runs in the same window.
        if (remaining > 0 && remaining <= WARNING_WINDOW_MS && !b.payment_warning_pushed_at) {
            const minutesLeft = Math.max(1, Math.ceil(remaining / 60000));
            try {
                await sdk.asServiceRole.entities.Booking.update(b.id, {
                    payment_warning_pushed_at: new Date().toISOString(),
                });
                await tryPush(sdk, {
                    user_email: b.guest_email,
                    title: `⏰ ${minutesLeft} min to pay`,
                    body: 'Your reservation will be cancelled if payment isn\'t completed soon. Tap to finish.',
                    url: `/Bookings#booking-${b.id}`,
                    tag: `booking-warn-${b.id}`,
                });
                warned += 1;
                console.log(`⏳ Payment-warning push sent for booking ${b.id} (${minutesLeft} min left)`);
            } catch (warnErr) {
                console.warn(`Payment-warning push failed for booking ${b.id} (non-fatal):`, warnErr);
            }
        }

        if (now <= deadlineMs) continue;
        try {
            // Stamp cancel_reason so the Bookings UI can show "Payment Expired"
            // instead of plain "Cancelled". The property+dates are still free
            // to re-book because checkAvailabilityWebhook only blocks against
            // bookings whose status is in {pending, confirmed}.
            await sdk.asServiceRole.entities.Booking.update(b.id, {
                status: 'cancelled',
                cancel_reason: 'payment_expired',
            });
            await notifyAdmin(b);
            // Notify the guest so they know their booking lapsed and can re-book.
            try {
                const guestEmailBody = `Hi ${b.guest_name || 'there'},

Your booking reservation has expired because payment was not completed within the allowed window.

🔖 Status: CANCELLED (Payment Expired)
👉 View your booking: ${bookingLink(b.id)}

You are welcome to start a new booking for the same property or choose another.

If you believe this is an error, please contact our support team.

— Urban Stays`;
                await sdk.asServiceRole.integrations.Core.SendEmail({
                    to: b.guest_email,
                    subject: 'Your Urban Stays booking has expired',
                    body: guestEmailBody,
                    from_name: 'Urban Stays',
                });
                console.log(`📧 Expiry email sent to ${b.guest_email} for booking ${b.id}`);
            } catch (emailErr) {
                console.warn(`Guest expiry email failed for booking ${b.id} (non-fatal):`, emailErr);
            }
            // Push the guest — they can re-book the same property + dates
            // because checkAvailabilityWebhook doesn't block on cancelled rows.
            await tryPush(sdk, {
                user_email: b.guest_email,
                title: '⏰ Payment window expired',
                body: 'Your reservation lapsed before payment. Tap to re-book.',
                url: `/Bookings#booking-${b.id}`,
                tag: `booking-expired-${b.id}`,
            });
            cancelled += 1;
            console.log(`⏰ Auto-cancelled expired booking ${b.id} (payment_expired)`);
        } catch (err) {
            console.error(`Failed to auto-cancel booking ${b.id}:`, err);
        }
    }

    return { scanned: pending.length, cancelled, warned };
}

// Note: Deno.cron registration is intentionally NOT used here because Base44's
// runtime provides the SDK client per-request via createClientFromRequest, and
// the cron context has no incoming request to derive that from. To run on a
// schedule, configure a Base44 dashboard schedule (or external cron) that POSTs
// to this function's HTTP endpoint as an admin user.

// Manual HTTP trigger — admin only. Useful for ad-hoc sweeps or test environments
// that don't expose Deno.cron.
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

    // Admin-only when invoked via HTTP. Base44 supplies the SDK client with
    // service-role access automatically via createClientFromRequest.
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
    } catch (authErr) {
        return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
    }

    try {
        const stays = await runSweep(sdk);
        // Rides sweep independently: a failure in one must not silently skip
        // the other, since both are holding inventory.
        let rides = { scanned: 0, cancelled: 0, warned: 0, arriving: 0, error: undefined as string | undefined };
        try {
            rides = { ...rides, ...(await runRideSweep(sdk)) };
        } catch (rideErr) {
            console.error('Ride sweep failed:', rideErr);
            rides.error = (rideErr as Error).message;
        }
        const result = { stays, rides };
        return new Response(JSON.stringify({ success: true, data: result }), { status: 200, headers });
    } catch (error) {
        console.error('autoCancelExpiredBookings error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});