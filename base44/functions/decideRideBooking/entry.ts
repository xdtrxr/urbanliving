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
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
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

const ngn = (n: unknown) => `₦${(Number(n) || 0).toLocaleString()}`;

async function emailGuest(
    sdk: any,
    ride: any,
    approved: boolean,
    extras: { finalPrice?: number; reason?: string; alternatives?: any[] } = {},
) {
    if (!ride.guest_email) return;
    const when = new Date(ride.start_at).toLocaleString('en-GB', {
        timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short',
    });

    // The confirmed figure may differ from what the guest was quoted. Saying so
    // in the same breath as "pay now" is the entire point of splitting
    // estimated_price from total_price — a guest must never discover a changed
    // price on the Paystack screen.
    const charged = extras.finalPrice ?? Number(ride.total_price) ?? 0;
    const estimated = Number(ride.estimated_price ?? ride.total_price) || 0;
    const priceMoved = Number(charged) !== estimated;

    const priceBlock = (priceMoved
        ? `💰 Confirmed total: ${ngn(charged)}\n` +
          `   (your estimate was ${ngn(estimated)})\n` +
          (extras.reason ? `   Reason: ${extras.reason}\n` : '')
        : `💰 Total: ${ngn(charged)}\n`) +
        // The extra-hour rule is part of the price the guest is agreeing to,
        // so it is stated in the same block as the total, not buried later.
        (ride.extra_hour_rate_ngn
            ? `⏱ Extra time: ${ngn(ride.extra_hour_rate_ngn)} per hour beyond your booking, settled after the trip\n`
            : '');

    const altBlock = (extras.alternatives || []).length
        ? `\nSimilar vehicles free in ${extras.alternatives![0]?.city || 'your city'}:\n` +
          extras.alternatives!.map((v: any) =>
              `• ${v.name} — from ${ngn(v.price_per_hour_ngn || v.price_12hr_ngn)}` +
              `${v.price_per_hour_ngn ? '/hour' : ' for 12 hours'}\n` +
              `  ${APP_BASE_URL}/Vehicle?id=${v.id}\n`).join('') + `\n`
        : '';

    const body = approved
        ? `Hi ${ride.guest_name || 'there'},\n\n` +
          `Good news — ${ride.vehicle_name} is available for your ride, and a driver is arranged.\n\n` +
          `🔖 Status: CONFIRMED AVAILABLE — AWAITING PAYMENT\n` +
          (ride.booking_reference ? `🏷️ Reference: ${ride.booking_reference}\n` : '') +
          `🚗 Vehicle: ${ride.vehicle_name}\n` +
          `🕒 Pickup: ${when}\n` +
          priceBlock + `\n` +
          `👉 Pay now: ${rideLink(ride.id)}\n\n` +
          `You have 1 hour from opening the payment page to complete payment (3-hour cap from this approval), after which the booking is released.\n\n` +
          `— Urban Stays`
        : `Hi ${ride.guest_name || 'there'},\n\n` +
          `Unfortunately ${ride.vehicle_name} isn't available for ${when}.\n\n` +
          `🔖 Status: CANCELLED\n` +
          (ride.booking_reference ? `🏷️ Reference: ${ride.booking_reference}\n` : '') +
          altBlock +
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

// An id goes into the URL of the row it fetches ("../Booking/abc" would fetch
// a row of another entity, and every check that follows would then be made on
// the wrong kind of row), so only a plain id is ever used. Lockstep copy, see
// createWithdrawalRequest.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// entity.get() rejects for a row that is not there. Unguarded, a stale or
// mistyped id is answered with a 500 instead of "not found".
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
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

        const {
            ride_booking_id, action, note,
            final_price, price_adjustment_reason, suggested_vehicle_ids,
        } = await req.json().catch(() => ({}));
        if (!ride_booking_id || !['approve', 'reject'].includes(action)) {
            return json({ success: false, error: 'ride_booking_id and action (approve|reject) are required' }, 400);
        }

        const ride = isId(ride_booking_id) ? await getOrNull(base44.asServiceRole.entities.RideBooking, ride_booking_id) : null;
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

        // ── Price confirmation ──────────────────────────────────────────
        // The guest was quoted an estimate. Admin confirms a final figure,
        // which may differ once fuel, waiting time or an airport run is
        // accounted for. A change without a stated reason is refused: the
        // guest has to be able to see WHY the number moved, and making that
        // structurally impossible to skip is cheaper than trusting habit.
        const estimated = Number(ride.estimated_price ?? ride.total_price) || 0;
        let charged = estimated;
        if (final_price !== undefined && final_price !== null && final_price !== '') {
            const parsed = Number(final_price);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                return json({ success: false, error: 'final_price must be a positive number', code: 'BAD_PRICE' }, 400);
            }
            if (parsed !== estimated && !String(price_adjustment_reason || '').trim()) {
                return json({
                    success: false,
                    error: 'Changing the price needs a reason the guest can read.',
                    code: 'REASON_REQUIRED',
                }, 400);
            }
            charged = parsed;
        }
        const priceMoved = charged !== estimated;

        // ── Alternatives on reject ──────────────────────────────────────
        // "Not available" is a dead end; "not available, but these three are"
        // keeps the guest in the funnel. Only ever suggest vehicles that are
        // bookable and in the same city as the one they asked for.
        let alternatives: any[] = [];
        if (!approved && Array.isArray(suggested_vehicle_ids) && suggested_vehicle_ids.length) {
            const wanted = suggested_vehicle_ids.slice(0, 4);
            const rows = await Promise.all(wanted.map((id: string) =>
                base44.asServiceRole.entities.Vehicle.get(id).catch(() => null)));
            const askedCity = ride.pickup_location?.city;
            alternatives = rows.filter((v: any) =>
                v && v.active !== false && v.admin_approved !== false
                && v.id !== ride.vehicle_id
                && (!askedCity || v.city === askedCity));
        }

        await base44.asServiceRole.entities.RideBooking.update(ride_booking_id, approved
            ? {
                approved_at: nowIso,
                payment_deadline: new Date(Date.now() + PAYMENT_WINDOW_MS).toISOString(),
                admin_response: adminResponse,
                total_price: charged,
                // Backfill for rows written before estimated_price existed, so
                // "did the price change?" is answerable for every booking.
                estimated_price: ride.estimated_price ?? estimated,
                ...(priceMoved
                    ? { price_adjustment_reason: String(price_adjustment_reason).trim() }
                    : {}),
            }
            : {
                status: 'cancelled',
                cancel_reason: 'admin_rejected',
                admin_response: adminResponse,
                ...(alternatives.length
                    ? { suggested_vehicle_ids: alternatives.map((v: any) => v.id) }
                    : {}),
            });

        await editTelegram(
            ride.telegram_message_id,
            `🚗 Ride \`${ride.id}\` — ${ride.vehicle_name}`,
            approved
                ? `✅ *APPROVED* (in-app)${priceMoved ? ` — price set to ${ngn(charged)}` : ''}`
                : `❌ *REJECTED* (in-app)${alternatives.length ? ` — ${alternatives.length} alternative(s) offered` : ''}`,
        );
        await emailGuest(base44, ride, approved, {
            finalPrice: charged,
            reason: priceMoved ? String(price_adjustment_reason).trim() : undefined,
            alternatives,
        });
        await tryPush(base44, {
            user_email: ride.guest_email,
            title: approved ? '✅ Ride confirmed available' : '❌ Ride unavailable',
            body: approved
                // The push is often the only thing a guest reads before tapping
                // through to pay, so a changed price has to appear here too.
                ? priceMoved
                    ? `${ride.vehicle_name} is held for you at ${ngn(charged)} (was ${ngn(estimated)}). Tap to pay.`
                    : `${ride.vehicle_name} is held for you — tap to pay and lock it in.`
                : alternatives.length
                    ? `${ride.vehicle_name} isn't free, but ${alternatives.length} similar car${alternatives.length === 1 ? '' : 's'} ${alternatives.length === 1 ? 'is' : 'are'}. Tap to see.`
                    : `${ride.vehicle_name} isn't free for that window. Tap to try another.`,
            url: approved ? `/Bookings#ride-${ride.id}` : '/PlanTrip',
            tag: `ride-decision-${ride.id}`,
        });

        return json({
            success: true,
            data: {
                ride_booking_id,
                status: approved ? 'approved' : 'rejected',
                total_price: approved ? charged : undefined,
                price_changed: approved ? priceMoved : undefined,
                suggested: alternatives.map((v: any) => ({ id: v.id, name: v.name })),
            },
        });
    } catch (error) {
        console.error('decideRideBooking error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
