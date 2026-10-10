import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// The platform's 5-minute sweep. Despite the name it now covers five things:
//
//   1. Stays  — auto-cancel past the payment deadline, plus a 5-minute warning.
//   2. Rides  — the same two passes against RideBooking.
//   3. Rides  — a driver-arriving-soon push ~30 minutes before pickup.
//   4. Rides  — a paid ride whose booked window is over is marked completed.
//   5. Rides  — driver pay held on a ride is released two hours after its end.
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

// ── Ride time model — lockstep copy, see checkRideAvailability ──────────────
const WAT_OFFSET = '+01:00';
const DAY_MS = 24 * HOUR_MS;
const MAX_HOURLY = 8;

function rideDurationMs(tier: string, days?: number, hours?: number): number {
    switch (tier) {
        case 'hourly': return Math.min(MAX_HOURLY, Math.max(1, Number(hours) || 1)) * HOUR_MS;
        case '12hr': return 12 * HOUR_MS;
        case '24hr': return DAY_MS;
        case 'multi_day': return Math.max(1, Number(days) || 1) * DAY_MS;
        case 'weekly': return 7 * DAY_MS;
        case 'monthly': return 30 * DAY_MS;
        default: return NaN;
    }
}

// Prefer the stored instants. Fall back to deriving them for any row written
// before start_at existed, so a legacy ride still completes on time.
function windowOf(r: any): { startMs: number; endMs: number } | null {
    let startMs = Date.parse(r.start_at || '');
    if (Number.isNaN(startMs)) startMs = Date.parse(`${r.service_date}T${r.start_time}:00${WAT_OFFSET}`);
    if (Number.isNaN(startMs)) return null;
    let endMs = Date.parse(r.end_at || '');
    if (Number.isNaN(endMs)) {
        const dur = rideDurationMs(r.duration_tier, r.duration_days, r.duration_hours);
        if (Number.isNaN(dur)) return null;
        endMs = startMs + dur;
    }
    return { startMs, endMs };
}

// ── Completion and driver pay release ───────────────────────────────────────
// The decisions are separate functions with plain JavaScript bodies so that
// scripts/check-driver-wallet.mjs can lift them off disk and run them.

// The booked window is over. A row with no readable time is never "over":
// it waits for admin rather than completing on a guess.
function rideEnded(ride: any, nowMs: number) {
    const w = windowOf(ride);
    return !!w && Number.isFinite(w.endMs) && w.endMs <= nowMs;
}

// A held earning that has waited out its two hours and is not paused.
function isReleasable(earning: any, nowMs: number) {
    if (!earning || earning.status !== 'held' || earning.on_hold || earning.reversed_at) return false;
    const t = Date.parse(earning.release_at || '');
    return !Number.isNaN(t) && t <= nowMs;
}

// What to do with a due earning, given the ride it is for. This is the net
// under assignRideDriver and cancelRideBooking: if either stopped halfway, the
// pay they should have reversed is reversed here instead of being released.
function releaseDecision(earning: any, ride: any) {
    if (!ride) return 'reverse:ride no longer exists';
    if (ride.status === 'cancelled') return 'reverse:ride cancelled';
    if (ride.driver_id !== earning.driver_id) return 'reverse:ride reassigned';
    if (ride.payment_status !== 'paid') return 'hold:ride is not paid';
    return 'release';
}

// True while admin has not closed a complaint the GUEST made about THIS
// DRIVER on this ride. That is a dispute about the service the driver is
// being paid for, so the pay waits. It is matched on the driver the report
// names: if the ride was handed to someone else after the complaint, the
// complaint is about the first driver, and the second is paid on time. A
// report the DRIVER filed about the guest never holds the driver's own pay:
// that would punish them for speaking up. Lockstep copy in
// settleDriverEarning.
async function hasOpenGuestReport(sr: any, rideBookingId: string, driverId: string) {
    if (!driverId) return false;
    const open = await sr.RideReport.filter({
        ride_booking_id: rideBookingId,
        reporter_role: 'guest',
        reported_driver_id: driverId,
        status: { $in: ['open', 'reviewing'] },
    });
    return Array.isArray(open) && open.length > 0;
}

// A reversal always wins. Nothing here can lock a row, so a release can land
// on top of a reversal made a moment earlier and leave the row saying
// "released". reversed_at is never cleared, so after any write that sets a
// status other than reversed the row is read again, and put back if it
// carries one. Returns the row as it now stands. Lockstep copy in
// settleDriverEarning.
async function keepReversed(sr: any, earningId: string) {
    const fresh = await sr.DriverEarning.get(earningId);
    if (!fresh || !fresh.reversed_at || fresh.status === 'reversed') return fresh;
    await sr.DriverEarning.update(earningId, { status: 'reversed', on_hold: false });
    return { ...fresh, status: 'reversed', on_hold: false };
}

