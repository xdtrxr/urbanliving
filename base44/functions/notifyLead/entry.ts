import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// Posts a Telegram alert to admin for a new qualified Lead.
// Body: { lead_id: string }
// The lead must already exist. The function reads it under the service role
// (anon leads have no auth context), formats the message per spec section 13,
// posts to TELEGRAM_ADMIN_CHAT_ID, and stamps the returned message_id back
// on the lead row.

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
        const lead = await base44.asServiceRole.entities.Lead.get(leadId);
        if (!lead) {
            return new Response(JSON.stringify({ success: false, error: 'Lead not found' }), { status: 404, headers });
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
