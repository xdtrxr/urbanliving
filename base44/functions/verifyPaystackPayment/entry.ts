import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// IMPORTANT: This function and base44/functions/paystackWebhook/entry.ts share
// the post-payment booking-update logic (mark paid, notify admin, inline
// referral cash + loyalty bonus). Base44 functions are isolated dirs, so the
// logic is duplicated. Keep them in lockstep when changing either path.

const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify';
const REFERRAL_RATE = 0.05;
const REFERRER_LOYALTY_BONUS = 250;
const GUEST_BOOKING_POINTS = 500;

// Public origin used in outbound email links. Falls back to the prod domain
// so guest emails always have a working link even if APP_BASE_URL isn't set
// (e.g. fresh dev environments).
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const bookingLink = (bookingId: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(bookingId)}#booking-${encodeURIComponent(bookingId)}`;
const propertyLink = (propertyId: string) => `${APP_BASE_URL}/Property?id=${encodeURIComponent(propertyId)}`;

// Awards the flat 500-point booking bonus to the guest, idempotent on
// (user_email, transaction_type='booking', booking_id). Mirrors the client-side
// awardBookingMilestones flow so guests still get credited if they close their
// tab before PaymentPage finishes. Same dedup key on both sides — re-runs noop.
async function awardGuestBookingPoints(sdk: any, guestEmail: string, bookingId: string) {
    try {
        const guests = await sdk.asServiceRole.entities.User.filter({ email: guestEmail });
        const guest = guests[0];
        if (!guest) {
            console.warn(`awardGuestBookingPoints: no User row for ${guestEmail}`);
            return;
        }
        const existing = await sdk.asServiceRole.entities.LoyaltyTransaction.filter({
            user_email: guestEmail,
            transaction_type: 'booking',
            booking_id: bookingId,
        });
        if (existing.length > 0) {
            console.log(`Guest ${guestEmail} already credited for booking ${bookingId}; skipping.`);
            return;
        }
        const newLoyalty = (Number(guest.loyalty_points) || 0) + GUEST_BOOKING_POINTS;
        await sdk.asServiceRole.entities.User.update(guest.id, { loyalty_points: newLoyalty });
        await sdk.asServiceRole.entities.LoyaltyTransaction.create({
            user_email: guestEmail,
            points_earned: GUEST_BOOKING_POINTS,
            transaction_type: 'booking',
            booking_id: bookingId,
            description: `Earned ${GUEST_BOOKING_POINTS} points from a booking`,
        });
        console.log(`🎁 Guest ${guestEmail} awarded ${GUEST_BOOKING_POINTS} points for booking ${bookingId}`);
    } catch (err) {
        console.warn('awardGuestBookingPoints failed (non-fatal):', err);
    }
}

// Sends the guest the property address, host phone, and arrival instructions
// immediately after a payment confirms. Mirrors the same helper in
// paystackWebhook — keep in lockstep when changing.
// Returns { sent, needs_admin } so the caller can decide whether to invoke
// requestHostDetails when host info is missing. Prefers per-booking overrides
// (filled by admin via Telegram for a previous incomplete-property booking)
// over Property defaults. Mirrored in paystackWebhook — keep in lockstep.
async function sendArrivalEmail(opts: {
    sdk: any;
    booking: any;
}): Promise<{ sent: boolean; needs_admin: boolean }> {
    const { sdk, booking } = opts;
    try {
        const property = await sdk.asServiceRole.entities.Property.get(booking.property_id);
        if (!property) {
            console.warn(`sendArrivalEmail: property ${booking.property_id} not found`);
            return { sent: false, needs_admin: false };
        }

        const hostPhone = booking.host_phone_override || property.host_phone || '';
        const hostName = booking.host_name_override || property.host_name || '';
        const arrivalInstructions = booking.arrival_instructions_override || property.arrival_instructions || '';

        // Gate: if either critical field is missing AND we don't have an
        // override yet, escalate to admin via Telegram instead of sending an
        // email with "not provided" in it.
        if (!hostPhone || !arrivalInstructions) {
            console.log(`sendArrivalEmail: missing host details for booking ${booking.id} (phone=${!!hostPhone}, instructions=${!!arrivalInstructions}) — needs admin input`);
            return { sent: false, needs_admin: true };
        }

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
👥 Guests: ${Number(booking.guests) || 1}

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
        console.log(`✅ Arrival email sent to ${booking.guest_email} for booking ${booking.id}`);
        return { sent: true, needs_admin: false };
    } catch (err) {
        console.error('sendArrivalEmail failed (non-fatal):', err);
        return { sent: false, needs_admin: false };
    }
}

// Fire-and-forget push to a user. Swallows all errors so a push outage
// can never block the parent business action. Stable `tag` lets a re-sent
// push for the same event replace the previous notification on-device
// instead of stacking duplicates.
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

