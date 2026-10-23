import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// Called by verifyPaystackPayment / paystackWebhook after a booking is paid
// but BEFORE the arrival email is sent, when the Property is missing
// host_phone or arrival_instructions.
//
// Posts a Telegram message with force_reply set so admin's text reply is
// captured by telegramWebhook (matched via [#HOST:<bookingId>] in the prompt).
// Stamps booking.host_details_status = 'awaiting_admin' so we know the email
// is paused, and so we don't double-prompt on a retry.
//
// Body: { booking_id: string }

interface Body { booking_id: string; internal_secret?: string }

// ── Caller gate ─────────────────────────────────────────────────────────────
// Invoked by verifyPaystackPayment and paystackWebhook, which carry no admin
// session, so this cannot demand a login. Without a gate anyone with a
// booking id could stamp host_details_status and spam the admin Telegram.
// Internal callers pass INTERNAL_FUNCTION_SECRET; an admin session is also
// accepted. Unset secret → warn and allow, so nothing breaks before it is set.
const INTERNAL_SECRET = Deno.env.get('INTERNAL_FUNCTION_SECRET') || '';

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function internalOrAdmin(sdk: any, body: any): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (!INTERNAL_SECRET) {
        console.warn('INTERNAL_FUNCTION_SECRET not configured — requestHostDetails is accepting unauthenticated calls');
        return { ok: true };
    }
    const presented = typeof body?.internal_secret === 'string' ? body.internal_secret : '';
    if (presented && safeEqual(presented, INTERNAL_SECRET)) return { ok: true };
    try {
        const user = await sdk.auth.me().catch(() => null);
        if (user?.role === 'admin') return { ok: true };
    } catch { /* no session on this request */ }
    return { ok: false, status: 401, error: 'Unauthorized' };
}

// An id goes into the URL of the row it fetches ("../Booking/abc" would fetch
// a row of another entity, and every check that follows would then be made on
// the wrong kind of row), so only a plain id is ever used. Lockstep copy, see
// createWithdrawalRequest.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
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
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), { status: 405, headers });
    }

    try {
        const base44 = createClientFromRequest(req);
        const body = (await req.json().catch(() => ({}))) as Body;
        const bookingId = (body.booking_id || '').toString().trim();
        if (!bookingId) {
            return new Response(JSON.stringify({ success: false, error: 'Missing booking_id' }), { status: 400, headers });
        }

        const gate = await internalOrAdmin(base44, body);
        if (!gate.ok) {
            return new Response(JSON.stringify({ success: false, error: gate.error }), { status: gate.status, headers });
        }

        const booking = isId(bookingId) ? await getOrNull(base44.asServiceRole.entities.Booking, bookingId) : null;
        if (!booking) {
            return new Response(JSON.stringify({ success: false, error: 'Booking not found' }), { status: 404, headers });
        }

        // Idempotency — if we already asked for this booking and admin hasn't
        // answered yet, don't re-spam Telegram.
        if (booking.host_details_status === 'awaiting_admin') {
            return new Response(JSON.stringify({
                success: true,
                data: { skipped: 'already_awaiting' },
            }), { status: 200, headers });
        }

        const property = isId(booking.property_id) ? await getOrNull(base44.asServiceRole.entities.Property, booking.property_id) : null;
        const propertyTitle = property?.title || booking.property_id;
        const missing: string[] = [];
        if (!property?.host_phone) missing.push('host phone');
        if (!property?.arrival_instructions) missing.push('arrival instructions');

        const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
        const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
        if (!token || !chatId) {
            console.warn('Telegram credentials not configured — cannot ask admin for host details');
            return new Response(JSON.stringify({
                success: false,
                error: 'Telegram not configured',
            }), { status: 500, headers });
        }

        const prompt = `🏠 *HOST DETAILS NEEDED — booking paid, email on hold*

*Property:* ${propertyTitle}
*Guest:* ${booking.guest_name || booking.guest_email} (${booking.guest_email})
*Check-in:* ${booking.check_in}

Missing: ${missing.join(' + ') || 'host details'}.

*Reply to this message with:*
• Line 1: host phone (e.g. +234 801 234 5678)
• Line 2+: arrival instructions (gate code, parking, key handover, etc.)

The guest gets their arrival email the moment you reply.

[#HOST:${bookingId}]`;

        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: prompt,
                parse_mode: 'Markdown',
                reply_markup: { force_reply: true, selective: false },
            }),
        });
        const data = await res.json();
        if (!data.ok) {
            console.error('Telegram send error:', data);
            return new Response(JSON.stringify({
                success: false,
                error: 'Telegram API error',
                details: data,
            }), { status: 502, headers });
        }

        await base44.asServiceRole.entities.Booking.update(bookingId, {
            host_details_status: 'awaiting_admin',
        });

        return new Response(JSON.stringify({
            success: true,
            data: { booking_id: bookingId, telegram_message_id: data.result.message_id },
        }), { status: 200, headers });
    } catch (error) {
        console.error('requestHostDetails error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
