import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Authenticate user
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { account_number, bank_code } = await req.json();

        if (!account_number || !bank_code) {
            return Response.json({ 
                error: 'Missing required fields: account_number and bank_code' 
            }, { status: 400 });
        }

        // Validate account number format (10 digits)
        if (!/^\d{10}$/.test(account_number)) {
            return Response.json({ 
                error: 'Invalid account number format. Must be 10 digits.' 
            }, { status: 400 });
        }

        const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        if (!paystackSecretKey) {
            return Response.json({ 
                error: 'Payment service not configured' 
            }, { status: 500 });
        }

        // Call Paystack API to resolve account
        const response = await fetch(
            `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${paystackSecretKey}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        const data = await response.json();

        if (!response.ok || !data.status) {
            return Response.json({ 
                success: false,
                error: data.message || 'Could not resolve bank account',
                details: data
            }, { status: 400 });
        }

        return Response.json({
            success: true,
            account_name: data.data.account_name,
            account_number: data.data.account_number,
            bank_code: bank_code
        });

    } catch (error) {
        console.error('Error resolving bank account:', error);
        return Response.json({ 
            success: false,
            error: error.message 
        }, { status: 500 });
    }
});