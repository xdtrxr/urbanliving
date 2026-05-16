import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

Deno.serve(async (req) => {
    console.log('=== TELEGRAM WEBHOOK CALLED ===');

    // Verify the secret token Telegram includes when the webhook was registered
    // with `secret_token=...`. Without this, anyone who knows the URL can forge
    // approve/reject callback queries.
    const expectedSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
    if (expectedSecret) {
        const incomingSecret = req.headers.get('x-telegram-bot-api-secret-token') || '';
        if (incomingSecret !== expectedSecret) {
            console.warn('Telegram webhook secret mismatch — rejecting');
            return new Response(JSON.stringify({ ok: false }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    } else {
        console.warn('TELEGRAM_WEBHOOK_SECRET not configured — webhook is unauthenticated');
    }

    // Base44 supplies the SDK client with service-role access automatically.
    // No BASE44_APP_ID / BASE44_SERVICE_ROLE_KEY env vars needed.
    const base44 = createClientFromRequest(req);

    try {
        const update = await req.json();
        console.log('Telegram update received');

        // Branch 1: admin replied to one of our force_reply prompts.
        // We use [#SM:<id>] embedded in the prompt to know which support
        // message they're editing/replacing.
        if (update.message && update.message.reply_to_message && update.message.text) {
            const prompt = update.message.reply_to_message.text || '';
            const m = prompt.match(/\[#SM:([a-zA-Z0-9_-]+)\]/);
            if (m) {
                return await handleAdminTextReply({
                    base44,
                    supportMessageId: m[1],
                    adminText: update.message.text,
                    chatId: update.message.chat.id,
                    replyToMessageId: update.message.message_id,
                });
            }
        }

        if (!update.callback_query) {
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const callbackQuery = update.callback_query;
        const callbackData = callbackQuery.data || '';
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;

        console.log('Callback data:', callbackData);

        // Branch 2: support draft actions (sup_send / sup_edit / sup_replace)
        const supMatch = callbackData.match(/^sup_(send|edit|replace)_(.+)$/);
        if (supMatch) {
            return await handleSupportCallback({
                base44,
                action: supMatch[1] as 'send' | 'edit' | 'replace',
                supportMessageId: supMatch[2],
                callbackQueryId: callbackQuery.id,
                chatId,
                originalMessageText: callbackQuery.message.text || '',
                originalMessageId: messageId,
            });
        }

        // Branch 3: legacy availability approve/reject
        const [action, requestId] = callbackData.split('_');

        if (!['approve', 'reject'].includes(action) || !requestId) {
            throw new Error('Invalid callback data');
        }

        // Fetch the request via SDK
        const request = await base44.asServiceRole.entities.AvailabilityRequest.get(requestId);
        if (!request) {
            console.error('AvailabilityRequest not found:', requestId);
            await answerCallbackQuery(callbackQuery.id, 'Request not found.');
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (request.status !== 'pending') {
            await answerCallbackQuery(callbackQuery.id, 'This request has already been processed.');
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Update the request status
        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        const adminResponse = action === 'approve'
            ? 'Property is available for your requested dates!'
            : 'Sorry, the property is not available for these dates. Please try different dates or check other properties.';

        await base44.asServiceRole.entities.AvailabilityRequest.update(requestId, {
            status: newStatus,
            admin_response: adminResponse,
        });

        console.log(`✅ Request ${requestId} ${newStatus}`);

        // Find the matching pending Booking. On approve, stamp approved_at so
        // the payment timer can start. On reject, cancel it so it doesn't
        // linger in pending forever.
        try {
            const matches = await base44.asServiceRole.entities.Booking.filter({
                property_id: request.property_id,
                check_in: request.check_in,
                check_out: request.check_out,
                guest_email: request.user_email,
                status: 'pending',
            });
            const target = Array.isArray(matches) ? matches[0] : null;
            if (target?.id) {
                const update = action === 'approve'
                    ? { approved_at: new Date().toISOString() }
                    : { status: 'cancelled' };
                await base44.asServiceRole.entities.Booking.update(target.id, update);
                console.log(`✅ Booking ${target.id} updated for ${action}: ${JSON.stringify(update)}`);
            } else {
                console.warn(`⚠️ No matching pending booking found for ${action}`);
            }
        } catch (stampError) {
            console.error(`❌ Error updating booking on ${action}:`, stampError);
        }

        // Update Telegram message in place
        const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
        const statusEmoji = action === 'approve' ? '✅' : '❌';
        const statusText = action === 'approve' ? 'APPROVED' : 'REJECTED';

        const updatedMessage = `${statusEmoji} ${statusText}\n\n${callbackQuery.message.text || ''}\n\nStatus: ${statusText} by admin`;

        await fetch(`https://api.telegram.org/bot${telegramBotToken}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text: updatedMessage,
            }),
        });

        await answerCallbackQuery(callbackQuery.id, `Request ${statusText.toLowerCase()} successfully!`);

        // Email the guest about the decision
        try {
            await emailGuestDecision({
                base44,
                guestEmail: request.user_email,
                guestName: request.user_name,
                propertyTitle: request.property_title,
                checkIn: request.check_in,
                checkOut: request.check_out,
                action,
            });
        } catch (emailErr) {
            console.error('Failed to email guest about decision:', emailErr);
        }

        return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('=== TELEGRAM WEBHOOK ERROR ===', error);
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
});

interface GuestDecisionParams {
    base44: any;
    guestEmail: string;
    guestName: string;
    propertyTitle: string;
    checkIn: string;
    checkOut: string;
    action: 'approve' | 'reject';
}

async function emailGuestDecision(p: GuestDecisionParams) {
    if (!p.guestEmail) {
        console.warn('No guest email — skipping decision notification');
        return;
    }

    const subject = p.action === 'approve'
        ? `Approved: your booking for ${p.propertyTitle}`
        : `Update on your booking request for ${p.propertyTitle}`;

    const body = p.action === 'approve'
        ? `Hi ${p.guestName || 'there'},\n\n` +
          `Great news — your availability request for "${p.propertyTitle}" (${p.checkIn} → ${p.checkOut}) has been approved.\n\n` +
          `You have 1 hour to complete payment from when you open the payment page (and a 3-hour hard cap from this approval). After that the booking will be automatically cancelled.\n\n` +
          `Open Bookings to proceed: head to the app and click "Proceed to Payment" on this booking.\n\n` +
          `— Urban Stays`
        : `Hi ${p.guestName || 'there'},\n\n` +
          `Unfortunately, "${p.propertyTitle}" is not available for ${p.checkIn} → ${p.checkOut}.\n\n` +
          `Please try different dates or browse other properties in the app.\n\n` +
          `— Urban Stays`;

    await p.base44.integrations.Core.SendEmail({
        to: p.guestEmail,
        subject,
        body,
        from_name: 'Urban Stays',
    });
    console.log(`✅ Guest decision email sent to ${p.guestEmail}`);
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
    const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    await fetch(`https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: text,
        }),
    });
}

// === Support draft handling ===
// User posts in a SupportTicket → draftSupportReply pushes a Nova draft to
// admin Telegram with three inline buttons. The button taps are routed here.

interface SupportCallbackParams {
    base44: any;
    action: 'send' | 'edit' | 'replace';
    supportMessageId: string;
    callbackQueryId: string;
    chatId: number;
    originalMessageText: string;
    originalMessageId: number;
}

async function handleSupportCallback(p: SupportCallbackParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    const userMessage = await p.base44.asServiceRole.entities.SupportMessage.get(p.supportMessageId);
    if (!userMessage) {
        await answerCallbackQuery(p.callbackQueryId, 'Message not found.');
        return jsonResp({ ok: true });
    }
    if (userMessage.nova_draft_status && userMessage.nova_draft_status !== 'pending') {
        await answerCallbackQuery(p.callbackQueryId, 'Already actioned.');
        return jsonResp({ ok: true });
    }

    if (p.action === 'send') {
        const draft = userMessage.nova_draft || '';
        if (!draft) {
            await answerCallbackQuery(p.callbackQueryId, 'No draft to send.');
            return jsonResp({ ok: true });
        }
        await postAdminReply(p.base44, userMessage.ticket_id, draft);
        await p.base44.asServiceRole.entities.SupportMessage.update(p.supportMessageId, {
            nova_draft_status: 'sent_as_is',
        });
        await editTelegramMessage(token, p.chatId, p.originalMessageId,
            `✅ *SENT — Nova draft used as-is*\n\n${p.originalMessageText}`);
        await answerCallbackQuery(p.callbackQueryId, 'Sent to user.');
        return jsonResp({ ok: true });
    }

    // edit or replace — both ask the admin to reply with the final text.
    const prompt = p.action === 'edit'
        ? `✏️ *Edit the draft below — your reply replaces Nova's text and goes to the user.*\n\n*Current draft:*\n${userMessage.nova_draft || '(empty)'}\n\n[#SM:${p.supportMessageId}]`
        : `🔁 *Type a fresh reply — Nova's draft will be discarded.*\n\n*User asked:*\n${userMessage.message.slice(0, 400)}\n\n[#SM:${p.supportMessageId}]`;

    await sendTelegramMessage(token, p.chatId, prompt, { force_reply: true, selective: false });
    await answerCallbackQuery(p.callbackQueryId, p.action === 'edit' ? 'Reply to edit.' : 'Reply with new text.');
    return jsonResp({ ok: true });
}

interface AdminReplyParams {
    base44: any;
    supportMessageId: string;
    adminText: string;
    chatId: number;
    replyToMessageId: number;
}

async function handleAdminTextReply(p: AdminReplyParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    const userMessage = await p.base44.asServiceRole.entities.SupportMessage.get(p.supportMessageId);
    if (!userMessage) {
        await sendTelegramMessage(token, p.chatId, '⚠️ Could not find that support message.', {});
        return jsonResp({ ok: true });
    }
    if (userMessage.nova_draft_status && userMessage.nova_draft_status !== 'pending') {
        await sendTelegramMessage(token, p.chatId, '⚠️ This message has already been actioned.', {});
        return jsonResp({ ok: true });
    }

    const reply = (p.adminText || '').trim();
    if (!reply) return jsonResp({ ok: true });

    // Was this admin replying to an edit prompt or a replace prompt? We can
    // tell from the prompt prefix, but the outcome is the same operationally:
    // their text becomes the response. We mark 'edited' vs 'replaced' based
    // on whether they kept any of the original draft text.
    const looksLikeEdit = userMessage.nova_draft && reply.includes(userMessage.nova_draft.slice(0, 30));
    await postAdminReply(p.base44, userMessage.ticket_id, reply);
    await p.base44.asServiceRole.entities.SupportMessage.update(p.supportMessageId, {
        nova_draft_status: looksLikeEdit ? 'edited' : 'replaced',
    });
    await sendTelegramMessage(token, p.chatId,
        `✅ Reply sent to user (${looksLikeEdit ? 'edited' : 'replaced'} Nova draft).`, {});
    return jsonResp({ ok: true });
}

async function postAdminReply(base44: any, ticketId: string, message: string) {
    // Persist as a human_agent SupportMessage so the user sees it in their
    // ticket view. Also bump the ticket from 'open' to 'in_progress' if
    // it was the first admin response.
    await base44.asServiceRole.entities.SupportMessage.create({
        ticket_id: ticketId,
        sender_type: 'human_agent',
        message,
        message_type: 'text',
        automated_response: false,
    });
    try {
        const ticket = await base44.asServiceRole.entities.SupportTicket.get(ticketId);
        if (ticket && ticket.status === 'open') {
            await base44.asServiceRole.entities.SupportTicket.update(ticketId, { status: 'in_progress' });
        }
    } catch (e) {
        console.warn('Failed to bump ticket status:', (e as Error).message);
    }
}

async function sendTelegramMessage(token: string | undefined, chatId: number, text: string, replyMarkup: Record<string, unknown>) {
    if (!token) return;
    const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'Markdown' };
    if (replyMarkup && Object.keys(replyMarkup).length > 0) {
        payload.reply_markup = replyMarkup;
    }
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (e) {
        console.error('sendTelegramMessage failed:', e);
    }
}

async function editTelegramMessage(token: string | undefined, chatId: number, messageId: number, text: string) {
    if (!token) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' }),
        });
    } catch (e) {
        console.error('editTelegramMessage failed:', e);
    }
}
