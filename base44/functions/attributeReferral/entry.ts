import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

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

        // Already attributed? (one-shot per user)
        const existing = await base44.asServiceRole.entities.Referral.filter({ referred_email: user.email });
        if (existing.length > 0) {
            return new Response(JSON.stringify({
                success: false,
                code: 'ALREADY_ATTRIBUTED',
                error: 'You have already used a referral code',
            }), { status: 409, headers });
        }

        // Find referrer by code (service role bypasses User RLS)
        const referrers = await base44.asServiceRole.entities.User.filter({ referral_code: refCodeRaw });
        if (referrers.length === 0) {
            return new Response(JSON.stringify({
                success: false,
                code: 'INVALID_CODE',
                error: 'Referral code not found',
            }), { status: 404, headers });
        }
        const referrer = referrers[0];

        if (referrer.email === user.email) {
            return new Response(JSON.stringify({
                success: false,
                code: 'SELF_REFERRAL',
                error: 'You cannot use your own referral code',
            }), { status: 400, headers });
        }

        // Stamp the user with the code
        await base44.asServiceRole.entities.User.update(user.id, {
            referred_by_code: refCodeRaw,
            referral_prompt_seen: true,
        });

        // Create the Referral record
        const referral = await base44.asServiceRole.entities.Referral.create({
            referrer_email: referrer.email,
            referred_email: user.email,
            status: 'signed_up',
        });

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
