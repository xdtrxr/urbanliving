import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// IMPORTANT: This function and base44/functions/verifyPaystackPayment/entry.ts
// share the post-payment booking-update logic (mark paid, notify admin, inline
// referral cash + loyalty bonus). Base44 functions are isolated dirs, so the
// logic is duplicated. Keep them in lockstep when changing either path.

const REFERRAL_RATE = 0.05;
const REFERRER_LOYALTY_BONUS = 250;

async function hmacSha512Hex(secret: string, body: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-512' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare so an attacker can't time-out the HMAC check.
function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

// Sends the guest the property address, host phone, and arrival instructions
// immediately after a payment confirms. Mirrors the same helper in
// verifyPaystackPayment — keep in lockstep when changing.
async function sendArrivalEmail(opts: {
    sdk: any;
    bookingId: string;
    guestEmail: string;
    guestName: string;
    propertyId: string;
    checkIn: string;
    checkOut: string;
    guests: number;
}) {
    try {
        const property = await opts.sdk.asServiceRole.entities.Property.get(opts.propertyId);
        if (!property) {
            console.warn(`sendArrivalEmail: property ${opts.propertyId} not found`);
            return;
        }
        const loc = property.location || {};
        const fullAddress = [loc.address, loc.city, loc.country].filter(Boolean).join(', ');
        const mapsLink = loc.coordinates?.lat && loc.coordinates?.lng
            ? `https://www.google.com/maps?q=${loc.coordinates.lat},${loc.coordinates.lng}`
            : (fullAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}` : null);

        const hostLine = property.host_phone
            ? `📞 Call your host on arrival: ${property.host_name || 'Host'} — ${property.host_phone}`
            : `📞 Host contact: not provided — message us via support if you need help.`;

        const arrivalBlock = property.arrival_instructions
            ? `\n\nArrival instructions from the host:\n${property.arrival_instructions}`
            : '';

        const mapsBlock = mapsLink ? `\nMap: ${mapsLink}` : '';

        const body = `Hi ${opts.guestName || 'there'},

Payment confirmed — your booking at "${property.title}" is locked in. 🎉

📍 Address: ${fullAddress || 'See app for details'}${mapsBlock}
🗓 Check-in: ${opts.checkIn}
🗓 Check-out: ${opts.checkOut}
👥 Guests: ${opts.guests}

${hostLine}${arrivalBlock}

Have a smooth trip — see you soon.

— Urban Stays`;

        await opts.sdk.integrations.Core.SendEmail({
            to: opts.guestEmail,
            subject: `You're checked in: arrival details for ${property.title}`,
            body,
            from_name: 'Urban Stays',
        });
        console.log(`✅ Arrival email sent to ${opts.guestEmail} for booking ${opts.bookingId}`);
    } catch (err) {
        console.error('sendArrivalEmail failed (non-fatal):', err);
    }
}

