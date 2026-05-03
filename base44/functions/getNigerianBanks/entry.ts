import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Authenticate user
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        if (!paystackSecretKey) {
            return Response.json({ 
                error: 'Payment service not configured' 
            }, { status: 500 });
        }

        // Fetch list of Nigerian banks from Paystack
        const response = await fetch('https://api.paystack.co/bank?country=nigeria', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${paystackSecretKey}`,
                'Content-Type': 'application/json',
            },
        });

        const data = await response.json();

        if (!response.ok || !data.status) {
            return Response.json({ 
                success: false,
                error: 'Failed to fetch banks list',
                details: data
            }, { status: 400 });
        }

        return Response.json({
            success: true,
            banks: data.data
        });

    } catch (error) {
        console.error('Error fetching banks:', error);
        return Response.json({ 
            success: false,
            error: error.message 
        }, { status: 500 });
    }
});