import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// The payment states that mean a guest has booked with us: paid, a payment on
// hold for the admin to confirm, or a payment already given back. A refunded
// guest who books again is a returning customer, not somebody's referral.
// Unpaid requests (cancelled or not) do not count: asking is not booking.
const BOOKED = ['paid', 'pending_confirmation', 'refunded'];

// Has this email booked a stay or a ride? Read with the service role: the
// question is about the caller, but the answer must not depend on what their
// read rules happen to let them see. guest_email is compared exactly by the
// platform, so the lower-case spelling is asked for as well when it differs
// (a booking an admin typed in by hand is most likely lower case). One row is
// enough to answer, so one is asked for, never the default page of 50.
async function hasBooked(db: any, email: string): Promise<boolean> {
    const spellings = [...new Set([email, email.toLowerCase()])];
    for (const entity of ['Booking', 'RideBooking']) {
        for (const guest_email of spellings) {
            const rows = await db[entity].filter({ guest_email, payment_status: { $in: BOOKED } }, '-created_date', 1);
            if (rows.length > 0) return true;
        }
    }
    return false;
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
        // On the platform auth.me() throws for a signed-out caller rather
        // than answering null. Caught here, that is the 401 it should be,
        // not the 500 the catch at the bottom would make of it. Every lookup
        // below is by the caller's email, and a filter on an empty value
        // matches other people's rows, so an account without one is refused.
        const user = await base44.auth.me().catch(() => null);
        if (!user || !user.email) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401, headers });
        }

        const body = await req.json().catch(() => ({}));
        const refCodeRaw = (body.ref_code || '').toString().trim().toUpperCase();
        if (!refCodeRaw) {
            return new Response(JSON.stringify({ success: false, error: 'ref_code is required' }), { status: 400, headers });
        }
        if (refCodeRaw.length > 64) {
            return new Response(JSON.stringify({ success: false, code: 'INVALID_CODE', error: 'Referral code not found' }), { status: 404, headers });
        }
        const db = base44.asServiceRole.entities;
        const sameEmail = (x: unknown, y: unknown) => String(x || '').toLowerCase() === String(y || '').toLowerCase();

        // Already attributed? (one-shot per user)
        const existing = await db.Referral.filter({ referred_email: user.email }, 'created_date', 5);
        if (existing.length > 0) {
            return new Response(JSON.stringify({
                success: false,
                code: 'ALREADY_ATTRIBUTED',
                error: 'You have already used a referral code',
            }), { status: 409, headers });
        }

        // Who holds the code. A code is made in the browser and nothing makes
        // it unique, so anyone can copy a friend's code onto their own
        // profile. Every holder is looked at, never just the first one found:
        // "the first" let a copier take the referrals meant for the owner.
        // The upper-case form is how codes are stored now; some early rows
        // are lower case. The code is the caller's text, so it is escaped
        // before it goes into a pattern: ".*" matched every account.
        // Both lookups are always made. Asking for the other spellings only
        // when the upper-case one found nobody meant that a copier holding
        // "LARA1" hid an owner whose code is stored as "lara1", and took her
        // referrals.
        const literal = refCodeRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exact = await db.User.filter({ referral_code: refCodeRaw }, 'created_date', 5);
        const anyCase = await db.User.filter({
            referral_code: { $regex: `^${literal}$`, $options: 'i' },
        }, 'created_date', 5);
        const holders = [...exact, ...anyCase.filter((u: any) => !exact.some((e: any) => e.id === u.id))];
        if (holders.length === 0) {
            return new Response(JSON.stringify({
                success: false,
                code: 'INVALID_CODE',
                error: 'Referral code not found',
            }), { status: 404, headers });
        }
        const others = holders.filter((holder: any) => !sameEmail(holder.email, user.email));
        if (others.length === 0) {
            return new Response(JSON.stringify({
                success: false,
                code: 'SELF_REFERRAL',
                error: 'You cannot use your own referral code',
            }), { status: 400, headers });
        }
        if (others.length > 1) {
            // Nobody can say whose referral this is, so it is nobody's. The
            // admin can see who holds the code from the ids in this line.
            console.error(`Referral code ${refCodeRaw} is held by more than one account: ${others.map((o: any) => o.id).join(', ')}`);
            return new Response(JSON.stringify({
                success: false,
                code: 'AMBIGUOUS_CODE',
                error: 'This code cannot be used right now. Ask your friend to send their link again, or contact support.',
            }), { status: 409, headers });
        }
        const referrer = others[0];

        // Referral codes are for new accounts: the owner's decision of
        // 2026-10-23 (todo.md, "Decision 3"). A link sent to people who are
        // already customers would earn the sender 5% of each one's next
        // booking, which they did nothing to bring, and would block the
        // friend who really brought them from ever being entered.
        //
        // The code is judged before the account, so this comes last. Someone
        // who opens their own link to see that it works is told it is their
        // own code, a mistyped code is reported as not found, and a copied
        // code still leaves its line in the log for the admin. Each of those
        // is the more specific answer; this one refuses only a code that
        // would otherwise have been accepted. Nothing is written before it.
        if (await hasBooked(db, user.email)) {
            return new Response(JSON.stringify({
                success: false,
                code: 'EXISTING_CUSTOMER',
                error: 'Referral codes are for new accounts. This account has already booked with us.',
            }), { status: 409, headers });
        }

        // The Referral row is the record of who referred whom: the reward
        // follows it and nothing else. It is written first, then every row
        // for this guest is read back, because two requests at the same
        // moment (two tabs, two codes) both pass the check above. The oldest
        // row stands and a later one is taken back.
        const referral = await db.Referral.create({
            referrer_email: referrer.email,
            referred_email: user.email,
            status: 'signed_up',
        });
        const rows = await db.Referral.filter({ referred_email: user.email }, 'created_date', 50);
        const oldest = rows.slice().sort((x: any, y: any) => String(x.created_date || '').localeCompare(String(y.created_date || ''))
            || String(x.id).localeCompare(String(y.id)))[0];
        if (oldest && oldest.id !== referral.id) {
            await db.Referral.delete(referral.id).catch(() => {});
            return new Response(JSON.stringify({
                success: false,
                code: 'ALREADY_ATTRIBUTED',
                error: 'You have already used a referral code',
            }), { status: 409, headers });
        }

        // The stamp on the profile only stops the app asking again. If it
        // fails the referral still stands.
        try {
            await db.User.update(user.id, {
                referred_by_code: refCodeRaw,
                referral_prompt_seen: true,
            });
        } catch (stampErr) {
            console.warn('attributeReferral: profile stamp failed (the referral stands):', stampErr);
        }

        return new Response(JSON.stringify({
            success: true,
            data: {
                referrer_email: referrer.email,
                referral_id: referral.id,
            },
        }), { status: 200, headers });
    } catch (error) {
        console.error('attributeReferral error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
