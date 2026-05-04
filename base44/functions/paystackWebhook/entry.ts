import { createClient } from 'npm:@base44/sdk@0.7.1';

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

async function notifyAdmin(opts: {
    bookingId: string;
    guestName: string;
    guestEmail: string;
    propertyId: string;
    amountNGN: number;
    reference: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const text = `💰 *PAYMENT RECEIVED (webhook)*\n\n` +
        `Booking \`${opts.bookingId}\`\n` +
        `• Guest: ${opts.guestName} (${opts.guestEmail})\n` +
        `• Property: \`${opts.propertyId}\`\n` +
        `• Amount: ₦${opts.amountNGN.toLocaleString()}\n` +
        `• Paystack ref: \`${opts.reference}\``;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Telegram payment notify failed:', err);
    }
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
    if (expected !== signatureHeader) {
        console.warn('Invalid Paystack signature — ignoring');
        return ack({ skipped: 'invalid_signature' });
    }

    let event: any;
    try { event = JSON.parse(rawBody); } catch { return ack({ skipped: 'bad_json' }); }

    if (event?.event !== 'charge.success') {
        return ack({ skipped: `unhandled_event:${event?.event}` });
    }

    const reference: string = event?.data?.reference;
    const amountKobo: number = Number(event?.data?.amount) || 0;
    const currency: string = event?.data?.currency || '';
    const metadata = event?.data?.metadata || {};
    const bookingId: string | undefined = metadata?.booking_id;

    if (!reference || !bookingId) {
        console.warn('Webhook missing reference or booking_id', { reference, bookingId });
        return ack({ skipped: 'missing_fields' });
    }
    if (currency && currency !== 'NGN') {
        console.warn(`Webhook currency ${currency} != NGN — ignoring`);
        return ack({ skipped: `bad_currency:${currency}` });
    }

    const appId = Deno.env.get('BASE44_APP_ID');
    const apiKey = Deno.env.get('BASE44_SERVICE_ROLE_KEY');
    if (!appId || !apiKey) {
        console.error('BASE44_APP_ID / BASE44_SERVICE_ROLE_KEY missing');
        return ack({ skipped: 'no_base44_credentials' });
    }

    try {
        const sdk = createClient({ appId, serviceToken: apiKey, requiresAuth: false });
        const booking = await sdk.asServiceRole.entities.Booking.get(bookingId);
        if (!booking) return ack({ skipped: 'booking_not_found' });

        if (booking.payment_status === 'paid' && booking.status === 'confirmed') {
            return ack({ skipped: 'already_paid' });
        }

        const expectedKobo = Math.round((Number(booking.total_price) || 0) * 100);
        if (amountKobo !== expectedKobo) {
            console.error(`Webhook amount mismatch: expected ${expectedKobo}, got ${amountKobo}`);
            return ack({ skipped: 'amount_mismatch' });
        }

        const nowIso = new Date().toISOString();
        await sdk.asServiceRole.entities.Booking.update(booking.id, {
            payment_status: 'paid',
            status: 'confirmed',
            payment_method: 'paystack',
            transaction_hash: reference,
            paid_at: nowIso,
        });

        await notifyAdmin({
            bookingId: booking.id,
            guestName: booking.guest_name,
            guestEmail: booking.guest_email,
            propertyId: booking.property_id,
            amountNGN: Number(booking.total_price) || 0,
            reference,
        });

        try {
            await sdk.functions.invoke('processReferralReward', { booking_id: booking.id });
        } catch (refErr) {
            console.warn('processReferralReward (webhook path) failed:', refErr);
        }

        return ack({ processed: true, booking_id: booking.id });
    } catch (err) {
        console.error('paystackWebhook error:', err);
        return ack({ error: (err as Error).message });
    }
});
