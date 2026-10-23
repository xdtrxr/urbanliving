import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// Public origin used in outbound email links. Falls back to the prod domain
// so guest emails always have a working link even if APP_BASE_URL isn't set.
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const bookingLink = (bookingId: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(bookingId)}#booking-${encodeURIComponent(bookingId)}`;
const propertyLink = (propertyId: string) => `${APP_BASE_URL}/Property?id=${encodeURIComponent(propertyId)}`;
const searchLink = () => `${APP_BASE_URL}/Search`;

// Fire-and-forget push helper. Errors are swallowed so a push outage can
// never block the parent flow (approve, reject, support reply). Stable
// `tag` per event means a re-fire replaces the prior on-device notification
// rather than stacking duplicates.
async function tryPush(sdk: any, opts: {
    user_email: string;
    title: string;
    body?: string;
    url?: string;
    tag?: string;
}) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
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
    console.log('=== TELEGRAM WEBHOOK CALLED ===');

    // Verify the secret token Telegram includes when the webhook was registered
    // with `secret_token=...`. Without this, anyone who knows the URL can forge
    // approve/reject callback queries.
    const expectedSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
    if (expectedSecret) {
        const incomingSecret = req.headers.get('x-telegram-bot-api-secret-token') || '';
        if (incomingSecret !== expectedSecret) {
            console.warn('Telegram webhook secret mismatch — rejecting');
            return new Response(JSON.stringify({ ok: false }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    } else {
        console.warn('TELEGRAM_WEBHOOK_SECRET not configured — webhook is unauthenticated');
    }

    // Base44 supplies the SDK client with service-role access automatically.
    // No BASE44_APP_ID / BASE44_SERVICE_ROLE_KEY env vars needed.
    const base44 = createClientFromRequest(req);

    try {
        const update = await req.json();
        console.log('Telegram update received');

        // Branch 1: admin replied to one of our force_reply prompts.
        // We embed a [#TAG:<id>] token in the prompt to know what we're being
        // answered about.
        if (update.message && update.message.reply_to_message && update.message.text) {
            const prompt = update.message.reply_to_message.text || '';

            const supMatch = prompt.match(/\[#SM:([a-zA-Z0-9_-]+)\]/);
            if (supMatch) {
                return await handleAdminTextReply({
                    base44,
                    supportMessageId: supMatch[1],
                    adminText: update.message.text,
                    chatId: update.message.chat.id,
                    replyToMessageId: update.message.message_id,
                });
            }

            const hostMatch = prompt.match(/\[#HOST:([a-zA-Z0-9_-]+)\]/);
            if (hostMatch) {
                return await handleAdminHostReply({
                    base44,
                    bookingId: hostMatch[1],
                    adminText: update.message.text,
                    chatId: update.message.chat.id,
                });
            }
        }

        if (!update.callback_query) {
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const callbackQuery = update.callback_query;
        const callbackData = callbackQuery.data || '';
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;

        console.log('Callback data:', callbackData);

        // Branch 2: support draft actions (sup_send / sup_edit / sup_replace)
        const supCbMatch = callbackData.match(/^sup_(send|edit|replace)_(.+)$/);
        if (supCbMatch) {
            return await handleSupportCallback({
                base44,
                action: supCbMatch[1] as 'send' | 'edit' | 'replace',
                supportMessageId: supCbMatch[2],
                callbackQueryId: callbackQuery.id,
                chatId,
                originalMessageText: callbackQuery.message.text || '',
                originalMessageId: messageId,
            });
        }

        // Branch 2b: "set as default" choice after host details were filled
        const hostDefaultMatch = callbackData.match(/^host_default_(yes|no)_(.+)$/);
        if (hostDefaultMatch) {
            return await handleHostDefaultCallback({
                base44,
                choice: hostDefaultMatch[1] as 'yes' | 'no',
                bookingId: hostDefaultMatch[2],
                callbackQueryId: callbackQuery.id,
                chatId,
                originalMessageId: messageId,
                originalMessageText: callbackQuery.message.text || '',
            });
        }

        // Branch 2c: ride approve/reject.
        // MUST sit before the generic split('_') below — that split would
        // read "ride_approve_<id>" as action="ride", and the request would be
        // rejected as invalid callback data.
        const rideMatch = callbackData.match(/^ride_(approve|reject)_(.+)$/);
        if (rideMatch) {
            return await handleRideDecision({
                base44,
                approve: rideMatch[1] === 'approve',
                rideId: rideMatch[2],
                callbackQueryId: callbackQuery.id,
                chatId,
                messageId,
                originalText: callbackQuery.message.text || callbackQuery.message.caption || '',
            });
        }

        // Branch 2d: the two buttons on a "payment on hold" alert.
        // MUST sit before the generic split('_') below, like the ride branch:
        // that split would read "held_confirm_<id>" as action="held".
        // The same two buttons on a held RIDE payment carry "held_ride_".
        const heldRideMatch = callbackData.match(/^held_ride_(confirm|refund)_(.+)$/);
        if (heldRideMatch) {
            return await handleHeldPayment({
                base44,
                confirm: heldRideMatch[1] === 'confirm',
                bookingId: heldRideMatch[2],
                ride: true,
                callbackQueryId: callbackQuery.id,
                chatId,
                messageId,
                originalText: callbackQuery.message.text || '',
            });
        }
        const heldMatch = callbackData.match(/^held_(confirm|refund)_(.+)$/);
        if (heldMatch) {
            return await handleHeldPayment({
                base44,
                confirm: heldMatch[1] === 'confirm',
                bookingId: heldMatch[2],
                callbackQueryId: callbackQuery.id,
                chatId,
                messageId,
                originalText: callbackQuery.message.text || '',
            });
        }

        // Branch 3: legacy availability approve/reject
        const [action, requestId] = callbackData.split('_');

        if (!['approve', 'reject'].includes(action) || !requestId) {
            throw new Error('Invalid callback data');
        }

        // Fetch the request via SDK
        const request = isId(requestId) ? await getOrNull(base44.asServiceRole.entities.AvailabilityRequest, requestId) : null;
        if (!request) {
            console.error('AvailabilityRequest not found:', requestId);
            await answerCallbackQuery(callbackQuery.id, 'Request not found.');
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (request.status !== 'pending') {
            await answerCallbackQuery(callbackQuery.id, 'This request has already been processed.');
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // A decision is two writes. If one fails, say so here: this handler's
        // outer catch answers Telegram "ok" and tells the admin nothing, and
        // the admin would take the press for done.
        let outcome: any;
        try {
            outcome = await decideRequest(base44, request, action as 'approve' | 'reject');
        } catch (decideErr) {
            console.error(`Deciding request ${requestId} failed part-way:`, decideErr);
            await answerCallbackQuery(callbackQuery.id, 'Not done. See the message below.');
            await telegramPlain('sendMessage', { chat_id: chatId, text: 'Not done: something failed part-way through. Press the button again to finish it.' });
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (!outcome.ok) {
            // Nothing was decided. The pop-up is short, so the reason is also
            // posted in the chat where it can be read in full.
            await answerCallbackQuery(callbackQuery.id, 'Not done. See the message below.');
            await telegramPlain('sendMessage', { chat_id: chatId, text: `Not done: ${outcome.error}` });
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const matchedBookingId: string | null = outcome.bookingId || null;
        console.log(`✅ Request ${requestId} ${outcome.status}`);

        // Update Telegram message in place
        const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
        const statusEmoji = action === 'approve' ? '✅' : '❌';
        const statusText = action === 'approve' ? 'APPROVED' : 'REJECTED';

        const statusNote = outcome.confirmedWithPayment
            ? 'APPROVED by admin. The booking is paid and confirmed.'
            : `${statusText} by admin`;
        const updatedMessage = `${statusEmoji} ${statusText}\n\n${callbackQuery.message.text || ''}\n\nStatus: ${statusNote}`;

        await fetch(`https://api.telegram.org/bot${telegramBotToken}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text: updatedMessage,
            }),
        });

        await answerCallbackQuery(callbackQuery.id, `Request ${statusText.toLowerCase()} successfully!`);

        if (outcome.refundOwed) {
            await tellAdminRefundOwed(outcome.bookingId, request.user_email, outcome.refundOwed);
        }

        // Nothing more for the guest when the booking was confirmed with a
        // payment on hold (verifyPaystackPayment has sent the arrival details;
        // "you have an hour to pay" would be wrong), or when they had
        // cancelled the request themselves.
        if (outcome.confirmedWithPayment || outcome.guestCancelled) {
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Email the guest about the decision
        try {
            await emailGuestDecision({
                base44,
                guestEmail: request.user_email,
                guestName: request.user_name,
                propertyTitle: request.property_title,
                propertyId: request.property_id,
                bookingId: matchedBookingId,
                checkIn: request.check_in,
                checkOut: request.check_out,
                optionLabel: Number(request.bedrooms_booked) > 0 ? `the ${Number(request.bedrooms_booked)}-bedroom option` : '',
                action: action as 'approve' | 'reject',
                refund: outcome.refundOwed,
            });
        } catch (emailErr) {
            console.error('Failed to email guest about decision:', emailErr);
        }

        // Push the guest. Deep-link into the specific booking when we found
        // one — falls back to the bookings list if the match lookup missed.
        const pushUrl = matchedBookingId
            ? `/Bookings#booking-${matchedBookingId}`
            : '/Bookings';
        if (action === 'approve') {
            await tryPush(base44, {
                user_email: request.user_email,
                title: '✅ Booking approved',
                body: `"${request.property_title}" is yours for ${request.check_in} → ${request.check_out}. Tap to pay within 1 hour.`,
                url: pushUrl,
                tag: `booking-decision-${matchedBookingId || requestId}`,
            });
        } else {
            await tryPush(base44, {
                user_email: request.user_email,
                title: '❌ Booking declined',
                body: `"${request.property_title}" isn\'t available for those dates. Tap to find another stay.`,
                url: '/Search',
                tag: `booking-decision-${matchedBookingId || requestId}`,
            });
        }

        return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('=== TELEGRAM WEBHOOK ERROR ===', error);
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
});

interface GuestDecisionParams {
    base44: any;
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
}

async function emailGuestDecision(p: GuestDecisionParams) {
    if (!p.guestEmail) {
        console.warn('No guest email — skipping decision notification');
        return;
    }

    const subject = p.action === 'approve'
        ? `Approved: your booking for ${p.propertyTitle}`
        : `Update on your booking request for ${p.propertyTitle}`;

    const bookingHref = p.bookingId ? bookingLink(p.bookingId) : `${APP_BASE_URL}/Bookings`;
    const propertyHref = p.propertyId ? propertyLink(p.propertyId) : null;

    const body = p.action === 'approve'
        ? `Hi ${p.guestName || 'there'},\n\n` +
          `Great news — your availability request for "${p.propertyTitle}" (${p.checkIn} → ${p.checkOut}${p.optionLabel ? `, ${p.optionLabel}` : ''}) has been approved.\n\n` +
          `🔖 Status: APPROVED — AWAITING PAYMENT\n` +
          `👉 View & pay: ${bookingHref}\n` +
          (propertyHref ? `🏠 Property page: ${propertyHref}\n` : '') +
          `\nYou have 1 hour to complete payment from when you open the payment page (and a 3-hour hard cap from this approval). After that the booking will be automatically cancelled.\n\n` +
          `— Urban Stays`
        : `Hi ${p.guestName || 'there'},\n\n` +
          `Unfortunately, "${p.propertyTitle}" is not available for ${p.checkIn} → ${p.checkOut}.\n\n` +
          (p.refund ? `We received your payment of ₦${p.refund.amountNGN.toLocaleString()} (reference ${p.refund.reference}). It will be refunded in full.\n\n` : '') +
          `🔖 Status: CANCELLED\n` +
          `👉 View this booking: ${bookingHref}\n` +
          `🔎 Find another property: ${searchLink()}\n\n` +
          `— Urban Stays`;

    await p.base44.integrations.Core.SendEmail({
        to: p.guestEmail,
        subject,
        body,
        from_name: 'Urban Stays',
    });
    console.log(`✅ Guest decision email sent to ${p.guestEmail}`);
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
    const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    await fetch(`https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: text,
        }),
    });
}

// === Payment on hold ===
// verifyPaystackPayment and paystackWebhook post a "payment on hold" alert
// with two buttons when money arrives for a booking it may not confirm. This
// is where the buttons land. Both hand the work to the function that owns it,
// carrying the internal secret, because there is no admin session here:
// Confirm goes to verifyPaystackPayment (confirm_held), Mark refunded to
// markHeldPaymentRefunded. If the secret is not configured both refuse, and
// the admin is pointed at the Admin screen, which works from their login.

// Plain text on purpose. These messages carry Paystack references, ids and
// the server's own sentences; one stray underscore and Telegram refuses a
// Markdown message outright, and here that message is the admin's only word
// on what happened to a payment.
async function telegramPlain(method: 'sendMessage' | 'editMessageText', payload: Record<string, unknown>) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!token) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const answer = await res.json().catch(() => null);
        if (!answer || !answer.ok) console.error(`Telegram ${method} was not taken:`, answer);
    } catch (e) {
        console.error(`Telegram ${method} failed:`, e);
    }
}

interface HeldPaymentParams {
    base44: any;
    confirm: boolean;
    bookingId: string;
    // A ride rather than a stay: bookingId is then the ride's id.
    ride?: boolean;
    callbackQueryId: string;
    chatId: number;
    messageId: number;
    originalText: string;
}

async function handleHeldPayment(p: HeldPaymentParams): Promise<Response> {
    const done = () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    const internal_secret = Deno.env.get('INTERNAL_FUNCTION_SECRET') || '';
    let said: any = {};
    try {
        const answer = p.ride
            ? (p.confirm
                ? await p.base44.functions.invoke('verifyRidePayment', { ride_booking_id: p.bookingId, confirm_held: true, internal_secret })
                : await p.base44.functions.invoke('markHeldPaymentRefunded', { ride_booking_id: p.bookingId, internal_secret }))
            : (p.confirm
                ? await p.base44.functions.invoke('verifyPaystackPayment', { booking_id: p.bookingId, confirm_held: true, internal_secret })
                : await p.base44.functions.invoke('markHeldPaymentRefunded', { booking_id: p.bookingId, internal_secret }));
        said = (answer && answer.data && answer.data.data) || {};
    } catch (err) {
        const said = (err as any)?.response?.data;
        const status = (err as any)?.response?.status || (err as any)?.status;
        const reason = status === 403
            ? 'This button could not be used from Telegram. Open Admin and use "Payments on hold" there.'
            : (said?.error || 'It did not go through. Nothing was changed.');
        await answerCallbackQuery(p.callbackQueryId, 'Not done. See the message below.');
        await telegramPlain('sendMessage', { chat_id: p.chatId, text: `Not done: ${reason}` });
        return done();
    }
    // Only what is known to have happened. The email to the guest can fail,
    // or wait on host details the property does not have, and "the guest has
    // been told" over a guest who was not is how nobody finds out.
    let note: string;
    if (p.confirm && p.ride) {
        note = said.already_paid
            ? 'This ride was already paid. Nothing was changed.'
            : said.guest_emailed
                ? 'CONFIRMED with this payment. The guest has been emailed. Assign a driver next.'
                : 'CONFIRMED with this payment. The email to the guest could NOT be sent: contact the guest yourself. Assign a driver next.';
    } else if (p.confirm) {
        note = said.already_paid
            ? 'This booking was already paid. Nothing was changed.'
            : said.arrival_email === 'sent'
                ? 'CONFIRMED with this payment. The guest has been sent their arrival details.'
                : said.arrival_email === 'waiting_for_host_details'
                    ? 'CONFIRMED with this payment. The arrival email is WAITING for the host details: answer the prompt in this chat.'
                    : 'CONFIRMED with this payment. The arrival email could NOT be sent: contact the guest yourself.';
    } else {
        note = said.already
            ? 'This payment was already marked refunded.'
            : said.guest_emailed
                ? 'MARKED REFUNDED. The guest has been emailed.'
                : 'MARKED REFUNDED. The email to the guest could NOT be sent: tell them yourself.';
    }
    // Editing the text also takes the two buttons off, so it cannot be pressed twice.
    await telegramPlain('editMessageText', { chat_id: p.chatId, message_id: p.messageId, text: `${p.originalText}\n\n${note}` });
    await answerCallbackQuery(p.callbackQueryId, p.confirm
        ? (said.already_paid ? 'Already paid.' : (p.ride ? 'Ride confirmed.' : 'Booking confirmed.'))
        : 'Marked refunded.');
    return done();
}

// === Support draft handling ===
// User posts in a SupportTicket → draftSupportReply pushes a Nova draft to
// admin Telegram with three inline buttons. The button taps are routed here.

interface SupportCallbackParams {
    base44: any;
    action: 'send' | 'edit' | 'replace';
    supportMessageId: string;
    callbackQueryId: string;
    chatId: number;
    originalMessageText: string;
    originalMessageId: number;
}

async function handleSupportCallback(p: SupportCallbackParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    const userMessage = isId(p.supportMessageId) ? await getOrNull(p.base44.asServiceRole.entities.SupportMessage, p.supportMessageId) : null;
    if (!userMessage) {
        await answerCallbackQuery(p.callbackQueryId, 'Message not found.');
        return jsonResp({ ok: true });
    }
    if (userMessage.nova_draft_status && userMessage.nova_draft_status !== 'pending') {
        await answerCallbackQuery(p.callbackQueryId, 'Already actioned.');
        return jsonResp({ ok: true });
    }

    if (p.action === 'send') {
        const draft = userMessage.nova_draft || '';
        if (!draft) {
            await answerCallbackQuery(p.callbackQueryId, 'No draft to send.');
            return jsonResp({ ok: true });
        }
        await postAdminReply(p.base44, userMessage.ticket_id, draft);
        await p.base44.asServiceRole.entities.SupportMessage.update(p.supportMessageId, {
            nova_draft_status: 'sent_as_is',
        });
        await editTelegramMessage(token, p.chatId, p.originalMessageId,
            `✅ *SENT — Nova draft used as-is*\n\n${p.originalMessageText}`);
        await answerCallbackQuery(p.callbackQueryId, 'Sent to user.');
        return jsonResp({ ok: true });
    }

    // edit or replace — both ask the admin to reply with the final text.
    const prompt = p.action === 'edit'
        ? `✏️ *Edit the draft below — your reply replaces Nova's text and goes to the user.*\n\n*Current draft:*\n${userMessage.nova_draft || '(empty)'}\n\n[#SM:${p.supportMessageId}]`
        : `🔁 *Type a fresh reply — Nova's draft will be discarded.*\n\n*User asked:*\n${userMessage.message.slice(0, 400)}\n\n[#SM:${p.supportMessageId}]`;

    await sendTelegramMessage(token, p.chatId, prompt, { force_reply: true, selective: false });
    await answerCallbackQuery(p.callbackQueryId, p.action === 'edit' ? 'Reply to edit.' : 'Reply with new text.');
    return jsonResp({ ok: true });
}

interface AdminReplyParams {
    base44: any;
    supportMessageId: string;
    adminText: string;
    chatId: number;
    replyToMessageId: number;
}

async function handleAdminTextReply(p: AdminReplyParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    const userMessage = isId(p.supportMessageId) ? await getOrNull(p.base44.asServiceRole.entities.SupportMessage, p.supportMessageId) : null;
    if (!userMessage) {
        await sendTelegramMessage(token, p.chatId, '⚠️ Could not find that support message.', {});
        return jsonResp({ ok: true });
    }
    if (userMessage.nova_draft_status && userMessage.nova_draft_status !== 'pending') {
        await sendTelegramMessage(token, p.chatId, '⚠️ This message has already been actioned.', {});
        return jsonResp({ ok: true });
    }

    const reply = (p.adminText || '').trim();
    if (!reply) return jsonResp({ ok: true });

    // Was this admin replying to an edit prompt or a replace prompt? We can
    // tell from the prompt prefix, but the outcome is the same operationally:
    // their text becomes the response. We mark 'edited' vs 'replaced' based
    // on whether they kept any of the original draft text.
    const looksLikeEdit = userMessage.nova_draft && reply.includes(userMessage.nova_draft.slice(0, 30));
    await postAdminReply(p.base44, userMessage.ticket_id, reply);
    await p.base44.asServiceRole.entities.SupportMessage.update(p.supportMessageId, {
        nova_draft_status: looksLikeEdit ? 'edited' : 'replaced',
    });
    await sendTelegramMessage(token, p.chatId,
        `✅ Reply sent to user (${looksLikeEdit ? 'edited' : 'replaced'} Nova draft).`, {});
    return jsonResp({ ok: true });
}

async function postAdminReply(base44: any, ticketId: string, message: string) {
    // Persist as a human_agent SupportMessage so the user sees it in their
    // ticket view. Also bump the ticket from 'open' to 'in_progress' if
    // it was the first admin response.
    await base44.asServiceRole.entities.SupportMessage.create({
        ticket_id: ticketId,
        sender_type: 'human_agent',
        message,
        message_type: 'text',
        automated_response: false,
    });
    let ticketOwnerEmail: string | undefined;
    try {
        const ticket = isId(ticketId) ? await getOrNull(base44.asServiceRole.entities.SupportTicket, ticketId) : null;
        if (ticket) {
            ticketOwnerEmail = ticket.user_email;
            if (ticket.status === 'open') {
                await base44.asServiceRole.entities.SupportTicket.update(ticketId, { status: 'in_progress' });
            }
        }
    } catch (e) {
        console.warn('Failed to bump ticket status:', (e as Error).message);
    }

    // Push the user — their support thread got a reply. Keep the preview
    // short (push payloads are constrained) and link them straight into
    // Support so they land on the conversation.
    if (ticketOwnerEmail) {
        const preview = message.length > 80 ? `${message.slice(0, 80)}…` : message;
        await tryPush(base44, {
            user_email: ticketOwnerEmail,
            title: '💬 Reply from Urban Stays',
            body: preview,
            url: `/Support?ticket=${encodeURIComponent(ticketId)}`,
            tag: `support-${ticketId}`,
        });
    }
}

async function sendTelegramMessage(token: string | undefined, chatId: number, text: string, replyMarkup: Record<string, unknown>) {
    if (!token) return;
    const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'Markdown' };
    if (replyMarkup && Object.keys(replyMarkup).length > 0) {
        payload.reply_markup = replyMarkup;
    }
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (e) {
        console.error('sendTelegramMessage failed:', e);
    }
}

async function editTelegramMessage(token: string | undefined, chatId: number, messageId: number, text: string) {
    if (!token) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' }),
        });
    } catch (e) {
        console.error('editTelegramMessage failed:', e);
    }
}

// === Host-details fallback handling ===
// requestHostDetails sent admin a force_reply prompt with [#HOST:<bookingId>].
// Admin replies with two-line text (line 1 = phone, line 2+ = arrival
// instructions). We parse, write per-booking overrides, send the arrival
// email, and then ask "Save as default for the property?" with inline buttons.

interface HostReplyParams {
    base44: any;
    bookingId: string;
    adminText: string;
    chatId: number;
}

async function handleAdminHostReply(p: HostReplyParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    const booking = isId(p.bookingId) ? await getOrNull(p.base44.asServiceRole.entities.Booking, p.bookingId) : null;
    if (!booking) {
        await sendTelegramMessage(token, p.chatId, '⚠️ Could not find that booking.', {});
        return jsonResp({ ok: true });
    }
    if (booking.host_details_status === 'filled_by_admin' || booking.host_details_status === 'default_saved') {
        await sendTelegramMessage(token, p.chatId, '⚠️ This booking already has host details on file.', {});
        return jsonResp({ ok: true });
    }

    const lines = (p.adminText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return jsonResp({ ok: true });

    const phoneLine = lines[0];
    const instructionsLines = lines.slice(1);
    if (instructionsLines.length === 0) {
        await sendTelegramMessage(token, p.chatId,
            '⚠️ Please reply with TWO sections: phone on line 1, then arrival instructions on the next lines.', {});
        return jsonResp({ ok: true });
    }
    const arrivalInstructions = instructionsLines.join('\n');

    // Persist as per-booking overrides + flag for follow-up step
    await p.base44.asServiceRole.entities.Booking.update(p.bookingId, {
        host_phone_override: phoneLine,
        arrival_instructions_override: arrivalInstructions,
        host_details_status: 'filled_by_admin',
    });

    // Send the arrival email using the new overrides
    let emailOk = false;
    try {
        const fresh = await p.base44.asServiceRole.entities.Booking.get(p.bookingId);
        const result = await sendArrivalEmailFromBooking(p.base44, fresh);
        emailOk = result.sent;
    } catch (err) {
        console.error('sendArrivalEmailFromBooking failed:', err);
    }

    // Ask whether to save as Property default
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: p.chatId,
            text: emailOk
                ? `✅ Arrival email sent to ${booking.guest_email}.\n\nSave these as the property's default so future bookings don't need to ask?`
                : `⚠️ Saved host details, but email send failed. Save these as the property's default?`,
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Save as default', callback_data: `host_default_yes_${p.bookingId}` },
                    { text: '🚫 Just this booking', callback_data: `host_default_no_${p.bookingId}` },
                ]],
            },
        }),
    });

    return jsonResp({ ok: true });
}

interface HostDefaultParams {
    base44: any;
    choice: 'yes' | 'no';
    bookingId: string;
    callbackQueryId: string;
    chatId: number;
    originalMessageId: number;
    originalMessageText: string;
}

async function handleHostDefaultCallback(p: HostDefaultParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    const booking = isId(p.bookingId) ? await getOrNull(p.base44.asServiceRole.entities.Booking, p.bookingId) : null;
    if (!booking) {
        await answerCallbackQuery(p.callbackQueryId, 'Booking not found.');
        return jsonResp({ ok: true });
    }
    if (booking.host_details_status === 'default_saved') {
        await answerCallbackQuery(p.callbackQueryId, 'Already saved.');
        return jsonResp({ ok: true });
    }

    if (p.choice === 'yes') {
        try {
            const propertyUpdate: Record<string, unknown> = {};
            if (booking.host_phone_override) propertyUpdate.host_phone = booking.host_phone_override;
            if (booking.host_name_override) propertyUpdate.host_name = booking.host_name_override;
            if (booking.arrival_instructions_override) propertyUpdate.arrival_instructions = booking.arrival_instructions_override;
            if (Object.keys(propertyUpdate).length > 0) {
                await p.base44.asServiceRole.entities.Property.update(booking.property_id, propertyUpdate);
            }
            await p.base44.asServiceRole.entities.Booking.update(p.bookingId, {
                host_details_status: 'default_saved',
            });
            await editTelegramMessage(token, p.chatId, p.originalMessageId,
                `${p.originalMessageText}\n\n✅ Saved as the property's default. Future bookings will use these automatically.`);
            await answerCallbackQuery(p.callbackQueryId, 'Saved as default.');
        } catch (err) {
            console.error('Failed to save Property default:', err);
            await answerCallbackQuery(p.callbackQueryId, 'Save failed.');
        }
    } else {
        await editTelegramMessage(token, p.chatId, p.originalMessageId,
            `${p.originalMessageText}\n\n🚫 Kept for this booking only.`);
        await answerCallbackQuery(p.callbackQueryId, 'Per-booking only.');
    }

    return jsonResp({ ok: true });
}

// Local copy of the email-sender so telegramWebhook is self-contained.
// Mirrors the helper in verifyPaystackPayment / paystackWebhook.
async function sendArrivalEmailFromBooking(sdk: any, booking: any): Promise<{ sent: boolean }> {
    try {
        const property = await sdk.asServiceRole.entities.Property.get(booking.property_id);
        if (!property) return { sent: false };

        const hostPhone = booking.host_phone_override || property.host_phone || '';
        const hostName = booking.host_name_override || property.host_name || '';
        const arrivalInstructions = booking.arrival_instructions_override || property.arrival_instructions || '';
        if (!hostPhone || !arrivalInstructions) return { sent: false };

        const loc = property.location || {};
        const fullAddress = [loc.address, loc.city, loc.country].filter(Boolean).join(', ');
        const mapsLink = loc.coordinates?.lat && loc.coordinates?.lng
            ? `https://www.google.com/maps?q=${loc.coordinates.lat},${loc.coordinates.lng}`
            : (fullAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}` : null);
        const mapsBlock = mapsLink ? `\nMap: ${mapsLink}` : '';

        const body = `Hi ${booking.guest_name || 'there'},

Payment confirmed — your booking at "${property.title}" is locked in. 🎉

🔖 Status: CONFIRMED & PAID
👉 View your booking: ${bookingLink(booking.id)}
🏠 Property page: ${propertyLink(booking.property_id)}

📍 Address: ${fullAddress || 'See app for details'}${mapsBlock}
🗓 Check-in: ${booking.check_in}
🗓 Check-out: ${booking.check_out}
👥 Guests: ${Number(booking.guests) || 1}${Number(booking.bedrooms_booked) > 0 ? `\n🛏 Booked: the ${Number(booking.bedrooms_booked)}-bedroom option` : ''}

📞 Call your host on arrival: ${hostName || 'Host'} — ${hostPhone}

Arrival instructions from the host:
${arrivalInstructions}

Have a smooth trip — see you soon.

— Urban Stays`;

        await sdk.integrations.Core.SendEmail({
            to: booking.guest_email,
            subject: `You're checked in: arrival details for ${property.title}`,
            body,
            from_name: 'Urban Stays',
        });
        return { sent: true };
    } catch (err) {
        console.error('sendArrivalEmailFromBooking failed:', err);
        return { sent: false };
    }
}


// ── Held ride decisions ──────────────────────────────────────────────────────
// LOCKSTEP: from this line to "end of held ride decisions" the text is the
// same in decideRideBooking and telegramWebhook; scripts/check-ride-payment.mjs
// fails if the two copies differ.
//
// A guest can pay before anyone has approved the ride; the payment is then
// held (see ridePaymentVerdict in verifyRidePayment). Approving such a ride
// confirms it with that payment, through verifyRidePayment's confirm path,
// the one way a held payment becomes a confirmed ride, and at the price that
// was paid. Declining it cancels the ride and leaves a refund owed, which the
// admin is reminded of here.

function rideHasHeldPayment(ride: any) {
    return !!ride && ride.payment_status === 'pending_confirmation' && !!ride.transaction_hash;
}

// { ok: true, guestEmailed } or { ok: false, code, error }.
async function confirmRideWithHeldPayment(sdk: any, rideId: string) {
    try {
        const answer = await sdk.functions.invoke('verifyRidePayment', {
            ride_booking_id: rideId,
            confirm_held: true,
            internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '',
        });
        const data = (answer && answer.data && answer.data.data) || {};
        return { ok: true, guestEmailed: !!data.guest_emailed };
    } catch (err) {
        const said = (err as any)?.response?.data;
        if (said && said.code === 'ADMIN_ONLY') {
            return {
                ok: false,
                code: 'ADMIN_ONLY',
                error: 'The payment on hold could not be confirmed from here. Open Admin and press "Confirm" on the Payments on hold card.',
            };
        }
        return {
            ok: false,
            code: (said && said.code) || 'HELD_NOT_CONFIRMED',
            error: (said && said.error) || 'The payment on hold could not be confirmed. Nothing was changed.',
        };
    }
}

// Plain text, with the button that records the refund once it has been made.
async function tellAdminRideRefundOwed(ride: any) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) {
        console.error(`Ride ${ride.id} was declined with a payment on hold and Telegram is not configured: nobody was reminded of the refund.`);
        return;
    }
    const amountNGN = Number(ride.total_price) || 0;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `REFUND OWED. Ride ${ride.id} was declined, and the guest's payment of ₦${amountNGN.toLocaleString()} (ref ${ride.transaction_hash}) is still on hold.\n`
                    + `Guest: ${ride.guest_name || 'no name'} (${ride.guest_email})\n\n`
                    + 'Refund it in Paystack, then press Mark refunded.',
                reply_markup: { inline_keyboard: [[{ text: 'Mark refunded', callback_data: `held_ride_refund_${ride.id}` }]] },
            }),
        });
    } catch (err) {
        console.error(`Refund-owed reminder failed for ride ${ride.id}:`, err);
    }
}
// ── end of held ride decisions ───────────────────────────────────────────────

