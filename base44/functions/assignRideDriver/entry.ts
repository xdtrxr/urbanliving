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
// login is assigned exactly as before and nothing is recorded. A figure of
// ₦0 holds nothing, so the ride row also keeps which driver a figure was
// given for (pay_answered_for): that is how getRideBookings tells "paid
// nothing through the app, on purpose" from "nobody recorded their pay".
//
// TWO ASSIGNMENTS AT ONCE. Nothing here can lock the ride, so a second
// assignment can land a moment before or after this one. writeAssignment
// writes the ride row and then makes the ledger agree with whoever the ride
// row says is driving, however the two calls interleave: that driver ends
// with one held row and nobody else with any. The call that lost is told so
// (SUPERSEDED) and its guest is not notified.
//
// THE SAME DRIVER AGAIN is not a new assignment. It is how pay is recorded
// for a ride that was assigned before the driver had a login, or before pay
// was tracked: the checks on whether this driver should be sent are skipped,
// the guest is not told a second time, and a standing pay row is never
// repriced.
//
// A STALE DIALOG. "The same driver again" is judged against the ride row as
// it is now, and the dialog was drawn from the ride as it was when it was
// opened. So the dialog also says who it believed was on the ride
// (expected_driver_id). If that is no longer who the ride row names, someone
// has changed the driver since, and nothing is written (SUPERSEDED):
// otherwise "Record pay" for the driver who was on the ride would hand the
// ride back to them. A request without the field is not checked.

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// Admin blocked this account from rides when resolving a report against it
// (resolveRideReport). Only the boolean true blocks. Lockstep copy, see
// checkRideAvailability.
function isRideBlocked(account: any) {
    return !!account && account.ride_blocked === true;
}

// Whether the account a ride was booked under is blocked from rides. Looks
// only at an account that really has that address: a ride row with no guest
// email must not match whichever account the lookup happened to return.
function guestIsBlocked(accounts: any[], email: string) {
    const wanted = String(email || '').trim().toLowerCase();
    if (!wanted) return false;
    return (accounts || []).some((a) => !!a && String(a.email || '').trim().toLowerCase() === wanted && isRideBlocked(a));
}

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

// The stretch a ride keeps its driver, or its car, busy, given its booked
// window `w`. A ride still to run, or running, holds them for all of it. A
// completed ride held them until it was completed: at its booked end if the
// sweep closed it, earlier if admin marked it done because the guest finished
// early. The caller adds the turnaround. Lockstep copy in
// checkRideAvailability.
function busyWindow(ride: any, w: any) {
    if (!w) return null;
    if (ride.status !== 'completed') return w;
    const doneMs = Date.parse(ride.completed_at || '');
    if (Number.isNaN(doneMs)) return w;
    return { startMs: w.startMs, endMs: Math.max(w.startMs, Math.min(w.endMs, doneMs)) };
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
    // The booked duration is whatever the guest typed at request time and the
    // rate is whatever admin typed. A product that is not a finite amount
    // under the ceiling is not a pay figure: return nothing, so the dialog
    // asks admin to type one.
    const amount = rate * units;
    if (!Number.isFinite(amount) || amount > MAX_PAYOUT_NGN) return null;
    return { amount, basis, rate, units };
}

function releaseAtFor(endAtIso: string) {
    const endMs = Date.parse(endAtIso || '');
    if (Number.isNaN(endMs)) return null;
    // An end at the very edge of the representable range parses, but two
    // hours later does not exist and toISOString would throw on it.
    const release = new Date(endMs + RELEASE_BUFFER_MS);
    if (Number.isNaN(release.getTime())) return null;
    return release.toISOString();
}

// The pay figure admin typed, if any. { ok: true, value: null } means nothing
// was typed and the costing row decides. Anything that is not a whole-naira
// amount between 0 and the ceiling is refused rather than coerced, so NaN or
// "25,000" read as 25 can never reach the ledger.
function parsePayoutOverride(raw: unknown) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null };
    // Plain digits only. Number() would also swallow "1e3", "0x10" and "+5".
    if (typeof raw === 'string' && !/^\d{1,9}(\.\d+)?$/.test(raw.trim())) return { ok: false, value: null };
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

