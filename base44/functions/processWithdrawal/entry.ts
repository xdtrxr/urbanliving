import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// processWithdrawal
// ----------------------------------------------------------------------------
// Admin sends a withdrawal to Paystack, or asks Paystack about one it already
// has.
//
// SENT ONCE. Nothing on this platform can lock a row, so two calls for the
// same withdrawal (two tabs, two admins, a second press after a timeout) can
// both read it as pending. Three things stand between that and two bank
// transfers:
//   1. the Paystack reference is fixed per row, wd-<row id>, and Paystack
//      does not hold two transfers with one reference;
//   2. before sending, and again after any refusal, this function asks
//      Paystack what it already holds for that reference;
//   3. the row is read again immediately before it is marked processing, and
//      a row another call has just closed is left closed.
// A withdrawal is marked failed only when Paystack refused it for a stated
// reason AND holds no transfer for it.
//
// CREDITED BACK ONCE, AND ONLY WHAT WAS TAKEN. A referral withdrawal is paid
// out of a stored balance, which createWithdrawalRequest debits and records
// in WithdrawalLedger. A failed one is credited back only if that debit is on
// record, exactly once, and never while another attempt to send it could
// still succeed (refundReferralOnce). A referral request with no debit on
// record was made before the ledger existed or typed into the database by
// hand; the two look the same. It is not sent unless admin says so a second
// time, and it is never credited back automatically.
//
// NEVER STUCK. The reference is written on the row before Paystack is asked
// to send. If the answer never arrives, the row stays processing with no
// transfer code, which canSend() lets admin retry. A row that does have a
// transfer code is never sent again, but canRecheck() lets admin ask Paystack
// where it stands, which settles a row whose webhook never arrived. A failed
// referral row that was not credited back can be looked at again the same
// way (canCredit).
//
// ON THE LEDGER. A driver-wallet withdrawal was not debited from anywhere:
// the row is the reservation against the driver's released earnings. So it
// is checked against the earnings ledger again here, and the request itself
// must be one of the rows that check counts, still waiting to be paid.
// Nothing on the row is trusted: a browser can create a WithdrawalRequest row
// directly until the stricter create rule staged in
// docs/entity-rules-pending-publish is live.

const WITHDRAWAL_THRESHOLD_NGN = 10000;

// How long a call that wrote an "attempt" or a "claim" row can still be
// running. A row older than this with no outcome on it is taken to have died
// with its function. Lockstep in processWithdrawal and paystackTransferWebhook.
const STALE_ATTEMPT_MS = 10 * 60 * 1000;

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

// entity.get() rejects when there is no such row (the platform answers 404).
// This answers null for that one case and lets every other failure through,
// so "the row is gone" and "the read failed" are never confused.
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
    }
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

// Only a withdrawal that debited a stored balance is refunded to one. A row
// written before wallets existed is a referral withdrawal. Lockstep copy in
// paystackTransferWebhook.
function refundsToBalance(withdrawal: any) {
    return !!withdrawal && withdrawal.wallet !== 'driver';
}

// ── The referral balance's paper trail — lockstep in paystackTransferWebhook ─
// WithdrawalLedger is admin-only for every operation, so unlike a
// WithdrawalRequest row it cannot be typed in from a browser. Three kinds of
// row, all for one withdrawal:
//   debit    createWithdrawalRequest took the amount off the stored balance
//   attempt  a call is about to ask Paystack to send it
//            (open, then sent | refused | unconfirmed | abandoned)
//   refund   a call claims the right to credit it back
//            (claimed, then crediting, then credited; or duplicate | held_back | no_user)

// Whether the app has on record that it took this request's amount off the
// user's referral balance.
function debitOnRecord(entries: any[], withdrawal: any) {
    const email = String((withdrawal && withdrawal.user_email) || '').trim().toLowerCase();
    const amount = Number(withdrawal && withdrawal.amount);
    if (!email || !Number.isFinite(amount) || amount <= 0) return false;
    return (entries || []).some((e) => !!e
        && e.kind === 'debit'
        && e.withdrawal_request_id === withdrawal.id
        && String(e.user_email || '').trim().toLowerCase() === email
        && Number(e.amount_ngn) === amount);
}