// Settle one due earning: 'released' | 'reversed' | 'held' | 'skipped'.
// Re-reads the row first, because admin may have paused, adjusted or reversed
// it since the page was fetched. Releasing is a status flip and nothing else:
// the driver's balance is derived from the ledger, so running this twice for
// the same row cannot pay twice.
async function settleDueEarning(sr: any, earningId: string, nowMs: number) {
    const e = await sr.DriverEarning.get(earningId);
    if (!isReleasable(e, nowMs)) return 'skipped';
    let ride;
    try {
        ride = await sr.RideBooking.get(e.ride_booking_id);
    } catch (err) {
        // A read that failed is not a ride that is gone. Never reverse on it.
        console.warn(`Could not read ride ${e.ride_booking_id} for earning ${e.id}; trying again next tick`, err);
        return 'skipped';
    }
    const nowIso = new Date(nowMs).toISOString();
    const parts = releaseDecision(e, ride).split(':');
    if (parts[0] === 'reverse') {
        const note = `Sweep: ${parts[1]}`;
        await sr.DriverEarning.update(e.id, {
            status: 'reversed',
            reversed_at: nowIso,
            on_hold: false,
            admin_notes: e.admin_notes ? `${e.admin_notes} | ${note}` : note,
        });
        return 'reversed';
    }
    if (parts[0] === 'hold') {
        await sr.DriverEarning.update(e.id, { on_hold: true, hold_reason: parts[1] });
        return 'held';
    }
    // The guest has complained about this ride and admin has not closed it
    // yet. The pay waits; the next tick after the report is closed releases it.
    if (await hasOpenGuestReport(sr, e.ride_booking_id, e.driver_id)) return 'skipped';
    await sr.DriverEarning.update(e.id, {
        status: 'released', released_at: nowIso, on_hold: false, hold_reason: '',
    });
    // Admin, a reassignment or a cancellation may have reversed this row
    // while the ride was being read. If so it stays reversed, and the caller
    // does not tell the driver it was released.
    const after = await keepReversed(sr, e.id);
    return after && after.status === 'reversed' ? 'reversed' : 'released';
}

// One plain-text line to the admin group. Plain text on purpose: these
// messages carry vehicle names and reasons that were never escaped for
// Markdown, and Telegram drops a message it cannot parse.
async function notifyAdminLine(text: string) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
        });
    } catch (err) {
        console.error('Telegram notify failed:', err);
    }
}

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

async function runRideSweep(sdk: any): Promise<Record<string, number>> {
    const now = Date.now();
    let cancelled = 0;
    let warned = 0;
    let arriving = 0;
    let completed = 0;
    let released = 0;
    let payReversed = 0;

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

    // Pass 4 — a paid ride whose booked window is over is completed. Until
    // this pass existed nothing ever wrote the status; rides aged into "past"
    // by the clock alone.
    for (const r of confirmed) {
        if (!rideEnded(r, now)) continue;
        try {
            await sdk.asServiceRole.entities.RideBooking.update(r.id, {
                status: 'completed',
                completed_at: new Date().toISOString(),
                completed_by: 'system',
            });
            completed += 1;
        } catch (err) {
            console.error(`Failed to complete ride ${r.id}:`, err);
        }
    }

    // Pass 5 — release driver pay that has waited out its two hours. Wrapped
    // as a whole so that a failed page read here cannot cost the counts from
    // the passes above.
    try {
        const sr = sdk.asServiceRole.entities;
        const held = await fetchAll(sr.DriverEarning, { status: 'held' });
        for (const row of held) {
            if (!isReleasable(row, now)) continue;
            try {
                const outcome = await settleDueEarning(sr, row.id, now);
                const amount = `₦${(Number(row.amount_ngn) || 0).toLocaleString()}`;
                if (outcome === 'reversed') payReversed += 1;
                if (outcome === 'held') {
                    await notifyAdminLine(
                        `⏸ DRIVER PAY ON HOLD\n\n${amount} for ${row.vehicle_name || 'a ride'} (${row.booking_reference || row.ride_booking_id}) ` +
                        `was due for release, but the ride is not marked paid. Review it in Admin → Rides → Earnings.`,
                    );
                }
                if (outcome !== 'released') continue;
                released += 1;
                const driver = await sr.Driver.get(row.driver_id);
                const driverEmail = typeof driver?.user_email === 'string' ? driver.user_email.trim().toLowerCase() : '';
                if (driverEmail) {
                    await tryPush(sdk, {
                        user_email: driverEmail,
                        title: `💸 ${amount} is now available`,
                        body: `Your pay for the ${row.vehicle_name || 'ride'}${row.service_date ? ` on ${row.service_date}` : ''} has been released to your wallet.`,
                        url: '/DriverWallet',
                        tag: `driver-released-${row.id}`,
                    });
                }
            } catch (err) {
                console.error(`Failed to settle driver earning ${row.id}:`, err);
            }
        }
    } catch (err) {
        console.error('Driver pay release pass failed:', err);
    }

    return {
        scanned: pending.length + confirmed.length,
        cancelled, warned, arriving, completed, released, pay_reversed: payReversed,
    };
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