// ISO string for an instant, or null when it is not a representable date. A
// ride's end is derived from the duration the guest booked, so it is checked
// before anything calls toISOString on it.
function safeIso(ms: number) {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Hold the new driver's pay. Returns the earning that now stands for this
// driver on this ride, or null when there is nothing to hold. Safe to call
// twice: a standing row is returned as it is, never duplicated or repriced.
async function holdEarning(sr: any, ride: any, driverId: string, payout: any, endAtIso: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: ride.id });
    const standing = ledger.find((e) => e.driver_id === driverId && e.status !== 'reversed');
    if (standing) return standing;
    if (!payout || !(payout.amount > 0)) return null;
    // No readable end means no moment to release at. Refuse loudly rather
    // than write a row that could never be paid out.
    const releaseAt = releaseAtFor(endAtIso);
    if (!releaseAt) throw new Error('holdEarning: this ride has no readable end time');
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
        release_at: releaseAt,
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
// they are totalled so the caller can tell admin. The rows that were reversed
// are handed back as they were read, pay figures included. Lockstep copy in
// cancelRideBooking.
async function reverseHeldEarnings(sr: any, rideId: string, keepDriverId: string, note: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: rideId });
    const out = { reversed_ngn: 0, released_ngn: 0, driver_ids: [], rows: [] };
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
            out.rows.push(e);
        } else if (e.status === 'released') {
            out.released_ngn += amount;
        }
    }
    return out;
}

// The pay figures on a ledger row, in the shape holdEarning takes.
function payoutOf(earning: any) {
    return {
        amount: Math.max(0, Math.round(Number(earning.amount_ngn) || 0)),
        basis: earning.basis || 'manual',
        rate: Math.max(0, Math.round(Number(earning.rate_ngn) || 0)),
        units: Number(earning.units) || 1,
    };
}

// How many times realignLedger looks again before it gives up and says so.
const MAX_REALIGN_PASSES = 6;

// Make the ledger agree with whoever the ride row says is driving NOW. That
// is not always the driver this call just wrote: another assignment for the
// same ride can land a moment before or after this one, and nothing here can
// lock the ride.
//
// Each pass reads the ride, reverses pay still held for anyone else, and
// makes sure the driver on the ride has a standing row. Every write is made
// on a reading of the ride that may be stale by the time it lands, so every
// write is followed by another pass, and the loop ends on a pass that found
// nothing to fix. If this call reversed a row for a driver who turns out to
// be on the ride after all, it holds the same figures for them again, as a
// new row: a reversed row is never revived.
//
// scripts/check-driver-wallet.mjs runs two of these against each other in
// every order their requests could arrive.
async function realignLedger(sr: any, ride: any, driverId: string, payout: any, endAtIso: string, note: string, nowIso: string, heldBefore: any) {
    const out = { settled: false, superseded: false, cancelled: false, current_driver_id: '', earning: null, reversed_ngn: 0, released_ngn: 0 };
    // Rows this call reversed, and the ids of rows it created.
    const taken = [];
    const made = heldBefore ? [heldBefore.id] : [];
    for (let pass = 0; pass < MAX_REALIGN_PASSES && !out.settled; pass += 1) {
        const now = await sr.RideBooking.get(ride.id);
        // A ride cancelled while this was running, or gone, has nobody
        // driving it: every held row comes off and none goes on.
        const cancelled = !now || now.status === 'cancelled';
        const currentId = cancelled ? '' : (now.driver_id || '');
        out.cancelled = cancelled;
        const others = await reverseHeldEarnings(sr, ride.id, currentId, note, nowIso);
        taken.push(...others.rows);
        let wrote = others.rows.length > 0;
        // What the driver on the ride should be holding: this call's figure
        // if it is this call's driver, otherwise what this call took off
        // them on an earlier pass, when the ride row still named someone else.
        const theirs = taken.filter((e) => e.driver_id === currentId);
        const figures = currentId === driverId ? payout : (theirs.length > 0 ? payoutOf(theirs[theirs.length - 1]) : null);
        let standing = null;
        if (currentId && figures) {
            standing = await holdEarning(sr, ride, currentId, figures, endAtIso, nowIso);
            if (standing && standing.held_at === nowIso && !made.includes(standing.id)) {
                made.push(standing.id);
                wrote = true;
            }
            // Held, and gone again before this call could look: another call
            // reversed it on a stale reading of the ride. Look again.
            if (!standing && figures.amount > 0) wrote = true;
        }
        out.superseded = currentId !== driverId;
        out.current_driver_id = currentId;
        out.earning = out.superseded ? null : standing;
        out.reversed_ngn += others.reversed_ngn;
        out.released_ngn = others.released_ngn;
        out.settled = !wrote;
    }
    return out;
}

