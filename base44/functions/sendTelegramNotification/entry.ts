import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Verify user is authenticated
        try {
            await base44.auth.me();
        } catch (authError) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const {
            request_id,
            property_title,
            property_id,
            property_location,
            user_name,
            user_email,
            user_mobile,
            check_in,
            check_out,
            guests,
            has_conflict
        } = body;

        const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
        const adminChatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');

        if (!telegramBotToken || !adminChatId) {
            console.warn('Telegram credentials not configured');
            return Response.json({ 
                success: true,
                message: 'Notification skipped - Telegram not configured'
            });
        }

        // Fetch property to get photo
        const appId = Deno.env.get('BASE44_APP_ID');
        const apiKey = Deno.env.get('BASE44_SERVICE_ROLE_KEY');
        let propertyImageUrl = null;
        try {
            const propRes = await fetch(`https://app.base44.com/api/apps/${appId}/entities/Property/${property_id}`, {
                headers: { 'api_key': apiKey, 'Content-Type': 'application/json' }
            });
            if (propRes.ok) {
                const prop = await propRes.json();
                if (prop.images && prop.images.length > 0) {
                    propertyImageUrl = prop.images[0];
                }
            }
        } catch (e) {
            console.warn('Could not fetch property image:', e.message);
        }

        const conflictEmoji = has_conflict ? '⚠️' : '✅';
        const conflictText = has_conflict ? 'CONFLICT DETECTED' : 'NO CONFLICTS';

        const locationStr = property_location
            ? [property_location.address, property_location.city, property_location.country].filter(Boolean).join(', ')
            : 'Not provided';

        const message = `${conflictEmoji} AVAILABILITY CHECK REQUEST

📍 Property: ${property_title}
🆔 Property ID: ${property_id}
📌 Location: ${locationStr}

👤 Guest Details:
• Name: ${user_name}
• Email: ${user_email}
• Mobile: ${user_mobile || 'Not provided'}
• Guests: ${guests}

📅 Requested Dates:
• Check-in: ${check_in}
• Check-out: ${check_out}

${conflictText}

Request ID: ${request_id}`;

        const replyMarkup = {
            inline_keyboard: [[
                { text: '✅ Approve', callback_data: `approve_${request_id}` },
                { text: '❌ Reject', callback_data: `reject_${request_id}` }
            ]]
        };

        let telegramEndpoint, telegramBody;
        if (propertyImageUrl) {
            telegramEndpoint = `https://api.telegram.org/bot${telegramBotToken}/sendPhoto`;
            telegramBody = {
                chat_id: adminChatId,
                photo: propertyImageUrl,
                caption: message,
                reply_markup: replyMarkup
            };
        } else {
            telegramEndpoint = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
            telegramBody = {
                chat_id: adminChatId,
                text: message,
                reply_markup: replyMarkup
            };
        }

        const telegramUrl = telegramEndpoint;
        const telegramResponse = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(telegramBody)
        });

        const telegramData = await telegramResponse.json();
        
        if (telegramData.ok) {
            console.log('✅ Telegram notification sent to admin');
            return Response.json({ 
                success: true,
                message: 'Admin notified via Telegram'
            });
        } else {
            console.error('Telegram API error:', telegramData);
            return Response.json({ 
                success: false,
                error: 'Failed to send Telegram notification'
            });
        }

    } catch (error) {
        console.error('Error sending notification:', error);
        return Response.json({ 
            error: error.message 
        }, { status: 500 });
    }
});