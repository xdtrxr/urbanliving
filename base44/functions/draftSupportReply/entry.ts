import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// Drafts a reply to a user's support message using Nova, then posts the draft
// to admin Telegram with three inline buttons:
//   ✅ Send draft as-is      → uses Nova's text verbatim as the admin response
//   ✏️ Edit draft            → admin replies-to a force_reply prompt and the
//                              text they type becomes the response
//   🔁 Replace                → same prompt but framed as a from-scratch reply
//
// The Nova draft is stored on the SupportMessage row (nova_draft +
// nova_draft_status='pending') so the Telegram callback handler can later
// stamp the chosen outcome and post the human_agent SupportMessage.
//
// Body: { message_id: string }

interface DraftPayload {
    message_id: string;
}

function escapeMarkdown(s: string) {
    if (!s) return '';
    return s.replace(/([_*`[\]])/g, '\\$1');
}

async function buildNovaDraft(base44: any, ticket: any, history: any[], latestMessage: string) {
    // Compact transcript — keep last ~12 messages to bound token use
    const recent = history.slice(-12).map((m) => {
        const who = m.sender_type === 'user' ? 'User' : (m.sender_type === 'human_agent' ? 'Admin' : 'Nova');
        return `${who}: ${m.message}`;
    }).join('\n');

    const prompt = `You are **Agent Nova**, the AI support assistant for **UrbanStays by HOMESHARES** — verified short-let apartments in Abuja and Lagos, Nigeria.

You are drafting a reply for a human admin to review. The admin will either send your draft as-is, edit it, or replace it. Your draft must be:
- Warm, professional, and concise (2–5 short sentences max)
- In the same language register as the user (English, Pidgin, or mixed)
- Specific to the user's actual question — never generic "we'll get back to you"
- Honest about what you don't know — if the answer requires admin action (refund, schedule change, custom request), say "I've passed this to our team and they'll [specific action] within [timeframe]"
- Never invent policy, prices, or property availability
- Never share other users' data
- Don't sign off with a name — admin will do that

## TICKET CONTEXT
Subject: ${ticket.subject || '(no subject)'}
Category: ${ticket.category || 'general'}
Priority: ${ticket.priority || 'medium'}
Status: ${ticket.status || 'open'}
Opened by: ${ticket.user_email}

## CONVERSATION SO FAR
${recent || '(this is the opening message)'}

## LATEST USER MESSAGE
"${latestMessage}"

Return ONLY the reply text — no preamble, no JSON, no markdown headers. Just the message body the admin will send.`;

    const result = await base44.integrations.Core.InvokeLLM({
        prompt,
        add_context_from_internet: false,
    });
    return (typeof result === 'string' ? result : String(result || '')).trim();
}

async function sendDraftToAdminTelegram(opts: {
    ticket: any;
    userMessage: string;
    draft: string;
    messageId: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) {
        console.warn('Telegram credentials not configured — skipping support draft notification');
        return { sent: false, message_id: null as string | null };
    }

    const text = `🆘 *SUPPORT — Nova drafted a reply*

📋 *Ticket:* ${escapeMarkdown(opts.ticket.subject || '(no subject)')}
🏷 *Category:* ${opts.ticket.category || 'general'} · *Priority:* ${opts.ticket.priority || 'medium'}
👤 *From:* ${opts.ticket.user_email}

💬 *User said:*
${escapeMarkdown(opts.userMessage.slice(0, 600))}${opts.userMessage.length > 600 ? '…' : ''}

🤖 *Nova draft:*
${escapeMarkdown(opts.draft.slice(0, 900))}${opts.draft.length > 900 ? '…' : ''}

_Tap a button below. Edit / Replace will prompt you to type the final reply._

*Msg ID:* \`${opts.messageId}\``;

    const replyMarkup = {
        inline_keyboard: [[
            { text: '✅ Send draft', callback_data: `sup_send_${opts.messageId}` },
            { text: '✏️ Edit', callback_data: `sup_edit_${opts.messageId}` },
            { text: '🔁 Replace', callback_data: `sup_replace_${opts.messageId}` },
        ]],
    };

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup,
        }),
    });
    const data = await res.json();
    if (!data.ok) {
        console.error('Telegram send error:', data);
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
        const user = await base44.auth.me().catch(() => null);
        if (!user) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
        }

        const body = (await req.json().catch(() => ({}))) as DraftPayload;
        const messageId = body.message_id;
        if (!messageId) {
            return new Response(JSON.stringify({ success: false, error: 'Missing message_id' }), { status: 400, headers });
        }

        // Read under service role — caller may be the user who just posted; we
        // need full ticket + sibling messages regardless.
        const message = isId(messageId) ? await getOrNull(base44.asServiceRole.entities.SupportMessage, messageId) : null;
        if (!message) {
            return new Response(JSON.stringify({ success: false, error: 'Message not found' }), { status: 404, headers });
        }
        if (message.sender_type !== 'user') {
            return new Response(JSON.stringify({ success: false, error: 'Only user messages get drafted replies' }), { status: 400, headers });
        }

        const ticket = isId(message.ticket_id) ? await getOrNull(base44.asServiceRole.entities.SupportTicket, message.ticket_id) : null;
        if (!ticket) {
            return new Response(JSON.stringify({ success: false, error: 'Ticket not found' }), { status: 404, headers });
        }
        // Caller must own the ticket OR be an admin. Stops spamming admin
        // Telegram with drafts for other people's tickets.
        const isAdmin = user.role === 'admin';
        if (!isAdmin && ticket.user_email !== user.email) {
            return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403, headers });
        }

        const history = await base44.asServiceRole.entities.SupportMessage.filter(
            { ticket_id: message.ticket_id },
            'created_date',
        );

        let draft = '';
        try {
            draft = await buildNovaDraft(base44, ticket, history, message.message);
        } catch (llmErr) {
            console.error('Nova draft failed:', llmErr);
            draft = "Thanks for reaching out — I've passed this to our team and someone will follow up shortly.";
        }
        if (!draft || draft.length < 5) {
            draft = "Thanks for reaching out — I've passed this to our team and someone will follow up shortly.";
        }

        const tg = await sendDraftToAdminTelegram({
            ticket,
            userMessage: message.message,
            draft,
            messageId: message.id,
        });

        try {
            await base44.asServiceRole.entities.SupportMessage.update(message.id, {
                nova_draft: draft,
                nova_draft_status: 'pending',
                telegram_message_id: tg.message_id || undefined,
            });
        } catch (updateErr) {
            console.warn('Failed to stamp draft on SupportMessage:', updateErr);
        }

        return new Response(JSON.stringify({
            success: true,
            data: { message_id: message.id, draft_length: draft.length, telegram_sent: tg.sent },
        }), { status: 200, headers });
    } catch (error) {
        console.error('draftSupportReply error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
