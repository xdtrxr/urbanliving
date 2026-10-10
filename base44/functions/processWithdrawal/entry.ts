import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// processWithdrawal
// ----------------------------------------------------------------------------
// Admin sends a withdrawal to Paystack.
//
// SENT ONCE. Nothing on this platform can lock a row, so two calls for the
// same withdrawal (a double press, two tabs, two admins) can both read it as
// pending. Two things stand between that and two bank transfers:
//   1. the Paystack reference is fixed per row, wd-<row id>, and Paystack
//      does not hold two transfers with one reference;
//   2. before sending, and again after any refusal, this function asks
//      Paystack what it already holds for that reference.
// A withdrawal is marked failed, and a referral refunded, only when Paystack
// refused it for a stated reason AND holds no transfer for it. Refunding on a
// guess would pay twice: once by transfer and once by refund.
//
// NEVER STUCK. The reference is written on the row before Paystack is asked
// to send. If the answer never arrives, the row stays processing with no
// transfer code, which is exactly the state canSend() lets admin retry, and
// paystackTransferWebhook can still find the row from the reference alone.
//
// ON THE LEDGER. A referral withdrawal was debited from
// User.referral_balance_ngn when it was requested. A driver-wallet withdrawal
// was not debited from anywhere: the row is the reservation against the
// driver's released earnings. So a driver-wallet request is checked against
// the ledger again here, and the request itself must be one of the rows that
// check counts. Nothing on the row is trusted: a browser can create a
// WithdrawalRequest row directly until the stricter create rule staged in
// docs/entity-rules-pending-publish is live.

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

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copies in every function that takes an id.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
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

// Only a withdrawal that debited a stored balance is refunded to one. A row
// written before wallets existed is a referral withdrawal. Lockstep copy in
// paystackTransferWebhook.
function refundsToBalance(withdrawal: any) {
    return !!withdrawal && withdrawal.wallet !== 'driver';
}

// ── Sending ─────────────────────────────────────────────────────────────────

