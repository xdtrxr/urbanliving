import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Authenticate user and check admin
        const user = await base44.auth.me();
        if (!user || user.role !== 'admin') {
            return Response.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
        }

        const { withdrawal_request_id } = await req.json();

        if (!withdrawal_request_id) {
            return Response.json({ 
                error: 'Missing withdrawal_request_id' 
            }, { status: 400 });
        }

        // Get withdrawal request
        const withdrawalRequest = await base44.asServiceRole.entities.WithdrawalRequest.get(withdrawal_request_id);
        
        if (!withdrawalRequest) {
            return Response.json({ error: 'Withdrawal request not found' }, { status: 404 });
        }

        if (withdrawalRequest.status !== 'pending') {
            return Response.json({ 
                error: `Withdrawal is already ${withdrawalRequest.status}` 
            }, { status: 400 });
        }

        // Get bank account details
        const bankAccount = await base44.asServiceRole.entities.UserBankAccount.get(withdrawalRequest.bank_account_id);
        
        if (!bankAccount) {
            return Response.json({ error: 'Bank account not found' }, { status: 404 });
        }

        const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        if (!paystackSecretKey) {
            return Response.json({ error: 'Payment service not configured' }, { status: 500 });
        }

        // Update status to processing
        await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_request_id, {
            status: 'processing'
        });

        let recipientCode = bankAccount.recipient_code;

        // Create transfer recipient if not exists
        if (!recipientCode) {
            const recipientResponse = await fetch('https://api.paystack.co/transferrecipient', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${paystackSecretKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    type: 'nuban',
                    name: bankAccount.account_name,
                    account_number: bankAccount.account_number,
                    bank_code: bankAccount.bank_code,
                    currency: 'NGN'
                })
            });

            const recipientData = await recipientResponse.json();

            if (!recipientResponse.ok || !recipientData.status) {
                // Revert status and refund
                await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_request_id, {
                    status: 'failed',
                    error_message: recipientData.message || 'Failed to create transfer recipient',
                    processed_at: new Date().toISOString()
                });

                // Refund user
                const requestUser = await base44.asServiceRole.entities.User.filter({ email: withdrawalRequest.user_email });
                if (requestUser.length > 0) {
                    const currentBalance = requestUser[0].referral_balance_ngn || 0;
                    await base44.asServiceRole.entities.User.update(requestUser[0].id, {
                        referral_balance_ngn: currentBalance + withdrawalRequest.amount
                    });
                }

                return Response.json({ 
                    success: false,
                    error: 'Failed to create transfer recipient',
                    details: recipientData
                }, { status: 400 });
            }

            recipientCode = recipientData.data.recipient_code;

            // Update bank account with recipient code
            await base44.asServiceRole.entities.UserBankAccount.update(bankAccount.id, {
                recipient_code: recipientCode
            });
        }

        // Initiate transfer
        const transferResponse = await fetch('https://api.paystack.co/transfer', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${paystackSecretKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                source: 'balance',
                reason: `LuxeLiving withdrawal - ${withdrawalRequest.id.substring(0, 8)}`,
                amount: withdrawalRequest.amount * 100, // Convert to kobo
                recipient: recipientCode,
                reference: `WD-${withdrawalRequest.id.substring(0, 8)}-${Date.now()}`
            })
        });

        const transferData = await transferResponse.json();

        if (!transferResponse.ok || !transferData.status) {
            // Revert status and refund
            await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_request_id, {
                status: 'failed',
                error_message: transferData.message || 'Transfer initiation failed',
                processed_at: new Date().toISOString()
            });

            // Refund user
            const requestUser = await base44.asServiceRole.entities.User.filter({ email: withdrawalRequest.user_email });
            if (requestUser.length > 0) {
                const currentBalance = requestUser[0].referral_balance_ngn || 0;
                await base44.asServiceRole.entities.User.update(requestUser[0].id, {
                    referral_balance_ngn: currentBalance + withdrawalRequest.amount
                });
            }

            return Response.json({ 
                success: false,
                error: 'Transfer failed',
                details: transferData
            }, { status: 400 });
        }

        // Update withdrawal request with transfer details
        await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_request_id, {
            transfer_code: transferData.data.transfer_code,
            transfer_id: transferData.data.id.toString(),
            status: 'completed',
            processed_at: new Date().toISOString()
        });

        return Response.json({
            success: true,
            message: 'Withdrawal processed successfully',
            transfer_data: transferData.data
        });

    } catch (error) {
        console.error('Error processing withdrawal:', error);
        return Response.json({ 
            success: false,
            error: error.message 
        }, { status: 500 });
    }
});