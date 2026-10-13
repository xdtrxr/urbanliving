import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// createRideReport
// ----------------------------------------------------------------------------
// One party to a ride tells admin about a problem with the other: a driver
// about a rude, abusive or absent guest, or a guest about a driver.
//
// What makes a report trustworthy enough to act on is decided here, not in
// the browser:
//   - WHO   the reporter is taken from the session and must be the guest who
//           booked the ride or the driver assigned to it
//   - WHEN  from the ride's start until seven days after its end
//   - ONCE  one report per reporter per ride; for a guest, one per driver
//           they had on it
//   - WHAT  a category from a fixed list, 10 to 2000 characters of text, and
//           at most three photos, each a link to a file uploaded through
//           this platform
//
// While a guest's report about a driver is open, that driver's pay for the
// ride stays held (the sweep and settleDriverEarning both check). A report a
// driver files about a guest holds nobody's pay. Nothing is done to either
// party until admin decides, in resolveRideReport.

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// ── Ride time model — lockstep copy, see checkRideAvailability ──────────────
const WAT_OFFSET = '+01:00';
const HOUR_MS = 60 * 60 * 1000;
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
// before start_at existed.
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

// ── What a report is ────────────────────────────────────────────────────────
const REPORT_WINDOW_AFTER_END_MS = 7 * DAY_MS;
const CATEGORIES = ['rude', 'abusive', 'threatening', 'unsafe', 'no_show', 'damage', 'other'];
const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 2000;
const MAX_EVIDENCE = 3;
const MAX_URL_LENGTH = 600;
// Where an uploaded file lives: this platform's file store, under an app id.
// MIRRORED client-side by UPLOAD_URL in src/config/rides.js.
const UPLOAD_URL = /^https:\/\/base44\.app\/api\/apps\/[a-f0-9]{24}\/files\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:jpe?g|png|webp|gif|heic|heif)$/i;
const CARD_EXCERPT = 300;

// A ride can be reported from the moment it starts until seven days after it
// ends. Before the start there is nothing to report; long afterwards nobody
// can check what happened. Lockstep copies in getDriverRides and
// getRideBookings decide whether the Report button is shown.
function reportWindowOpen(ride: any, nowMs: number) {
    const w = windowOf(ride);
    if (!w || !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) return false;
    return w.startMs <= nowMs && nowMs <= w.endMs + REPORT_WINDOW_AFTER_END_MS;
}

// Which side of the ride this login was on, or null for neither. The guest is
// matched on the booking's email; the driver on the Driver row their login is
// linked to. Someone who is both reports as the guest.
function reporterRoleFor(ride: any, userEmail: string, driver: any) {
    const me = String(userEmail || '').trim().toLowerCase();
    if (!ride || !me) return null;
    if (String(ride.guest_email || '').trim().toLowerCase() === me) return 'guest';
    if (driver && driver.id && ride.driver_id && ride.driver_id === driver.id) return 'driver';
    return null;
}

// Whether a link is a file uploaded through this platform. A report photo is
// later drawn as <img src> on admin's screen. Any other https link would let
// whoever filed the report choose the server that learns when, and from
// where, admin opened it, and choose what admin is shown. So nothing else is
// ever stored: not another host, not a query string, not a path that climbs.
function isUploadUrl(url: unknown) {
    return typeof url === 'string' && url.length <= MAX_URL_LENGTH && UPLOAD_URL.test(url) && !url.includes('..');
}

// The reporter's input, checked. A photo must be a link isUploadUrl accepts.
function validateReportInput(body: any) {
    const category = body && body.category;
    if (typeof category !== 'string' || !CATEGORIES.includes(category)) {
        return { ok: false, code: 'INVALID_CATEGORY', error: 'Choose what kind of problem this was.' };
    }
    const description = typeof (body && body.description) === 'string' ? body.description.trim() : '';
    if (description.length < MIN_DESCRIPTION || description.length > MAX_DESCRIPTION) {
        return {
            ok: false,
            code: 'DESCRIPTION_LENGTH',
            error: `Describe what happened in ${MIN_DESCRIPTION} to ${MAX_DESCRIPTION} characters.`,
        };
    }
    const raw = body && body.evidence_urls;
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
        return { ok: false, code: 'BAD_URL', error: 'The photos could not be read. Remove them and try again.' };
    }
    const urls = [];
    for (const item of raw || []) {
        if (!isUploadUrl(item)) {
            return { ok: false, code: 'BAD_URL', error: 'One of the photos is not a valid upload. Remove it and try again.' };
        }
        if (!urls.includes(item)) urls.push(item);
    }
    if (urls.length > MAX_EVIDENCE) {
        return { ok: false, code: 'TOO_MANY_FILES', error: `Attach at most ${MAX_EVIDENCE} photos.` };
    }
    return { ok: true, value: { category, description, evidence_urls: urls } };
}

// The card admin gets on Telegram. Plain text on purpose: the description is
// whatever the reporter typed, and an unbalanced * or _ makes Telegram reject
// a Markdown message outright, which would lose the alert.
function reportCardText(report: any) {
    const text = String(report.description || '');
    const excerpt = text.length > CARD_EXCERPT ? `${text.slice(0, CARD_EXCERPT)}…` : text;
    const lines = [
        '🚩 RIDE REPORT',
        '',
        report.reporter_role === 'driver' ? 'A driver reported a guest' : 'A guest reported a driver',
        `Ride: ${report.booking_reference || report.ride_booking_id}${report.vehicle_name ? ` · ${report.vehicle_name}` : ''}`,
        `From: ${report.reporter_name || report.reporter_email}`,
        `About: ${report.reported_name || report.reported_email || 'the driver'}`,
        `Category: ${report.category}`,
        '',
        excerpt,
    ];
    const photos = (report.evidence_urls || []).length;
    if (photos > 0) lines.push('', `Photos attached: ${photos}`);
    lines.push('', 'Review it in Admin → Rides → Reports.');
    return lines.join('\n');
}

