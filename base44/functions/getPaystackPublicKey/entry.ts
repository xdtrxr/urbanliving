import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// Returns the Paystack public key for client-side Paystack popup initialization.
// Authenticated users only — the public key isn't a secret per se but limiting
// it to logged-in users keeps it out of arbitrary scrapers.

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST' && req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
    }

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me().catch(() => null);
        if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
        }

        const publicKey = Deno.env.get('PAYSTACK_PUBLIC_KEY');
        if (!publicKey) {
            console.error('PAYSTACK_PUBLIC_KEY not configured');
            return new Response(JSON.stringify({
                error: 'Payment provider not configured',
            }), { status: 500, headers });
        }

        return new Response(JSON.stringify({ publicKey }), { status: 200, headers });
    } catch (error) {
        console.error('getPaystackPublicKey error:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            details: (error as Error).message,
        }), { status: 500, headers });
    }
});