// Whether a ledger row was made recently enough that the call that made it
// can still be running. A row with no readable time counts as recent.
function madeRecently(entry: any, nowIso: string) {
    const made = Date.parse((entry && entry.created_date) || '');
    const now = Date.parse(nowIso || '');
    if (Number.isNaN(made) || Number.isNaN(now)) return true;
    return now - made < STALE_ATTEMPT_MS;
}

// Whether a ledger row is an attempt to send that has put a transfer out, or
// still could. While one exists, a refusal with nothing held at Paystack is
// not safe to credit back: the other attempt could succeed a moment later.
function attemptBlocksRefund(entry: any, nowIso: string) {
    if (!entry || entry.kind !== 'attempt') return false;
    if (entry.state === 'sent') return true;
    return (entry.state === 'open' || entry.state === 'unconfirmed') && madeRecently(entry, nowIso);
}

// Whether a ledger row is a claim on this withdrawal's refund that still
// stands: it has credited, is in the middle of crediting, or was made a
// moment ago and has not been decided. An attempt to send that sees one
// stands down.
function claimIsLive(entry: any, nowIso: string) {
    if (!entry || entry.kind !== 'refund') return false;
    if (entry.state === 'credited' || entry.state === 'crediting') return true;
    return entry.state === 'claimed' && madeRecently(entry, nowIso);
}

// Credit a failed referral withdrawal back to the stored balance: only what
// the app took, and exactly once.
//
// Nothing here can lock a row, so "has this been refunded?" cannot be read
// and then acted on: two calls would both read "no". Instead each call first
// writes a claim, then reads all the claims; only the oldest standing one
// credits. `unsent` says the refund is for a refusal with nothing held at
// Paystack; that one also stands down while another attempt to send could
// still put a transfer out, so a withdrawal is never both paid and credited.
//
// Answers refunded | already | no_debit | held_back | interrupted | no_user |
// not_stored. A driver-wallet request debited nothing, so marking it failed
// is its refund (not_stored).
async function refundReferralOnce(sr: any, withdrawal: any, nowIso: string, unsent: boolean) {
    if (!refundsToBalance(withdrawal)) return 'not_stored';
    const own = { withdrawal_request_id: withdrawal.id };
    const before = await fetchAll(sr.WithdrawalLedger, own);
    if (!debitOnRecord(before, withdrawal)) return 'no_debit';
    if (before.some((e) => e.kind === 'refund' && e.state === 'credited')) return 'already';
    // A credit that started and never finished: the balance may or may not
    // carry it. Only a person can tell.
    const halfDone = before.find((e) => e.kind === 'refund' && e.state === 'crediting');
    if (halfDone) return madeRecently(halfDone, nowIso) ? 'already' : 'interrupted';
    // A row refunded before the ledger existed carries only the stamp.
    const fresh = await sr.WithdrawalRequest.get(withdrawal.id);
    if (!fresh || fresh.refunded_at) return 'already';

    const amount = Math.max(0, Math.round(Number(withdrawal.amount) || 0));
    const claim = await sr.WithdrawalLedger.create({
        withdrawal_request_id: withdrawal.id,
        user_email: withdrawal.user_email,
        kind: 'refund',
        state: 'claimed',
        amount_ngn: amount,
    });
    const after = await fetchAll(sr.WithdrawalLedger, own);
    const standing = after
        .filter((e) => claimIsLive(e, nowIso))
        .sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
            || String(a.id).localeCompare(String(b.id)));
    if (standing.length === 0 || standing[0].id !== claim.id) {
        await sr.WithdrawalLedger.update(claim.id, { state: 'duplicate' });
        return 'already';
    }
    if (unsent && after.some((e) => attemptBlocksRefund(e, nowIso))) {
        await sr.WithdrawalLedger.update(claim.id, { state: 'held_back' });
        return 'held_back';
    }
    const users = await sr.User.filter({ email: withdrawal.user_email });
    if (!Array.isArray(users) || users.length === 0) {
        await sr.WithdrawalLedger.update(claim.id, { state: 'no_user' });
        return 'no_user';
    }
    await sr.WithdrawalLedger.update(claim.id, { state: 'crediting' });
    await sr.User.update(users[0].id, {
        referral_balance_ngn: (Number(users[0].referral_balance_ngn) || 0) + amount,
    });
    await sr.WithdrawalLedger.update(claim.id, { state: 'credited' });
    await sr.WithdrawalRequest.update(withdrawal.id, { refunded_at: nowIso });
    return 'refunded';
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

