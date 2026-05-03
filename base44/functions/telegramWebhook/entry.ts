import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
    console.log('=== TELEGRAM WEBHOOK CALLED ===');

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

        return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('=== TELEGRAM WEBHOOK ERROR ===', error);
        // Always return 200 OK to Telegram, even on errors
        return new Response(JSON.stringify({ 
            ok: true,
            error: error.message 
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
});

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