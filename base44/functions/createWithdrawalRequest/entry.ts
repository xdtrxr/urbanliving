import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// createWithdrawalRequest
// ----------------------------------------------------------------------------
// A user asks for money to be sent to their bank. Admin then processes the
// request (processWithdrawal), and Paystack confirms the outcome later
// (paystackTransferWebhook).
//
// Two wallets, two ways of reserving the money:
//
//   referral  User.referral_balance_ngn is a stored number. The amount is
//             DEBITED here and credited back if the transfer fails.
//   driver    There is no stored balance. What a driver can withdraw is
//             walletTotals() over their released earnings and their earlier
//             driver-wallet withdrawals. Nothing is debited: the pending row
//             written here IS the reservation, and a failed row simply stops
//             counting. processWithdrawal re-checks the ledger before paying.
//
// The row is created under the service role. It used to be created as the
// user, which is why the WithdrawalRequest create rule lets a browser write
// one directly; the stricter rule staged in docs/entity-rules-pending-publish
// can be applied once this version is published.
//
// One withdrawal in flight per person, across both wallets.

const WITHDRAWAL_THRESHOLD_NGN = 10000;

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

// The amount asked for: a positive whole number of naira, or null. Kobo are
// refused rather than rounded, so the figure the user typed is the figure
// that is reserved and the figure that is sent.
function parseWithdrawalAmount(raw: unknown) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return null;
    return raw;
}

const refuse = (status: number, error: string, code?: string) =>
    Response.json({ success: false, error, ...(code ? { code } : {}) }, { status });

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);

        const user = await base44.auth.me();
        if (!user) return refuse(401, 'Unauthorized');

        const body = await req.json().catch(() => ({}));
        const bank_account_id = body?.bank_account_id;

        if (body?.wallet !== undefined && body.wallet !== 'referral' && body.wallet !== 'driver') {
            return refuse(400, 'Unknown wallet.', 'INVALID_WALLET');
        }
        const wallet = body?.wallet === 'driver' ? 'driver' : 'referral';
        const label = wallet === 'driver' ? 'driver earnings' : 'referral earnings';

        if (body?.amount === undefined || body?.amount === null || !bank_account_id) {
            return refuse(400, 'Missing required fields: amount and bank_account_id');
        }
        const amount = parseWithdrawalAmount(body.amount);
        if (amount === null) {
            return refuse(400, 'Enter the amount in whole naira.', 'INVALID_AMOUNT');
        }
        if (amount < WITHDRAWAL_THRESHOLD_NGN) {
            return refuse(400, `Minimum withdrawal amount is ₦${WITHDRAWAL_THRESHOLD_NGN.toLocaleString()}`);
        }

        const sr = base44.asServiceRole.entities;

        // ── Which money, and how much of it is there ────────────────────
        let driver: any = null;
        let available = 0;
        if (wallet === 'driver') {
            // Resolved from the session email. Nothing the browser sends
            // chooses whose wallet this is.
            driver = await findDriverForUser(sr, user.email);
            if (!driver) {
                return refuse(403, 'This account is not linked to a driver profile.', 'NOT_A_DRIVER');
            }
            const [earnings, rows] = await Promise.all([
                fetchAll(sr.DriverEarning, { driver_id: driver.id }),
                fetchAll(sr.WithdrawalRequest, { driver_id: driver.id }),
            ]);
            available = walletTotals(earnings, driverWithdrawals(driver, rows)).available;
        } else {
            available = Number(user.referral_balance_ngn) || 0;
        }

        if (available < WITHDRAWAL_THRESHOLD_NGN) {
            return refuse(400, `You need at least ₦${WITHDRAWAL_THRESHOLD_NGN.toLocaleString()} in ${label} to withdraw. Current balance: ₦${available.toLocaleString()}.`);
        }
        if (amount > available) {
            return refuse(400, `Insufficient balance. You have ₦${available.toLocaleString()} available.`);
        }

        // ── The destination must be the caller's own verified account ───
        let bankAccount: any = null;
        try {
            bankAccount = await base44.entities.UserBankAccount.get(bank_account_id);
        } catch (_err) {
            bankAccount = null;
        }
        if (!bankAccount || bankAccount.user_email !== user.email) {
            return refuse(400, 'Invalid bank account');
        }
        if (!bankAccount.is_verified) {
            return refuse(400, 'Bank account is not verified. Please verify your account first.');
        }

        // ── One in flight per person, whichever wallet ──────────────────
        const inFlight = { user_email: user.email, status: { $in: ['pending', 'processing'] } };
        const pendingWithdrawals = await sr.WithdrawalRequest.filter(inFlight);
        if (pendingWithdrawals.length > 0) {
            return refuse(400, 'You have a pending withdrawal request. Please wait for it to complete.');
        }

        const withdrawalRequest = await sr.WithdrawalRequest.create({
            user_email: user.email,
            bank_account_id,
            amount,
            status: 'pending',
            requested_at: new Date().toISOString(),
            wallet,
            ...(driver ? { driver_id: driver.id } : {}),
        });

        // ── Race defence ────────────────────────────────────────────────
        // Two requests sent at the same instant both pass every check above.
        // Now that this row exists, look again: there must be exactly one in
        // flight, and the money must still cover it. If not, this request
        // loses and is marked failed.
        const livePending = await sr.WithdrawalRequest.filter(inFlight);
        let stillCovered = false;
        let referralUser: any = null;
        if (wallet === 'driver') {
            const [earnings, rows] = await Promise.all([
                fetchAll(sr.DriverEarning, { driver_id: driver.id }),
                fetchAll(sr.WithdrawalRequest, { driver_id: driver.id }),
            ]);
            // This request is now one of the rows, so "covered" means the
            // ledger shows no shortfall with it counted.
            stillCovered = walletTotals(earnings, driverWithdrawals(driver, rows)).shortfall === 0;
        } else {
            const fresh = await sr.User.filter({ email: user.email });
            referralUser = fresh[0] || null;
            stillCovered = !!referralUser && (Number(referralUser.referral_balance_ngn) || 0) >= amount;
        }

        if (livePending.length > 1 || !stillCovered) {
            await sr.WithdrawalRequest.update(withdrawalRequest.id, {
                status: 'failed',
                error_message: 'Concurrent withdrawal detected — request rejected.',
                processed_at: new Date().toISOString(),
            });
            return refuse(409, 'A concurrent withdrawal request was detected. Please try again in a moment.');
        }

        // Referral money is reserved by taking it off the stored balance.
        // Driver money needs no write: the pending row above is the reservation.
        if (wallet === 'referral') {
            await sr.User.update(referralUser.id, {
                referral_balance_ngn: (Number(referralUser.referral_balance_ngn) || 0) - amount,
            });
        }

        return Response.json({
            success: true,
            withdrawal_request: withdrawalRequest,
            message: 'Withdrawal request created successfully. It will be processed within 24-48 hours.',
        });
    } catch (error) {
        console.error('Error creating withdrawal request:', error);
        return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
});
