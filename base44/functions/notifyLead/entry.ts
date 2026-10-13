import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// Posts a Telegram alert to admin for a new qualified Lead.
// Body: { lead_id: string }
// The lead must already exist. The function reads it under the service role
// (anon leads have no auth context), formats the message per spec section 13,
// posts to TELEGRAM_ADMIN_CHAT_ID, and stamps the returned message_id back
// on the lead row.

// ── Caller gate ─────────────────────────────────────────────────────────────
// Called from the concierge page right after it creates a Lead, sometimes by
// a visitor with no session, so a login cannot be required. Without a gate
// anyone could re-announce any lead to the admin Telegram indefinitely.
// Accepted callers: internal (INTERNAL_FUNCTION_SECRET), an admin session, or
// anyone for a lead that is under ten minutes old and has never been
// announced — which bounds abuse to one message per genuine lead.
const INTERNAL_SECRET = Deno.env.get('INTERNAL_FUNCTION_SECRET') || '';
const FRESH_LEAD_MS = 10 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function isInternalOrAdmin(sdk: any, body: any): Promise<boolean> {
    const presented = typeof body?.internal_secret === 'string' ? body.internal_secret : '';
    if (INTERNAL_SECRET && presented && safeEqual(presented, INTERNAL_SECRET)) return true;
    try {
        const user = await sdk.auth.me();
        if (user?.role === 'admin') return true;
    } catch { /* no session on this request */ }
    return false;
}

const fmtMoney = (n: number | undefined | null) => {
    if (!n || Number.isNaN(Number(n))) return null;
    return '₦' + Number(n).toLocaleString();
};

async function sendTelegram(opts: {
    leadId: string;
    name: string;
    phone: string;
    email: string;
    city: string;
    area: string;
    checkIn?: string;
    checkOut?: string;
    guests?: number;
    budgetMin?: number;
    budgetMax?: number;
    apartmentType?: string;
    specialRequests?: string;
    source: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) {
        console.warn('Telegram credentials not configured — skipping lead notification');
        return { sent: false, message_id: null as string | null };
    }

    const dates = opts.checkIn && opts.checkOut
        ? `${opts.checkIn} → ${opts.checkOut}`
        : 'Not specified';

    const budget = (() => {
        const min = fmtMoney(opts.budgetMin);
        const max = fmtMoney(opts.budgetMax);
        if (min && max) return `${min} – ${max} / night`;
        if (max) return `Up to ${max} / night`;
        if (min) return `From ${min} / night`;
        return 'Not specified';
    })();

    const specialBlock = opts.specialRequests && opts.specialRequests.trim()
        ? `\n\n📝 *Notes:*\n${opts.specialRequests.trim()}`
        : '';

    const text = `🔔 *NEW LEAD — Qualified*

👤 *Contact*
• Name: ${opts.name}
• Phone: ${opts.phone}
• Email: ${opts.email}

📍 *Looking For*
• City: ${opts.city || 'Not specified'}
• Area: ${opts.area || 'Not specified'}
• Type: ${opts.apartmentType || 'Any'}
• Guests: ${opts.guests ?? 'Not specified'}

📅 *Dates:* ${dates}
💰 *Budget:* ${budget}${specialBlock}

🌐 *Source:* ${opts.source}
*Lead ID:* \`${opts.leadId}\``;

    const payload = {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
    };

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
        console.error('Telegram API error:', data);
        return { sent: false, message_id: null as string | null };
    }
    return { sent: true, message_id: String(data.result.message_id) };
}

// An id goes into the URL of the row it fetches ("../Booking/abc" would fetch
// a row of another entity), so only a plain id is ever used. Lockstep copy,
// see createWithdrawalRequest.
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
        const body = await req.json().catch(() => ({}));
        const leadId = body.lead_id;
        if (!leadId) {
            return new Response(JSON.stringify({ success: false, error: 'Missing lead_id' }), { status: 400, headers });
        }

        // Read under service role — leads created by anon users have no auth context
        const lead = isId(leadId) ? await getOrNull(base44.asServiceRole.entities.Lead, leadId) : null;
        if (!lead) {
            return new Response(JSON.stringify({ success: false, error: 'Lead not found' }), { status: 404, headers });
        }

        // Announce a lead once. A repeat call is a no-op for everyone, and a
        // non-internal, non-admin caller may only trigger the first announce
        // of a lead created in the last few minutes.
        if (lead.telegram_message_id) {
            return new Response(JSON.stringify({
                success: true,
                data: { lead_id: lead.id, telegram_sent: true, skipped: 'already_notified' },
            }), { status: 200, headers });
        }
        if (!(await isInternalOrAdmin(base44, body))) {
            const createdMs = Date.parse(lead.created_date || '');
            const fresh = !Number.isNaN(createdMs) && Date.now() - createdMs < FRESH_LEAD_MS;
            if (!fresh) {
                return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
            }
        }

        const tg = await sendTelegram({
            leadId: lead.id,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            city: lead.city,
            area: lead.area,
            checkIn: lead.check_in,
            checkOut: lead.check_out,
            guests: lead.guests,
            budgetMin: lead.budget_min,
            budgetMax: lead.budget_max,
            apartmentType: lead.apartment_type,
            specialRequests: lead.special_requests,
            source: lead.source || 'chat',
        });

        if (tg.message_id) {
            try {
                await base44.asServiceRole.entities.Lead.update(lead.id, {
                    telegram_message_id: tg.message_id,
                    status: lead.status === 'qualifying' ? 'qualified' : lead.status,
                });
            } catch (updateErr) {
                console.warn('Failed to attach telegram_message_id to lead:', updateErr);
            }
        }

        return new Response(JSON.stringify({
            success: true,
            data: { lead_id: lead.id, telegram_sent: tg.sent },
        }), { status: 200, headers });
    } catch (error) {
        console.error('notifyLead error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
