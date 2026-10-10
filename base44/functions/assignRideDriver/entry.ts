import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// assignRideDriver
// ----------------------------------------------------------------------------
// Admin attaches a driver to a paid ride. Assignment happens after payment by
// design: approval commits the vehicle, and holding a driver against a booking
// that may still expire would take them out of circulation for nothing.
//
// Enforces driver availability with the same overlap rule used for vehicles,
// filtered on driver_id — a driver cannot be in two cars at once any more than
// a car can be in two places.
//
// Also the moment the driver's pay is HELD. For a driver who has a login
// (Driver.user_email), a DriverEarning row is written for the pay figure —
// what admin typed, or the vehicle's driver cost for the booked duration.
// The sweep releases it two hours after the booked end. A driver without a
// login is assigned exactly as before and nothing is recorded.

// ── Ride time model — lockstep copy, see checkRideAvailability ──────────────
const WAT_OFFSET = '+01:00';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_HOURLY = 8;

// Per-vehicle turnaround — lockstep copy, see checkRideAvailability. A driver
// needs the same clearance between jobs that a car does.
const DEFAULT_TURNAROUND_MS = 1 * HOUR_MS;
function turnaroundMsFor(vehicle: any): number {
    const h = Number(vehicle?.turnaround_hours);
    return Number.isFinite(h) && h >= 0 ? h * HOUR_MS : DEFAULT_TURNAROUND_MS;
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

function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number, buffer: number): boolean {
    return aStart < bEnd + buffer && aEnd + buffer > bStart;
}

// ── Driver pay model ────────────────────────────────────────────────────────
// What a driver is paid for a ride, read off the vehicle's VehicleCosting row.
// MIRRORED client-side by driverPayoutFor in src/config/rides.js, which draws
// the figure in the Assign driver dialog before anything is submitted. This
// copy is the one that reaches the ledger; scripts/check-driver-wallet.mjs
// executes both and fails if they disagree for any duration tier.
//
// Held pay becomes releasable two hours after the booked end, so an
// extra-hour settlement or a complaint from either side can land first.
const RELEASE_BUFFER_MS = 2 * HOUR_MS;
const MAX_PAYOUT_NGN = 50000000;

function driverPayoutFor(costing: any, tier: string, hours?: number, days?: number) {
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
            units = Math.min(MAX_HOURLY, Math.max(1, Math.round(Number(hours) || 1)));
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
    return { amount: rate * units, basis, rate, units };
}

function releaseAtFor(endAtIso: string) {
    const endMs = Date.parse(endAtIso || '');
    if (Number.isNaN(endMs)) return null;
    return new Date(endMs + RELEASE_BUFFER_MS).toISOString();
}

// The pay figure admin typed, if any. { ok: true, value: null } means nothing
// was typed and the costing row decides. Anything that is not a whole-naira
// amount between 0 and the ceiling is refused rather than coerced, so NaN or
// "25,000" read as 25 can never reach the ledger.
function parsePayoutOverride(raw: unknown) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null };
    const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PAYOUT_NGN) {
        return { ok: false, value: null };
    }
    return { ok: true, value: Math.round(n) };
}

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

// ── Driver earnings ledger ──────────────────────────────────────────────────
// Bodies are plain JavaScript on purpose: scripts/check-driver-wallet.mjs
// lifts these two off disk and runs them against an in-memory ledger.

// Hold the new driver's pay. Returns the earning that now stands for this
// driver on this ride, or null when there is nothing to hold. Safe to call
// twice: a standing row is returned as it is, never duplicated or repriced.
async function holdEarning(sr: any, ride: any, driverId: string, payout: any, endAtIso: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: ride.id });
    const standing = ledger.find((e) => e.driver_id === driverId && e.status !== 'reversed');
    if (standing) return standing;
    if (!payout || !(payout.amount > 0)) return null;
    await sr.DriverEarning.create({
        driver_id: driverId,
        ride_booking_id: ride.id,
        booking_reference: ride.booking_reference || '',
        vehicle_name: ride.vehicle_name || '',
        service_date: ride.service_date,
        end_at: endAtIso,
        amount_ngn: payout.amount,
        basis: payout.basis,
        rate_ngn: payout.rate,
        units: payout.units,
        status: 'held',
        on_hold: false,
        release_at: releaseAtFor(endAtIso),
        held_at: nowIso,
    });
    // Two admins assigning in the same second would both reach this line. The
    // oldest held row for this driver and ride stands; any twin is reversed.
    const twins = await fetchAll(sr.DriverEarning, { ride_booking_id: ride.id, driver_id: driverId, status: 'held' });
    twins.sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
        || String(a.id).localeCompare(String(b.id)));
    for (const extra of twins.slice(1)) {
        await sr.DriverEarning.update(extra.id, {
            status: 'reversed', reversed_at: nowIso, admin_notes: `Duplicate of ${twins[0].id}`,
        });
    }
    return twins[0] || null;
}

