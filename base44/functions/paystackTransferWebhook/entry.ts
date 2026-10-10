import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// paystackTransferWebhook
// ----------------------------------------------------------------------------
// Confirms the final outcome of an outbound transfer (withdrawal payout).
//
// processWithdrawal initiates a transfer with Paystack and leaves the
// WithdrawalRequest row in `processing` state. Paystack then settles the
// transfer asynchronously and POSTs one of:
//   transfer.success   → funds arrived at the recipient bank
//   transfer.failed    → bank rejected / NUBAN invalid / float exhausted
//   transfer.reversed  → completed transfer was reversed
//
// On success we flip the row to `completed`.
// On failure/reversal we flip to `failed`/`reversed` AND refund the user's
// referral_balance_ngn (we debited it at request creation).
//
// Security: HMAC-SHA512 of the raw body with PAYSTACK_SECRET_KEY, compared
// constant-time against the x-paystack-signature header. Anything that
// doesn't verify is silently ack'd (we still 200 so Paystack stops retrying)
// but takes no DB action — same pattern as paystackWebhook.
//
// Finding the row: processWithdrawal sends the reference wd-<row id>, so the
// row is read by that id and by nothing else. Transfers sent before
// references had that form are matched on transfer_code, then transfer_id,
// and only against rows that carry no reference of the new form.
//
// Idempotency: a row is settled once. A re-delivered success or failure finds
// it already final and is a no-op. Two events act on a final row (see
// webhookShouldAct): a reversal of a completed transfer, and a success for a
// row that was marked failed on a stale reading while the money went out.
//
// Crediting back: a referral withdrawal is credited back only if its debit is
// on record in WithdrawalLedger, and exactly once (refundReferralOnce,
// lockstep with processWithdrawal). A driver-wallet payout debited nothing.