// The Paystack reference for a withdrawal. Fixed per row, in the form
// Paystack requires (lowercase letters, digits, - and _, 16 to 50 characters),
// so Paystack never holds two transfers for one withdrawal.
// paystackTransferWebhook reads the row id back out of it.
function transferReferenceFor(withdrawalId: string) {
    return `wd-${String(withdrawalId).toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
}

// Whether this row may be sent now: a pending one, or one an earlier attempt
// marked processing without ever getting a transfer code back. Sending the
// second kind again is safe because its reference is the same.
function canSend(withdrawal: any) {
    if (!withdrawal) return false;
    if (withdrawal.status === 'pending') return true;
    return withdrawal.status === 'processing' && !withdrawal.transfer_code;
}

// Whether the bank account on a request is the requester's own.
function bankBelongsTo(bankAccount: any, withdrawal: any) {
    const owner = String((bankAccount && bankAccount.user_email) || '').trim().toLowerCase();
    const asker = String((withdrawal && withdrawal.user_email) || '').trim().toLowerCase();
    return !!owner && owner === asker;
}

// What Paystack's answer to "what do you hold for this reference?" means:
// the transfer; null for a definite "nothing"; undefined for "could not
// tell". When a transfer exists the answer is a 2xx carrying it, so any
// ordinary refusal means there is none. A bad key, a timeout, a rate limit
// or a fault on Paystack's side says nothing either way.
function lookupFromResponse(httpStatus: number, body: any) {
    if (httpStatus >= 200 && httpStatus < 300) {
        return body && body.status && body.data && body.data.transfer_code ? body.data : undefined;
    }
    if (httpStatus < 400 || httpStatus === 401 || httpStatus === 403) return undefined;
    if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return undefined;
    return null;
}

// Paystack's stated reason for refusing a request, or null when it gave no
// usable answer: no response at all (0), a timeout, a rate limit, a fault on
// its side, a body that was not JSON, or a 2xx without what was asked for.
// null never leads to a refund. It means "ask again", not "no".
function refusalMessage(httpStatus: number, body: any, fallback: string) {
    if (httpStatus < 400 || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return null;
    if (!body || typeof body !== 'object') return null;
    return String(body.message || fallback);
}

// What happened to a transfer request. `message` is refusalMessage's answer;
// `lookup` is lookupFromResponse's.
//   sent          Paystack accepted it
//   already_sent  not accepted, but the transfer exists: another call, or an
//                 earlier attempt, got there first
//   failed        refused for a stated reason and nothing exists: the only
//                 case in which a referral is refunded
//   unconfirmed   anything else. The row stays processing and nobody is
//                 refunded, because refunding a transfer that did go out
//                 would pay twice.
function transferOutcome(accepted: boolean, message: string | null, lookup: any) {
    if (accepted) return 'sent';
    if (lookup && lookup.transfer_code) return 'already_sent';
    if (lookup === undefined) return 'unconfirmed';
    if (message === null || message === undefined) return 'unconfirmed';
    if (/reference/i.test(String(message))) return 'unconfirmed';
    return 'failed';
}

// Where a withdrawal row should stand given the status Paystack reports for
// its transfer. '' means not settled yet: the row stays processing and the
// settlement webhook finishes it.
function rowStatusFor(transferStatus: string) {
    if (transferStatus === 'success') return 'completed';
    if (transferStatus === 'failed') return 'failed';
    if (transferStatus === 'reversed') return 'reversed';
    return '';
}

// Why a driver-wallet withdrawal must not be paid, or '' when it may be.
// The request itself has to be one of the rows walletTotals counts, so "the
// ledger covers it" is the same as "there is no shortfall".
async function driverWithdrawalProblem(sr: any, w: any) {
    const amount = Number(w.amount);
    if (typeof w.amount !== 'number' || !Number.isInteger(amount) || amount < WITHDRAWAL_THRESHOLD_NGN) {
        return 'The amount on this request is not a valid withdrawal.';
    }
    if (!isId(w.driver_id)) return 'This request names no driver.';
    const driver = await sr.Driver.get(w.driver_id);
    if (!driver) return 'The driver profile for this request no longer exists.';
    // Whatever the lookup answered with, it must be the row the request names.
    if (driver.id !== w.driver_id) return 'This request names no driver.';
    // Only the login linked to the driver right now may start a withdrawal.
    const requester = String(w.user_email || '').trim().toLowerCase();
    if (!requester || requester !== String(driver.user_email || '').trim().toLowerCase()) {
        return 'This login is not the one linked to the driver profile.';
    }
    const earnings = await fetchAll(sr.DriverEarning, { driver_id: driver.id });
    const rows = await fetchAll(sr.WithdrawalRequest, { driver_id: driver.id });
    const counted = driverWithdrawals(driver, rows);
    // If the request is not among the counted rows, the arithmetic below says
    // nothing about it, and "no shortfall" would be meaningless.
    if (!counted.some((r) => r.id === w.id)) return 'This request is not on the driver\'s ledger.';
    const totals = walletTotals(earnings, counted);
    if (totals.shortfall > 0) {
        return `The driver's released earnings do not cover this request (short by ₦${totals.shortfall.toLocaleString()}).`;
    }
    return '';
}

// Credit a failed referral withdrawal back to the stored balance, once: the
// row's refunded_at stamp is the guard, and it is the same stamp
// paystackTransferWebhook uses. A driver-wallet request debited nothing, so
// marking it failed is its refund. Says whether anything was credited.
async function refundReferralOnce(sr: any, withdrawal: any, nowIso: string) {
    if (!refundsToBalance(withdrawal)) return false;
    const fresh = await sr.WithdrawalRequest.get(withdrawal.id);
    if (!fresh || fresh.refunded_at) return false;
    const users = await sr.User.filter({ email: withdrawal.user_email });
    if (!Array.isArray(users) || users.length === 0) return false;
    await sr.User.update(users[0].id, {
        referral_balance_ngn: (Number(users[0].referral_balance_ngn) || 0) + (Number(withdrawal.amount) || 0),
    });
    await sr.WithdrawalRequest.update(withdrawal.id, { refunded_at: nowIso });
    return true;
}

