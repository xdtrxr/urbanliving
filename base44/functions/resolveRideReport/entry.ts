import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// resolveRideReport
// ----------------------------------------------------------------------------
// Admin's decision on a ride report: still looking at it, resolved (with no
// action, a warning, or a block), or dismissed.
//
// A block is the only decision with an effect outside the report:
//   - about a GUEST   sets User.ride_blocked, which checkRideAvailability
//                     refuses. Moving the report away from blocked clears the
//                     flag again, unless another resolved report against the
//                     same guest still says blocked.
//   - about a DRIVER  sets Driver.active = false so they stop appearing when
//                     a ride is assigned. It is never switched back on from
//                     here: admin may have deactivated them for other reasons,
//                     and the switch is on the Drivers tab.
//
// Closing a report (resolved or dismissed) is also what lets the driver's pay
// for that ride release: the sweep skips an earning whose ride has an open or
// reviewing report.

const RESOLVE_STATUSES = ['reviewing', 'resolved', 'dismissed'];
const ACTIONS = ['none', 'warning', 'blocked'];
const MAX_NOTES = 1000;

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

// What the report becomes. `was` and `now` are the action before and after,
// so the caller can tell whether a block has to be applied or lifted. Plain
// JavaScript body: scripts/check-ride-reports.mjs lifts and runs it.
function nextReportState(report: any, input: any, adminEmail: string, nowIso: string) {
    const status = input && input.status;
    if (typeof status !== 'string' || !RESOLVE_STATUSES.includes(status)) return { ok: false, code: 'INVALID_STATUS' };
    const asked = input && input.action_taken;
    const named = asked !== undefined && asked !== null;
    if (named && (typeof asked !== 'string' || !ACTIONS.includes(asked))) return { ok: false, code: 'INVALID_ACTION' };
    const was = (report && report.action_taken) || 'none';
    // Dismissing means "nothing to act on", whatever was sent or decided before.
    const now = status === 'dismissed' ? 'none' : (named ? asked : was);
    const notes = typeof (input && input.admin_notes) === 'string'
        ? { admin_notes: input.admin_notes.trim().slice(0, MAX_NOTES) }
        : {};
    const closing = status === 'resolved' || status === 'dismissed'
        ? { resolved_at: nowIso, resolved_by: adminEmail || '' }
        : {};
    return { ok: true, patch: { status, action_taken: now, ...notes, ...closing }, was, now };
}

// Whether the reported guest is blocked once this report holds `thisAction`.
// `reports` is every report against that guest. A block stands for as long as
// any RESOLVED report says so; this report's own row in the list is ignored
// because it may be stale.
function guestBlockAfter(reports: any[], thisReportId: string, thisAction: string) {
    if (thisAction === 'blocked') return true;
    return (reports || []).some((r) => !!r
        && r.id !== thisReportId
        && r.status === 'resolved'
        && r.action_taken === 'blocked');
}

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
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

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);
        if (user.role !== 'admin') return json({ success: false, error: 'Admin access required' }, 403);

        const body = await req.json().catch(() => null);
        const { report_id, status, action_taken, admin_notes } = body || {};
        if (!isId(report_id)) {
            return json({ success: false, error: 'report_id is required' }, 400);
        }

        const sr = base44.asServiceRole.entities;
        const report = await getOrNull(sr.RideReport, report_id);
        if (!report || report.id !== report_id) {
            return json({ success: false, error: 'That report no longer exists.', code: 'NOT_FOUND' }, 404);
        }

        const next = nextReportState(report, { status, action_taken, admin_notes }, user.email, new Date().toISOString());
        if (!next.ok) {
            return json({
                success: false,
                error: next.code === 'INVALID_STATUS' ? 'Choose reviewing, resolved or dismissed.' : 'Choose none, warning or blocked.',
                code: next.code,
            }, 400);
        }

        await sr.RideReport.update(report.id, next.patch);

        // ── The one effect outside the report ───────────────────────────
        let effect = 'none';
        if (report.reported_email && (next.now === 'blocked' || next.was === 'blocked')) {
            // Only touch the flag when this report is, or was, a reason for it.
            const about = await fetchAll(sr.RideReport, { reported_email: report.reported_email });
            const shouldBlock = guestBlockAfter(about, report.id, next.now as string);
            const accounts = await sr.User.filter({ email: report.reported_email });
            const guest = accounts?.[0] || null;
            if (!guest) {
                effect = 'guest_not_found';
            } else if ((guest.ride_blocked === true) !== shouldBlock) {
                await sr.User.update(guest.id, { ride_blocked: shouldBlock });
                effect = shouldBlock ? 'guest_blocked' : 'guest_unblocked';
            }
        } else if (report.reported_driver_id && next.now === 'blocked' && next.was !== 'blocked') {
            const driver = isId(report.reported_driver_id) ? await sr.Driver.get(report.reported_driver_id) : null;
            if (driver && driver.active !== false) {
                await sr.Driver.update(driver.id, { active: false });
                effect = 'driver_deactivated';
            }
        }

        // Tell the reporter it was looked at. Never what was decided about
        // the other person: that is between admin and them.
        const closedNow = (next.patch.status === 'resolved' || next.patch.status === 'dismissed')
            && report.status !== next.patch.status;
        if (closedNow && report.reporter_email) {
            await tryPush(base44, {
                user_email: report.reporter_email,
                title: 'Your report was reviewed',
                body: `The team has looked at your report on ride ${report.booking_reference || ''}. Thank you for telling us.`.replace('  ', ' '),
                url: report.reporter_role === 'driver' ? '/DriverRides' : '/Bookings',
                tag: `ride-report-${report.id}`,
            });
        }

        const updated = await sr.RideReport.get(report.id);
        return json({ success: true, data: { report: updated, effect } });
    } catch (error) {
        console.error('resolveRideReport error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
