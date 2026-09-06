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

// ── Ride time model — lockstep copy, see checkRideAvailability ──────────────
const WAT_OFFSET = '+01:00';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TURNAROUND_MS = 2 * HOUR_MS;

function rideDurationMs(tier: string, days?: number): number {
    switch (tier) {
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
        const dur = rideDurationMs(r.duration_tier, r.duration_days);
        if (Number.isNaN(dur)) return null;
        endMs = startMs + dur;
    }
    return { startMs, endMs };
}

function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number, buffer = TURNAROUND_MS): boolean {
    return aStart < bEnd + buffer && aEnd + buffer > bStart;
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

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', opts);
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

        const { ride_booking_id, driver_id } = await req.json().catch(() => ({}));
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
            if (windowsOverlap(win.startMs, win.endMs, ow.startMs, ow.endMs)) {
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

        const reassigning = !!ride.driver_id && ride.driver_id !== driver_id;
        await base44.asServiceRole.entities.RideBooking.update(ride_booking_id, {
            driver_id,
            driver_assigned_at: new Date().toISOString(),
        });

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

        return json({
            success: true,
            data: { ride_booking_id, driver_id, driver_name: driver.full_name, reassigned: reassigning },
        });
    } catch (error) {
        console.error('assignRideDriver error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