// File one report, once per reporter per ride. Takes the ride ROW, not the id
// that arrived in the request, so the "already reported" lookup and the
// stored row both use the ride's own id. reporter is { email, role, name,
// reported_name }; input is validateReportInput's value.
//
// A guest's report is about the driver on the ride when it is filed, so for a
// guest "once" is once per driver. When admin hands the ride to someone else,
// often because of that very complaint, the guest can report the driver who
// took over, and only that report can hold the second driver's pay. It
// cannot be used to stack reports: only admin changes who is on a ride.
//
// Two taps on Submit can both pass the "already" check. The oldest report
// stands; a later twin is removed and answered as a duplicate.
async function fileRideReport(sr: any, ride: any, reporter: any, input: any) {
    const mine = reporter.role === 'guest'
        ? { ride_booking_id: ride.id, reporter_email: reporter.email, reported_driver_id: ride.driver_id || '' }
        : { ride_booking_id: ride.id, reporter_email: reporter.email };
    const already = await sr.RideReport.filter(mine);
    if (Array.isArray(already) && already.length > 0) return { ok: false, code: 'ALREADY_REPORTED' };
    const row = {
        ride_booking_id: ride.id,
        booking_reference: ride.booking_reference || '',
        vehicle_name: ride.vehicle_name || '',
        service_date: ride.service_date,
        reporter_email: reporter.email,
        reporter_role: reporter.role,
        reporter_name: reporter.name || '',
        // Who the report is about: a guest by email, a driver by id. The
        // driver's id is what decides whose pay an open report holds.
        reported_email: reporter.role === 'driver' ? (ride.guest_email || '') : '',
        reported_driver_id: reporter.role === 'guest' ? (ride.driver_id || '') : '',
        reported_name: reporter.reported_name || '',
        category: input.category,
        description: input.description,
        evidence_urls: input.evidence_urls,
        status: 'open',
        action_taken: 'none',
    };
    const created = await sr.RideReport.create(row);
    const twins = (await sr.RideReport.filter(mine))
        .sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
            || String(a.id).localeCompare(String(b.id)));
    if (twins.length > 1 && twins[0].id !== created.id) {
        await sr.RideReport.delete(created.id);
        return { ok: false, code: 'ALREADY_REPORTED' };
    }
    return { ok: true, id: created.id, row };
}

// The Driver row this login belongs to, or null. Lockstep copy, see
// getDriverProfile.
async function findDriverForUser(sr: any, email: string) {
    const raw = String(email || '').trim();
    const lower = raw.toLowerCase();
    if (!lower) return null;
    let rows = await sr.Driver.filter({ user_email: lower });
    if ((!rows || rows.length === 0) && raw !== lower) rows = await sr.Driver.filter({ user_email: raw });
    if (!rows || rows.length === 0) return null;
    rows.sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')));
    return rows[0];
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

        const body = await req.json().catch(() => null);
        const ride_booking_id = body?.ride_booking_id;
        if (!isId(ride_booking_id)) {
            return json({ success: false, error: 'ride_booking_id is required' }, 400);
        }
        const input = validateReportInput(body);
        if (!input.ok) return json({ success: false, error: input.error, code: input.code }, 400);

        const sr = base44.asServiceRole.entities;
        const ride = await sr.RideBooking.get(ride_booking_id);
        if (!ride || ride.id !== ride_booking_id) {
            return json({ success: false, error: 'Ride booking not found', code: 'NOT_FOUND' }, 404);
        }

        // Who is asking, decided from the session. Nothing in the request
        // body says which side they were on.
        const driver = await findDriverForUser(sr, user.email);
        const role = reporterRoleFor(ride, user.email, driver);
        if (!role) {
            return json({
                success: false,
                error: 'Only the guest or the driver of this ride can report it.',
                code: 'NOT_PARTY',
            }, 403);
        }
        if (ride.payment_status !== 'paid') {
            return json({ success: false, error: 'Only a paid ride can be reported.', code: 'NOT_PAID' }, 409);
        }
        if (!ride.driver_id) {
            return json({ success: false, error: 'This ride has no driver assigned yet.', code: 'NO_DRIVER' }, 409);
        }
        if (!reportWindowOpen(ride, Date.now())) {
            return json({
                success: false,
                error: 'A ride can be reported from when it starts until 7 days after it ends.',
                code: 'OUTSIDE_WINDOW',
            }, 409);
        }

        // Who the report is about, snapshotted so the inbox reads on its own.
        let reportedName = ride.guest_name || '';
        if (role === 'guest') {
            const theirDriver = isId(ride.driver_id) ? await sr.Driver.get(ride.driver_id) : null;
            reportedName = theirDriver?.full_name || 'Driver';
        }

        const filed = await fileRideReport(sr, ride, {
            email: user.email,
            role,
            name: role === 'driver' ? (driver?.full_name || '') : (ride.guest_name || user.full_name || ''),
            reported_name: reportedName,
        }, input.value);
        if (!filed.ok) {
            return json({
                success: false,
                error: 'You have already reported this ride. The team has it.',
                code: 'ALREADY_REPORTED',
            }, 409);
        }

        await notifyAdminLine(reportCardText(filed.row));

        return json({ success: true, data: { report_id: filed.id, reporter_role: role } });
    } catch (error) {
        console.error('createRideReport error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
