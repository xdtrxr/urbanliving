import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// decideRideBooking
// ----------------------------------------------------------------------------
// Admin approve/reject for a ride request, invoked from the Admin panel.
// The Telegram inline-keyboard path in telegramWebhook performs the same
// transition — Base44 function directories are isolated and cannot share a
// module, so that logic is duplicated there.
//
// KEEP THE TWO IN LOCKSTEP. The apartment flow has the same split and has
// already drifted (its two copies use different from_name values on the guest
// email). Both ride copies are deliberately kept to the same shape: guard,
// write, edit Telegram, email, push.
//
// Unlike apartments there is no separate AvailabilityRequest to decide on —
// the decision lands directly on the RideBooking row, and `approved_at` is
// itself the idempotency guard.

const HOUR_MS = 60 * 60 * 1000;
const PAYMENT_WINDOW_MS = 1 * HOUR_MS;

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const rideLink = (id: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(id)}#ride-${encodeURIComponent(id)}`;

const APPROVE_MSG = 'Your ride is confirmed as available — complete payment to lock it in.';
const REJECT_MSG = 'Sorry, this vehicle is not available for that window. Please try a different time or another vehicle.';

// Fire-and-forget push. Never let a push outage block the decision.
async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', opts);
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

async function editTelegram(messageId: string | undefined, originalText: string, decided: string) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId || !messageId) return;
    const body = {
        chat_id: chatId,
        message_id: Number(messageId),
        text: `${decided}\n\n${originalText}`,
        parse_mode: 'Markdown',
    };
    try {
        // The admin message may have been sent as a photo, in which case the
        // text lives in a caption and editMessageText fails. Fall back rather
        // than leaving the card looking undecided.
        const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.ok) {
            await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId, message_id: Number(messageId),
                    caption: `${decided}\n\n${originalText}`, parse_mode: 'Markdown',
                }),
            });
        }
    } catch (err) {
        console.warn('Telegram edit failed (non-fatal):', err);
    }
}

async function emailGuest(sdk: any, ride: any, approved: boolean) {
    if (!ride.guest_email) return;
    const when = new Date(ride.start_at).toLocaleString('en-GB', {
        timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short',
    });
    const body = approved
        ? `Hi ${ride.guest_name || 'there'},\n\n` +
          `Good news — ${ride.vehicle_name} is available for your ride.\n\n` +
          `🔖 Status: APPROVED — AWAITING PAYMENT\n` +
          `🚗 Vehicle: ${ride.vehicle_name}\n` +
          `🕒 Pickup: ${when}\n` +
          `💰 Total: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n\n` +
          `👉 Pay now: ${rideLink(ride.id)}\n\n` +
          `You have 1 hour from opening the payment page to complete payment (3-hour cap from this approval), after which the booking is released.\n\n` +
          `— Urban Stays`
        : `Hi ${ride.guest_name || 'there'},\n\n` +
          `Unfortunately ${ride.vehicle_name} isn't available for ${when}.\n\n` +
          `🔖 Status: CANCELLED\n` +
          `🔎 Browse other vehicles: ${APP_BASE_URL}/PlanTrip\n\n` +
          `— Urban Stays`;
    try {
        await sdk.integrations.Core.SendEmail({
            to: ride.guest_email,
            subject: approved
                ? `Approved: your ride in the ${ride.vehicle_name}`
                : `Update on your ride request`,
            body,
            from_name: 'Urban Stays',
        });
    } catch (err) {
        console.warn('Guest decision email failed (non-fatal):', err);
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
        if (user.role !== 'admin') return json({ success: false, error: 'Admin access required' }, 403);

        const { ride_booking_id, action, note } = await req.json().catch(() => ({}));
        if (!ride_booking_id || !['approve', 'reject'].includes(action)) {
            return json({ success: false, error: 'ride_booking_id and action (approve|reject) are required' }, 400);
        }

        const ride = await base44.asServiceRole.entities.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);

        // Idempotency: approved_at is the decision stamp. A row that already
        // carries one, or that has left `pending`, has been actioned.
        if (ride.status !== 'pending' || ride.approved_at) {
            return json({
                success: false,
                error: `This ride has already been actioned (status: ${ride.status})`,
                code: 'ALREADY_DECIDED',
            }, 409);
        }

        const approved = action === 'approve';
        const nowIso = new Date().toISOString();
        const adminResponse = (typeof note === 'string' && note.trim())
            ? note.trim()
            : (approved ? APPROVE_MSG : REJECT_MSG);

        await base44.asServiceRole.entities.RideBooking.update(ride_booking_id, approved
            ? {
                approved_at: nowIso,
                payment_deadline: new Date(Date.now() + PAYMENT_WINDOW_MS).toISOString(),
                admin_response: adminResponse,
            }
            : {
                status: 'cancelled',
                cancel_reason: 'admin_rejected',
                admin_response: adminResponse,
            });

        await editTelegram(
            ride.telegram_message_id,
            `🚗 Ride \`${ride.id}\` — ${ride.vehicle_name}`,
            approved ? '✅ *APPROVED* (in-app)' : '❌ *REJECTED* (in-app)',
        );
        await emailGuest(base44, ride, approved);
        await tryPush(base44, {
            user_email: ride.guest_email,
            title: approved ? '✅ Ride approved' : '❌ Ride unavailable',
            body: approved
                ? `${ride.vehicle_name} is held for you — tap to pay and lock it in.`
                : `${ride.vehicle_name} isn't free for that window. Tap to try another.`,
            url: approved ? `/Bookings#ride-${ride.id}` : '/PlanTrip',
            tag: `ride-decision-${ride.id}`,
        });

        return json({ success: true, data: { ride_booking_id, status: approved ? 'approved' : 'rejected' } });
    } catch (error) {
        console.error('decideRideBooking error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
