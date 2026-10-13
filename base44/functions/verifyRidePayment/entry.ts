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

// A ride that has been paid stays paid, whatever happened to it afterwards.
// The guard used to be "paid AND confirmed", which let an old Paystack
// reference walk straight past it on a ride that had since been completed by
// the sweep or cancelled by admin, and flip that ride back to confirmed.
// Lockstep copy in verifyRidePayment and paystackWebhook.
function rideAlreadyPaid(ride: any) {
    return !!ride && ride.payment_status === 'paid';
}

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

// Which booking a Paystack transaction was made for, read from the metadata
// the payment page attached to it: ride_booking_id for a ride, booking_id for
// a stay. Without this a reference that paid for one booking could be handed
// in again to mark another booking of the same price as paid. true: it names
// this booking. false: it names another one. null: it names none, and the
// caller must check the reference has not been used. Lockstep copy in
// verifyRidePayment and verifyPaystackPayment.
function paymentIsFor(metadata: unknown, kind: string, id: string) {
    let meta = metadata;
    if (typeof meta === 'string') {
        try {
            meta = JSON.parse(meta);
        } catch (_err) {
            meta = null;
        }
    }
    const m = meta && typeof meta === 'object' ? meta : {};
    const ride = String(m.ride_booking_id || '');
    const stay = String(m.booking_id || '');
    if (kind === 'ride') {
        if (stay) return false;
        return ride ? ride === id : null;
    }
    if (ride) return false;
    return stay ? stay === id : null;
}

