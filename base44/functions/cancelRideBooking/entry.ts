import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// cancelRideBooking
// ----------------------------------------------------------------------------
// Guest (or admin) cancellation.
//
// Exists as a function specifically because the apartment equivalent does not.
// Stays are cancelled by an unvalidated client-side entity write straight from
// Bookings.jsx, which means the 24-hour rule is enforced only in the UI, no
// cancel_reason is ever stamped, and nobody is notified. Routing rides through
// a function closes all three: eligibility is checked server-side, the reason
// is recorded, and the admin hears about it — which matters more for rides,
// where a cancellation frees a vehicle someone else may be waiting on.

const HOUR_MS = 60 * 60 * 1000;
const MIN_NOTICE_MS = 24 * HOUR_MS;

async function notifyAdmin(ride: any, byAdmin: boolean) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const when = (() => {
        try {
            return new Date(ride.start_at).toLocaleString('en-GB', {
                timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
            });
        } catch { return ride.start_at; }
    })();
    const text = `🚫 *RIDE CANCELLED*${byAdmin ? ' (by admin)' : ''}\n\n` +
        `Ride \`${ride.id}\`\n` +
        `• Vehicle: ${ride.vehicle_name}\n` +
        `• Guest: ${ride.guest_name} (${ride.guest_email})\n` +
        `• Was booked for: ${when}\n` +
        `• Value: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n\n` +
        `The vehicle is free again for that window.`;
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

        const { ride_booking_id, reason } = await req.json().catch(() => ({}));
        if (!ride_booking_id) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const ride = await base44.asServiceRole.entities.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);

        const isAdmin = user.role === 'admin';
        if (ride.guest_email !== user.email && !isAdmin) {
            return json({ success: false, error: 'Not your booking' }, 403);
        }

        if (ride.status === 'cancelled') {
            return json({ success: true, data: { ride_booking_id, already_cancelled: true } });
        }
        if (ride.status === 'completed') {
            return json({ success: false, error: 'This ride has already been completed', code: 'ALREADY_COMPLETED' }, 409);
        }

        // Paid rides need a refund decision, so they go through support —
        // same policy as paid stays. Admin can still force a cancellation.
        if (ride.payment_status === 'paid' && !isAdmin) {
            return json({
                success: false,
                error: 'This ride is already paid. Contact support to cancel and arrange a refund.',
                code: 'PAID_NEEDS_SUPPORT',
            }, 409);
        }

        const startMs = Date.parse(ride.start_at || '');
        if (!isAdmin && !Number.isNaN(startMs) && startMs - Date.now() < MIN_NOTICE_MS) {
            return json({
                success: false,
                error: 'Rides can only be cancelled more than 24 hours before pickup. Contact support.',
                code: 'TOO_LATE_TO_CANCEL',
            }, 409);
        }

        await base44.asServiceRole.entities.RideBooking.update(ride_booking_id, {
            status: 'cancelled',
            cancel_reason: isAdmin && ride.guest_email !== user.email ? 'other' : 'user_cancelled',
            admin_response: typeof reason === 'string' && reason.trim() ? reason.trim() : undefined,
        });

        await notifyAdmin(ride, isAdmin && ride.guest_email !== user.email);

        return json({ success: true, data: { ride_booking_id, status: 'cancelled' } });
    } catch (error) {
        console.error('cancelRideBooking error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
