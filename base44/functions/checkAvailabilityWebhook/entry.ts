import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

interface ConflictDetails {
    booking_id: string;
    check_in: string;
    check_out: string;
    guest_email: string;
}

function detectConflict(existing: any[], requestedIn: Date, requestedOut: Date): { hasConflict: boolean; conflicting: any | null } {
    for (const booking of existing) {
        const bookingIn = new Date(booking.check_in);
        const bookingOut = new Date(booking.check_out);
        if (
            (requestedIn >= bookingIn && requestedIn < bookingOut) ||
            (requestedOut > bookingIn && requestedOut <= bookingOut) ||
            (requestedIn <= bookingIn && requestedOut >= bookingOut)
        ) {
            return { hasConflict: true, conflicting: booking };
        }
    }
    return { hasConflict: false, conflicting: null };
}

async function fetchPropertyImage(base44Client: any, propertyId: string): Promise<string | null> {
    try {
        const props = await base44Client.asServiceRole.entities.Property.filter({ id: propertyId });
        const prop = props?.[0];
        return Array.isArray(prop?.images) && prop.images.length > 0 ? prop.images[0] : null;
    } catch (e) {
        console.warn('fetchPropertyImage failed:', (e as Error).message);
        return null;
    }
}

async function sendAdminTelegram(opts: {
    propertyTitle: string;
    propertyId: string;
    propertyLocation: any;
    propertyImageUrl: string | null;
    userName: string;
    userEmail: string;
    userMobile: string;
    guests: number;
    checkIn: string;
    checkOut: string;
    totalPrice: number;
    specialRequests: string;
    hasConflict: boolean;
    conflicting: any | null;
    requestId: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) {
        console.warn('Telegram credentials not configured — skipping admin notification');
        return { sent: false, message_id: null as string | null };
    }

    const conflictEmoji = opts.hasConflict ? '⚠️' : '✅';
    const conflictText = opts.hasConflict ? 'CONFLICT DETECTED' : 'NO CONFLICTS';
    const locationStr = opts.propertyLocation
        ? [opts.propertyLocation.address, opts.propertyLocation.city, opts.propertyLocation.country].filter(Boolean).join(', ')
        : 'Not provided';

    const conflictBlock = opts.hasConflict && opts.conflicting
        ? `\n\n⚠️ *${conflictText}*\n• Conflicting Booking: \`${opts.conflicting.id}\`\n• Dates: ${opts.conflicting.check_in} → ${opts.conflicting.check_out}\n• Guest: ${opts.conflicting.guest_email}`
        : `\n\n✅ *${conflictText}*\nNo overlapping bookings.`;

    const specialRequestsBlock = opts.specialRequests && opts.specialRequests.trim()
        ? `\n\n📝 *Special Requests:*\n${opts.specialRequests.trim()}`
        : '';

    const totalLine = opts.totalPrice > 0
        ? `\n💰 *Total:* ₦${opts.totalPrice.toLocaleString()}`
        : '';

    const text = `${conflictEmoji} *AVAILABILITY CHECK REQUEST*

📍 *Property:* ${opts.propertyTitle}
🆔 *Property ID:* \`${opts.propertyId}\`
📌 *Location:* ${locationStr}

👤 *Guest Details:*
• Name: ${opts.userName}
• Email: ${opts.userEmail}
• Mobile: ${opts.userMobile || 'Not provided'}
• Guests: ${opts.guests}

📅 *Requested Dates:*
• Check-in: ${opts.checkIn}
• Check-out: ${opts.checkOut}${totalLine}${specialRequestsBlock}${conflictBlock}

*Request ID:* \`${opts.requestId}\``;

    const replyMarkup = {
        inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve_${opts.requestId}` },
            { text: '❌ Reject', callback_data: `reject_${opts.requestId}` },
        ]],
    };

    let endpoint: string;
    let payload: Record<string, unknown>;
    if (opts.propertyImageUrl) {
        endpoint = `https://api.telegram.org/bot${token}/sendPhoto`;
        payload = {
            chat_id: chatId,
            photo: opts.propertyImageUrl,
            caption: text,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup,
        };
    } else {
        endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
        payload = {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup,
        };
    }

    const res = await fetch(endpoint, {
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
        const user = await base44.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
        }

        const body = await req.json().catch(() => ({}));
        const {
            property_id,
            property_title,
            property_location,
            check_in,
            check_out,
            guests,
            total_price,
            special_requests,
        } = body;

        if (!property_id || !check_in || !check_out) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Missing required fields: property_id, check_in, check_out',
            }), { status: 400, headers });
        }

        const checkInDate = new Date(check_in);
        const checkOutDate = new Date(check_out);
        if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime())) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid date format' }), { status: 400, headers });
        }
        if (checkOutDate <= checkInDate) {
            return new Response(JSON.stringify({ success: false, error: 'check_out must be after check_in' }), { status: 400, headers });
        }

        // Conflict detection: any existing pending/confirmed booking on the same property whose dates overlap
        const existing = await base44.asServiceRole.entities.Booking.filter({
            property_id,
            status: { $in: ['confirmed', 'pending'] },
        });
        const { hasConflict, conflicting } = detectConflict(existing, checkInDate, checkOutDate);
        const conflictDetails: ConflictDetails | null = hasConflict && conflicting ? {
            booking_id: conflicting.id,
            check_in: conflicting.check_in,
            check_out: conflicting.check_out,
            guest_email: conflicting.guest_email,
        } : null;

        // Create the AvailabilityRequest (under user context — RLS lets the user own it)
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
            conflict_details: conflictDetails,
        });

        // Create the pending Booking (holds the slot + the timer attaches once admin approves)
        const pendingBooking = await base44.entities.Booking.create({
            property_id,
            guest_name: user.full_name || 'Guest User',
            guest_email: user.email,
            check_in,
            check_out,
            guests: guests || 1,
            total_price: total_price || 0,
            special_requests: special_requests || '',
            status: 'pending',
            payment_status: 'unpaid',
        });

        // Notify admin (with property photo if available)
        let telegramMessageId: string | null = null;
        try {
            const propertyImageUrl = await fetchPropertyImage(base44, property_id);
            const tgResult = await sendAdminTelegram({
                propertyTitle: property_title || 'Untitled property',
                propertyId: property_id,
                propertyLocation: property_location,
                propertyImageUrl,
                userName: user.full_name || 'Guest User',
                userEmail: user.email,
                userMobile: user.phone_number || '',
                guests: guests || 1,
                checkIn: check_in,
                checkOut: check_out,
                totalPrice: Number(total_price) || 0,
                specialRequests: special_requests || '',
                hasConflict,
                conflicting,
                requestId: availabilityRequest.id,
            });
            telegramMessageId = tgResult.message_id;
        } catch (tgErr) {
            console.error('Telegram notification failed (non-fatal):', tgErr);
        }

        if (telegramMessageId) {
            try {
                await base44.asServiceRole.entities.AvailabilityRequest.update(availabilityRequest.id, {
                    telegram_message_id: telegramMessageId,
                });
            } catch (updateErr) {
                console.warn('Failed to attach telegram_message_id to request:', updateErr);
            }
        }

        return new Response(JSON.stringify({
            success: true,
            data: {
                request_id: availabilityRequest.id,
                booking_id: pendingBooking.id,
                has_conflict: hasConflict,
                conflict_details: conflictDetails,
                telegram_sent: telegramMessageId !== null,
            },
        }), { status: 200, headers });
    } catch (error) {
        console.error('checkAvailabilityWebhook error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});