async function notifyAdmin(opts: {
    bookingId: string;
    guestName: string;
    guestEmail: string;
    propertyId: string;
    amountNGN: number;
    reference: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const text = `💰 *PAYMENT RECEIVED (webhook)*\n\n` +
        `Booking \`${opts.bookingId}\`\n` +
        `• Guest: ${opts.guestName} (${opts.guestEmail})\n` +
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
    const ack = (extra: Record<string, unknown> = {}) =>
        new Response(JSON.stringify({ ok: true, ...extra }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405 });
    }

    const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secretKey) {
        console.error('PAYSTACK_SECRET_KEY not configured — rejecting webhook');
        return ack({ skipped: 'no_secret' });
    }

    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-paystack-signature') || '';
    const expected = await hmacSha512Hex(secretKey, rawBody);
    if (!safeEqual(expected, signatureHeader)) {
        console.warn('Invalid Paystack signature — ignoring');
        return ack({ skipped: 'invalid_signature' });
    }

    let event: any;
    try { event = JSON.parse(rawBody); } catch { return ack({ skipped: 'bad_json' }); }

    if (event?.event !== 'charge.success') {
        return ack({ skipped: `unhandled_event:${event?.event}` });
    }

    const reference: string = event?.data?.reference;
    const amountKobo: number = Number(event?.data?.amount) || 0;
    const currency: string = event?.data?.currency || '';
    const metadata = event?.data?.metadata || {};
    const bookingId: string | undefined = metadata?.booking_id;

    if (!reference || !bookingId) {
        console.warn('Webhook missing reference or booking_id', { reference, bookingId });
        return ack({ skipped: 'missing_fields' });
    }
    if (currency && currency !== 'NGN') {
        console.warn(`Webhook currency ${currency} != NGN — ignoring`);
        return ack({ skipped: `bad_currency:${currency}` });
    }

    // Base44 supplies the SDK client with service-role access automatically
    // via createClientFromRequest — no env vars needed.
    const sdk = createClientFromRequest(req);

    try {
        const booking = await sdk.asServiceRole.entities.Booking.get(bookingId);
        if (!booking) return ack({ skipped: 'booking_not_found' });

        if (booking.payment_status === 'paid' && booking.status === 'confirmed') {
            return ack({ skipped: 'already_paid' });
        }

        const expectedKobo = Math.round((Number(booking.total_price) || 0) * 100);
        if (amountKobo !== expectedKobo) {
            console.error(`Webhook amount mismatch: expected ${expectedKobo}, got ${amountKobo}`);
            return ack({ skipped: 'amount_mismatch' });
        }

        const nowIso = new Date().toISOString();
        await sdk.asServiceRole.entities.Booking.update(booking.id, {
            payment_status: 'paid',
            status: 'confirmed',
            payment_method: 'paystack',
            transaction_hash: reference,
            paid_at: nowIso,
        });

        // Idempotency guard against the verify+webhook race: re-read and
        // only proceed with notify + referral if transaction_hash is OUR
        // reference. Otherwise verifyPaystackPayment already handled it.
        const after = await sdk.asServiceRole.entities.Booking.get(booking.id);
        if (after?.transaction_hash !== reference) {
            console.log(`Lost race to mark booking ${booking.id} paid (winner ref: ${after?.transaction_hash}). Skipping.`);
            return ack({ skipped: 'lost_race', booking_id: booking.id });
        }

        await notifyAdmin({
            bookingId: booking.id,
            guestName: booking.guest_name,
            guestEmail: booking.guest_email,
            propertyId: booking.property_id,
            amountNGN: Number(booking.total_price) || 0,
            reference,
        });

        await sendArrivalEmail({
            sdk,
            bookingId: booking.id,
            guestEmail: booking.guest_email,
            guestName: booking.guest_name,
            propertyId: booking.property_id,
            checkIn: booking.check_in,
            checkOut: booking.check_out,
            guests: Number(booking.guests) || 1,
        });

        // Inline referral reward — direct service-role writes, idempotent.
        try {
            const guests = await sdk.asServiceRole.entities.User.filter({ email: booking.guest_email });
            const guest = guests[0];
            if (guest?.referred_by_code) {
                const referrers = await sdk.asServiceRole.entities.User.filter({ referral_code: guest.referred_by_code });
                const referrer = referrers[0];
                if (referrer) {
                    let referrals = await sdk.asServiceRole.entities.Referral.filter({
                        referrer_email: referrer.email,
                        referred_email: guest.email,
                    });
                    let referral = referrals[0];
                    if (!referral) {
                        referral = await sdk.asServiceRole.entities.Referral.create({
                            referrer_email: referrer.email,
                            referred_email: guest.email,
                            status: 'signed_up',
                        });
                    }
                    if (referral.status !== 'booking_completed') {
                        const amountNGN = Math.round((Number(booking.total_price) || 0) * REFERRAL_RATE);
                        const newBalance = (Number(referrer.referral_balance_ngn) || 0) + amountNGN;
                        const newLoyalty = (Number(referrer.loyalty_points) || 0) + REFERRER_LOYALTY_BONUS;
                        await sdk.asServiceRole.entities.User.update(referrer.id, {
                            referral_balance_ngn: newBalance,
                            loyalty_points: newLoyalty,
                        });
                        try {
                            await sdk.asServiceRole.entities.LoyaltyTransaction.create({
                                user_email: referrer.email,
                                points_earned: REFERRER_LOYALTY_BONUS,
                                transaction_type: 'referral',
                                booking_id: booking.id,
                                description: `REFERRAL_BONUS — Referred ${guest.email} who booked (webhook)`,
                            });
                        } catch (loyaltyErr) {
                            console.warn('Referrer loyalty log failed (non-fatal):', loyaltyErr);
                        }
                        await sdk.asServiceRole.entities.Referral.update(referral.id, {
                            status: 'booking_completed',
                            booking_id: booking.id,
                            amount_earned_ngn: amountNGN,
                        });
                        console.log(`🎁 Referrer ${referrer.email} awarded ₦${amountNGN}`);
                    }
                }
            }
        } catch (refErr) {
            console.warn('Webhook inline referral reward failed (non-fatal):', refErr);
        }

        return ack({ processed: true, booking_id: booking.id });
    } catch (err) {
        console.error('paystackWebhook error:', err);
        return ack({ error: (err as Error).message });
    }
});