async function hmacSha512Hex(secret: string, body: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-512' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

// Fire-and-forget push to the user. Swallows all errors so a push outage
// can never block the parent business action. Use a stable tag so re-sent
// pushes (e.g. failover + webhook re-delivery) replace each other instead
// of stacking notifications on the user's device.
async function tryPush(sdk: any, opts: {
    user_email: string;
    title: string;
    body?: string;
    url?: string;
    tag?: string;
}) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

async function notifyAdmin(opts: {
    title: string;
    withdrawalId: string;
    userEmail: string;
    amountNGN: number;
    reason?: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const reasonLine = opts.reason ? `\n• Reason: ${opts.reason}` : '';
    const text = `${opts.title}\n\n` +
        `Withdrawal \`${opts.withdrawalId.substring(0, 8)}\`\n` +
        `• User: ${opts.userEmail}\n` +
        `• Amount: ₦${opts.amountNGN.toLocaleString()}` +
        reasonLine;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Telegram withdrawal notify failed:', err);
    }
}

// Only a withdrawal that debited a stored balance is refunded to one. A row
// written before wallets existed is a referral withdrawal. Lockstep copy in
// processWithdrawal.
function refundsToBalance(withdrawal: any) {
    return !!withdrawal && withdrawal.wallet !== 'driver';
}

// The row id inside a reference built by processWithdrawal (wd-<row id>), or
// null for anything else. Only the exact shape is accepted: a reference made
// by the old code, WD-<8 hex>-<time>, must not be read as a row id whatever
// case it comes back in.
function withdrawalIdFromReference(reference: string) {
    const m = /^wd-([a-f0-9]{24})$/.exec(String(reference || ''));
    return m ? m[1] : null;
}

// Whether an event should change this row. A row is settled once: a
// re-delivered success or failure finds it already final and is ignored. Two
// events act on a final row:
//   - a reversal after success, when the bank sends the money back: the
//     payout must stop counting as paid;
//   - a success for a row marked failed. A second press that lost a race can
//     write "failed" on a stale reading while the transfer it lost to goes
//     out. The money left, so the row must say so.
function webhookShouldAct(eventName: string, row: any) {
    const status = row && row.status;
    if (status === 'processing') return true;
    if (eventName === 'transfer.reversed' && status === 'completed') return true;
    return eventName === 'transfer.success' && status === 'failed';
}

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

// ── The referral balance's paper trail — lockstep, see processWithdrawal ────
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

Deno.serve(async (req) => {
    const ack = (extra: Record<string, unknown> = {}) =>
        new Response(JSON.stringify({ ok: true, ...extra }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405 });
    }

    const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secretKey) {
        console.error('PAYSTACK_SECRET_KEY not configured — rejecting webhook');
        return ack({ skipped: 'no_secret' });
    }

    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-paystack-signature') || '';
    const expected = await hmacSha512Hex(secretKey, rawBody);
    if (!safeEqual(expected, signatureHeader)) {
        console.warn('Invalid Paystack signature — ignoring');
        return ack({ skipped: 'invalid_signature' });
    }

    let event: any;
    try { event = JSON.parse(rawBody); } catch { return ack({ skipped: 'bad_json' }); }

    const eventName: string = event?.event || '';
    if (!['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(eventName)) {
        return ack({ skipped: `unhandled_event:${eventName}` });
    }

    const transferCode: string | undefined = event?.data?.transfer_code;
    const reference: string | undefined = event?.data?.reference;
    const reason: string | undefined = event?.data?.reason || event?.data?.gateway_response;

    if (!transferCode && !reference) {
        console.warn('Transfer webhook missing transfer_code and reference', event?.data);
        return ack({ skipped: 'missing_identifiers' });
    }

    const sdk = createClientFromRequest(req);

    try {
        const sr = sdk.asServiceRole.entities;
        let withdrawals: any[] = [];
        const rowId = withdrawalIdFromReference(reference || '');
        if (rowId) {
            // The reference names the row. Nothing else is tried: a row that
            // merely carries the same transfer code is not this withdrawal.
            // This also finds a row whose transfer code was never written
            // because Paystack's answer to processWithdrawal was lost.
            try {
                const row = await sr.WithdrawalRequest.get(rowId);
                if (row && row.id === rowId) withdrawals = [row];
            } catch (_err) {
                // No such row.
            }
        } else {
            // A transfer sent before references carried the row id. A row
            // that carries a reference of the new form was not sent that way,
            // whatever transfer code is written on it; of the rest, the
            // oldest is the one the old code sent.
            if (transferCode) {
                withdrawals = await sr.WithdrawalRequest.filter({ transfer_code: transferCode });
            }
            if (withdrawals.length === 0 && event?.data?.id) {
                withdrawals = await sr.WithdrawalRequest.filter({ transfer_id: String(event.data.id) });
            }
            withdrawals = withdrawals
                .filter((w: any) => !w.transfer_reference)
                .sort((a: any, b: any) => String(a.created_date || '').localeCompare(String(b.created_date || '')));
        }
        const withdrawal = withdrawals[0];
        if (!withdrawal) {
            console.warn('No WithdrawalRequest matched transfer', { transferCode, reference });
            return ack({ skipped: 'withdrawal_not_found' });
        }

        if (!webhookShouldAct(eventName, withdrawal)) {
            console.log(`Withdrawal ${withdrawal.id} is already ${withdrawal.status}: nothing to do for ${eventName}`);
            return ack({ skipped: 'already_settled', status: withdrawal.status });
        }

        const nowIso = new Date().toISOString();
        const amountNGN = Number(withdrawal.amount) || 0;
        const naira = `₦${amountNGN.toLocaleString()}`;
        // A row found by its reference may never have had its code written.
        const codePatch = transferCode && !withdrawal.transfer_code ? { transfer_code: transferCode } : {};

        if (eventName === 'transfer.success') {
            await sr.WithdrawalRequest.update(withdrawal.id, { status: 'completed', processed_at: nowIso, ...codePatch });
            // The row had been credited back and the bank has now paid it as
            // well. refundReferralOnce is built so this cannot happen, and
            // nothing here can take a credit back safely, so if it ever does
            // admin is told in the plainest terms.
            const paidAndCredited = refundsToBalance(withdrawal) && !!withdrawal.refunded_at;
            await notifyAdmin({
                title: paidAndCredited ? '⚠️ *Withdrawal PAID after it was credited back*' : '✅ *Withdrawal SETTLED*',
                withdrawalId: withdrawal.id,
                userEmail: withdrawal.user_email,
                amountNGN,
                reason: paidAndCredited
                    ? `Take ${naira} off this user's referral balance: it was credited back and the bank has now paid the transfer too.`
                    : undefined,
            });
            await tryPush(sdk, {
                user_email: withdrawal.user_email,
                title: '💸 Withdrawal sent',
                body: `${naira} is on its way to your bank.`,
                url: '/Withdrawals',
                tag: `withdrawal-${withdrawal.id}`,
            });
            return ack({ processed: true, withdrawal_id: withdrawal.id, status: 'completed' });
        }

        // Failure or reversal. The transfer existed, so its reference can
        // never carry another one: crediting back needs no look at other
        // attempts (unsent is false).
        const newStatus = eventName === 'transfer.reversed' ? 'reversed' : 'failed';
        const why = reason || `Transfer ${newStatus}`;
        await sr.WithdrawalRequest.update(withdrawal.id, {
            status: newStatus,
            error_message: why,
            processed_at: nowIso,
            ...codePatch,
        });
        const refund = await refundReferralOnce(sr, withdrawal, nowIso, false);
        const credited = refund === 'refunded' || refund === 'already';
        const stored = refundsToBalance(withdrawal);
        if (stored && !credited) {
            await sr.WithdrawalRequest.update(withdrawal.id, {
                error_message: `${why}. NOT credited back (${refund}). Open Admin → Withdrawals and press Credit back, or correct the balance by hand.`,
            });
        }
        await notifyAdmin({
            title: newStatus === 'reversed' ? '↩️ *Withdrawal REVERSED*' : '❌ *Withdrawal FAILED*',
            withdrawalId: withdrawal.id,
            userEmail: withdrawal.user_email,
            amountNGN,
            reason: stored && !credited ? `${why}. NOT credited back (${refund}): check it in Admin → Withdrawals.` : reason,
        });
        await tryPush(sdk, {
            user_email: withdrawal.user_email,
            title: newStatus === 'reversed' ? '↩️ Withdrawal reversed' : '❌ Withdrawal failed',
            body: !stored
                ? `${naira} is back in your driver wallet. Tap to try again.`
                : credited
                    ? `We've refunded ${naira} to your referral balance. Tap to try again.`
                    : `Your withdrawal of ${naira} did not go through. The team is checking your balance.`,
            url: stored ? '/Withdrawals' : '/DriverWallet',
            tag: `withdrawal-${withdrawal.id}`,
        });
        return ack({ processed: true, withdrawal_id: withdrawal.id, status: newStatus, refund });
    } catch (err) {
        console.error('paystackTransferWebhook error:', err);
        return ack({ error: (err as Error).message });
    }
});