// Referral reward. This function is word for word the same in
// processReferralReward, verifyPaystackPayment, verifyRidePayment and
// paystackWebhook: functions cannot share code, and
// scripts/check-referral-reward.mjs fails if the copies drift apart.
//
// What it keeps:
//  - Only a paid stay or ride earns, and the row handed in must say so.
//  - The referrer is whoever the guest's Referral row names. Only
//    attributeReferral writes that row, once per guest and never naming the
//    guest. The codes on the two profiles are not read here: a code is text
//    anyone can copy onto their own profile, and until 2026-10-12 a guest
//    could point their own profile at any code they liked.
//  - One reward per referred guest, for the first stay or ride they pay for.
//    Every row for the guest is looked at, because rewards paid in May 2026
//    left a second row beside the sign-up one.
//  - Never twice for one booking, never to the guest, and never for a
//    booking that was paid for before the guest was referred.
// Two writers reach this for one payment (the payment page and Paystack's
// webhook), and there is nothing to lock. So each first writes a claim, the
// referrer's loyalty row for this booking, then reads all the claims: only the
// oldest goes on to move money, and the others take theirs back. If the money
// then fails to move, what was written here is undone so a retry can pay; if
// it cannot be told whether the money moved, it is left as paid, because a
// reward that needs a person to look is better than one paid twice.
async function payReferralReward(db: any, paid: any, what: string) {
    const oldestFirst = (a: any, b: any) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
        || String(a.id).localeCompare(String(b.id));
    const guestEmail = String(paid.guest_email || '').toLowerCase();
    if (!guestEmail) return { skipped: 'no_referrer' };
    if (paid.payment_status !== 'paid') return { skipped: 'not_paid' };
    // Nothing to pay must not use the guest's one reward up.
    const amountNGN = Math.round((Number(paid.total_price) || 0) * REFERRAL_RATE);
    if (amountNGN <= 0) return { skipped: 'no_amount' };

    const rows = await db.Referral.filter({ referred_email: paid.guest_email }, 'created_date', 50);
    if (rows.length === 0) return { skipped: 'no_referrer' };
    if (rows.some((row: any) => row.booking_id === paid.id || row.status === 'booking_completed')) {
        return { skipped: 'already_awarded' };
    }
    const referral = rows.slice().sort(oldestFirst)[0];
    const referrerEmail = String(referral.referrer_email || '').toLowerCase();
    if (!referrerEmail || referrerEmail === guestEmail) return { skipped: 'self_referral' };
    // Compared to the second: both are UTC, written in different precisions.
    if (paid.paid_at && referral.created_date
        && String(paid.paid_at).slice(0, 19) < String(referral.created_date).slice(0, 19)) {
        return { skipped: 'paid_before_referral' };
    }
    const findReferrer = async () => (await db.User.filter({ email: referral.referrer_email }, 'created_date', 1))[0];
    if (!(await findReferrer())) return { skipped: 'referrer_not_found' };

    const claim = await db.LoyaltyTransaction.create({
        user_email: referral.referrer_email,
        points_earned: REFERRER_LOYALTY_BONUS,
        transaction_type: 'referral',
        booking_id: paid.id,
        description: `REFERRAL_BONUS — Referred ${paid.guest_email} who ${what}`,
    });
    const claims = await db.LoyaltyTransaction.filter({ transaction_type: 'referral', booking_id: paid.id }, 'created_date', 50);
    if (claims.slice().sort(oldestFirst)[0].id !== claim.id) {
        await db.LoyaltyTransaction.delete(claim.id).catch(() => {});
        return { skipped: 'already_awarded' };
    }

    // Read right before the credit: the balance is a number a withdrawal may
    // have changed since the first read.
    let before: any = null;
    try {
        await db.Referral.update(referral.id, {
            status: 'booking_completed',
            booking_id: paid.id,
            amount_earned_ngn: amountNGN,
        });
        before = await findReferrer();
        await db.User.update(before.id, {
            referral_balance_ngn: (Number(before.referral_balance_ngn) || 0) + amountNGN,
            loyalty_points: (Number(before.loyalty_points) || 0) + REFERRER_LOYALTY_BONUS,
        });
    } catch (err) {
        // A write can fail after it has landed. Undo only when the balance
        // reads exactly as it did before the credit was sent.
        let moved = false;
        if (before) {
            try {
                const now = await findReferrer();
                moved = !now || (Number(now.referral_balance_ngn) || 0) !== (Number(before.referral_balance_ngn) || 0);
            } catch {
                moved = true;
            }
        }
        if (!moved) {
            await db.Referral.update(referral.id, {
                status: referral.status || 'signed_up',
                booking_id: null,
                amount_earned_ngn: null,
            }).catch(() => {});
            await db.LoyaltyTransaction.delete(claim.id).catch(() => {});
        }
        throw err;
    }
    return { referrer_email: referral.referrer_email, amount_ngn: amountNGN, referral_id: referral.id };
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

        // A plain id only. "../Booking/<a stay>" would fetch a stay as if it
        // were a ride, and every check below would be made on the wrong kind
        // of row.
        const ride = isId(ride_booking_id) ? await getOrNull(base44.asServiceRole.entities.RideBooking, ride_booking_id) : null;
        if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);
        if (ride.guest_email !== user.email && user.role !== 'admin') {
            return json({ success: false, error: 'Not your booking' }, 403);
        }
        if (rideAlreadyPaid(ride)) {
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

        // The reference must be the one that paid for THIS booking, and must
        // not already be on another one.
        const madeFor = paymentIsFor(verifyData.data?.metadata, 'ride', ride.id);
        const reused = madeFor === false ? [] : (await base44.asServiceRole.entities.RideBooking.filter({ transaction_hash: reference }))
            .filter((row: any) => row.id !== ride.id);
        if (madeFor === false || reused.length > 0) {
            console.error(`Reference ${reference} was not paid for ride ${ride.id}`);
            return json({ success: false, error: 'This payment was made for a different booking.', code: 'REFERENCE_MISMATCH' }, 400);
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

        // Referral reward. Who is paid, and how often, is decided in
        // payReferralReward, which every writer of the reward shares.
        try {
            const reward: any = await payReferralReward(base44.asServiceRole.entities, after, 'booked a ride');
            if (!reward.skipped) {
                await tryPush(base44, {
                    user_email: reward.referrer_email,
                    title: '🎁 Referral payout',
                    body: `₦${reward.amount_ngn.toLocaleString()} just landed in your referral balance.`,
                    url: '/Withdrawals',
                    tag: `referral-${reward.referral_id}`,
                });
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
