import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// Public origin used in outbound email links. Falls back to the prod domain
// so guest emails always have a working link even if APP_BASE_URL isn't set.
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const bookingLink = (bookingId: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(bookingId)}#booking-${encodeURIComponent(bookingId)}`;
const propertyLink = (propertyId: string) => `${APP_BASE_URL}/Property?id=${encodeURIComponent(propertyId)}`;
const searchLink = () => `${APP_BASE_URL}/Search`;

async function emailGuestDecision(opts: {
    sdk: any;
    guestEmail: string;
    guestName: string;
    propertyTitle: string;
    propertyId?: string;
    bookingId?: string | null;
    checkIn: string;
    checkOut: string;
    action: 'approve' | 'reject';
}) {
    if (!opts.guestEmail) return;
    const subject = opts.action === 'approve'
        ? `Approved: your booking for ${opts.propertyTitle}`
        : `Update on your booking request for ${opts.propertyTitle}`;

    const bookingHref = opts.bookingId ? bookingLink(opts.bookingId) : `${APP_BASE_URL}/Bookings`;
    const propertyHref = opts.propertyId ? propertyLink(opts.propertyId) : null;

    const body = opts.action === 'approve'
        ? `Hi ${opts.guestName || 'there'},\n\n` +
          `Great news — your availability request for "${opts.propertyTitle}" (${opts.checkIn} → ${opts.checkOut}) has been approved.\n\n` +
          `🔖 Status: APPROVED — AWAITING PAYMENT\n` +
          `👉 View & pay: ${bookingHref}\n` +
          (propertyHref ? `🏠 Property page: ${propertyHref}\n` : '') +
          `\nYou have 1 hour to complete payment from when you open the payment page (and a 3-hour hard cap from this approval). After that the booking will be automatically cancelled.\n\n` +
          `— UrbanStays`
        : `Hi ${opts.guestName || 'there'},\n\n` +
          `Unfortunately, "${opts.propertyTitle}" is not available for ${opts.checkIn} → ${opts.checkOut}.\n\n` +
          `🔖 Status: CANCELLED\n` +
          `👉 View this booking: ${bookingHref}\n` +
          `🔎 Find another property: ${searchLink()}\n\n` +
          `— UrbanStays`;
    try {
        await opts.sdk.integrations.Core.SendEmail({
            to: opts.guestEmail,
            subject,
            body,
            from_name: 'UrbanStays',
        });
    } catch (err) {
        console.error('Failed to email guest about decision:', err);
    }
}

async function editTelegramMessage(messageId: string | null, action: 'approve' | 'reject', originalText: string | null) {
    if (!messageId) return;
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const statusEmoji = action === 'approve' ? '✅' : '❌';
    const statusText = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const newText = `${statusEmoji} ${statusText} (in-app)\n\n${originalText || ''}\n\nDecided in-app by admin`;
    try {
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: Number(messageId),
                text: newText,
            }),
        });
    } catch (err) {
        // Photo messages can't use editMessageText — fall back to editMessageCaption
        console.warn('editMessageText failed (likely a photo message):', err);
        try {
            await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: Number(messageId),
                    caption: newText,
                }),
            });
        } catch (err2) {
            console.warn('editMessageCaption also failed:', err2);
        }
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
        const user = await base44.auth.me();
        if (!user) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
        }
        if (user.role !== 'admin') {
            return new Response(JSON.stringify({ success: false, error: 'Admin role required' }), { status: 403, headers });
        }

        const body = await req.json().catch(() => ({}));
        const requestId = (body.request_id || '').toString().trim();
        const action: 'approve' | 'reject' = body.action === 'reject' ? 'reject' : 'approve';
        if (!requestId) {
            return new Response(JSON.stringify({ success: false, error: 'request_id is required' }), { status: 400, headers });
        }

        const request = await base44.asServiceRole.entities.AvailabilityRequest.get(requestId);
        if (!request) {
            return new Response(JSON.stringify({ success: false, error: 'Request not found' }), { status: 404, headers });
        }
        if (request.status !== 'pending') {
            return new Response(JSON.stringify({
                success: false,
                error: `Request already ${request.status}`,
            }), { status: 409, headers });
        }

        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        const adminResponse = action === 'approve'
            ? 'Property is available for your requested dates!'
            : 'Sorry, the property is not available for these dates. Please try different dates or check other properties.';

        await base44.asServiceRole.entities.AvailabilityRequest.update(requestId, {
            status: newStatus,
            admin_response: adminResponse,
        });

        // Find the matching pending Booking. On approve: stamp approved_at so
        // the payment timer can start. On reject: cancel it so it doesn't
        // linger in pending forever. matchedBookingId is hoisted so the guest
        // email can deep-link straight to it.
        let matchedBookingId: string | null = null;
        try {
            const matches = await base44.asServiceRole.entities.Booking.filter({
                property_id: request.property_id,
                check_in: request.check_in,
                check_out: request.check_out,
                guest_email: request.user_email,
                status: 'pending',
            });
            const target = matches[0];
            if (target?.id) {
                matchedBookingId = target.id;
                const update = action === 'approve'
                    ? { approved_at: new Date().toISOString() }
                    : { status: 'cancelled' };
                await base44.asServiceRole.entities.Booking.update(target.id, update);
            }
        } catch (updateErr) {
            console.error(`Booking ${action} update failed:`, updateErr);
        }

        // Edit the Telegram message in-place so admin sees the in-app decision
        await editTelegramMessage(
            request.telegram_message_id || null,
            action,
            null,
        );

        // Email the guest
        await emailGuestDecision({
            sdk: base44,
            guestEmail: request.user_email,
            guestName: request.user_name,
            propertyTitle: request.property_title,
            propertyId: request.property_id,
            bookingId: matchedBookingId,
            checkIn: request.check_in,
            checkOut: request.check_out,
            action,
        });

        return new Response(JSON.stringify({
            success: true,
            data: { request_id: requestId, status: newStatus },
        }), { status: 200, headers });
    } catch (error) {
        console.error('decideAvailabilityRequest error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
