import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

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
        // Try uppercase first (the canonical storage form), then any case,
        // for legacy lowercase rows. The code is the caller's text, so it is
        // escaped before it goes into a pattern: ".*" matched every account.
        let holders = await db.User.filter({ referral_code: refCodeRaw }, 'created_date', 5);
        if (holders.length === 0) {
            const literal = refCodeRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            holders = await db.User.filter({
                referral_code: { $regex: `^${literal}$`, $options: 'i' },
            }, 'created_date', 5);
        }
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
