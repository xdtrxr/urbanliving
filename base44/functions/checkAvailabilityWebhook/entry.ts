import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ 
            error: 'Method not allowed',
            success: false 
        }), { status: 405, headers });
    }

    try {
        const base44 = createClientFromRequest(req);
        
        // Authenticate user
        const user = await base44.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ 
                error: 'Unauthorized',
                success: false 
            }), { status: 401, headers });
        }

        const body = await req.json();
        const { property_id, property_title, check_in, check_out, guests } = body;

        console.log('=== AVAILABILITY CHECK WEBHOOK TRIGGERED ===');
        console.log('User:', user.email);
        console.log('Property:', property_title);
        console.log('Check-in:', check_in);
        console.log('Check-out:', check_out);
        console.log('Guests:', guests);

        // Validate required fields
        if (!property_id || !check_in || !check_out) {
            return new Response(JSON.stringify({ 
                error: 'Missing required fields: property_id, check_in, check_out',
                success: false 
            }), { status: 400, headers });
        }

        // Check for conflicting bookings
        const existingBookings = await base44.asServiceRole.entities.Booking.filter({
            property_id: property_id,
            status: { $in: ['confirmed', 'pending'] }
        });

        const checkInDate = new Date(check_in);
        const checkOutDate = new Date(check_out);

        let hasConflict = false;
        let conflictingBooking = null;

        for (const booking of existingBookings) {
            const bookingCheckIn = new Date(booking.check_in);
            const bookingCheckOut = new Date(booking.check_out);

            // Check if dates overlap
            if (
                (checkInDate >= bookingCheckIn && checkInDate < bookingCheckOut) ||
                (checkOutDate > bookingCheckIn && checkOutDate <= bookingCheckOut) ||
                (checkInDate <= bookingCheckIn && checkOutDate >= bookingCheckOut)
            ) {
                hasConflict = true;
                conflictingBooking = booking;
                break;
            }
        }

        // Create availability request - IMPORTANT: Use user context, not service role
        const availabilityRequest = await base44.entities.AvailabilityRequest.create({
            property_id,
            property_title,
            user_email: user.email,
            user_name: user.full_name || 'Guest User',
            check_in,
            check_out,
            guests,
            status: 'pending',
            has_conflict: hasConflict,
            conflict_details: hasConflict ? {
                booking_id: conflictingBooking.id,
                check_in: conflictingBooking.check_in,
                check_out: conflictingBooking.check_out,
                guest_email: conflictingBooking.guest_email
            } : null
        });

        console.log('✅ Availability request created:', availabilityRequest.id);
        console.log('✅ Request created_by:', availabilityRequest.created_by);

        // Send Telegram notification to admin (non-blocking)
        try {
            const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
            const adminChatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');

            if (!telegramBotToken || !adminChatId) {
                console.warn('⚠️ Telegram credentials not configured');
            } else {
                const conflictEmoji = hasConflict ? '⚠️' : '✅';
                const conflictText = hasConflict ? 'CONFLICT DETECTED' : 'NO CONFLICTS';

                const message = `${conflictEmoji} *AVAILABILITY CHECK REQUEST*

📍 *Property:* ${property_title}
🆔 *Property ID:* \`${property_id}\`

👤 *Guest Details:*
• Name: ${user.full_name || 'Guest User'}
• Email: ${user.email}
• Guests: ${guests}

📅 *Requested Dates:*
• Check-in: ${check_in}
• Check-out: ${check_out}

${hasConflict ? `
⚠️ *${conflictText}*
• Conflicting Booking: \`${conflictingBooking.id}\`
• Dates: ${conflictingBooking.check_in} to ${conflictingBooking.check_out}
• Guest: ${conflictingBooking.guest_email}
` : `
✅ *${conflictText}*
No existing bookings found for these dates.
`}

*Request ID:* \`${availabilityRequest.id}\`

Please approve or reject this availability request:`;

                const telegramUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
                
                const telegramResponse = await fetch(telegramUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: adminChatId,
                        text: message,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                {
                                    text: '✅ Approve',
                                    callback_data: `approve_${availabilityRequest.id}`
                                },
                                {
                                    text: '❌ Reject',
                                    callback_data: `reject_${availabilityRequest.id}`
                                }
                            ]]
                        }
                    })
                });

                const telegramData = await telegramResponse.json();
                
                if (telegramData.ok) {
                    // Update request with telegram message ID using service role
                    await base44.asServiceRole.entities.AvailabilityRequest.update(availabilityRequest.id, {
                        telegram_message_id: telegramData.result.message_id.toString()
                    });
                    console.log('✅ Telegram notification sent to admin');
                } else {
                    console.error('❌ Telegram API error:', telegramData);
                }
            }
        } catch (telegramError) {
            console.error('❌ Failed to send Telegram notification:', telegramError);
            // Don't fail the whole request if Telegram fails
        }

        // Always return success with request ID
        return new Response(JSON.stringify({ 
            success: true,
            request_id: availabilityRequest.id,
            status: 'pending',
            message: 'Availability check request sent to admin. You will be notified once reviewed.',
            has_conflict: hasConflict
        }), { status: 200, headers });

    } catch (error) {
        console.error('=== AVAILABILITY CHECK ERROR ===', error);
        console.error('Error stack:', error.stack);
        return new Response(JSON.stringify({ 
            error: 'Internal server error',
            details: error.message,
            success: false 
        }), { status: 500, headers });
    }
});