import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// checkRideAvailability
// ----------------------------------------------------------------------------
// Entry point for every ride request. Mirrors checkAvailabilityWebhook's role
// in the apartment flow, with four deliberate differences:
//
//   1. ONE ROW, NOT TWO. Apartments create an AvailabilityRequest *and* a
//      Booking, then re-join them later by a 4-field composite match. Rides
//      keep the decision state (approved_at / admin_response /
//      telegram_message_id) on the RideBooking itself. No FK to maintain.
//
//   2. CONFLICTS ARE A HARD BLOCK. The apartment flow flags a conflict and
//      creates the booking anyway, leaving the admin to enforce. A car cannot
//      be in two places, so there is no judgement call to preserve — we 409
//      before creating anything.
//
//   3. PRICE IS COMPUTED SERVER-SIDE from the Vehicle row. The apartment flow
//      trusts a client-supplied total_price, which means a tampered request
//      could set its own price and still pass payment verification (the
//      verifier only checks Paystack's amount against the stored total).
//      Rides never read a price off the request body.
//
//   4. ADD-ONS SKIP APPROVAL. A ride attached to a stay that is already
//      confirmed AND paid comes from a vetted guest, so it goes straight to
//      payment. An add-on against an *unpaid* stay is rejected outright
//      rather than silently downgraded to a standalone request.

// ── Ride time model ─────────────────────────────────────────────────────────
// DUPLICATED across ride functions — Base44 function directories are isolated
// and cannot import a shared module. Keep every copy in lockstep.
//
// Nigeria is WAT (UTC+1) year-round with no DST, and the offset MUST be
// pinned. Parsing "2026-08-10T09:00" without it resolves to the *runtime's*
// local zone: correct by accident on a WAT laptop, an hour out on the UTC
// server. That failure mode is invisible in local testing.
const WAT_OFFSET = '+01:00';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PAYMENT_WINDOW_MS = 1 * HOUR_MS;
const MAX_OPEN_REQUESTS = 3;
const MAX_HOURLY = 8;
// The booking form stops at 30 days (longer hires go by the week or month).
// The server has to say so too: the day count multiplies straight into the
// price, the driver's pay and the length of time the vehicle is blocked.
const MAX_MULTI_DAYS = 30;

function multiDaysOk(days: unknown) {
    const d = Number(days);
    return Number.isInteger(d) && d >= 1 && d <= MAX_MULTI_DAYS;
}

// Admin blocked this account from rides when resolving a report against it
// (resolveRideReport). Only the boolean true blocks.
function isRideBlocked(account: any) {
    return !!account && account.ride_blocked === true;
}

// Turnaround was a flat 2h constant until hourly hire landed. Two hours of
// clearance either side of a one-hour booking would cap a car at roughly three
// hires a day, so it is now per-vehicle and defaults to one hour.
const DEFAULT_TURNAROUND_MS = 1 * HOUR_MS;
function turnaroundMsFor(vehicle: any): number {
    const h = Number(vehicle?.turnaround_hours);
    return Number.isFinite(h) && h >= 0 ? h * HOUR_MS : DEFAULT_TURNAROUND_MS;
}

function rideStartAt(serviceDate: string, startTime: string): number {
    return Date.parse(`${serviceDate}T${startTime}:00${WAT_OFFSET}`);
}

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

function rideWindow(r: any): { startMs: number; endMs: number } | null {
    const startMs = rideStartAt(r.service_date, r.start_time);
    const dur = rideDurationMs(r.duration_tier, r.duration_days, r.duration_hours);
    if (Number.isNaN(startMs) || Number.isNaN(dur)) return null;
    return { startMs, endMs: startMs + dur };
}

// Conflict when the gap between two windows is smaller than the buffer, in
// either direction. The buffer appears once per side, which requires BUFFER
// of clearance rather than doubling it.
function windowsOverlap(
    aStart: number, aEnd: number,
    bStart: number, bEnd: number,
    buffer: number,
): boolean {
    return aStart < bEnd + buffer && aEnd + buffer > bStart;
}

