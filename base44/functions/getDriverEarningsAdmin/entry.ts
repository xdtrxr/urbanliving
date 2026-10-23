import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getDriverEarningsAdmin
// ----------------------------------------------------------------------------
// Everything the admin Earnings tab shows: the pay ledger across all drivers,
// and one summary line per driver (held, available, paid out, shortfall).
//
// The summaries are computed here rather than in the browser so that there is
// no client copy of the wallet arithmetic to drift, and so the totals count
// every row even when the list on screen is capped.

const LIST_LIMIT = 500;

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

// ── Wallet arithmetic — lockstep copies, see getDriverWallet ────────────────

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
        // A row that has ever been reversed counts nowhere, whatever its
        // status says. Nothing here can lock a row, so a release can land on
        // top of a reversal made a moment earlier; reversed_at is never
        // cleared, which makes it the one mark that cannot be lost that way.
        if (!e || e.reversed_at) continue;
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

// One line per driver who has any pay or payout on record: the same numbers
// that driver sees in their own wallet. A shortfall (pay reversed after it was
// withdrawn) sorts first, because that is money to recover. Lockstep copy in
// getDashboardStats.
function driverWalletSummaries(drivers: any[], earnings: any[], withdrawals: any[]) {
    const out = [];
    for (const driver of drivers || []) {
        if (!driver) continue;
        const theirEarnings = (earnings || []).filter((e) => !!e && e.driver_id === driver.id);
        const theirWithdrawals = driverWithdrawals(driver, withdrawals);
        if (theirEarnings.length === 0 && theirWithdrawals.length === 0) continue;
        const totals = walletTotals(theirEarnings, theirWithdrawals);
        out.push({
            driver_id: driver.id,
            full_name: driver.full_name || 'Driver',
            has_login: !!String(driver.user_email || '').trim(),
            held: totals.held,
            available: totals.available,
            paid_out: totals.paid_out,
            reserved: totals.reserved,
            shortfall: totals.shortfall,
        });
    }
    out.sort((a, b) => (b.shortfall - a.shortfall)
        || ((b.held + b.available) - (a.held + a.available))
        || String(a.full_name).localeCompare(String(b.full_name)));
    return out;
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
        const user = await base44.auth.me().catch(() => null);
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);
        if (user.role !== 'admin') return json({ success: false, error: 'Admin access required' }, 403);

        const sr = base44.asServiceRole.entities;
        const [earnings, drivers, withdrawals] = await Promise.all([
            fetchAll(sr.DriverEarning, {}),
            fetchAll(sr.Driver, {}),
            fetchAll(sr.WithdrawalRequest, { wallet: 'driver' }),
        ]);

        const names = new Map<string, string>();
        for (const d of drivers) names.set(d.id, d.full_name || 'Driver');

        const summaries = driverWalletSummaries(drivers, earnings, withdrawals);
        const totals = { held: 0, available: 0, shortfall: 0 };
        for (const s of summaries) {
            totals.held += s.held;
            totals.available += s.available;
            totals.shortfall += s.shortfall;
        }

        const newestFirst = earnings.slice().sort(
            (a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')),
        );

        return json({
            success: true,
            data: {
                earnings: newestFirst.slice(0, LIST_LIMIT).map((e) => ({
                    ...e,
                    driver_name: names.get(e.driver_id) || 'Deleted driver',
                })),
                earnings_truncated: earnings.length > LIST_LIMIT,
                drivers: summaries,
                totals,
            },
        });
    } catch (error) {
        console.error('getDriverEarningsAdmin error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