// Send one withdrawal and say what the response should be: { status, body }.
// Everything that touches Paystack goes through `paystack` (see
// paystackClient), so this exact code runs in scripts/check-driver-wallet.mjs
// against a stand-in, including two calls overlapping on one row.
async function sendWithdrawal(sr: any, paystack: any, withdrawal: any, nowIso: string) {
    const reference = transferReferenceFor(withdrawal.id);
    const refuse = (status, error, code) => ({ status, body: { success: false, error, code } });

    // The transfer exists at Paystack. Record its codes. The row's status is
    // only ever moved forward: to its settled state if the bank has settled
    // and the row is not final yet, or from pending to processing. It is
    // never written over a state the settlement webhook may have set a
    // moment ago, which is why the row is read again here.
    const alreadySent = async (transfer) => {
        const settled = rowStatusFor(transfer.status);
        const fresh = await sr.WithdrawalRequest.get(withdrawal.id);
        const open = !!fresh && (fresh.status === 'pending' || fresh.status === 'processing');
        const patch = {
            transfer_reference: reference,
            transfer_code: transfer.transfer_code,
            transfer_id: String(transfer.id || ''),
        };
        if (settled && open) {
            patch.status = settled;
            patch.processed_at = nowIso;
        } else if (!settled && fresh && fresh.status === 'pending') {
            patch.status = 'processing';
        }
        await sr.WithdrawalRequest.update(withdrawal.id, patch);
        if (open && (settled === 'failed' || settled === 'reversed')) await refundReferralOnce(sr, withdrawal, nowIso);
        const status = patch.status || (fresh && fresh.status) || 'processing';
        const what = {
            completed: 'This withdrawal had already been sent, and the bank has paid it.',
            failed: 'This withdrawal had already been sent, and the bank refused it. It is marked failed.',
            reversed: 'This withdrawal had already been sent, and the bank sent the money back. It is marked reversed.',
        }[status] || 'This withdrawal had already been sent to Paystack. Its status will update when the bank settles.';
        return {
            status: 200,
            body: {
                success: true,
                already_sent: true,
                status,
                message: `${what} Nothing was sent a second time.`,
            },
        };
    };

    // What it means that Paystack did not accept a request. `message` is its
    // stated reason, or null when it gave no usable answer.
    const notAccepted = async (label, message, details) => {
        const lookup = await paystack.find(reference);
        const outcome = transferOutcome(false, message, lookup);
        if (outcome === 'already_sent') return alreadySent(lookup);
        if (outcome === 'unconfirmed') {
            return refuse(502, `Paystack did not confirm the transfer. The withdrawal is left as processing and cannot be sent twice. Press Retry in a minute. If it keeps happening, look up the reference ${reference} in Paystack.`, 'UNCONFIRMED');
        }
        await sr.WithdrawalRequest.update(withdrawal.id, {
            status: 'failed',
            error_message: message || label,
            processed_at: nowIso,
        });
        await refundReferralOnce(sr, withdrawal, nowIso);
        return { status: 400, body: { success: false, error: label, details } };
    };

    // Ask before sending. A transfer for this withdrawal may already exist:
    // an earlier attempt whose answer was lost, or a press a moment ago.
    const before = await paystack.find(reference);
    if (before === undefined) {
        return refuse(502, 'Paystack could not be asked whether this withdrawal has already been sent, so nothing was sent. Try again in a minute.', 'UNCONFIRMED');
    }
    if (before) return alreadySent(before);

    // Nothing has been sent, so a request that should not be paid can still
    // be turned away. A driver-wallet request is only as good as the ledger
    // behind it; one that fails is closed, so it cannot be retried into a
    // payout later. Nothing was debited for it, so nothing is refunded.
    if (withdrawal.wallet === 'driver') {
        const problem = await driverWithdrawalProblem(sr, withdrawal);
        if (problem) {
            await sr.WithdrawalRequest.update(withdrawal.id, {
                status: 'failed',
                error_message: problem,
                processed_at: nowIso,
            });
            return refuse(409, problem, 'NOT_COVERED');
        }
    }

    let bankAccount = null;
    if (isId(withdrawal.bank_account_id)) {
        try {
            bankAccount = await sr.UserBankAccount.get(withdrawal.bank_account_id);
        } catch (_err) {
            bankAccount = null;
        }
    }
    if (!bankAccount) return refuse(404, 'Bank account not found', 'NO_BANK');
    // createWithdrawalRequest only accepts the requester's own account, so a
    // row naming someone else's was not made by it. Left exactly as it is,
    // for a person to look at: failing it would refund a referral balance
    // that may never have been debited.
    if (!bankBelongsTo(bankAccount, withdrawal)) {
        return refuse(409, 'The bank account on this request does not belong to the person who asked. Nothing was sent.', 'BANK_MISMATCH');
    }

    // The reference goes on the row before Paystack is asked to send.
    await sr.WithdrawalRequest.update(withdrawal.id, { status: 'processing', transfer_reference: reference });

    // Create the transfer recipient the first time this account is paid.
    let recipientCode = bankAccount.recipient_code;
    if (!recipientCode) {
        const made = await paystack.createRecipient(bankAccount);
        if (!made.ok) return notAccepted('Failed to create transfer recipient', made.message, made.details);
        recipientCode = made.code;
        await sr.UserBankAccount.update(bankAccount.id, { recipient_code: recipientCode });
    }

    const sent = await paystack.send({
        source: 'balance',
        reason: `UrbanStays withdrawal - ${String(withdrawal.id).substring(0, 8)}`,
        amount: Math.round(Number(withdrawal.amount) * 100), // kobo
        recipient: recipientCode,
        reference,
    });
    if (!sent.ok) return notAccepted('Transfer failed', sent.message, sent.details);

    // Paystack accepted the transfer for processing. It is NOT marked
    // completed here: settlement is asynchronous and can still fail.
    // paystackTransferWebhook hears transfer.success / transfer.failed /
    // transfer.reversed and moves the row to its final state.
    await sr.WithdrawalRequest.update(withdrawal.id, {
        transfer_code: sent.transfer.transfer_code,
        transfer_id: String(sent.transfer.id || ''),
    });
    return {
        status: 200,
        body: {
            success: true,
            message: 'Transfer initiated — Paystack will confirm settlement asynchronously.',
            transfer_data: sent.transfer,
        },
    };
}

