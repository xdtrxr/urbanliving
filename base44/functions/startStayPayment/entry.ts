import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// startStayPayment
// ----------------------------------------------------------------------------
// Called once when the guest opens the payment page for a stay. Twin of
// startRidePayment. Stamps payment_started_at server-side and returns the
// stored price and the payment deadline.
//
// Two things this replaces:
//   1. PaymentPage wrote Booking.payment_started_at straight from the client —
//      the field that decides how long a guest has to pay was guest-writable.
//   2. PaymentPage took the amount to charge from a URL parameter. The
//      verifiers always checked Paystack's amount against the stored
//      total_price, so a tampered URL could not under-pay, but it could show
//      the guest one number and charge another. The stored figure is now the
//      only one the page sees.
//
// Deadline rule, identical to autoCancelExpiredBookings so the page and the
// sweep never disagree about when the window shuts:
//   min(approved_at + 3h, max(approved_at + 1h, payment_started_at + 1h))

const HOUR_MS = 60 * 60 * 1000;
const PAYMENT_WINDOW_MS = 1 * HOUR_MS;
const APPROVAL_CAP_MS = 3 * HOUR_MS;

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

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me().catch(() => null);
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const { booking_id } = await req.json().catch(() => ({}));
        if (!booking_id) return json({ success: false, error: 'booking_id is required' }, 400);

        const booking = isId(booking_id) ? await getOrNull(base44.asServiceRole.entities.Booking, booking_id) : null;
        if (!booking) return json({ success: false, error: 'Booking not found' }, 404);
        if (booking.guest_email !== user.email && user.role !== 'admin') {
            return json({ success: false, error: 'Not your booking' }, 403);
        }
        if (booking.payment_status === 'paid') {
            return json({ success: true, data: { already_paid: true, booking_id } });
        }
        // A payment is already on hold for this booking (it arrived before
        // the booking could be confirmed). Asked before anything else: once
        // the admin approves, nothing below would stop a second payment.
        if (booking.payment_status === 'pending_confirmation') {
            return json({
                success: false,
                error: `We already have your payment of ₦${(Number(booking.total_price) || 0).toLocaleString()} for this booking. It is waiting for our team to confirm it. Please do not pay again.`,
                code: 'PAYMENT_HELD',
            }, 409);
        }
        if (booking.payment_status === 'refunded') {
            return json({
                success: false,
                error: 'The payment for this booking was refunded. Please make a new request if you still want these dates.',
                code: 'PAYMENT_REFUNDED',
            }, 409);
        }
        if (booking.status === 'cancelled') {
            return json({ success: false, error: 'This booking was cancelled', code: 'CANCELLED' }, 409);
        }
        if (!booking.approved_at) {
            return json({ success: false, error: 'This booking has not been approved yet', code: 'NOT_APPROVED' }, 409);
        }

        const approvedMs = Date.parse(booking.approved_at);
        const nowMs = Date.now();
        const startedMs = Date.parse(booking.payment_started_at || '') || nowMs;
        const cap = approvedMs + APPROVAL_CAP_MS;
        const deadlineMs = Math.min(cap, Math.max(approvedMs + PAYMENT_WINDOW_MS, startedMs + PAYMENT_WINDOW_MS));

        if (deadlineMs <= nowMs) {
            return json({
                success: false,
                error: 'The payment window for this booking has closed.',
                code: 'WINDOW_CLOSED',
            }, 409);
        }

        // One-shot: re-opening the page must not restart the clock.
        let startedAt = booking.payment_started_at || null;
        if (!startedAt) {
            startedAt = new Date(nowMs).toISOString();
            await base44.asServiceRole.entities.Booking.update(booking_id, { payment_started_at: startedAt });
        }

        let propertyTitle = '';
        try {
            const property = await getOrNull(base44.asServiceRole.entities.Property, booking.property_id);
            propertyTitle = property?.title || '';
        } catch (err) {
            console.warn('Could not read property title (non-fatal):', err);
        }

        return json({
            success: true,
            data: {
                booking_id,
                total_price: Number(booking.total_price) || 0,
                // What is being paid for, restated on the payment page.
                check_in: booking.check_in,
                check_out: booking.check_out,
                bedrooms_booked: Number(booking.bedrooms_booked) || 0,
                property_title: propertyTitle,
                guest_email: booking.guest_email,
                approved_at: booking.approved_at,
                payment_started_at: startedAt,
                payment_deadline: new Date(deadlineMs).toISOString(),
            },
        });
    } catch (error) {
        console.error('startStayPayment error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