// Reverse the pay still HELD on a ride for every driver except keepDriverId
// (pass '' to reverse all of it). Released rows are never clawed back here;
// they are totalled so the caller can tell admin. Lockstep copy in
// cancelRideBooking.
async function reverseHeldEarnings(sr: any, rideId: string, keepDriverId: string, note: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: rideId });
    const out = { reversed_ngn: 0, released_ngn: 0, driver_ids: [] };
    for (const e of ledger) {
        if (keepDriverId && e.driver_id === keepDriverId) continue;
        const amount = Math.max(0, Math.round(Number(e.amount_ngn) || 0));
        if (e.status === 'held') {
            await sr.DriverEarning.update(e.id, {
                status: 'reversed',
                reversed_at: nowIso,
                on_hold: false,
                admin_notes: e.admin_notes ? `${e.admin_notes} | ${note}` : note,
            });
            out.reversed_ngn += amount;
            if (!out.driver_ids.includes(e.driver_id)) out.driver_ids.push(e.driver_id);
        } else if (e.status === 'released') {
            out.released_ngn += amount;
        }
    }
    return out;
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
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

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);
        if (user.role !== 'admin') return json({ success: false, error: 'Admin access required' }, 403);

        const { ride_booking_id, driver_id, pickup_instructions, driver_payout_ngn } = await req.json().catch(() => ({}));
        if (!ride_booking_id || !driver_id) {
            return json({ success: false, error: 'ride_booking_id and driver_id are required' }, 400);
        }

        const ride = await base44.asServiceRole.entities.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);
        if (ride.status === 'cancelled') {
            return json({ success: false, error: 'This ride was cancelled', code: 'CANCELLED' }, 409);
        }
        if (ride.payment_status !== 'paid') {
            return json({
                success: false,
                error: 'Assign a driver only after the ride is paid.',
                code: 'NOT_PAID',
            }, 409);
        }

        const driver = await base44.asServiceRole.entities.Driver.get(driver_id);
        if (!driver) return json({ success: false, error: 'Driver not found' }, 404);
        if (driver.active === false || driver.admin_approved === false) {
            return json({
                success: false,
                error: 'That driver is inactive or not approved.',
                code: 'DRIVER_UNAVAILABLE',
            }, 409);
        }

        // City mismatch is almost always a mis-click rather than an intent to
        // send a driver between Abuja and Lagos, so it is worth blocking.
        const vehicle = await base44.asServiceRole.entities.Vehicle.get(ride.vehicle_id);
        if (vehicle?.city && driver.city && vehicle.city !== driver.city) {
            return json({
                success: false,
                error: `${driver.full_name} is based in ${driver.city} but this vehicle is in ${vehicle.city}.`,
                code: 'CITY_MISMATCH',
            }, 409);
        }

        const win = windowOf(ride);
        if (!win) return json({ success: false, error: 'This ride has an unreadable time window' }, 409);

        // Driver double-booking check, same overlap rule as vehicles.
        const theirRides = await fetchAll(base44.asServiceRole.entities.RideBooking, {
            driver_id, status: { $in: ['pending', 'confirmed'] },
        });
        for (const other of theirRides) {
            if (other.id === ride.id) continue;
            const ow = windowOf(other);
            if (!ow) continue;
            if (windowsOverlap(win.startMs, win.endMs, ow.startMs, ow.endMs, turnaroundMsFor(vehicle))) {
                return json({
                    success: false,
                    error: `${driver.full_name} is already driving another booking in that window.`,
                    code: 'DRIVER_DOUBLE_BOOKED',
                    conflict: {
                        ride_booking_id: other.id,
                        start_at: new Date(ow.startMs).toISOString(),
                        end_at: new Date(ow.endMs).toISOString(),
                    },
                }, 409);
            }
        }

        const sr = base44.asServiceRole.entities;
        const reassigning = !!ride.driver_id && ride.driver_id !== driver_id;
        const nowIso = new Date().toISOString();

        // ── Driver pay ──────────────────────────────────────────────────
        // Tracked only for a driver who has a login to see it with. ₦0 is a
        // real answer ("paid inside the partner's rate") and holds nothing;
        // no figure at all is refused so nobody drives for an unknown amount.
        const linkedEmail = typeof driver.user_email === 'string' ? driver.user_email.trim().toLowerCase() : '';
        let payout: any = null;
        if (linkedEmail) {
            const typed = parsePayoutOverride(driver_payout_ngn);
            if (!typed.ok) {
                return json({
                    success: false,
                    error: 'Driver pay must be a whole naira amount between 0 and 50,000,000.',
                    code: 'INVALID_PAYOUT',
                }, 400);
            }
            if (typed.value !== null) {
                payout = { amount: typed.value, basis: 'manual', rate: typed.value, units: 1 };
            } else {
                const costings = await sr.VehicleCosting.filter({ vehicle_id: ride.vehicle_id });
                payout = driverPayoutFor(costings?.[0] || null, ride.duration_tier, ride.duration_hours, ride.duration_days);
                if (!payout) {
                    return json({
                        success: false,
                        error: 'No driver cost is set for this vehicle. Enter the pay for this ride, or set it under Vehicles → Internal costing.',
                        code: 'PAYOUT_REQUIRED',
                    }, 409);
                }
            }
        }

        const earning = linkedEmail
            ? await holdEarning(sr, ride, driver_id, payout, new Date(win.endMs).toISOString(), nowIso)
            : null;

        await sr.RideBooking.update(ride_booking_id, {
            driver_id,
            driver_assigned_at: nowIso,
            // Only overwrite when something was actually typed — a reassignment
            // that leaves the box blank must not wipe instructions already
            // written for this pickup.
            ...(typeof pickup_instructions === 'string' && pickup_instructions.trim()
                ? { pickup_instructions: pickup_instructions.trim() }
                : {}),
        });

        // Runs for every assignment, linked driver or not: handing a ride to
        // someone else must always take it off the previous driver's ledger.
        const others = await reverseHeldEarnings(sr, ride_booking_id, driver_id, `Reassigned to ${driver.full_name}`, nowIso);

        // Guest email with the driver's details — this is the moment the
        // contact becomes visible, so it goes out by email as well as push
        // rather than relying on the guest opening the app.
        try {
            const when = new Date(win.startMs).toLocaleString('en-GB', {
                timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short',
            });
            await base44.integrations.Core.SendEmail({
                to: ride.guest_email,
                subject: reassigning
                    ? `Driver update for your ${ride.vehicle_name}`
                    : `Your driver for the ${ride.vehicle_name}`,
                body: `Hi ${ride.guest_name || 'there'},\n\n` +
                    `${reassigning ? 'Your driver has been changed.' : 'Your driver is confirmed.'}\n\n` +
                    `👤 Driver: ${driver.full_name}\n` +
                    `📞 Phone: ${driver.phone}\n` +
                    (driver.years_experience ? `⭐ Experience: ${driver.years_experience} years\n` : '') +
                    `🚗 Vehicle: ${ride.vehicle_name}\n` +
                    `🕒 Pickup: ${when}\n\n` +
                    `They'll be in touch closer to the time. Safe travels.\n\n` +
                    `— Urban Stays`,
                from_name: 'Urban Stays',
            });
        } catch (err) {
            console.warn('Driver assignment email failed (non-fatal):', err);
        }

        await tryPush(base44, {
            user_email: ride.guest_email,
            title: reassigning ? '🔄 Driver updated' : '👤 Driver assigned',
            body: `${driver.full_name} will be driving your ${ride.vehicle_name}. Tap for their details.`,
            url: `/Bookings#ride-${ride.id}`,
            tag: `ride-driver-${ride.id}`,
        });

        // The driver hears about it too, now that they have somewhere to look.
        const whenShort = new Date(win.startMs).toLocaleString('en-GB', {
            timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
        });
        if (linkedEmail) {
            await tryPush(base44, {
                user_email: linkedEmail,
                title: '🚗 New ride assigned',
                body: earning && earning.status === 'held'
                    ? `${ride.vehicle_name} on ${whenShort} · ₦${(Number(earning.amount_ngn) || 0).toLocaleString()} held until the trip ends`
                    : `${ride.vehicle_name} on ${whenShort}. Tap for the pickup details.`,
                url: `/DriverRides#ride-${ride.id}`,
                tag: `driver-assigned-${ride.id}`,
            });
        }
        if (reassigning) {
            try {
                const previous = await sr.Driver.get(ride.driver_id);
                const previousEmail = typeof previous?.user_email === 'string' ? previous.user_email.trim().toLowerCase() : '';
                if (previousEmail) {
                    await tryPush(base44, {
                        user_email: previousEmail,
                        title: '🔄 Ride reassigned',
                        body: `You are no longer driving the ${ride.vehicle_name} on ${whenShort}.`,
                        url: '/DriverRides',
                        tag: `driver-removed-${ride.id}`,
                    });
                }
            } catch (err) {
                console.warn('Previous driver push failed (non-fatal):', err);
            }
        }

        return json({
            success: true,
            data: {
                ride_booking_id,
                driver_id,
                driver_name: driver.full_name,
                reassigned: reassigning,
                // false means this driver has no login, so nothing was recorded.
                pay_tracked: !!linkedEmail,
                driver_payout_ngn: earning ? Number(earning.amount_ngn) || 0 : (payout ? payout.amount : null),
                payout_basis: earning ? earning.basis || null : (payout ? payout.basis : null),
                earning_id: earning ? earning.id : null,
                // The previous driver's pay was already released and has NOT
                // been taken back. Admin decides in Rides → Earnings.
                previous_earning_released: others.released_ngn > 0,
            },
        });
    } catch (error) {
        console.error('assignRideDriver error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