// Everything an assignment writes, in the one order that is safe.
//   1. The pay row. If the ledger cannot be written this throws, and the ride
//      is not handed to a driver whose pay could not be recorded.
//   2. The ride row. When the same driver is submitted again `patch` names
//      no driver: at most who the pay figure was for, and new instructions.
//   3. The ledger is made to agree with the ride row. A failure here is
//      reported in ledger_error, not thrown: the driver IS on the ride by
//      then, and answering "it failed" would be a lie admin might act on.
// `payout` is null for a driver with no login: nothing is recorded for them.
async function writeAssignment(sr: any, ride: any, driverId: string, payout: any, endAtIso: string, patch: any, note: string, nowIso: string) {
    const first = payout ? await holdEarning(sr, ride, driverId, payout, endAtIso, nowIso) : null;
    if (Object.keys(patch || {}).length > 0) await sr.RideBooking.update(ride.id, patch);
    try {
        const out = await realignLedger(sr, ride, driverId, payout, endAtIso, note, nowIso, first);
        return { ...out, ledger_error: out.settled ? '' : 'the ledger did not settle' };
    } catch (err) {
        return {
            settled: false,
            superseded: false,
            current_driver_id: driverId,
            earning: first,
            reversed_ngn: 0,
            released_ngn: 0,
            ledger_error: String((err && err.message) || err),
        };
    }
}

// Who is told about an assignment. The guest hears when a driver is being
// sent to them: not when the same driver is submitted again to record pay,
// and not when a driver is attached to a ride that is already over. The
// driver hears about a new job or, when there is no new job, about pay that
// was recorded just now.
function assignmentNotices(sameDriver: boolean, rideOver: boolean, payIsNew: boolean) {
    const newJob = !sameDriver && !rideOver;
    return { guest: newJob, driver: newJob ? 'assigned' : (payIsNew ? 'pay' : '') };
}

