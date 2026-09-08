import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// Public origin used in outbound email links. Falls back to the prod domain
// so guest emails always have a working link even if APP_BASE_URL isn't set.
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const bookingLink = (bookingId: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(bookingId)}#booking-${encodeURIComponent(bookingId)}`;
const propertyLink = (propertyId: string) => `${APP_BASE_URL}/Property?id=${encodeURIComponent(propertyId)}`;
const searchLink = () => `${APP_BASE_URL}/Search`;

// Fire-and-forget push helper. Errors are swallowed so a push outage can
// never block the parent flow (approve, reject, support reply). Stable
// `tag` per event means a re-fire replaces the prior on-device notification
// rather than stacking duplicates.
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
        // We embed a [#TAG:<id>] token in the prompt to know what we're being
        // answered about.
        if (update.message && update.message.reply_to_message && update.message.text) {
            const prompt = update.message.reply_to_message.text || '';

            const supMatch = prompt.match(/\[#SM:([a-zA-Z0-9_-]+)\]/);
            if (supMatch) {
                return await handleAdminTextReply({
                    base44,
                    supportMessageId: supMatch[1],
                    adminText: update.message.text,
                    chatId: update.message.chat.id,
                    replyToMessageId: update.message.message_id,
                });
            }

            const hostMatch = prompt.match(/\[#HOST:([a-zA-Z0-9_-]+)\]/);
            if (hostMatch) {
                return await handleAdminHostReply({
                    base44,
                    bookingId: hostMatch[1],
                    adminText: update.message.text,
                    chatId: update.message.chat.id,
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
        const supCbMatch = callbackData.match(/^sup_(send|edit|replace)_(.+)$/);
        if (supCbMatch) {
            return await handleSupportCallback({
                base44,
                action: supCbMatch[1] as 'send' | 'edit' | 'replace',
                supportMessageId: supCbMatch[2],
                callbackQueryId: callbackQuery.id,
                chatId,
                originalMessageText: callbackQuery.message.text || '',
                originalMessageId: messageId,
            });
        }

        // Branch 2b: "set as default" choice after host details were filled
        const hostDefaultMatch = callbackData.match(/^host_default_(yes|no)_(.+)$/);
        if (hostDefaultMatch) {
            return await handleHostDefaultCallback({
                base44,
                choice: hostDefaultMatch[1] as 'yes' | 'no',
                bookingId: hostDefaultMatch[2],
                callbackQueryId: callbackQuery.id,
                chatId,
                originalMessageId: messageId,
                originalMessageText: callbackQuery.message.text || '',
            });
        }

        // Branch 2c: ride approve/reject.
        // MUST sit before the generic split('_') below — that split would
        // read "ride_approve_<id>" as action="ride", and the request would be
        // rejected as invalid callback data.
        const rideMatch = callbackData.match(/^ride_(approve|reject)_(.+)$/);
        if (rideMatch) {
            return await handleRideDecision({
                base44,
                approve: rideMatch[1] === 'approve',
                rideId: rideMatch[2],
                callbackQueryId: callbackQuery.id,
                chatId,
                messageId,
                originalText: callbackQuery.message.text || callbackQuery.message.caption || '',
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
        // linger in pending forever. Hoisted out of the try so we can pass the
        // booking id into the guest email for a deep link back to the booking.
        let matchedBookingId: string | null = null;
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
                matchedBookingId = target.id;
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
                propertyId: request.property_id,
                bookingId: matchedBookingId,
                checkIn: request.check_in,
                checkOut: request.check_out,
                action,
            });
        } catch (emailErr) {
            console.error('Failed to email guest about decision:', emailErr);
        }

        // Push the guest. Deep-link into the specific booking when we found
        // one — falls back to the bookings list if the match lookup missed.
        const pushUrl = matchedBookingId
            ? `/Bookings#booking-${matchedBookingId}`
            : '/Bookings';
        if (action === 'approve') {
            await tryPush(base44, {
                user_email: request.user_email,
                title: '✅ Booking approved',
                body: `"${request.property_title}" is yours for ${request.check_in} → ${request.check_out}. Tap to pay within 1 hour.`,
                url: pushUrl,
                tag: `booking-decision-${matchedBookingId || requestId}`,
            });
        } else {
            await tryPush(base44, {
                user_email: request.user_email,
                title: '❌ Booking declined',
                body: `"${request.property_title}" isn\'t available for those dates. Tap to find another stay.`,
                url: '/Search',
                tag: `booking-decision-${matchedBookingId || requestId}`,
            });
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
    propertyId?: string;
    bookingId?: string | null;
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

    const bookingHref = p.bookingId ? bookingLink(p.bookingId) : `${APP_BASE_URL}/Bookings`;
    const propertyHref = p.propertyId ? propertyLink(p.propertyId) : null;

    const body = p.action === 'approve'
        ? `Hi ${p.guestName || 'there'},\n\n` +
          `Great news — your availability request for "${p.propertyTitle}" (${p.checkIn} → ${p.checkOut}) has been approved.\n\n` +
          `🔖 Status: APPROVED — AWAITING PAYMENT\n` +
          `👉 View & pay: ${bookingHref}\n` +
          (propertyHref ? `🏠 Property page: ${propertyHref}\n` : '') +
          `\nYou have 1 hour to complete payment from when you open the payment page (and a 3-hour hard cap from this approval). After that the booking will be automatically cancelled.\n\n` +
          `— Urban Stays`
        : `Hi ${p.guestName || 'there'},\n\n` +
          `Unfortunately, "${p.propertyTitle}" is not available for ${p.checkIn} → ${p.checkOut}.\n\n` +
          `🔖 Status: CANCELLED\n` +
          `👉 View this booking: ${bookingHref}\n` +
          `🔎 Find another property: ${searchLink()}\n\n` +
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
    let ticketOwnerEmail: string | undefined;
    try {
        const ticket = await base44.asServiceRole.entities.SupportTicket.get(ticketId);
        if (ticket) {
            ticketOwnerEmail = ticket.user_email;
            if (ticket.status === 'open') {
                await base44.asServiceRole.entities.SupportTicket.update(ticketId, { status: 'in_progress' });
            }
        }
    } catch (e) {
        console.warn('Failed to bump ticket status:', (e as Error).message);
    }

    // Push the user — their support thread got a reply. Keep the preview
    // short (push payloads are constrained) and link them straight into
    // Support so they land on the conversation.
    if (ticketOwnerEmail) {
        const preview = message.length > 80 ? `${message.slice(0, 80)}…` : message;
        await tryPush(base44, {
            user_email: ticketOwnerEmail,
            title: '💬 Reply from Urban Stays',
            body: preview,
            url: `/Support?ticket=${encodeURIComponent(ticketId)}`,
            tag: `support-${ticketId}`,
        });
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

// === Host-details fallback handling ===
// requestHostDetails sent admin a force_reply prompt with [#HOST:<bookingId>].
// Admin replies with two-line text (line 1 = phone, line 2+ = arrival
// instructions). We parse, write per-booking overrides, send the arrival
// email, and then ask "Save as default for the property?" with inline buttons.

interface HostReplyParams {
    base44: any;
    bookingId: string;
    adminText: string;
    chatId: number;
}

async function handleAdminHostReply(p: HostReplyParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    const booking = await p.base44.asServiceRole.entities.Booking.get(p.bookingId);
    if (!booking) {
        await sendTelegramMessage(token, p.chatId, '⚠️ Could not find that booking.', {});
        return jsonResp({ ok: true });
    }
    if (booking.host_details_status === 'filled_by_admin' || booking.host_details_status === 'default_saved') {
        await sendTelegramMessage(token, p.chatId, '⚠️ This booking already has host details on file.', {});
        return jsonResp({ ok: true });
    }

    const lines = (p.adminText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return jsonResp({ ok: true });

    const phoneLine = lines[0];
    const instructionsLines = lines.slice(1);
    if (instructionsLines.length === 0) {
        await sendTelegramMessage(token, p.chatId,
            '⚠️ Please reply with TWO sections: phone on line 1, then arrival instructions on the next lines.', {});
        return jsonResp({ ok: true });
    }
    const arrivalInstructions = instructionsLines.join('\n');

    // Persist as per-booking overrides + flag for follow-up step
    await p.base44.asServiceRole.entities.Booking.update(p.bookingId, {
        host_phone_override: phoneLine,
        arrival_instructions_override: arrivalInstructions,
        host_details_status: 'filled_by_admin',
    });

    // Send the arrival email using the new overrides
    let emailOk = false;
    try {
        const fresh = await p.base44.asServiceRole.entities.Booking.get(p.bookingId);
        const result = await sendArrivalEmailFromBooking(p.base44, fresh);
        emailOk = result.sent;
    } catch (err) {
        console.error('sendArrivalEmailFromBooking failed:', err);
    }

    // Ask whether to save as Property default
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: p.chatId,
            text: emailOk
                ? `✅ Arrival email sent to ${booking.guest_email}.\n\nSave these as the property's default so future bookings don't need to ask?`
                : `⚠️ Saved host details, but email send failed. Save these as the property's default?`,
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Save as default', callback_data: `host_default_yes_${p.bookingId}` },
                    { text: '🚫 Just this booking', callback_data: `host_default_no_${p.bookingId}` },
                ]],
            },
        }),
    });

    return jsonResp({ ok: true });
}

interface HostDefaultParams {
    base44: any;
    choice: 'yes' | 'no';
    bookingId: string;
    callbackQueryId: string;
    chatId: number;
    originalMessageId: number;
    originalMessageText: string;
}

async function handleHostDefaultCallback(p: HostDefaultParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    const booking = await p.base44.asServiceRole.entities.Booking.get(p.bookingId);
    if (!booking) {
        await answerCallbackQuery(p.callbackQueryId, 'Booking not found.');
        return jsonResp({ ok: true });
    }
    if (booking.host_details_status === 'default_saved') {
        await answerCallbackQuery(p.callbackQueryId, 'Already saved.');
        return jsonResp({ ok: true });
    }

    if (p.choice === 'yes') {
        try {
            const propertyUpdate: Record<string, unknown> = {};
            if (booking.host_phone_override) propertyUpdate.host_phone = booking.host_phone_override;
            if (booking.host_name_override) propertyUpdate.host_name = booking.host_name_override;
            if (booking.arrival_instructions_override) propertyUpdate.arrival_instructions = booking.arrival_instructions_override;
            if (Object.keys(propertyUpdate).length > 0) {
                await p.base44.asServiceRole.entities.Property.update(booking.property_id, propertyUpdate);
            }
            await p.base44.asServiceRole.entities.Booking.update(p.bookingId, {
                host_details_status: 'default_saved',
            });
            await editTelegramMessage(token, p.chatId, p.originalMessageId,
                `${p.originalMessageText}\n\n✅ Saved as the property's default. Future bookings will use these automatically.`);
            await answerCallbackQuery(p.callbackQueryId, 'Saved as default.');
        } catch (err) {
            console.error('Failed to save Property default:', err);
            await answerCallbackQuery(p.callbackQueryId, 'Save failed.');
        }
    } else {
        await editTelegramMessage(token, p.chatId, p.originalMessageId,
            `${p.originalMessageText}\n\n🚫 Kept for this booking only.`);
        await answerCallbackQuery(p.callbackQueryId, 'Per-booking only.');
    }

    return jsonResp({ ok: true });
}

// Local copy of the email-sender so telegramWebhook is self-contained.
// Mirrors the helper in verifyPaystackPayment / paystackWebhook.
async function sendArrivalEmailFromBooking(sdk: any, booking: any): Promise<{ sent: boolean }> {
    try {
        const property = await sdk.asServiceRole.entities.Property.get(booking.property_id);
        if (!property) return { sent: false };

        const hostPhone = booking.host_phone_override || property.host_phone || '';
        const hostName = booking.host_name_override || property.host_name || '';
        const arrivalInstructions = booking.arrival_instructions_override || property.arrival_instructions || '';
        if (!hostPhone || !arrivalInstructions) return { sent: false };

        const loc = property.location || {};
        const fullAddress = [loc.address, loc.city, loc.country].filter(Boolean).join(', ');
        const mapsLink = loc.coordinates?.lat && loc.coordinates?.lng
            ? `https://www.google.com/maps?q=${loc.coordinates.lat},${loc.coordinates.lng}`
            : (fullAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}` : null);
        const mapsBlock = mapsLink ? `\nMap: ${mapsLink}` : '';

        const body = `Hi ${booking.guest_name || 'there'},

Payment confirmed — your booking at "${property.title}" is locked in. 🎉

🔖 Status: CONFIRMED & PAID
👉 View your booking: ${bookingLink(booking.id)}
🏠 Property page: ${propertyLink(booking.property_id)}

📍 Address: ${fullAddress || 'See app for details'}${mapsBlock}
🗓 Check-in: ${booking.check_in}
🗓 Check-out: ${booking.check_out}
👥 Guests: ${Number(booking.guests) || 1}

📞 Call your host on arrival: ${hostName || 'Host'} — ${hostPhone}

Arrival instructions from the host:
${arrivalInstructions}

Have a smooth trip — see you soon.

— Urban Stays`;

        await sdk.integrations.Core.SendEmail({
            to: booking.guest_email,
            subject: `You're checked in: arrival details for ${property.title}`,
            body,
            from_name: 'Urban Stays',
        });
        return { sent: true };
    } catch (err) {
        console.error('sendArrivalEmailFromBooking failed:', err);
        return { sent: false };
    }
}


// === Ride decision handling ===
// Twin of base44/functions/decideRideBooking/entry.ts, which serves the
// in-app Admin panel. Base44 function dirs are isolated and cannot share a
// module, so the transition is duplicated. KEEP THE TWO IN LOCKSTEP —
// the equivalent apartment pair has already drifted.
//
// Unlike the apartment flow there is no AvailabilityRequest: the decision
// lands on the RideBooking row and `approved_at` is the idempotency guard.
//
// ONE DELIBERATE DIVERGENCE, so it does not read as drift: decideRideBooking
// can confirm a ride at a price different from the guest's estimate, and can
// attach alternative vehicles to a rejection. This path can do neither — an
// inline keyboard has nowhere to type a figure or pick a car. Approving here
// therefore always accepts the estimate as-is, which the admin Telegram
// message says out loud. Price changes and alternatives are Admin-panel only.

interface RideDecisionParams {
    base44: any;
    approve: boolean;
    rideId: string;
    callbackQueryId: string;
    chatId: number;
    messageId: number;
    originalText: string;
}

async function handleRideDecision(p: RideDecisionParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
    });

    const RIDE_PAYMENT_WINDOW_MS = 60 * 60 * 1000;
    const APPROVE_MSG = 'Your ride is confirmed as available — complete payment to lock it in.';
    const REJECT_MSG = 'Sorry, this vehicle is not available for that window. Please try a different time or another vehicle.';

    const ride = await p.base44.asServiceRole.entities.RideBooking.get(p.rideId);
    if (!ride) {
        await answerCallbackQuery(p.callbackQueryId, 'Ride not found.');
        return jsonResp({ ok: true });
    }
    if (ride.status !== 'pending' || ride.approved_at) {
        await answerCallbackQuery(p.callbackQueryId, 'This ride has already been actioned.');
        return jsonResp({ ok: true });
    }

    const nowIso = new Date().toISOString();
    await p.base44.asServiceRole.entities.RideBooking.update(p.rideId, p.approve
        ? {
            approved_at: nowIso,
            payment_deadline: new Date(Date.now() + RIDE_PAYMENT_WINDOW_MS).toISOString(),
            admin_response: APPROVE_MSG,
        }
        : {
            status: 'cancelled',
            cancel_reason: 'admin_rejected',
            admin_response: REJECT_MSG,
        });

    const banner = p.approve ? '✅ *APPROVED*' : '❌ *REJECTED*';
    // The ride card is usually sent as a photo, so its text lives in a
    // caption and editMessageText will fail. Try text, then caption.
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: p.chatId, message_id: p.messageId,
                text: `${banner}\n\n${p.originalText}`, parse_mode: 'Markdown',
            }),
        });
        const data = await res.json();
        if (!data.ok) {
            await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: p.chatId, message_id: p.messageId,
                    caption: `${banner}\n\n${p.originalText}`, parse_mode: 'Markdown',
                }),
            });
        }
    } catch (err) {
        console.warn('Ride card edit failed (non-fatal):', err);
    }

    await answerCallbackQuery(p.callbackQueryId, p.approve ? 'Ride approved.' : 'Ride rejected.');

    // Guest email
    try {
        const when = new Date(ride.start_at).toLocaleString('en-GB', {
            timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short',
        });
        const body = p.approve
            ? `Hi ${ride.guest_name || 'there'},\n\n` +
              `Good news — ${ride.vehicle_name} is available for your ride.\n\n` +
              `🔖 Status: APPROVED — AWAITING PAYMENT\n` +
              `🚗 Vehicle: ${ride.vehicle_name}\n` +
              `🕒 Pickup: ${when}\n` +
              `💰 Total: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n` +
              (ride.extra_hour_rate_ngn
                  ? `⏱ Extra time: ₦${Number(ride.extra_hour_rate_ngn).toLocaleString()} per hour beyond your booking, settled after the trip\n`
                  : '') +
              `\n👉 Pay now: ${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(ride.id)}#ride-${encodeURIComponent(ride.id)}\n\n` +
              `You have 1 hour from opening the payment page to complete payment (3-hour cap from this approval), after which the booking is released.\n\n` +
              `— Urban Stays`
            : `Hi ${ride.guest_name || 'there'},\n\n` +
              `Unfortunately ${ride.vehicle_name} isn't available for ${when}.\n\n` +
              `🔖 Status: CANCELLED\n` +
              `🔎 Browse other vehicles: ${APP_BASE_URL}/PlanTrip\n\n` +
              `— Urban Stays`;
        await p.base44.integrations.Core.SendEmail({
            to: ride.guest_email,
            subject: p.approve
                ? `Approved: your ride in the ${ride.vehicle_name}`
                : 'Update on your ride request',
            body,
            from_name: 'Urban Stays',
        });
    } catch (err) {
        console.warn('Ride decision email failed (non-fatal):', err);
    }

    await tryPush(p.base44, {
        user_email: ride.guest_email,
        title: p.approve ? '✅ Ride approved' : '❌ Ride unavailable',
        body: p.approve
            ? `${ride.vehicle_name} is held for you — tap to pay and lock it in.`
            : `${ride.vehicle_name} isn't free for that window. Tap to try another.`,
        url: p.approve ? `/Bookings#ride-${ride.id}` : '/PlanTrip',
        tag: `ride-decision-${ride.id}`,
    });

    return jsonResp({ ok: true });
}
