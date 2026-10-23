import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// markHeldPaymentRefunded
// ----------------------------------------------------------------------------
// A payment that arrives for a stay it may not confirm is put on hold
// (see stayPaymentVerdict in verifyPaystackPayment). The admin then either
// confirms the booking with it, or sends the money back in Paystack. This
// records the second: the admin has refunded it by hand, and says so here.
// Nothing in the app moves money back by itself.
//
// Body: { booking_id } for a stay, { ride_booking_id } for a ride (rides are
// held the same way since 2026-10-23, see ridePaymentVerdict in
// verifyRidePayment).
// Who may: an admin session, or another function carrying
// INTERNAL_FUNCTION_SECRET (the Telegram button has no session). Refused when
// the secret is not configured.
//
// It writes payment_status 'refunded', cancels the booking if it was still
// waiting, closes the request it came from, and tells the guest.

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const bookingLink = (bookingId: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(bookingId)}#booking-${encodeURIComponent(bookingId)}`;
const rideLink = (rideId: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(rideId)}#ride-${encodeURIComponent(rideId)}`;

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

// Compared without stopping at the first difference.
function sameSecret(given: string, real: string) {
    if (given.length !== real.length) return false;
    let diff = 0;
    for (let i = 0; i < real.length; i++) diff |= given.charCodeAt(i) ^ real.charCodeAt(i);
    return diff === 0;
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

// The ride twin of the stay path in the handler below. A ride has no request
// row to close: the decision lives on the ride itself.
async function refundHeldRide(base44: any, rideId: string, who: string, respond: (status: number, payload: Record<string, unknown>) => Response) {
    const db = base44.asServiceRole.entities;
    const ride = isId(rideId) ? await getOrNull(db.RideBooking, rideId) : null;
    if (!ride) return respond(404, { success: false, error: 'Ride booking not found' });
    if (ride.payment_status === 'refunded') {
        return respond(200, { success: true, data: { ride_booking_id: ride.id, refunded: true, already: true } });
    }
    if (ride.payment_status !== 'pending_confirmation') {
        return respond(409, {
            success: false,
            error: ride.payment_status === 'paid'
                ? 'This ride is confirmed and paid, so there is no payment on hold to mark refunded.'
                : 'Nothing is on hold for this ride.',
            code: 'NOT_HELD',
        });
    }

    const amountNGN = Number(ride.total_price) || 0;
    const reference = String(ride.transaction_hash || '');
    // A ride still waiting to be decided is closed with it: its payment has
    // gone back, so it must stop holding its car.
    await db.RideBooking.update(ride.id, ride.status === 'pending'
        ? { payment_status: 'refunded', status: 'cancelled', cancel_reason: 'admin_rejected' }
        : { payment_status: 'refunded' });

    let pickup = String(ride.start_at || '');
    try {
        pickup = new Date(ride.start_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
    } catch { /* the stored value is used */ }
    let guestEmailed = false;
    try {
        await base44.integrations.Core.SendEmail({
            to: ride.guest_email,
            subject: 'Your payment has been refunded',
            body: `Hi ${ride.guest_name || 'there'},\n\n`
                + `We have refunded your payment of ₦${amountNGN.toLocaleString()} (reference ${reference}) for the ${ride.vehicle_name || 'ride'} on ${pickup}. `
                + 'The ride was not confirmed. It can take a few working days for the money to show in your account.\n\n'
                + `Your ride: ${rideLink(ride.id)}\n\n— Urban Stays`,
            from_name: 'Urban Stays',
        });
        guestEmailed = true;
    } catch (err) {
        console.warn('Ride refund email to the guest failed (non-fatal):', err);
    }
    await tryPush(base44, {
        user_email: ride.guest_email,
        title: 'Payment refunded',
        body: `₦${amountNGN.toLocaleString()} is on its way back to you. It can take a few working days.`,
        url: `/Bookings#ride-${ride.id}`,
        tag: `ride-held-${ride.id}`,
    });

    console.log(`Payment ${reference} for ride ${ride.id} marked refunded by ${who}`);
    return respond(200, { success: true, data: { ride_booking_id: ride.id, refunded: true, reference, amount_ngn: amountNGN, guest_emailed: guestEmailed } });
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const respond = (status: number, payload: Record<string, unknown>) =>
        new Response(JSON.stringify(payload), { status, headers });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return respond(405, { success: false, error: 'Method not allowed' });

    try {
        const base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));

        // The secret is read before the session: the Telegram button has none.
        const secret = Deno.env.get('INTERNAL_FUNCTION_SECRET') || '';
        let who = 'the admin';
        let allowed = !!secret && typeof body.internal_secret === 'string' && sameSecret(body.internal_secret, secret);
        if (!allowed) {
            try {
                const user = await base44.auth.me().catch(() => null);
                allowed = !!user && user.role === 'admin';
                if (allowed) who = user.email;
            } catch {
                allowed = false;
            }
        }
        if (!allowed) {
            return respond(403, { success: false, error: 'Only an admin can mark a payment refunded.', code: 'ADMIN_ONLY' });
        }

        if (body.ride_booking_id !== undefined) {
            return await refundHeldRide(base44, String(body.ride_booking_id || '').trim(), who, respond);
        }

        const db = base44.asServiceRole.entities;
        const bookingId = String(body.booking_id || '').trim();
        const booking = isId(bookingId) ? await getOrNull(db.Booking, bookingId) : null;
        if (!booking) return respond(404, { success: false, error: 'Booking not found' });
        if (booking.payment_status === 'refunded') {
            return respond(200, { success: true, data: { booking_id: booking.id, refunded: true, already: true } });
        }
        if (booking.payment_status !== 'pending_confirmation') {
            return respond(409, {
                success: false,
                error: booking.payment_status === 'paid'
                    ? 'This booking is confirmed and paid, so there is no payment on hold to mark refunded.'
                    : 'Nothing is on hold for this booking.',
                code: 'NOT_HELD',
            });
        }

        const amountNGN = Number(booking.total_price) || 0;
        const reference = String(booking.transaction_hash || '');
        // A booking still waiting to be decided is closed with it: its
        // payment has gone back, so it must stop holding its dates.
        await db.Booking.update(booking.id, booking.status === 'pending'
            ? { payment_status: 'refunded', status: 'cancelled', cancel_reason: 'admin_rejected' }
            : { payment_status: 'refunded' });

        // The request it came from leaves the admin's list. Found by the id
        // it carries; older rows are matched as they used to be.
        try {
            let requests = await db.AvailabilityRequest.filter({ booking_id: booking.id }, '-created_date', 5);
            if (requests.length === 0) {
                requests = await db.AvailabilityRequest.filter({
                    property_id: booking.property_id,
                    user_email: booking.guest_email,
                    check_in: booking.check_in,
                    check_out: booking.check_out,
                    status: 'pending',
                }, '-created_date', 5);
            }
            for (const request of requests) {
                if (request.status !== 'pending') continue;
                await db.AvailabilityRequest.update(request.id, {
                    status: 'rejected',
                    admin_response: 'The payment for this request was refunded.',
                });
            }
        } catch (err) {
            console.warn('markHeldPaymentRefunded: could not close the request (non-fatal):', err);
        }

        let guestEmailed = false;
        try {
            await base44.integrations.Core.SendEmail({
                to: booking.guest_email,
                subject: 'Your payment has been refunded',
                body: `Hi ${booking.guest_name || 'there'},\n\n`
                    + `We have refunded your payment of ₦${amountNGN.toLocaleString()} (reference ${reference}) for ${booking.check_in} to ${booking.check_out}. `
                    + 'The booking was not confirmed. It can take a few working days for the money to show in your account.\n\n'
                    + `Your booking: ${bookingLink(booking.id)}\n\n— Urban Stays`,
                from_name: 'Urban Stays',
            });
            guestEmailed = true;
        } catch (err) {
            console.warn('Refund email to the guest failed (non-fatal):', err);
        }
        await tryPush(base44, {
            user_email: booking.guest_email,
            title: 'Payment refunded',
            body: `₦${amountNGN.toLocaleString()} is on its way back to you. It can take a few working days.`,
            url: `/Bookings#booking-${booking.id}`,
            tag: `booking-held-${booking.id}`,
        });

        console.log(`Payment ${reference} for booking ${booking.id} marked refunded by ${who}`);
        return respond(200, { success: true, data: { booking_id: booking.id, refunded: true, reference, amount_ngn: amountNGN, guest_emailed: guestEmailed } });
    } catch (error) {
        console.error('markHeldPaymentRefunded error:', error);
        return respond(500, { success: false, error: 'Internal server error', details: (error as Error).message });
    }
});
