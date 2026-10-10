import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getDriverWallet
// ----------------------------------------------------------------------------
// The signed-in driver's money: what is held, what is available to withdraw,
// what has been paid out, and the ledger behind those three numbers.
//
// NOTHING HERE IS STORED. There is no balance column to drift or to tamper
// with. The balance is walletTotals() over the driver's DriverEarning rows and
// their own driver-wallet withdrawals, computed on every call. That is what
// makes release idempotent (flipping a row to released twice adds nothing)
// and makes a failed transfer refund itself (a failed row stops counting).
//
// This file is the HOME of the wallet arithmetic. createWithdrawalRequest,
// processWithdrawal and getDashboardStats carry lockstep copies of
// driverEmails, driverWithdrawals and walletTotals, and
// scripts/check-driver-wallet.mjs fails if any copy differs by a character.

const WITHDRAWAL_THRESHOLD_NGN = 10000;
const LEDGER_LIMIT = 200;

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

// ── Wallet arithmetic ───────────────────────────────────────────────────────
// Bodies are plain JavaScript: the check script lifts and runs them.

// Every login this driver is, or was, linked to. Lower-cased, once each.
function driverEmails(driver: any) {
    const all = [driver && driver.user_email].concat((driver && driver.previous_user_emails) || []);
    const out = [];
    for (const raw of all) {
        const email = String(raw || '').trim().toLowerCase();
        if (email && !out.includes(email)) out.push(email);
    }
    return out;
}

// The withdrawal rows that count against this driver's balance: driver-wallet
// rows carrying this driver's id AND made by a login that is, or was, linked
// to this driver. The second condition is not decoration. Until the staged
// rule that stops browsers creating WithdrawalRequest rows is live, any
// signed-in user can create one for their own email with any driver_id on it;
// the email is the one field the access rule pins to the creator.
function driverWithdrawals(driver: any, rows: any[]) {
    if (!driver) return [];
    const emails = driverEmails(driver);
    return (rows || []).filter((w) => !!w
        && w.wallet === 'driver'
        && w.driver_id === driver.id
        && emails.includes(String(w.user_email || '').trim().toLowerCase()));
}

// The driver's position in whole naira. Pass withdrawals through
// driverWithdrawals first. A failed or reversed transfer counts nowhere, so it
// needs no refund. If pay is reversed after it was withdrawn, available stops
// at zero and the difference is carried as shortfall until later pay covers it.
function walletTotals(earnings: any[], withdrawals: any[]) {
    const naira = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    let held = 0;
    let released = 0;
    for (const e of earnings || []) {
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
        else if (e.status === 'released') released += naira(e.amount_ngn);
    }
    let paidOut = 0;
    let reserved = 0;
    for (const w of withdrawals || []) {
        if (!w) continue;
        if (w.status === 'completed') paidOut += naira(w.amount);
        else if (w.status === 'pending' || w.status === 'processing') reserved += naira(w.amount);
    }
    const net = released - paidOut - reserved;
    return {
        held,
        released,
        paid_out: paidOut,
        reserved,
        available: Math.max(0, net),
        shortfall: Math.max(0, -net),
    };
}

// One ledger row as the driver sees it. An allow-list: hold reasons, admin
// notes and the rate behind the figure stay on the server.
function ledgerView(earning: any, underReview: boolean) {
    return {
        id: earning.id,
        ride_booking_id: earning.ride_booking_id,
        booking_reference: earning.booking_reference || null,
        vehicle_name: earning.vehicle_name || 'Ride',
        service_date: earning.service_date || null,
        amount_ngn: Math.max(0, Math.round(Number(earning.amount_ngn) || 0)),
        status: earning.status,
        on_hold: !!earning.on_hold,
        // The guest has an open complaint about this ride, so the held pay waits.
        under_review: earning.status === 'held' && !!underReview,
        release_at: earning.release_at || null,
        held_at: earning.held_at || earning.created_date || null,
        released_at: earning.released_at || null,
        reversed_at: earning.reversed_at || null,
    };
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

        const sr = base44.asServiceRole.entities;
        const driver = await findDriverForUser(sr, user.email);
        if (!driver) {
            return json({
                success: false,
                error: 'This account is not linked to a driver profile.',
                code: 'NOT_A_DRIVER',
            }, 403);
        }

        const [earnings, withdrawalRows, openReports] = await Promise.all([
            fetchAll(sr.DriverEarning, { driver_id: driver.id }),
            fetchAll(sr.WithdrawalRequest, { driver_id: driver.id }),
            fetchAll(sr.RideReport, { reporter_role: 'guest', status: { $in: ['open', 'reviewing'] } }),
        ]);
        const ridesUnderReview = new Set(openReports.map((r: any) => r.ride_booking_id));
        const mine = driverWithdrawals(driver, withdrawalRows);
        const totals = walletTotals(earnings, mine);

        const newestFirst = (a: any, b: any) =>
            String(b.held_at || b.created_date || '').localeCompare(String(a.held_at || a.created_date || ''));
        const inFlight = mine
            .filter((w) => w.status === 'pending' || w.status === 'processing')
            .sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')))[0] || null;

        return json({
            success: true,
            data: {
                available_ngn: totals.available,
                held_ngn: totals.held,
                paid_out_ngn: totals.paid_out,
                reserved_ngn: totals.reserved,
                shortfall_ngn: totals.shortfall,
                threshold_ngn: WITHDRAWAL_THRESHOLD_NGN,
                pending_withdrawal: inFlight ? {
                    id: inFlight.id,
                    amount: Math.max(0, Math.round(Number(inFlight.amount) || 0)),
                    status: inFlight.status,
                    requested_at: inFlight.requested_at || inFlight.created_date || null,
                } : null,
                ledger: earnings.slice().sort(newestFirst).slice(0, LEDGER_LIMIT)
                    .map((e) => ledgerView(e, ridesUnderReview.has(e.ride_booking_id))),
                ledger_truncated: earnings.length > LEDGER_LIMIT,
            },
        });
    } catch (error) {
        console.error('getDriverWallet error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