// ── Pricing — derived from the Vehicle, never from the request body ─────────
// MIRRORED client-side by estimateRidePrice in src/config/rides.js, which
// draws the figure the guest sees before submitting. Keep the two in lockstep:
// if they disagree, the guest is quoted one number and charged another.
function priceForTier(vehicle: any, tier: string, days?: number, hours?: number): number | null {
    const d = Math.max(1, Number(days) || 1);
    const perHour = Number(vehicle.price_per_hour_ngn) || 0;
    const p12 = Number(vehicle.price_12hr_ngn) || 0;
    const p24 = Number(vehicle.price_24hr_ngn) || 0;
    const extra = Number(vehicle.price_per_extra_day_ngn) || 0;
    switch (tier) {
        case 'hourly': {
            const h = Math.min(MAX_HOURLY, Math.max(1, Number(hours) || 1));
            return perHour ? perHour * h : null;
        }
        case '12hr': return p12 || null;
        case '24hr': return p24 || null;
        // Fall back to a flat per-day rate when no extra-day price is set.
        case 'multi_day': return p24 ? p24 + (d - 1) * (extra || p24) : null;
        case 'weekly': return Number(vehicle.price_per_week_ngn) || (p24 ? p24 * 7 : null);
        case 'monthly': return Number(vehicle.price_per_month_ngn) || (p24 ? p24 * 30 : null);
        default: return null;
    }
}

// Overage rate for hours beyond the booked window. MIRRORED client-side by
// extraHourRate in src/config/rides.js. Falls back to the standard hourly rate
// so every hourly-capable car has an extra-hour rule, per the client's brief.
function extraHourRateFor(vehicle: any): number | null {
    return Number(vehicle.price_extra_hour_ngn) || Number(vehicle.price_per_hour_ngn) || null;
}

// Base44's .filter() silently caps at 50 rows. Anything scanning for conflicts
// must page or it will happily approve a double-booking it never saw.
const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, undefined, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

// ── Booking reference ──────────────────────────────────────────────────────
// A short code the guest can quote in a WhatsApp message and admin can search
// on. The row id remains the actual key — this is a human convenience, so a
// single collision re-roll is proportionate rather than a uniqueness index.
// Crockford base32 minus I/L/O/U: no character pairs that get misread aloud or
// transcribed wrongly, and no accidental words.
const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function makeReference(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    let out = 'UD-';
    for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
    return out;
}

async function uniqueReference(sdk: any): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const ref = makeReference();
        try {
            const hit = await sdk.asServiceRole.entities.RideBooking.filter({ booking_reference: ref }, undefined, 1);
            if (!Array.isArray(hit) || hit.length === 0) return ref;
        } catch (err) {
            // A lookup failure must never block a booking over a cosmetic code.
            console.warn('Reference collision check failed, accepting candidate:', err);
            return ref;
        }
    }
    return makeReference();
}

// Human-readable duration for admin messages. '12hr' reads as "Full day" to
// match what the guest was shown at checkout — admin and guest must be looking
// at the same words when they talk on the phone.
function describeDuration(r: any): string {
    switch (r.duration_tier) {
        case 'hourly': {
            const h = Math.max(1, Number(r.duration_hours) || 1);
            return `${h} hour${h === 1 ? '' : 's'}`;
        }
        case '12hr': return 'Full day (12 hours)';
        case '24hr': return '24 hours';
        case 'multi_day': {
            const d = Math.max(1, Number(r.duration_days) || 1);
            return `${d} day${d === 1 ? '' : 's'}`;
        }
        case 'weekly': return '1 week';
        case 'monthly': return '1 month';
        default: return String(r.duration_tier || 'unknown');
    }
}

