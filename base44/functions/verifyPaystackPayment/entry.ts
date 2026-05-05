import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify';
const REFERRAL_RATE = 0.05;
const REFERRER_LOYALTY_BONUS = 250;

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
    const text = `💰 *PAYMENT RECEIVED*\n\n` +
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

        await notifyAdmin({
            bookingId: booking.id,
            guestName: booking.guest_name,
            guestEmail: booking.guest_email,
            propertyId: booking.property_id,
            amountNGN: Number(booking.total_price) || 0,
            reference,
        });

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
                    if (referral.status !== 'booking_completed') {
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