// The three Paystack calls a payout needs, in the shape sendWithdrawal reads.
function paystackClient(secretKey: string) {
    const headers = { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    // { http, body }. http is 0 when there was no response at all.
    const call = async (method: string, path: string, payload?: unknown) => {
        try {
            const res = await fetch(`https://api.paystack.co${path}`, {
                method,
                headers,
                ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
            });
            const body = await res.json().catch(() => null);
            return { http: res.status, body };
        } catch (err) {
            console.error(`Paystack ${method} ${path} gave no answer:`, err);
            return { http: 0, body: null };
        }
    };
    const accepted = (http: number, body: any) => http >= 200 && http < 300 && !!body && !!body.status && !!body.data;
    return {
        // The transfer Paystack holds for a reference: see lookupFromResponse.
        async find(reference: string) {
            const { http, body } = await call('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
            return lookupFromResponse(http, body);
        },
        async createRecipient(bankAccount: any) {
            const { http, body } = await call('POST', '/transferrecipient', {
                type: 'nuban',
                name: bankAccount.account_name,
                account_number: bankAccount.account_number,
                bank_code: bankAccount.bank_code,
                currency: 'NGN',
            });
            if (accepted(http, body) && body.data.recipient_code) return { ok: true, code: body.data.recipient_code };
            return { ok: false, message: refusalMessage(http, body, 'Failed to create transfer recipient'), details: body };
        },
        async send(payload: unknown) {
            const { http, body } = await call('POST', '/transfer', payload);
            if (accepted(http, body) && body.data.transfer_code) return { ok: true, transfer: body.data };
            return { ok: false, message: refusalMessage(http, body, 'Transfer initiation failed'), details: body };
        },
    };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);

        const user = await base44.auth.me();
        if (!user || user.role !== 'admin') {
            return Response.json({ success: false, error: 'Unauthorized. Admin access required.' }, { status: 403 });
        }

        const body = await req.json().catch(() => null);
        const withdrawal_request_id = body?.withdrawal_request_id;
        if (!isId(withdrawal_request_id)) {
            return Response.json({ success: false, error: 'Missing withdrawal_request_id' }, { status: 400 });
        }

        const sr = base44.asServiceRole.entities;
        const withdrawalRequest = await sr.WithdrawalRequest.get(withdrawal_request_id);
        if (!withdrawalRequest || withdrawalRequest.id !== withdrawal_request_id) {
            return Response.json({ success: false, error: 'Withdrawal request not found' }, { status: 404 });
        }
        if (!canSend(withdrawalRequest)) {
            return Response.json({
                success: false,
                error: `Withdrawal is already ${withdrawalRequest.status}`,
            }, { status: 400 });
        }

        const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        if (!paystackSecretKey) {
            return Response.json({ success: false, error: 'Payment service not configured' }, { status: 500 });
        }

        const result = await sendWithdrawal(sr, paystackClient(paystackSecretKey), withdrawalRequest, new Date().toISOString());
        if (result.status >= 500) console.warn(`processWithdrawal ${withdrawal_request_id}:`, result.body.error);
        return Response.json(result.body, { status: result.status });
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
});