// Whether the driver on the ride is no longer the one the Assign driver
// dialog saw when it was opened ('' for nobody). Only a request that says who
// it expected is judged: a page loaded before the dialog sent this sends
// nothing, and behaves as it always did.
function driverChangedSince(expectedDriverId: unknown, ride: any) {
    return typeof expectedDriverId === 'string' && expectedDriverId !== String(ride.driver_id || '');
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

        const body = await req.json().catch(() => null);
        const { ride_booking_id, driver_id, pickup_instructions, driver_payout_ngn, expected_driver_id } = body || {};
        if (!isId(ride_booking_id) || !isId(driver_id)) {
            return json({ success: false, error: 'ride_booking_id and driver_id are required' }, 400);
        }

        const sr = base44.asServiceRole.entities;
        const ride = await sr.RideBooking.get(ride_booking_id);
        if (!ride || ride.id !== ride_booking_id) return json({ success: false, error: 'Ride booking not found' }, 404);
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
        // Drawn from a ride that has moved on: see the header. Refused before
        // anything is read or written for the driver that was submitted.
        if (driverChangedSince(expected_driver_id, ride)) {
            return json({
                success: false,
                error: 'The driver on this ride changed after this window was opened, so nothing was saved. The list now shows who is on it.',
                code: 'SUPERSEDED',
            }, 409);
        }

        const driver = await sr.Driver.get(driver_id);
        if (!driver || driver.id !== driver_id) return json({ success: false, error: 'Driver not found' }, 404);

        const win = windowOf(ride);
        if (!win) return json({ success: false, error: 'This ride has an unreadable time window' }, 409);

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        // The same driver again is not a new assignment: see the header.
        const sameDriver = ride.driver_id === driver_id;
        const reassigning = !!ride.driver_id && !sameDriver;
        // Over: the sweep or admin completed it, or its booked window has passed.
        const rideOver = ride.status === 'completed' || nowMs > win.endMs;

        // ── Should this driver be sent? ─────────────────────────────────
        // None of it is asked about the driver who is already on the ride.
        if (!sameDriver) {
            if (driver.active === false || driver.admin_approved === false) {
                return json({
                    success: false,
                    error: 'That driver is inactive or not approved.',
                    code: 'DRIVER_UNAVAILABLE',
                }, 409);
            }

            // A guest admin has blocked from rides is not sent a driver. Not
            // asked about a ride that is already over: recording who drove it
            // sends nobody anywhere.
            if (!rideOver && typeof ride.guest_email === 'string' && ride.guest_email.trim()) {
                const accounts = await sr.User.filter({ email: ride.guest_email });
                if (guestIsBlocked(accounts, ride.guest_email)) {
                    return json({
                        success: false,
                        error: 'This guest is blocked from ride bookings. Cancel this ride, or lift the block under Rides → Reports, before sending a driver.',
                        code: 'GUEST_BLOCKED',
                    }, 409);
                }
            }

            // City mismatch is almost always a mis-click rather than an intent to
            // send a driver between Abuja and Lagos, so it is worth blocking.
            const vehicle = isId(ride.vehicle_id) ? await sr.Vehicle.get(ride.vehicle_id) : null;
            if (vehicle?.city && driver.city && vehicle.city !== driver.city) {
                return json({
                    success: false,
                    error: `${driver.full_name} is based in ${driver.city} but this vehicle is in ${vehicle.city}.`,
                    code: 'CITY_MISMATCH',
                }, 409);
            }

            // Driver double-booking check, same overlap rule as vehicles. A
            // completed ride still counts: it kept its driver until it was
            // completed, and the turnaround after it still applies.
            const theirRides = await fetchAll(sr.RideBooking, {
                driver_id, status: { $in: ['pending', 'confirmed', 'completed'] },
            });
            for (const other of theirRides) {
                if (other.id === ride.id) continue;
                const ow = busyWindow(other, windowOf(other));
                if (!ow) continue;
                if (windowsOverlap(win.startMs, win.endMs, ow.startMs, ow.endMs, turnaroundMsFor(vehicle))) {
                    return json({
                        success: false,
                        error: `${driver.full_name} is already driving another booking in that window.`,
                        code: 'DRIVER_DOUBLE_BOOKED',
                        conflict: {
                            ride_booking_id: other.id,
                            start_at: safeIso(ow.startMs),
                            end_at: safeIso(ow.endMs),
                        },
                    }, 409);
                }
            }
        }

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

        // The ride's end comes from what the guest booked. One that is not a
        // real date cannot be released against, so stop here with a message
        // rather than let toISOString throw further down.
        const endAtIso = safeIso(win.endMs);
        if (linkedEmail && (!endAtIso || !releaseAtFor(endAtIso))) {
            return json({ success: false, error: 'This ride has an unreadable time window', code: 'BAD_WINDOW' }, 409);
        }

        // ── Write ───────────────────────────────────────────────────────
        const instructions = typeof pickup_instructions === 'string' ? pickup_instructions.trim() : '';
        const patch = {
            // The same driver again changes nothing about who is driving.
            ...(sameDriver ? {} : { driver_id, driver_assigned_at: nowIso }),
            // Which driver a pay figure was given for. ₦0 holds nothing and
            // so leaves no pay row; this is what tells the admin list the
            // question was answered and not forgotten. Written whatever the
            // figure, so it says nothing about the amount: a guest can read
            // their own ride row.
            ...(linkedEmail ? { pay_answered_for: driver_id } : {}),
            // Only overwrite when something was actually typed — a reassignment
            // that leaves the box blank must not wipe instructions already
            // written for this pickup.
            ...(instructions ? { pickup_instructions: instructions } : {}),
        };
        const written = await writeAssignment(
            sr, ride, driver_id, payout, endAtIso, patch, `Reassigned to ${driver.full_name}`, nowIso,
        );
        if (written.ledger_error) {
            console.error(`assignRideDriver: ledger not settled for ride ${ride_booking_id}:`, written.ledger_error);
        }
        if (written.cancelled) {
            return json({
                success: false,
                error: 'This ride was cancelled while the driver was being assigned. Nobody has been notified.',
                code: 'CANCELLED',
            }, 409);
        }
        if (written.superseded) {
            return json({
                success: false,
                error: `Another assignment for this ride was saved at the same moment, so ${driver.full_name} is not on it. The list shows who is.`,
                code: 'SUPERSEDED',
            }, 409);
        }
        const earning = written.earning;
        // Held by this call, as opposed to a row that was already standing.
        const payIsNew = !!earning && earning.held_at === nowIso;
        const notices = assignmentNotices(sameDriver, rideOver, payIsNew);

        // Guest email with the driver's details — this is the moment the
        // contact becomes visible, so it goes out by email as well as push
        // rather than relying on the guest opening the app.
        if (notices.guest) {
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
        }

        // The driver hears about it too, now that they have somewhere to look.
        const whenShort = new Date(win.startMs).toLocaleString('en-GB', {
            timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
        });
        if (linkedEmail && notices.driver === 'assigned') {
            await tryPush(base44, {
                user_email: linkedEmail,
                title: '🚗 New ride assigned',
                body: earning && earning.status === 'held'
                    ? `${ride.vehicle_name} on ${whenShort} · ₦${(Number(earning.amount_ngn) || 0).toLocaleString()} held until the trip ends`
                    : `${ride.vehicle_name} on ${whenShort}. Tap for the pickup details.`,
                url: `/DriverRides#ride-${ride.id}`,
                tag: `driver-assigned-${ride.id}`,
            });
        } else if (linkedEmail && notices.driver === 'pay') {
            await tryPush(base44, {
                user_email: linkedEmail,
                title: '💰 Pay recorded',
                body: `₦${(Number(earning.amount_ngn) || 0).toLocaleString()} for the ${ride.vehicle_name} on ${whenShort} is in your wallet, held until it is released.`,
                url: '/DriverWallet',
                tag: `driver-pay-${ride.id}`,
            });
        }
        if (reassigning) {
            try {
                const previous = isId(ride.driver_id) ? await sr.Driver.get(ride.driver_id) : null;
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
                // true when this driver was already on the ride: nothing about
                // the assignment changed, and the guest was not told again.
                already_assigned: sameDriver,
                // false means this driver has no login, so nothing was recorded.
                pay_tracked: !!linkedEmail,
                // true when this call is the one that held the pay.
                pay_recorded: payIsNew,
                driver_payout_ngn: earning ? Number(earning.amount_ngn) || 0 : (payout ? payout.amount : null),
                payout_basis: earning ? earning.basis || null : (payout ? payout.basis : null),
                earning_id: earning ? earning.id : null,
                guest_notified: notices.guest,
                // The previous driver's pay was already released and has NOT
                // been taken back. Admin decides in Rides → Earnings.
                previous_earning_released: written.released_ngn > 0,
                // The driver is on the ride, but the pay records could not be
                // brought fully up to date. Admin is told to look.
                ledger_warning: !!written.ledger_error,
            },
        });
    } catch (error) {
        console.error('assignRideDriver error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
