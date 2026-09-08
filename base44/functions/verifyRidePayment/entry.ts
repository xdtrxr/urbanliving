import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// verifyRidePayment
// ----------------------------------------------------------------------------
// Client-invoked after the Paystack popup returns. Verifies the reference with
// Paystack, marks the ride paid, and fires the side effects.
//
// IMPORTANT: paystackWebhook runs this same post-payment block server-to-server
// for rides carrying ride_booking_id in their metadata. The two are duplicated
// because Base44 function directories are isolated. KEEP THEM IN LOCKSTEP —
// the equivalent stays pair has already drifted in the ordering of its
// referral writes.
//
// Rewards mirror stays, per the approved architecture: guest loyalty +500 and
// a 5% referral payout, because ride revenue is revenue. Both constants sit at
// the top so switching rides off is a one-line change.

const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify';
const REFERRAL_RATE = 0.05;
const REFERRER_LOYALTY_BONUS = 250;
const GUEST_RIDE_POINTS = 500;

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://urbanstays.io';
const rideLink = (id: string) => `${APP_BASE_URL}/Bookings?focus=${encodeURIComponent(id)}#ride-${encodeURIComponent(id)}`;

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

// Flat points award, idempotent on (user_email, transaction_type, booking_id).
// booking_id carries the ride id here — LoyaltyTransaction has no separate
// ride column, and the ids are globally unique, so the dedup key still holds.
async function awardGuestRidePoints(sdk: any, guestEmail: string, rideId: string) {
    try {
        const users = await sdk.asServiceRole.entities.User.filter({ email: guestEmail });
        const guest = users[0];
        if (!guest) return;
        const existing = await sdk.asServiceRole.entities.LoyaltyTransaction.filter({
            user_email: guestEmail, transaction_type: 'booking', booking_id: rideId,
        });
        if (existing.length > 0) return;
        await sdk.asServiceRole.entities.User.update(guest.id, {
            loyalty_points: (Number(guest.loyalty_points) || 0) + GUEST_RIDE_POINTS,
        });
        await sdk.asServiceRole.entities.LoyaltyTransaction.create({
            user_email: guestEmail,
            points_earned: GUEST_RIDE_POINTS,
            transaction_type: 'booking',
            booking_id: rideId,
            description: `Earned ${GUEST_RIDE_POINTS} points from a ride booking`,
        });
    } catch (err) {
        console.warn('awardGuestRidePoints failed (non-fatal):', err);
    }
}

async function notifyAdmin(ride: any, reference: string) {
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
    const text = `💰 *RIDE PAID*\n\n` +
        `Ride \`${ride.id}\`\n` +
        `• Vehicle: ${ride.vehicle_name}\n` +
        `• Guest: ${ride.guest_name} (${ride.guest_email})\n` +
        `• Mobile: ${ride.guest_phone || 'Not provided'}\n` +
        `• Pickup: ${when}\n` +
        `• Amount: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n` +
        `• Paystack ref: \`${reference}\`\n\n` +
        `⚠️ *Assign a driver* — the guest cannot see driver details until you do.`;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Ride payment notify failed:', err);
    }
}

