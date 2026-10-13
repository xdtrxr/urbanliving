import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// cancelBooking
// ----------------------------------------------------------------------------
// Guest (or admin) cancellation of a stay. Twin of cancelRideBooking.
//
// Until this existed the Bookings page cancelled a stay by writing
// status='cancelled' straight to the Booking row from the browser. That worked
// only because the Booking update rule let a guest edit their own row — and
// the same rule let them edit payment_status, total_price and approved_at.
// The rule is now admin-only, so every guest-side write to a Booking goes
// through a function that checks what it is being asked to do.
//
// Rules (guest): unpaid, pending or confirmed, and more than 24h before
// check-in. Paid stays need a refund decision, so they go through support.
// Admin can cancel anything that is not already cancelled.

const HOUR_MS = 60 * 60 * 1000;
const MIN_NOTICE_MS = 24 * HOUR_MS;

// An id goes into the URL of the row it fetches, so only a plain id is ever
// used. Lockstep copy, see createWithdrawalRequest.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// entity.get() rejects for a row that is not there.
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
    }
}
// Nigeria is WAT (UTC+1) year-round. Check-in is treated as the start of the
// calendar day in that zone, matching how the reminders cron reads it.
const WAT_OFFSET = '+01:00';

async function notifyAdmin(booking: any, propertyTitle: string, byAdmin: boolean) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const text = `🚫 *STAY CANCELLED*${byAdmin ? ' (by admin)' : ''}\n\n` +
        `Booking \`${booking.id}\`\n` +
        `• Property: ${propertyTitle}\n` +
        `• Guest: ${booking.guest_name || ''} (${booking.guest_email})\n` +
        `• Dates: ${booking.check_in} → ${booking.check_out}\n` +
        `• Value: ₦${(Number(booking.total_price) || 0).toLocaleString()}\n\n` +
        `The dates are free again.` +
        // A payment was on hold for it (it arrived before the booking could
        // be confirmed). Cancelling does not send it back.
        (booking.payment_status === 'pending_confirmation'
            ? `\n\n⚠️ A payment is ON HOLD for this booking. Refund it in Paystack, then mark it refunded under Admin, Payments on hold.`
            : '');
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Cancellation notify failed (non-fatal):', err);
    }
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const { booking_id, reason } = await req.json().catch(() => ({}));
        if (!booking_id) return json({ success: false, error: 'booking_id is required' }, 400);

        const booking = isId(booking_id) ? await getOrNull(base44.asServiceRole.entities.Booking, booking_id) : null;
        if (!booking) return json({ success: false, error: 'Booking not found' }, 404);

        const isAdmin = user.role === 'admin';
        if (booking.guest_email !== user.email && !isAdmin) {
            return json({ success: false, error: 'Not your booking' }, 403);
        }

        if (booking.status === 'cancelled') {
            return json({ success: true, data: { booking_id, already_cancelled: true } });
        }
        if (booking.status === 'completed') {
            return json({ success: false, error: 'This stay has already been completed', code: 'ALREADY_COMPLETED' }, 409);
        }

        if (!isAdmin) {
            // Money is waiting on this booking for the admin to confirm or
            // send back. Cancelled, it would read "the dates are free again"
            // and nobody would be reminded of the money.
            if (booking.payment_status === 'pending_confirmation') {
                return json({
                    success: false,
                    error: 'We are holding a payment for this booking. Contact support to cancel it and get your refund.',
                    code: 'PAYMENT_HELD',
                }, 409);
            }
            if (booking.payment_status === 'paid') {
                return json({
                    success: false,
                    error: 'This booking is already paid. Contact support to cancel and arrange a refund.',
                    code: 'PAID_NEEDS_SUPPORT',
                }, 409);
            }
            if (!['pending', 'confirmed'].includes(booking.status)) {
                return json({ success: false, error: 'This booking cannot be cancelled', code: 'NOT_CANCELLABLE' }, 409);
            }
            const checkInMs = Date.parse(`${booking.check_in}T00:00:00${WAT_OFFSET}`);
            if (!Number.isNaN(checkInMs) && checkInMs - Date.now() < MIN_NOTICE_MS) {
                return json({
                    success: false,
                    error: 'Stays can only be cancelled more than 24 hours before check-in. Contact support.',
                    code: 'TOO_LATE_TO_CANCEL',
                }, 409);
            }
        }

        await base44.asServiceRole.entities.Booking.update(booking_id, {
            status: 'cancelled',
            cancel_reason: isAdmin && booking.guest_email !== user.email ? 'other' : 'user_cancelled',
        });

        let propertyTitle = booking.property_id;
        try {
            const property = await getOrNull(base44.asServiceRole.entities.Property, booking.property_id);
            propertyTitle = property?.title || propertyTitle;
        } catch (err) {
            console.warn('Could not read property for cancellation notice (non-fatal):', err);
        }
        await notifyAdmin(
            { ...booking, ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}) },
            propertyTitle,
            isAdmin && booking.guest_email !== user.email,
        );

        return json({ success: true, data: { booking_id, status: 'cancelled' } });
    } catch (error) {
        console.error('cancelBooking error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
