import { createClient } from 'npm:@base44/sdk@0.7.1';

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

    try {
        const update = await req.json();
        console.log('Telegram update:', JSON.stringify(update, null, 2));

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

        // Use the API key directly with fetch
        const appId = Deno.env.get('BASE44_APP_ID');
        const apiKey = Deno.env.get('BASE44_SERVICE_ROLE_KEY');
        const baseUrl = `https://app.base44.com/api/apps/${appId}`;

        console.log('📡 Making direct API call to update request...');

        // Get the request first
        const getResponse = await fetch(`${baseUrl}/entities/AvailabilityRequest/${requestId}`, {
            method: 'GET',
            headers: {
                'api_key': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!getResponse.ok) {
            const errorText = await getResponse.text();
            console.error('❌ Failed to fetch request:', getResponse.status, errorText);
            throw new Error(`Failed to fetch request: ${getResponse.status}`);
        }

        const request = await getResponse.json();
        console.log('✅ Request fetched:', request);

        if (request.status !== 'pending') {
            await answerCallbackQuery(callbackQuery.id, 'This request has already been processed.');
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Update the request
        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        const adminResponse = action === 'approve' 
            ? 'Property is available for your requested dates!' 
            : 'Sorry, the property is not available for these dates. Please try different dates or check other properties.';

        const updateResponse = await fetch(`${baseUrl}/entities/AvailabilityRequest/${requestId}`, {
            method: 'PUT',
            headers: {
                'api_key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                status: newStatus,
                admin_response: adminResponse
            })
        });

        if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            console.error('❌ Failed to update request:', updateResponse.status, errorText);
            throw new Error(`Failed to update request: ${updateResponse.status}`);
        }

        console.log(`✅ Request ${requestId} ${newStatus}`);

        // Find the matching pending Booking. On approve, stamp approved_at so
        // the payment timer can start. On reject, cancel it so it doesn't
        // linger in pending forever.
        try {
            const matchQuery = new URLSearchParams({
                property_id: request.property_id,
                check_in: request.check_in,
                check_out: request.check_out,
                guest_email: request.user_email,
                status: 'pending',
            }).toString();
            const bookingsRes = await fetch(`${baseUrl}/entities/Booking?${matchQuery}`, {
                method: 'GET',
                headers: { 'api_key': apiKey, 'Content-Type': 'application/json' },
            });
            if (bookingsRes.ok) {
                const matches = await bookingsRes.json();
                const target = Array.isArray(matches) ? matches[0] : null;
                if (target?.id) {
                    const update = action === 'approve'
                        ? { approved_at: new Date().toISOString() }
                        : { status: 'cancelled' };
                    const stampRes = await fetch(`${baseUrl}/entities/Booking/${target.id}`, {
                        method: 'PUT',
                        headers: { 'api_key': apiKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify(update),
                    });
                    if (stampRes.ok) {
                        console.log(`✅ Booking ${target.id} updated for ${action}: ${JSON.stringify(update)}`);
                    } else {
                        console.warn(`⚠️ Failed to update booking on ${action}:`, stampRes.status, await stampRes.text());
                    }
                } else {
                    console.warn(`⚠️ No matching pending booking found for ${action}`);
                }
            } else {
                console.warn('⚠️ Failed to query bookings:', bookingsRes.status);
            }
        } catch (stampError) {
            console.error(`❌ Error updating booking on ${action}:`, stampError);
            // Don't fail the webhook if booking update fails
        }

        // Update Telegram message
        const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
        const statusEmoji = action === 'approve' ? '✅' : '❌';
        const statusText = action === 'approve' ? 'APPROVED' : 'REJECTED';

        const updatedMessage = `${statusEmoji} ${statusText}

${callbackQuery.message.text}

Status: ${statusText} by admin`;

        await fetch(`https://api.telegram.org/bot${telegramBotToken}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text: updatedMessage
            })
        });

        await answerCallbackQuery(callbackQuery.id, `Request ${statusText.toLowerCase()} successfully!`);

        // Email the guest about the decision
        try {
            await emailGuestDecision({
                guestEmail: request.user_email,
                guestName: request.user_name,
                propertyTitle: request.property_title,
                checkIn: request.check_in,
                checkOut: request.check_out,
                action,
                appId,
                serviceToken: apiKey,
            });
        } catch (emailErr) {
            console.error('Failed to email guest about decision:', emailErr);
        }

        return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('=== TELEGRAM WEBHOOK ERROR ===', error);
        // Always return 200 OK to Telegram, even on errors. Don't echo internal
        // error messages back over the wire.
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
});

interface GuestDecisionParams {
    guestEmail: string;
    guestName: string;
    propertyTitle: string;
    checkIn: string;
    checkOut: string;
    action: 'approve' | 'reject';
    appId: string;
    serviceToken: string;
}

async function emailGuestDecision(p: GuestDecisionParams) {
    if (!p.guestEmail) {
        console.warn('No guest email — skipping decision notification');
        return;
    }
    const sdk = createClient({ appId: p.appId, serviceToken: p.serviceToken, requiresAuth: false });

    const subject = p.action === 'approve'
        ? `Approved: your booking for ${p.propertyTitle}`
        : `Update on your booking request for ${p.propertyTitle}`;

    const body = p.action === 'approve'
        ? `Hi ${p.guestName || 'there'},\n\n` +
          `Great news — your availability request for "${p.propertyTitle}" (${p.checkIn} → ${p.checkOut}) has been approved.\n\n` +
          `You have 1 hour to complete payment from when you open the payment page (and a 3-hour hard cap from this approval). After that the booking will be automatically cancelled.\n\n` +
          `Open Bookings to proceed: head to the app and click "Proceed to Payment" on this booking.\n\n` +
          `— UrbanStays`
        : `Hi ${p.guestName || 'there'},\n\n` +
          `Unfortunately, "${p.propertyTitle}" is not available for ${p.checkIn} → ${p.checkOut}.\n\n` +
          `Please try different dates or browse other properties in the app.\n\n` +
          `— UrbanStays`;

    await sdk.integrations.Core.SendEmail({
        to: p.guestEmail,
        subject,
        body,
        from_name: 'UrbanStays',
    });
    console.log(`✅ Guest decision email sent to ${p.guestEmail}`);
}

async function answerCallbackQuery(callbackQueryId, text) {
    const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    await fetch(`https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: text
        })
    });
}