async function emailGuest(sdk: any, ride: any) {
    if (!ride.guest_email) return;
    const when = (() => {
        try {
            return new Date(ride.start_at).toLocaleString('en-GB', {
                timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short',
            });
        } catch { return ride.start_at; }
    })();
    const pickup = [ride.pickup_location?.address, ride.pickup_location?.area, ride.pickup_location?.city]
        .filter(Boolean).join(', ');
    try {
        await sdk.integrations.Core.SendEmail({
            to: ride.guest_email,
            subject: `Ride confirmed — ${ride.vehicle_name}`,
            body: `Hi ${ride.guest_name || 'there'},\n\n` +
                `Payment received — your ride is confirmed. 🎉\n\n` +
                `🔖 Status: CONFIRMED & PAID\n` +
                `🚗 Vehicle: ${ride.vehicle_name}\n` +
                `🕒 Pickup: ${when}\n` +
                (pickup ? `📍 From: ${pickup}\n` : '') +
                `💰 Paid: ₦${(Number(ride.total_price) || 0).toLocaleString()}\n\n` +
                `We're assigning your driver now. You'll get their name and number here and in the app as soon as they're confirmed.\n\n` +
                `👉 View your ride: ${rideLink(ride.id)}\n\n` +
                `— Urban Stays`,
            from_name: 'Urban Stays',
        });
    } catch (err) {
        console.warn('Ride confirmation email failed (non-fatal):', err);
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
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const { ride_booking_id, reference } = await req.json().catch(() => ({}));
        if (!ride_booking_id || !reference) {
            return json({ success: false, error: 'ride_booking_id and reference are required' }, 400);
        }

        const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        if (!secretKey) return json({ success: false, error: 'Payment service not configured' }, 500);

        const ride = await base44.asServiceRole.entities.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);
        if (ride.guest_email !== user.email && user.role !== 'admin') {
            return json({ success: false, error: 'Not your booking' }, 403);
        }
        if (ride.payment_status === 'paid' && ride.status === 'confirmed') {
            return json({ success: true, data: { already_paid: true, ride_booking_id } });
        }

        const verifyRes = await fetch(`${PAYSTACK_VERIFY_URL}/${encodeURIComponent(reference)}`, {
            headers: { Authorization: `Bearer ${secretKey}` },
        });
        const verifyData = await verifyRes.json();
        if (!verifyRes.ok || !verifyData.status || verifyData.data?.status !== 'success') {
            console.warn('Paystack ride verify failed', verifyData);
            return json({
                success: false,
                error: 'Payment not verified',
                details: verifyData?.message || 'Paystack returned non-success',
            }, 402);
        }

        const expectedKobo = Math.round((Number(ride.total_price) || 0) * 100);
        const actualKobo = Number(verifyData.data?.amount) || 0;
        if (actualKobo !== expectedKobo) {
            console.error(`Ride amount mismatch: expected ${expectedKobo}, got ${actualKobo}`);
            return json({
                success: false, error: 'Payment amount mismatch',
                expected_kobo: expectedKobo, actual_kobo: actualKobo,
            }, 400);
        }
        const currency = verifyData.data?.currency;
        if (currency && currency !== 'NGN') {
            return json({ success: false, error: `Unexpected currency ${currency}` }, 400);
        }

        const nowIso = new Date().toISOString();
        await base44.asServiceRole.entities.RideBooking.update(ride.id, {
            payment_status: 'paid',
            status: 'confirmed',
            payment_method: 'paystack',
            transaction_hash: reference,
            paid_at: nowIso,
        });

        // Race arbitration against paystackWebhook: re-read and only run the
        // side effects if our reference is the one that stuck.
        const after = await base44.asServiceRole.entities.RideBooking.get(ride.id);
        if (after?.transaction_hash !== reference) {
            return json({
                success: true,
                data: { ride_booking_id: ride.id, already_processed_by: 'webhook' },
            });
        }

        await notifyAdmin(after, reference);
        await emailGuest(base44, after);
        await tryPush(base44, {
            user_email: ride.guest_email,
            title: '✅ Ride confirmed',
            body: `${ride.vehicle_name} is booked. We'll share your driver's details shortly.`,
            url: `/Bookings#ride-${ride.id}`,
            tag: `ride-paid-${ride.id}`,
        });
        await awardGuestRidePoints(base44, ride.guest_email, ride.id);

        // Referral payout — same 5% and the same two idempotency guards as
        // stays: the referral's status, plus a booking_id stamp that catches
        // two writers passing the status check before either has written.
        try {
            const guests = await base44.asServiceRole.entities.User.filter({ email: ride.guest_email });
            const guest = guests[0];
            if (guest?.referred_by_code) {
                const referrers = await base44.asServiceRole.entities.User.filter({ referral_code: guest.referred_by_code });
                const referrer = referrers[0];
                if (referrer) {
                    let rows = await base44.asServiceRole.entities.Referral.filter({
                        referrer_email: referrer.email, referred_email: guest.email,
                    });
                    let referral = rows[0];
                    if (!referral) {
                        referral = await base44.asServiceRole.entities.Referral.create({
                            referrer_email: referrer.email, referred_email: guest.email, status: 'signed_up',
                        });
                    }
                    if (referral.status !== 'booking_completed' && referral.booking_id !== ride.id) {
                        const amountNGN = Math.round((Number(ride.total_price) || 0) * REFERRAL_RATE);
                        await base44.asServiceRole.entities.User.update(referrer.id, {
                            referral_balance_ngn: (Number(referrer.referral_balance_ngn) || 0) + amountNGN,
                            loyalty_points: (Number(referrer.loyalty_points) || 0) + REFERRER_LOYALTY_BONUS,
                        });
                        await base44.asServiceRole.entities.Referral.update(referral.id, {
                            status: 'booking_completed', booking_id: ride.id, amount_earned_ngn: amountNGN,
                        });
                        try {
                            await base44.asServiceRole.entities.LoyaltyTransaction.create({
                                user_email: referrer.email,
                                points_earned: REFERRER_LOYALTY_BONUS,
                                transaction_type: 'referral',
                                booking_id: ride.id,
                                description: `REFERRAL_BONUS — Referred ${guest.email} who booked a ride`,
                            });
                        } catch { /* log-only, non-fatal */ }
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
            console.warn('Ride referral reward failed (non-fatal):', refErr);
        }

        return json({
            success: true,
            data: { ride_booking_id: ride.id, paid_at: nowIso, amount_ngn: Number(ride.total_price) || 0, reference },
        });
    } catch (error) {
        console.error('verifyRidePayment error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
