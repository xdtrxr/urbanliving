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

        if (!update.callback_query) {
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const callbackQuery = update.callback_query;
        const callbackData = callbackQuery.data;
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;

        console.log('Callback data:', callbackData);

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
