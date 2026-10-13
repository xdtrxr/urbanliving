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
    optionLabel?: string;
    action: 'approve' | 'reject';
    // Set when the request is rejected while its booking holds a payment.
    refund?: { amountNGN: number; reference: string } | null;
}) {
    if (!opts.guestEmail) return;
    const subject = opts.action === 'approve'
        ? `Approved: your booking for ${opts.propertyTitle}`
        : `Update on your booking request for ${opts.propertyTitle}`;

    const bookingHref = opts.bookingId ? bookingLink(opts.bookingId) : `${APP_BASE_URL}/Bookings`;
    const propertyHref = opts.propertyId ? propertyLink(opts.propertyId) : null;

    const body = opts.action === 'approve'
        ? `Hi ${opts.guestName || 'there'},\n\n` +
          `Great news — your availability request for "${opts.propertyTitle}" (${opts.checkIn} → ${opts.checkOut}${opts.optionLabel ? `, ${opts.optionLabel}` : ''}) has been approved.\n\n` +
          `🔖 Status: APPROVED — AWAITING PAYMENT\n` +
          `👉 View & pay: ${bookingHref}\n` +
          (propertyHref ? `🏠 Property page: ${propertyHref}\n` : '') +
          `\nYou have 1 hour to complete payment from when you open the payment page (and a 3-hour hard cap from this approval). After that the booking will be automatically cancelled.\n\n` +
          `— UrbanStays`
        : `Hi ${opts.guestName || 'there'},\n\n` +
          `Unfortunately, "${opts.propertyTitle}" is not available for ${opts.checkIn} → ${opts.checkOut}.\n\n` +
          (opts.refund ? `We received your payment of ₦${opts.refund.amountNGN.toLocaleString()} (reference ${opts.refund.reference}). It will be refunded in full.\n\n` : '') +
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

// ── Deciding a stay request ──────────────────────────────────────────────────
// LOCKSTEP: from this line to "end of deciding a stay request" the text is the
// same in decideAvailabilityRequest (the Admin screen's buttons) and
// telegramWebhook (the buttons on the Telegram card). Functions cannot share
// code; scripts/check-stay-payment.mjs fails if the two copies differ.

// An id goes into the URL of the row it fetches, so only a plain id is ever
// used.
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

// The booking a request is about. checkAvailabilityWebhook writes its id on
// the request. Until 2026-10-12 it was found by looking for a pending booking
// with the same property, dates and guest: two requests from a double tap
// both landed on the first match, and a booking the guest had cancelled was
// not found at all, so the request was "approved" and the guest emailed a
// link to pay for a cancelled booking. Requests from before the id existed
// are still matched the old way.
async function bookingForRequest(db: any, request: any) {
    let booking = isId(request.booking_id) ? await getOrNull(db.Booking, request.booking_id) : null;
    if (booking && (booking.property_id !== request.property_id || booking.guest_email !== request.user_email)) booking = null;
    if (!booking && !request.booking_id) {
        const matches = await db.Booking.filter({
            property_id: request.property_id,
            check_in: request.check_in,
            check_out: request.check_out,
            guest_email: request.user_email,
            status: 'pending',
        }, '-created_date', 5);
        booking = (Array.isArray(matches) && matches[0]) || null;
    }
    return booking;
}

// What approving or rejecting a request does. Answers
//   { ok: true, status, bookingId, confirmedWithPayment, arrivalEmail, refundOwed, guestCancelled }
//   { ok: false, code, error }   nothing was decided; the request is still open
//                                (or, where the sentence says so, was closed)
//
// A booking may already hold a payment (the guest paid before the request was
// decided; see stayPaymentVerdict in verifyPaystackPayment). Then approving
// means confirming the booking with that payment, which only
// verifyPaystackPayment does, and rejecting leaves a refund owed.
//
// Two writes, the booking then the request, and nothing ties them together.
// So a press can find the booking already changed by an earlier press whose
// second write failed. Each branch below is written to finish that job, not
// to take the half-done state for something the guest did.
async function decideRequest(sdk: any, request: any, action: 'approve' | 'reject') {
    const db = sdk.asServiceRole.entities;
    const booking = await bookingForRequest(db, request);
    const held = !!booking && booking.payment_status === 'pending_confirmation' && !!booking.transaction_hash;
    const APPROVED = 'Property is available for your requested dates!';
    const REJECTED = 'Sorry, the property is not available for these dates. Please try different dates or check other properties.';
    const close = (status: string, admin_response: string) => db.AvailabilityRequest.update(request.id, { status, admin_response });

    // Already paid and confirmed. The guest paid and the booking was
    // confirmed without this request having been closed: a row from before
    // payments were held, or a confirm whose last write failed. There is
    // nothing left to approve, and "rejecting" must not tell a guest with a
    // paid, confirmed stay that it is cancelled.
    if (booking && booking.payment_status === 'paid') {
        if (action === 'reject') {
            return {
                ok: false,
                code: 'ALREADY_PAID',
                error: 'This booking is already paid and confirmed, so the request cannot be rejected. To cancel it, cancel the booking itself and refund the guest.',
            };
        }
        await close('approved', APPROVED);
        return { ok: true, status: 'approved', bookingId: booking.id, confirmedWithPayment: true };
    }

    // The booking is already cancelled, and no money is waiting on it.
    if (booking && booking.status === 'cancelled' && !held) {
        const byGuest = booking.cancel_reason === 'user_cancelled';
        if (action === 'reject') {
            // Cancelled by the guest: it only needs to leave the list.
            // Cancelled any other way: an earlier Reject got as far as the
            // booking and no further, and the guest has not been told. This
            // press finishes it, and the caller emails them.
            await close('rejected', byGuest ? 'This request was cancelled before it was decided.' : REJECTED);
            return { ok: true, status: 'rejected', bookingId: booking.id, guestCancelled: byGuest };
        }
        const expired = booking.cancel_reason === 'payment_expired';
        await close('rejected', expired ? 'This booking ran out of time to pay.' : 'This request was cancelled before it was decided.');
        return {
            ok: false,
            code: 'BOOKING_CANCELLED',
            error: byGuest
                ? 'The guest cancelled this request, so there was nothing to approve. It has been taken off the list.'
                : expired
                    ? 'This booking ran out of time to pay and was cancelled before its approval was finished. It has been taken off the list. Ask the guest to request again.'
                    : 'This booking was already cancelled, so there was nothing to approve. It has been taken off the list.',
        };
    }

    if (action === 'approve' && held) {
        let confirmed: any = null;
        try {
            const answer = await sdk.functions.invoke('verifyPaystackPayment', {
                booking_id: booking.id,
                confirm_held: true,
                internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '',
            });
            confirmed = (answer && answer.data && answer.data.data) || {};
        } catch (err) {
            const said = err && err.response && err.response.data;
            // No admin session reached the other function and no secret is
            // set: the Admin screen's own button works from the admin's login.
            if (said && said.code === 'ADMIN_ONLY') {
                return {
                    ok: false,
                    code: 'ADMIN_ONLY',
                    error: 'The payment on hold could not be confirmed from here. Open Admin and press "Confirm booking" on the Payments on hold card.',
                };
            }
            return {
                ok: false,
                code: (said && said.code) || 'HELD_NOT_CONFIRMED',
                error: (said && said.error) || 'The payment on hold could not be confirmed. Nothing was changed.',
            };
        }
        // verifyPaystackPayment closes the request as well, but treats that
        // write as optional. It is written here, where a failure is seen.
        await close('approved', APPROVED);
        return { ok: true, status: 'approved', bookingId: booking.id, confirmedWithPayment: true, arrivalEmail: confirmed.arrival_email || null };
    }

    // The booking first: if the second write fails the request is still open
    // and the button can be pressed again.
    if (booking && booking.status === 'pending') {
        await db.Booking.update(booking.id, action === 'approve'
            ? { approved_at: new Date().toISOString() }
            : { status: 'cancelled', cancel_reason: 'admin_rejected' });
    }
    const status = action === 'approve' ? 'approved' : 'rejected';
    await close(status, action === 'approve' ? APPROVED : REJECTED);
    return {
        ok: true,
        status,
        bookingId: booking ? booking.id : null,
        refundOwed: action === 'reject' && held
            ? { amountNGN: Number(booking.total_price) || 0, reference: String(booking.transaction_hash) }
            : null,
    };
}

// A request was rejected while its booking held a payment. The admin has to
// send the money back by hand; this is the reminder, with the button that
// records it once done.
async function tellAdminRefundOwed(bookingId: string, guestEmail: string, owed: { amountNGN: number; reference: string }) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) {
        console.error(`A refund is owed for booking ${bookingId} and Telegram is not configured: nobody was told.`);
        return;
    }
    const text = [
        'REFUND OWED',
        '',
        `You rejected a request that had a payment on hold.`,
        `Booking: ${bookingId}`,
        `Guest: ${guestEmail}`,
        `Amount: ₦${owed.amountNGN.toLocaleString()}`,
        `Paystack ref: ${owed.reference}`,
        '',
        'Refund it in Paystack, then press the button so the guest is told.',
    ].join('\n');
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                reply_markup: { inline_keyboard: [[{ text: 'Mark refunded', callback_data: `held_refund_${bookingId}` }]] },
            }),
        });
        const answer = await res.json().catch(() => null);
        if (!answer || !answer.ok) console.error(`Telegram did not take the refund-owed note for booking ${bookingId}:`, answer);
    } catch (err) {
        console.error(`Refund-owed note failed for booking ${bookingId}:`, err);
    }
}
// ── end of deciding a stay request ───────────────────────────────────────────

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

        const request = isId(requestId) ? await getOrNull(base44.asServiceRole.entities.AvailabilityRequest, requestId) : null;
        if (!request) {
            return new Response(JSON.stringify({ success: false, error: 'Request not found' }), { status: 404, headers });
        }
        if (request.status !== 'pending') {
            return new Response(JSON.stringify({
                success: false,
                error: `Request already ${request.status}`,
            }), { status: 409, headers });
        }

        const outcome: any = await decideRequest(base44, request, action);
        if (!outcome.ok) {
            return new Response(JSON.stringify({
                success: false,
                error: outcome.error,
                code: outcome.code,
            }), { status: 409, headers });
        }

        // Edit the Telegram message in-place so admin sees the in-app decision
        await editTelegramMessage(
            request.telegram_message_id || null,
            action,
            null,
        );

        if (outcome.refundOwed) {
            await tellAdminRefundOwed(outcome.bookingId, request.user_email, outcome.refundOwed);
        }

        // Email the guest. Not when the booking was confirmed with a payment
        // on hold (verifyPaystackPayment has sent the arrival details, and
        // "you have an hour to pay" would be wrong), and not when the guest
        // had cancelled it themselves.
        if (!outcome.confirmedWithPayment && !outcome.guestCancelled) {
            await emailGuestDecision({
                sdk: base44,
                guestEmail: request.user_email,
                guestName: request.user_name,
                propertyTitle: request.property_title,
                propertyId: request.property_id,
                bookingId: outcome.bookingId,
                checkIn: request.check_in,
                checkOut: request.check_out,
                optionLabel: Number(request.bedrooms_booked) > 0 ? `the ${Number(request.bedrooms_booked)}-bedroom option` : '',
                action,
                refund: outcome.refundOwed,
            });
        }

        return new Response(JSON.stringify({
            success: true,
            data: {
                request_id: requestId,
                status: outcome.status,
                booking_id: outcome.bookingId,
                confirmed_with_payment: !!outcome.confirmedWithPayment,
                arrival_email: outcome.arrivalEmail || null,
                refund_owed: !!outcome.refundOwed,
            },
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