// === Ride decision handling ===
// Twin of base44/functions/decideRideBooking/entry.ts, which serves the
// in-app Admin panel. Base44 function dirs are isolated and cannot share a
// module, so the transition is duplicated. KEEP THE TWO IN LOCKSTEP —
// the equivalent apartment pair has already drifted.
//
// Unlike the apartment flow there is no AvailabilityRequest: the decision
// lands on the RideBooking row and `approved_at` is the idempotency guard.
//
// ONE DELIBERATE DIVERGENCE, so it does not read as drift: decideRideBooking
// can confirm a ride at a price different from the guest's estimate, and can
// attach alternative vehicles to a rejection. This path can do neither — an
// inline keyboard has nowhere to type a figure or pick a car. Approving here
// therefore always accepts the estimate as-is, which the admin Telegram
// message says out loud. Price changes and alternatives are Admin-panel only.

interface RideDecisionParams {
    base44: any;
    approve: boolean;
    rideId: string;
    callbackQueryId: string;
    chatId: number;
    messageId: number;
    originalText: string;
}

async function handleRideDecision(p: RideDecisionParams): Promise<Response> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const jsonResp = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
    });

    const RIDE_PAYMENT_WINDOW_MS = 60 * 60 * 1000;
    const APPROVE_MSG = 'Your ride is confirmed as available — complete payment to lock it in.';
    const REJECT_MSG = 'Sorry, this vehicle is not available for that window. Please try a different time or another vehicle.';

    // A plain id only: "ride_approve_../Booking/<id>" would approve a stay.
    const ride = isId(p.rideId) ? await getOrNull(p.base44.asServiceRole.entities.RideBooking, p.rideId) : null;
    if (!ride) {
        await answerCallbackQuery(p.callbackQueryId, 'Ride not found.');
        return jsonResp({ ok: true });
    }
    if (ride.status !== 'pending' || ride.approved_at) {
        await answerCallbackQuery(p.callbackQueryId, 'This ride has already been actioned.');
        return jsonResp({ ok: true });
    }

    // The guest paid before this decision (see the held ride decisions
    // block). Approving confirms the ride with that money, which also tells
    // the guest; declining goes on below and leaves a refund owed.
    const heldPayment = rideHasHeldPayment(ride);
    if (heldPayment && p.approve) {
        const confirmed: any = await confirmRideWithHeldPayment(p.base44, ride.id);
        if (!confirmed.ok) {
            await answerCallbackQuery(p.callbackQueryId, 'Not done. See the message below.');
            await telegramPlain('sendMessage', { chat_id: p.chatId, text: `Not done: ${confirmed.error}` });
            return jsonResp({ ok: true });
        }
        const note = confirmed.guestEmailed
            ? 'APPROVED and CONFIRMED with the payment that was on hold. The guest has been emailed.'
            : 'APPROVED and CONFIRMED with the payment that was on hold. The email to the guest could NOT be sent: tell them yourself.';
        await telegramPlain('sendMessage', { chat_id: p.chatId, text: `Ride ${ride.id}: ${note}` });
        await answerCallbackQuery(p.callbackQueryId, 'Ride confirmed with the payment on hold.');
        return jsonResp({ ok: true });
    }

    const nowIso = new Date().toISOString();
    await p.base44.asServiceRole.entities.RideBooking.update(p.rideId, p.approve
        ? {
            approved_at: nowIso,
            payment_deadline: new Date(Date.now() + RIDE_PAYMENT_WINDOW_MS).toISOString(),
            admin_response: APPROVE_MSG,
        }
        : {
            status: 'cancelled',
            cancel_reason: 'admin_rejected',
            admin_response: REJECT_MSG,
        });

    const banner = p.approve ? '✅ *APPROVED*' : '❌ *REJECTED*';
    // The ride card is usually sent as a photo, so its text lives in a
    // caption and editMessageText will fail. Try text, then caption.
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: p.chatId, message_id: p.messageId,
                text: `${banner}\n\n${p.originalText}`, parse_mode: 'Markdown',
            }),
        });
        const data = await res.json();
        if (!data.ok) {
            await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: p.chatId, message_id: p.messageId,
                    caption: `${banner}\n\n${p.originalText}`, parse_mode: 'Markdown',
                }),
            });
        }
    } catch (err) {
        console.warn('Ride card edit failed (non-fatal):', err);
    }

    await answerCallbackQuery(p.callbackQueryId, p.approve ? 'Ride approved.' : 'Ride rejected.');

    // Guest email
    try {
        const when = new Date(ride.start_at).toLocaleString('en-GB', {
            timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short',
        });
        const body = p.approve
            ? `Hi ${ride.guest_name || 'there'},\n\n` +
              `Good news — ${ride.vehicle_name} is available for your ride.\n\n` +
              `🔖 Status: APPROVED — AWAITING PAYMENT\n` +
              `🚗 Vehicle: ${ride.vehicle_name}\n` +
              `🕒 Pickup: ${when}\n` +
              `💰 Total: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n` +
              (ride.extra_hour_rate_ngn
                  ? `⏱ Extra time: ₦${Number(ride.extra_hour_rate_ngn).toLocaleString()} per hour beyond your booking, settled after the trip\n`
                  : '') +
              `\n👉 Pay now: ${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(ride.id)}#ride-${encodeURIComponent(ride.id)}\n\n` +
              `You have 1 hour from opening the payment page to complete payment (3-hour cap from this approval), after which the booking is released.\n\n` +
              `— Urban Stays`
            : `Hi ${ride.guest_name || 'there'},\n\n` +
              `Unfortunately ${ride.vehicle_name} isn't available for ${when}.\n\n` +
              `🔖 Status: CANCELLED\n` +
              // The guest paid before the decision; the money goes back.
              (heldPayment ? `💸 Your payment of ₦${(Number(ride.total_price) || 0).toLocaleString()} will be refunded in full. It can take a few working days to reach you once it is sent.\n` : '') +
              `🔎 Browse other vehicles: ${APP_BASE_URL}/PlanTrip\n\n` +
              `— Urban Stays`;
        await p.base44.integrations.Core.SendEmail({
            to: ride.guest_email,
            subject: p.approve
                ? `Approved: your ride in the ${ride.vehicle_name}`
                : 'Update on your ride request',
            body,
            from_name: 'Urban Stays',
        });
    } catch (err) {
        console.warn('Ride decision email failed (non-fatal):', err);
    }

    if (heldPayment && !p.approve) await tellAdminRideRefundOwed(ride);
    await tryPush(p.base44, {
        user_email: ride.guest_email,
        title: p.approve ? '✅ Ride approved' : '❌ Ride unavailable',
        body: p.approve
            ? `${ride.vehicle_name} is held for you — tap to pay and lock it in.`
            : heldPayment
                ? `${ride.vehicle_name} isn't free for that window. Your payment will be refunded in full.`
                : `${ride.vehicle_name} isn't free for that window. Tap to try another.`,
        url: p.approve ? `/Bookings#ride-${ride.id}` : '/PlanTrip',
        tag: `ride-decision-${ride.id}`,
    });

    return jsonResp({ ok: true });
}
