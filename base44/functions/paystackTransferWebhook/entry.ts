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
// Idempotency: lookup is by transfer_code (preferred, set by processWithdrawal)
// or the transfer reference fallback. We refuse to act on rows that aren't in
// `processing` state, so a re-delivered webhook is a no-op.

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
        await sdk.functions.invoke('sendPushNotification', opts);
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

// Refunds the user's referral_balance_ngn for a failed/reversed transfer.
// Idempotent on the WithdrawalRequest row's `refunded_at` stamp — if that
// field is already set we skip the credit, so re-delivered webhooks (or a
// reversal that follows a failure that already refunded) can't double-credit.
async function refundUser(sdk: any, withdrawal: any) {
    if (withdrawal.refunded_at) {
        console.log(`Withdrawal ${withdrawal.id} already refunded at ${withdrawal.refunded_at} — skipping`);
        return;
    }
    const users = await sdk.asServiceRole.entities.User.filter({ email: withdrawal.user_email });
    const user = users[0];
    if (!user) {
        console.warn(`Refund target not found: ${withdrawal.user_email}`);
        return;
    }
    const newBalance = (Number(user.referral_balance_ngn) || 0) + (Number(withdrawal.amount) || 0);
    await sdk.asServiceRole.entities.User.update(user.id, { referral_balance_ngn: newBalance });
    await sdk.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, {
        refunded_at: new Date().toISOString(),
    });
    console.log(`💸 Refunded ₦${withdrawal.amount} to ${withdrawal.user_email} (withdrawal ${withdrawal.id})`);
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
        // Prefer lookup by transfer_code (we stamped it on the row at initiation).
        // Fall back to transfer_id if Paystack only sends id for this event type.
        let withdrawals: any[] = [];
        if (transferCode) {
            withdrawals = await sdk.asServiceRole.entities.WithdrawalRequest.filter({
                transfer_code: transferCode,
            });
        }
        if (withdrawals.length === 0 && event?.data?.id) {
            withdrawals = await sdk.asServiceRole.entities.WithdrawalRequest.filter({
                transfer_id: String(event.data.id),
            });
        }
        const withdrawal = withdrawals[0];
        if (!withdrawal) {
            console.warn('No WithdrawalRequest matched transfer', { transferCode, reference });
            return ack({ skipped: 'withdrawal_not_found' });
        }

        // Idempotency: we only act on rows still in `processing`. A re-delivered
        // success would have already flipped to `completed`; a re-delivered
        // failure would already be `failed` and refunded.
        if (withdrawal.status !== 'processing') {
            console.log(`Withdrawal ${withdrawal.id} not in processing (is: ${withdrawal.status}) — skipping`);
            return ack({ skipped: 'not_processing', status: withdrawal.status });
        }

        const nowIso = new Date().toISOString();

        if (eventName === 'transfer.success') {
            await sdk.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, {
                status: 'completed',
                processed_at: nowIso,
            });
            await notifyAdmin({
                title: '✅ *Withdrawal SETTLED*',
                withdrawalId: withdrawal.id,
                userEmail: withdrawal.user_email,
                amountNGN: Number(withdrawal.amount) || 0,
            });
            await tryPush(sdk, {
                user_email: withdrawal.user_email,
                title: '💸 Withdrawal sent',
                body: `₦${(Number(withdrawal.amount) || 0).toLocaleString()} is on its way to your bank.`,
                url: '/Withdrawals',
                tag: `withdrawal-${withdrawal.id}`,
            });
            return ack({ processed: true, withdrawal_id: withdrawal.id, status: 'completed' });
        }

        // failure or reversal — refund the reserved balance
        const newStatus = eventName === 'transfer.reversed' ? 'reversed' : 'failed';
        await sdk.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, {
            status: newStatus,
            error_message: reason || `Transfer ${newStatus}`,
            processed_at: nowIso,
        });
        await refundUser(sdk, { ...withdrawal, status: newStatus });
        await notifyAdmin({
            title: newStatus === 'reversed' ? '↩️ *Withdrawal REVERSED*' : '❌ *Withdrawal FAILED*',
            withdrawalId: withdrawal.id,
            userEmail: withdrawal.user_email,
            amountNGN: Number(withdrawal.amount) || 0,
            reason,
        });
        await tryPush(sdk, {
            user_email: withdrawal.user_email,
            title: newStatus === 'reversed' ? '↩️ Withdrawal reversed' : '❌ Withdrawal failed',
            body: `We've refunded ₦${(Number(withdrawal.amount) || 0).toLocaleString()} to your referral balance. Tap to try again.`,
            url: '/Withdrawals',
            tag: `withdrawal-${withdrawal.id}`,
        });
        return ack({ processed: true, withdrawal_id: withdrawal.id, status: newStatus });
    } catch (err) {
        console.error('paystackTransferWebhook error:', err);
        return ack({ error: (err as Error).message });
    }
});