// Whether Paystack can be asked where this row's transfer stands: a row that
// was sent under a reference Paystack knows it by, has a transfer code, and
// has not been settled. Asking never sends anything.
function canRecheck(withdrawal: any) {
    return !!withdrawal && withdrawal.status === 'processing' && !!withdrawal.transfer_code && !!withdrawal.transfer_reference;
}

// Whether a closed referral row can still be looked at for crediting back:
// it failed, or was reversed, and carries no sign that it was credited.
function canCredit(withdrawal: any) {
    return refundsToBalance(withdrawal)
        && (withdrawal.status === 'failed' || withdrawal.status === 'reversed')
        && !withdrawal.refunded_at;
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
// its transfer. '' means not settled yet: the row stays processing. A
// transfer that was abandoned, blocked or rejected never left the account,
// and Paystack sends no event for those, so they are treated as failed.
function rowStatusFor(transferStatus: string) {
    if (transferStatus === 'success') return 'completed';
    if (transferStatus === 'reversed') return 'reversed';
    if (['failed', 'abandoned', 'blocked', 'rejected'].includes(transferStatus)) return 'failed';
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
    const driver = await getOrNull(sr.Driver, w.driver_id);
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
    const own = counted.find((r) => r.id === w.id);
    if (!own) return 'This request is not on the driver\'s ledger.';
    // It must also still be waiting to be paid. A row another call has just
    // closed is on the ledger but reserves nothing, so "no shortfall" would
    // be true of it for the wrong reason.
    if (own.status !== 'pending' && own.status !== 'processing') return 'This request is no longer waiting to be paid.';
    const totals = walletTotals(earnings, counted);
    if (totals.shortfall > 0) {
        return `The driver's released earnings do not cover this request (short by ₦${totals.shortfall.toLocaleString()}).`;
    }
    return '';
}

// Send one withdrawal, or look again at one that was already sent or closed,
// and say what the response should be: { status, body }. It reads the row
// itself, so a caller never hands it a stale copy, and everything that
// touches Paystack goes through `paystack` (see paystackClient): this exact
// code runs in scripts/check-driver-wallet.mjs against a stand-in, several
// calls at once, in every order their requests could arrive.
async function sendWithdrawal(sr: any, paystack: any, withdrawalId: string, allowUnrecorded: boolean, nowIso: string) {
    const refuse = (status, error, code) => ({ status, body: { success: false, error, code } });
    const withdrawal = await getOrNull(sr.WithdrawalRequest, withdrawalId);
    if (!withdrawal || withdrawal.id !== withdrawalId) return refuse(404, 'Withdrawal request not found', 'NOT_FOUND');

    const reference = transferReferenceFor(withdrawal.id);
    const stored = refundsToBalance(withdrawal);
    const amount = Math.max(0, Math.round(Number(withdrawal.amount) || 0));
    const closed = (row) => refuse(409, row && row.refunded_at && canSend(row)
        ? 'This withdrawal has already been credited back. It cannot be sent.'
        : `Withdrawal is already ${row ? row.status : 'gone'}`, 'NOT_SENDABLE');
    const cannotAsk = () => refuse(502, 'Paystack could not be asked about this withdrawal, so nothing was sent and nothing changed. Try again in a minute.', 'UNCONFIRMED');
    // What a failed row and admin are told about the balance.
    const creditNote = (outcome) => ({
        refunded: ` ₦${amount.toLocaleString()} was credited back to the referral balance.`,
        already: ' It had already been credited back.',
        no_debit: ' It was NOT credited back: the app has no record of taking this amount off the balance. Credit it by hand if the request was genuine.',
        held_back: ' It was NOT credited back yet: another attempt to send it was still in flight. Press Credit back in a few minutes.',
        interrupted: ' It was NOT credited back: an earlier credit for it was interrupted. Check the balance and correct it by hand.',
        no_user: ' It was NOT credited back: no account has this email.',
    }[outcome] || '');
    // This call's own "attempt" row in the ledger (referral requests only),
    // and how the attempt ended.
    let attempt = null;
    const closeAttempt = async (state) => {
        if (attempt) await sr.WithdrawalLedger.update(attempt.id, { state });
    };

    // The transfer exists at Paystack. Record its codes. The row's status is
    // only ever moved forward: to its settled state if the bank has settled
    // and the row is not final yet, or from pending to processing. It is
    // never written over a state the settlement webhook may have set a
    // moment ago, which is why the row is read again here.
    const alreadySent = async (transfer) => {
        const settled = rowStatusFor(transfer.status);
        const fresh = await getOrNull(sr.WithdrawalRequest, withdrawal.id);
        const open = !!fresh && (fresh.status === 'pending' || fresh.status === 'processing');
        const bankSaid = settled === 'reversed' ? 'The bank sent this transfer back.' : 'The bank did not pay this transfer.';
        const patch = {
            transfer_reference: reference,
            transfer_code: transfer.transfer_code,
            transfer_id: String(transfer.id || ''),
        };
        if (settled && open) {
            patch.status = settled;
            patch.processed_at = nowIso;
            if (settled !== 'completed') patch.error_message = bankSaid;
        } else if (!settled && fresh && fresh.status === 'pending') {
            patch.status = 'processing';
        }
        await sr.WithdrawalRequest.update(withdrawal.id, patch);
        let note = '';
        if (open && (settled === 'failed' || settled === 'reversed')) {
            const outcome = await refundReferralOnce(sr, withdrawal, nowIso, false);
            note = creditNote(outcome);
            if (outcome !== 'refunded' && outcome !== 'not_stored' && outcome !== 'already') {
                await sr.WithdrawalRequest.update(withdrawal.id, { error_message: `${bankSaid}${note}` });
            }
        }
        const status = patch.status || (fresh && fresh.status) || 'processing';
        const what = {
            completed: 'This withdrawal had already been sent, and the bank has paid it.',
            failed: 'This withdrawal had already been sent, and the bank did not pay it. It is marked failed.',
            reversed: 'This withdrawal had already been sent, and the bank sent the money back. It is marked reversed.',
        }[status] || 'This withdrawal had already been sent to Paystack. Its status will update when the bank settles.';
        return {
            status: 200,
            body: {
                success: true,
                already_sent: true,
                status,
                message: `${what} Nothing was sent a second time.${note}`,
            },
        };
    };

    // What it means that Paystack did not accept a request. `message` is its
    // stated reason, or null when it gave no usable answer.
    const notAccepted = async (label, message, details) => {
        const lookup = await paystack.find(reference);
        const outcome = transferOutcome(false, message, lookup);
        if (outcome === 'already_sent') {
            // Somebody's transfer for this withdrawal exists. It is not this
            // attempt's: this one was turned away.
            await closeAttempt('refused');
            return alreadySent(lookup);
        }
        if (outcome === 'unconfirmed') {
            await closeAttempt('unconfirmed');
            return refuse(502, `Paystack did not confirm the transfer. The withdrawal is left as processing and cannot be sent twice. Press Retry in a minute. If it keeps happening, look up the reference ${reference} in Paystack.`, 'UNCONFIRMED');
        }
        await sr.WithdrawalRequest.update(withdrawal.id, {
            status: 'failed',
            error_message: message || label,
            processed_at: nowIso,
        });
        await closeAttempt('refused');
        const refund = await refundReferralOnce(sr, withdrawal, nowIso, true);
        if (refund !== 'refunded' && refund !== 'not_stored' && refund !== 'already') {
            await sr.WithdrawalRequest.update(withdrawal.id, { error_message: `${message || label}.${creditNote(refund)}` });
        }
        return { status: 400, body: { success: false, error: label, details, refund } };
    };

    // ── A row that was already sent: ask, never send ────────────────────────
    if (canRecheck(withdrawal)) {
        const held = await paystack.find(reference);
        if (held === undefined) return cannotAsk();
        if (!held) {
            return refuse(409, `Paystack holds no transfer under the reference ${reference}. Nothing changed. Look this withdrawal up in the Paystack dashboard by its transfer code.`, 'NO_TRANSFER');
        }
        return alreadySent(held);
    }

    // ── A failed referral row that was not credited back: look again ────────
    if (canCredit(withdrawal)) {
        const held = await paystack.find(reference);
        if (held === undefined) return cannotAsk();
        const heldStatus = held ? rowStatusFor(held.status) : 'none';
        if (held && heldStatus !== 'failed' && heldStatus !== 'reversed') {
            // Paystack holds a transfer for this withdrawal that did not fail:
            // the row was marked failed on a stale reading while the money
            // went out. Put the row right; there is nothing to credit back.
            await sr.WithdrawalRequest.update(withdrawal.id, {
                status: heldStatus || 'processing',
                transfer_reference: reference,
                transfer_code: held.transfer_code,
                transfer_id: String(held.id || ''),
                ...(heldStatus ? { processed_at: nowIso } : {}),
            });
            return {
                status: 200,
                body: {
                    success: true,
                    already_sent: true,
                    status: heldStatus || 'processing',
                    message: 'Paystack holds a transfer for this withdrawal that did not fail, so nothing was credited back. The row has been corrected.',
                },
            };
        }
        const refund = await refundReferralOnce(sr, withdrawal, nowIso, !held);
        return {
            status: 200,
            body: {
                success: true,
                credited: refund === 'refunded',
                refund,
                message: `Checked with Paystack: ${held ? 'the transfer did not go through' : 'it holds no transfer for this withdrawal'}.${creditNote(refund)}`,
            },
        };
    }

    if (!canSend(withdrawal)) return closed(withdrawal);

    // ── Send ────────────────────────────────────────────────────────────────
    // Ask before sending. A transfer for this withdrawal may already exist:
    // an earlier attempt whose answer was lost, or a press a moment ago.
    const before = await paystack.find(reference);
    if (before === undefined) return cannotAsk();
    if (before) return alreadySent(before);

    if (!stored) {
        // A driver-wallet request is only as good as the ledger behind it.
        // One that fails is closed, so it cannot be retried into a payout
        // later. Nothing was debited for it, so nothing is credited back.
        const problem = await driverWithdrawalProblem(sr, withdrawal);
        if (problem) {
            // Another call may have sent it, or closed it, while the ledger
            // was being read. Look once more before writing "failed" on it.
            const again = await paystack.find(reference);
            if (again === undefined) return cannotAsk();
            if (again) return alreadySent(again);
            const latest = await getOrNull(sr.WithdrawalRequest, withdrawal.id);
            if (!canSend(latest)) return closed(latest);
            await sr.WithdrawalRequest.update(withdrawal.id, {
                status: 'failed',
                error_message: problem,
                processed_at: nowIso,
            });
            return refuse(409, problem, 'NOT_COVERED');
        }
    } else if (!allowUnrecorded) {
        const entries = await fetchAll(sr.WithdrawalLedger, { withdrawal_request_id: withdrawal.id });
        if (!debitOnRecord(entries, withdrawal)) {
            return refuse(409, 'The app has no record of taking this amount off the referral balance. A request made before this version of the app can be genuine; one typed into the database by hand looks exactly the same. Check the person\'s referral earnings before sending it. If it is sent and then fails, it will not be credited back automatically.', 'UNRECORDED');
        }
    }

    let bankAccount = null;
    if (isId(withdrawal.bank_account_id)) bankAccount = await getOrNull(sr.UserBankAccount, withdrawal.bank_account_id);
    if (!bankAccount) return refuse(404, 'Bank account not found', 'NO_BANK');
    // createWithdrawalRequest only accepts the requester's own account, so a
    // row naming someone else's was not made by it. Left exactly as it is,
    // for a person to look at.
    if (!bankBelongsTo(bankAccount, withdrawal)) {
        return refuse(409, 'The bank account on this request does not belong to the person who asked. Nothing was sent.', 'BANK_MISMATCH');
    }

    // Read the row once more, immediately before it is marked processing.
    // Another call may have sent it or closed it since this one first read
    // it. A row that was sent in the meantime is answered the way a second
    // press on a sent row always is, by asking Paystack; a closed row stays
    // closed.
    const current = await getOrNull(sr.WithdrawalRequest, withdrawal.id);
    if (canRecheck(current)) {
        const held = await paystack.find(reference);
        if (held === undefined) return cannotAsk();
        if (held) return alreadySent(held);
    }
    if (!canSend(current) || current.refunded_at) return closed(current);

    if (stored) {
        // Say "I am about to send this" in the ledger, then look for a claim
        // on its refund. A call crediting it back does the mirror image
        // (claim, then look for attempts), so one of the two always sees the
        // other, and the withdrawal is never both sent and credited back.
        attempt = await sr.WithdrawalLedger.create({
            withdrawal_request_id: withdrawal.id,
            user_email: withdrawal.user_email,
            kind: 'attempt',
            state: 'open',
            amount_ngn: amount,
        });
        const seen = await fetchAll(sr.WithdrawalLedger, { withdrawal_request_id: withdrawal.id });
        if (seen.some((e) => claimIsLive(e, nowIso))) {
            await closeAttempt('abandoned');
            return refuse(409, 'This withdrawal is being credited back by another attempt. Nothing was sent.', 'NOT_SENDABLE');
        }
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
        amount: amount * 100, // kobo
        recipient: recipientCode,
        reference,
    });
    if (!sent.ok) return notAccepted('Transfer failed', sent.message, sent.details);

    await closeAttempt('sent');
    // Paystack can answer a repeat of a reference it already knows with the
    // transfer it already holds. If that one is settled, settle the row.
    if (rowStatusFor(sent.transfer.status)) return alreadySent(sent.transfer);

    // Paystack accepted the transfer for processing. It is NOT marked
    // completed here: settlement is asynchronous and can still fail.
    // paystackTransferWebhook hears transfer.success / transfer.failed /
    // transfer.reversed and moves the row to its final state.
    await sr.WithdrawalRequest.update(withdrawal.id, {
        transfer_code: sent.transfer.transfer_code,
        transfer_id: String(sent.transfer.id || ''),
    });
    const needsCode = sent.transfer.status === 'otp';
    return {
        status: 200,
        body: {
            success: true,
            ...(needsCode ? { warning: 'NEEDS_OTP' } : {}),
            message: needsCode
                ? 'Paystack is waiting for a one-time code before it releases this transfer. Approve it in the Paystack dashboard, or turn off transfer OTP there. Then press Check with Paystack on this row.'
                : 'Transfer initiated — Paystack will confirm settlement asynchronously.',
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

        const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        if (!paystackSecretKey) {
            return Response.json({ success: false, error: 'Payment service not configured' }, { status: 500 });
        }

        // sendWithdrawal reads the row itself and decides everything. Nothing
        // is decided here on a copy that could be stale by the time it is used.
        const result = await sendWithdrawal(
            base44.asServiceRole.entities,
            paystackClient(paystackSecretKey),
            withdrawal_request_id,
            body?.allow_unrecorded === true,
            new Date().toISOString(),
        );
        if (result.status >= 500) console.warn(`processWithdrawal ${withdrawal_request_id}:`, result.body.error);
        return Response.json(result.body, { status: result.status });
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
});