async function notifyAdmin(opts: {
    ride: any;
    vehicle: any;
    startMs: number;
    endMs: number;
}): Promise<string | null> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) {
        console.warn('Telegram not configured — skipping ride admin notification');
        return null;
    }

    const fmt = (ms: number) =>
        new Date(ms).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
    const loc = opts.ride.pickup_location || {};
    const pickup = [loc.address, loc.area, loc.city].filter(Boolean).join(', ') || 'Not specified';

    const text = `🚗 *RIDE REQUEST*  \`${opts.ride.booking_reference || ''}\`\n\n` +
        `*${opts.vehicle.name}* (${opts.vehicle.brand})\n` +
        `📍 ${opts.vehicle.city}\n\n` +
        `👤 *Guest*\n` +
        `• Name: ${opts.ride.guest_name}\n` +
        `• Email: ${opts.ride.guest_email}\n` +
        `• Phone: ${opts.ride.guest_phone}\n` +
        `• Passengers: ${opts.ride.passengers}\n\n` +
        `🕒 *Window* (${describeDuration(opts.ride)})\n` +
        `• From: ${fmt(opts.startMs)}\n` +
        `• To:   ${fmt(opts.endMs)}\n\n` +
        `📌 Pickup: ${pickup}\n` +
        `💰 Estimate: ₦${(Number(opts.ride.total_price) || 0).toLocaleString()}\n` +
        (opts.ride.extra_hour_rate_ngn
            ? `⏱ Extra hours: ₦${Number(opts.ride.extra_hour_rate_ngn).toLocaleString()}/hr\n`
            : '') +
        (opts.ride.special_requests ? `\n📝 ${opts.ride.special_requests}\n` : '') +
        `\n_Approving here accepts the estimate. To change the price first, use the Admin panel._\n` +
        `\n*Ride ID:* \`${opts.ride.id}\``;

    const replyMarkup = {
        inline_keyboard: [[
            { text: '✅ Approve', callback_data: `ride_approve_${opts.ride.id}` },
            { text: '❌ Reject', callback_data: `ride_reject_${opts.ride.id}` },
        ]],
    };

    const send = async (endpoint: string, payload: Record<string, unknown>) => {
        const res = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return res.json();
    };

    try {
        // Prefer a photo of the vehicle. If Telegram cannot fetch the image
        // (signed URL, bad host) fall back to text so the request is never
        // silently dropped — the same failure the apartment flow hit.
        const image = Array.isArray(opts.vehicle.images) ? opts.vehicle.images[0] : null;
        if (image) {
            const photo = await send('sendPhoto', {
                chat_id: chatId, photo: image, caption: text,
                parse_mode: 'Markdown', reply_markup: replyMarkup,
            });
            if (photo.ok) return String(photo.result.message_id);
            console.warn('sendPhoto failed, falling back to sendMessage:', photo.description);
        }
        const msg = await send('sendMessage', {
            chat_id: chatId,
            text: image ? `${text}\n\n🖼 ${image}` : text,
            parse_mode: 'Markdown', reply_markup: replyMarkup,
        });
        return msg.ok ? String(msg.result.message_id) : null;
    } catch (err) {
        console.error('Ride admin notification failed (non-fatal):', err);
        return null;
    }
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        // Read the account fresh under the service role rather than trusting
        // the copy on the session: a block must take effect at once.
        const accounts = await base44.asServiceRole.entities.User.filter({ email: user.email });
        if (isRideBlocked(accounts?.[0])) {
            return json({
                success: false,
                error: 'Ride bookings are not available on this account. Please contact support.',
                code: 'RIDE_BLOCKED',
            }, 403);
        }

        const body = await req.json().catch(() => ({}));
        const {
            vehicle_id, service_date, start_time, duration_tier,
            duration_days, duration_hours, pickup_location, dropoff_location,
            passengers, special_requests, linked_property_booking_id,
        } = body || {};

        // ── Validation ──────────────────────────────────────────────────
        if (!vehicle_id || !service_date || !start_time || !duration_tier) {
            return json({
                success: false,
                error: 'vehicle_id, service_date, start_time and duration_tier are all required',
            }, 400);
        }
        if (!user.phone_number && !body.guest_phone) {
            return json({ success: false, error: 'A phone number is required to book a ride', code: 'PHONE_REQUIRED' }, 400);
        }
        if (duration_tier === 'multi_day' && !multiDaysOk(duration_days)) {
            return json({
                success: false,
                error: `Multi-day bookings are for 1 to ${MAX_MULTI_DAYS} whole days. For longer, book by the week or the month.`,
                code: 'INVALID_DAYS',
            }, 400);
        }
        if (duration_tier === 'hourly') {
            const h = Number(duration_hours);
            if (!Number.isFinite(h) || h < 1 || h > MAX_HOURLY) {
                return json({
                    success: false,
                    error: `Hourly bookings run from 1 to ${MAX_HOURLY} hours`,
                    code: 'INVALID_HOURS',
                }, 400);
            }
        }

        const win = rideWindow({ service_date, start_time, duration_tier, duration_days, duration_hours });
        if (!win) return json({ success: false, error: 'Invalid date, time or duration tier' }, 400);
        if (win.startMs <= Date.now()) {
            return json({ success: false, error: 'Pickup time must be in the future', code: 'START_IN_PAST' }, 400);
        }

        // ── Vehicle must exist and be bookable ──────────────────────────
        const vehicle = await base44.asServiceRole.entities.Vehicle.get(vehicle_id);
        if (!vehicle) return json({ success: false, error: 'Vehicle not found' }, 404);
        if (vehicle.active === false || vehicle.admin_approved === false) {
            return json({ success: false, error: 'This vehicle is not currently available', code: 'VEHICLE_UNAVAILABLE' }, 409);
        }
        if (passengers && vehicle.max_passengers && Number(passengers) > Number(vehicle.max_passengers)) {
            return json({
                success: false,
                error: `This vehicle seats ${vehicle.max_passengers}`,
                code: 'TOO_MANY_PASSENGERS',
            }, 400);
        }

        // A vehicle can set its own floor — an owner may not want their car out
        // for a single hour. Checked before pricing so the guest gets the
        // actionable message ("this one needs 3 hours") rather than a bare
        // "no price for that duration".
        if (duration_tier === 'hourly') {
            const floor = Math.max(1, Number(vehicle.min_hours_per_booking) || 1);
            if (Number(duration_hours) < floor) {
                return json({
                    success: false,
                    error: `${vehicle.name} takes a minimum booking of ${floor} hour${floor === 1 ? '' : 's'}`,
                    code: 'BELOW_MIN_HOURS',
                    details: { min_hours: floor },
                }, 409);
            }
        }

        const total_price = priceForTier(vehicle, duration_tier, duration_days, duration_hours);
        if (!total_price) {
            return json({
                success: false,
                error: duration_tier === 'hourly'
                    ? `${vehicle.name} is not available by the hour — try a full day instead`
                    : 'This vehicle has no price set for that duration',
                code: 'NO_PRICE_FOR_TIER',
            }, 409);
        }

        // ── Open-request cap ────────────────────────────────────────────
        // Replaces the apartment flow's same-user-same-property rule, which
        // for rides would wrongly block a guest booking one car for two
        // different days. This caps inventory a single account can hold.
        const openRides = await fetchAll(base44.asServiceRole.entities.RideBooking, {
            guest_email: user.email, status: 'pending', payment_status: 'unpaid',
        });
        if (openRides.length >= MAX_OPEN_REQUESTS) {
            return json({
                success: false,
                error: `You already have ${openRides.length} ride requests awaiting approval or payment. Complete or cancel one first.`,
                code: 'TOO_MANY_OPEN_REQUESTS',
            }, 409);
        }

        // ── Hard conflict block ─────────────────────────────────────────
        const held = await fetchAll(base44.asServiceRole.entities.RideBooking, {
            vehicle_id, status: { $in: ['pending', 'confirmed'] },
        });
        for (const other of held) {
            const ow = rideWindow(other);
            if (!ow) continue;
            if (windowsOverlap(win.startMs, win.endMs, ow.startMs, ow.endMs, turnaroundMsFor(vehicle))) {
                return json({
                    success: false,
                    error: 'This vehicle is already booked for an overlapping window.',
                    code: 'VEHICLE_DOUBLE_BOOKED',
                    conflict: { start_at: new Date(ow.startMs).toISOString(), end_at: new Date(ow.endMs).toISOString() },
                }, 409);
            }
        }

        // ── Add-on branch ───────────────────────────────────────────────
        // A ride attached to a stay that is confirmed AND paid comes from an
        // already-vetted guest, so it skips approval. Anything else is
        // rejected explicitly — silently falling through to a standalone
        // request would give the guest a second approval queue and a second
        // payment clock drifting against the first.
        let isAddOn = false;
        if (linked_property_booking_id) {
            const stay = await base44.asServiceRole.entities.Booking.get(linked_property_booking_id);
            if (!stay || stay.guest_email !== user.email) {
                return json({ success: false, error: 'Linked booking not found', code: 'STAY_NOT_FOUND' }, 404);
            }
            if (stay.status !== 'confirmed' || stay.payment_status !== 'paid') {
                return json({
                    success: false,
                    error: 'Finish paying for your stay before adding a ride to it.',
                    code: 'STAY_NOT_PAID',
                    booking_id: stay.id,
                }, 409);
            }
            isAddOn = true;
        }

        // ── Create ──────────────────────────────────────────────────────
        const nowIso = new Date().toISOString();
        const payload: Record<string, unknown> = {
            vehicle_id,
            vehicle_name: vehicle.name,
            vehicle_image: Array.isArray(vehicle.images) ? vehicle.images[0] : undefined,
            guest_name: user.full_name || 'Guest User',
            guest_email: user.email,
            guest_phone: body.guest_phone || user.phone_number,
            booking_reference: await uniqueReference(base44),
            service_date,
            start_time,
            duration_tier,
            duration_days: duration_tier === 'multi_day' ? Number(duration_days) : 1,
            duration_hours: duration_tier === 'hourly' ? Number(duration_hours) : undefined,
            start_at: new Date(win.startMs).toISOString(),
            end_at: new Date(win.endMs).toISOString(),
            pickup_location: pickup_location || undefined,
            dropoff_location: dropoff_location || undefined,
            passengers: Number(passengers) || 1,
            special_requests: special_requests || '',
            // Both figures start equal. estimated_price is then frozen, while
            // total_price is what admin may adjust at approval and is the only
            // one the payment path ever reads.
            estimated_price: total_price,
            total_price,
            // Snapshotted like vehicle_name: the overage rate the guest saw
            // when they requested is the one that applies to this trip, even
            // if admin re-prices the car next week.
            extra_hour_rate_ngn: extraHourRateFor(vehicle) ?? undefined,
            status: 'pending',
            payment_status: 'unpaid',
            linked_property_booking_id: linked_property_booking_id || undefined,
        };

        // Add-ons are pre-approved, so the payment clock starts immediately.
        if (isAddOn) {
            payload.approved_at = nowIso;
            payload.payment_deadline = new Date(Date.now() + PAYMENT_WINDOW_MS).toISOString();
            payload.admin_response = 'Added to your existing stay — no approval needed.';
        }

        const ride = await base44.entities.RideBooking.create(payload);

        if (isAddOn) {
            return json({
                success: true,
                data: { ride_booking_id: ride.id, total_price, next: 'payment' },
            });
        }

        const messageId = await notifyAdmin({ ride, vehicle, startMs: win.startMs, endMs: win.endMs });
        if (messageId) {
            try {
                await base44.asServiceRole.entities.RideBooking.update(ride.id, { telegram_message_id: messageId });
            } catch (err) {
                console.warn('Could not stamp telegram_message_id (non-fatal):', err);
            }
        }

        return json({
            success: true,
            data: {
                ride_booking_id: ride.id,
                total_price,
                next: 'await_approval',
                telegram_sent: !!messageId,
            },
        });
    } catch (error) {
        console.error('checkRideAvailability error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