async function notifyAdmin(opts: {
    bookingId: string;
    guestName: string;
    guestEmail: string;
    guestPhone?: string;
    propertyId: string;
    amountNGN: number;
    reference: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const text = `💰 *PAYMENT RECEIVED*\n\n` +
        `Booking \`${opts.bookingId}\`\n` +
        `• Guest: ${opts.guestName} (${opts.guestEmail})\n` +
        `• Mobile: ${opts.guestPhone || 'Not provided'}\n` +
        `• Property: \`${opts.propertyId}\`\n` +
        `• Amount: ₦${opts.amountNGN.toLocaleString()}\n` +
        `• Paystack ref: \`${opts.reference}\``;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Telegram payment notify failed:', err);
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

        const body = await req.json().catch(() => ({}));
        const bookingId = (body.booking_id || '').toString().trim();
        const reference = (body.reference || '').toString().trim();
        if (!bookingId || !reference) {
            return new Response(JSON.stringify({
                success: false,
                error: 'booking_id and reference are required',
            }), { status: 400, headers });
        }

        const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        if (!secretKey) {
            console.error('PAYSTACK_SECRET_KEY not configured');
            return new Response(JSON.stringify({
                success: false,
                error: 'Payment provider not configured',
            }), { status: 500, headers });
        }

        const booking = await base44.asServiceRole.entities.Booking.get(bookingId);
        if (!booking) {
            return new Response(JSON.stringify({ success: false, error: 'Booking not found' }), { status: 404, headers });
        }

        if (booking.guest_email !== user.email && user.role !== 'admin') {
            return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403, headers });
        }

        // Idempotency
        if (booking.payment_status === 'paid' && booking.status === 'confirmed') {
            return new Response(JSON.stringify({
                success: true,
                data: { already_paid: true, booking_id: bookingId },
            }), { status: 200, headers });
        }

        // Verify with Paystack (authoritative)
        const verifyRes = await fetch(`${PAYSTACK_VERIFY_URL}/${encodeURIComponent(reference)}`, {
            headers: { Authorization: `Bearer ${secretKey}` },
        });
        const verifyData = await verifyRes.json();

        if (!verifyRes.ok || !verifyData.status || verifyData.data?.status !== 'success') {
            console.warn('Paystack verify failed', verifyData);
            return new Response(JSON.stringify({
                success: false,
                error: 'Payment not verified',
                details: verifyData?.message || 'Paystack returned non-success',
            }), { status: 402, headers });
        }

        // Amount check (Paystack returns kobo)
        const expectedKobo = Math.round((Number(booking.total_price) || 0) * 100);
        const actualKobo = Number(verifyData.data?.amount) || 0;
        if (actualKobo !== expectedKobo) {
            console.error(`Amount mismatch: expected ${expectedKobo}, got ${actualKobo}`);
            return new Response(JSON.stringify({
                success: false,
                error: 'Payment amount mismatch',
                expected_kobo: expectedKobo,
                actual_kobo: actualKobo,
            }), { status: 400, headers });
        }

        const currency = verifyData.data?.currency;
        if (currency && currency !== 'NGN') {
            return new Response(JSON.stringify({
                success: false,
                error: `Unsupported currency: ${currency}`,
            }), { status: 400, headers });
        }

        const nowIso = new Date().toISOString();
        await base44.asServiceRole.entities.Booking.update(booking.id, {
            payment_status: 'paid',
            status: 'confirmed',
            payment_method: 'paystack',
            transaction_hash: reference,
            paid_at: nowIso,
        });

        // Idempotency guard against the verify+webhook race: re-read and
        // confirm transaction_hash matches OUR reference. If another path
        // (typically the Paystack webhook) wrote first, skip notify + referral
        // so we don't double-fire them.
        const after = await base44.asServiceRole.entities.Booking.get(booking.id);
        if (after?.transaction_hash !== reference) {
            console.log(`Lost the race to mark booking ${booking.id} paid (winner ref: ${after?.transaction_hash}). Skipping side-effects.`);
            return new Response(JSON.stringify({
                success: true,
                data: { booking_id: booking.id, paid_at: after?.paid_at || nowIso, already_processed_by: 'webhook' },
            }), { status: 200, headers });
        }

        // Best-effort phone lookup — Booking rows don't carry a phone, but the
        // guest's User profile usually does. Never let this block the notify.
        let guestPhone = '';
        try {
            const guestUsers = await base44.asServiceRole.entities.User.filter({ email: booking.guest_email });
            guestPhone = guestUsers[0]?.phone_number || '';
        } catch { /* noop — phone shows as "Not provided" */ }

        await notifyAdmin({
            bookingId: booking.id,
            guestName: booking.guest_name,
            guestEmail: booking.guest_email,
            guestPhone,
            propertyId: booking.property_id,
            amountNGN: Number(booking.total_price) || 0,
            reference,
        });

        // Push the guest — booking is locked in. Tag by booking so a
        // webhook re-fire for the same payment replaces this notification
        // instead of stacking. Deep-links into their bookings list.
        await tryPush(base44, {
            user_email: booking.guest_email,
            title: '✅ Payment confirmed',
            body: `Your stay is locked in. Tap for arrival details.`,
            url: `/Bookings#booking-${booking.id}`,
            tag: `booking-paid-${booking.id}`,
        });

        // Re-read so we see any host_*_override that may have been filled
        // before payment confirmed (rare but possible if admin pre-filled).
        const bookingForEmail = await base44.asServiceRole.entities.Booking.get(booking.id);
        const emailResult = await sendArrivalEmail({ sdk: base44, booking: bookingForEmail });
        if (!emailResult.sent && emailResult.needs_admin) {
            try {
                await base44.functions.invoke('requestHostDetails', {
                    booking_id: booking.id,
                    internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '',
                });
            } catch (reqErr) {
                console.warn('requestHostDetails invoke failed (non-fatal):', reqErr);
            }
        } else if (emailResult.sent) {
            try {
                await base44.asServiceRole.entities.Booking.update(booking.id, {
                    host_details_status: 'complete',
                });
            } catch { /* noop */ }
        }

        await awardGuestBookingPoints(base44, booking.guest_email, booking.id);

        // Inline referral reward — direct service-role writes, idempotent.
        try {
            const guests = await base44.asServiceRole.entities.User.filter({ email: booking.guest_email });
            const guest = guests[0];
            if (guest?.referred_by_code) {
                const referrers = await base44.asServiceRole.entities.User.filter({ referral_code: guest.referred_by_code });
                const referrer = referrers[0];
                if (referrer) {
                    let referrals = await base44.asServiceRole.entities.Referral.filter({
                        referrer_email: referrer.email,
                        referred_email: guest.email,
                    });
                    let referral = referrals[0];
                    if (!referral) {
                        referral = await base44.asServiceRole.entities.Referral.create({
                            referrer_email: referrer.email,
                            referred_email: guest.email,
                            status: 'signed_up',
                        });
                    }
                    // Second idempotency guard: even if status check passes
                    // under a race, the booking_id stamp on the referral row
                    // will catch a second writer trying to credit the same
                    // booking.
                    const alreadyCreditedThisBooking = referral.booking_id === booking.id;
                    if (referral.status !== 'booking_completed' && !alreadyCreditedThisBooking) {
                        const amountNGN = Math.round((Number(booking.total_price) || 0) * REFERRAL_RATE);
                        const newBalance = (Number(referrer.referral_balance_ngn) || 0) + amountNGN;
                        const newLoyalty = (Number(referrer.loyalty_points) || 0) + REFERRER_LOYALTY_BONUS;
                        await base44.asServiceRole.entities.User.update(referrer.id, {
                            referral_balance_ngn: newBalance,
                            loyalty_points: newLoyalty,
                        });
                        await base44.asServiceRole.entities.Referral.update(referral.id, {
                            status: 'booking_completed',
                            booking_id: booking.id,
                            amount_earned_ngn: amountNGN,
                        });
                        try {
                            await base44.asServiceRole.entities.LoyaltyTransaction.create({
                                user_email: referrer.email,
                                points_earned: REFERRER_LOYALTY_BONUS,
                                transaction_type: 'referral',
                                booking_id: booking.id,
                                description: `REFERRAL_BONUS — Referred ${guest.email} who booked`,
                            });
                        } catch (loyaltyErr) {
                            console.warn('Referrer loyalty log failed (non-fatal):', loyaltyErr);
                        }
                        console.log(`🎁 Referrer ${referrer.email} awarded ₦${amountNGN} + ${REFERRER_LOYALTY_BONUS} loyalty points`);
                        // Push the referrer — they care a lot about this and
                        // it's a great moment of feedback that the program works.
                        await tryPush(base44, {
                            user_email: referrer.email,
                            title: '🎁 Referral payout',
                            body: `₦${amountNGN.toLocaleString()} just landed in your referral balance.`,
                            url: '/Withdrawals',
                            tag: `referral-${referral.id}`,
                        });
                    }
                }
            }
        } catch (refErr) {
            console.warn('Inline referral reward failed (non-fatal):', refErr);
        }

        return new Response(JSON.stringify({
            success: true,
            data: {
                booking_id: booking.id,
                paid_at: nowIso,
                amount_ngn: Number(booking.total_price) || 0,
                reference,
            },
        }), { status: 200, headers });
    } catch (error) {
        console.error('verifyPaystackPayment error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
