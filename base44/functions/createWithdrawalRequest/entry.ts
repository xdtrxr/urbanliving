import { createClientFromRequest } from 'npm:@base44/sdk@0.7.1';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // Authenticate user
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { amount, bank_account_id } = await req.json();

        // Validate input
        if (!amount || !bank_account_id) {
            return Response.json({ 
                error: 'Missing required fields: amount and bank_account_id' 
            }, { status: 400 });
        }

        if (amount < 1000) {
            return Response.json({ 
                error: 'Minimum withdrawal amount is ₦1,000' 
            }, { status: 400 });
        }

        // Check user's available balance
        const userBalance = user.referral_balance_ngn || 0;
        if (amount > userBalance) {
            return Response.json({ 
                error: `Insufficient balance. You have ₦${userBalance.toLocaleString()} available.` 
            }, { status: 400 });
        }

        // Verify bank account belongs to user
        const bankAccount = await base44.entities.UserBankAccount.get(bank_account_id);
        if (!bankAccount || bankAccount.user_email !== user.email) {
            return Response.json({ 
                error: 'Invalid bank account' 
            }, { status: 400 });
        }

        if (!bankAccount.is_verified) {
            return Response.json({ 
                error: 'Bank account is not verified. Please verify your account first.' 
            }, { status: 400 });
        }

        // Check for pending withdrawals
        const pendingWithdrawals = await base44.entities.WithdrawalRequest.filter({
            user_email: user.email,
            status: { $in: ['pending', 'processing'] }
        });

        if (pendingWithdrawals.length > 0) {
            return Response.json({ 
                error: 'You have a pending withdrawal request. Please wait for it to complete.' 
            }, { status: 400 });
        }

        // Create withdrawal request
        const withdrawalRequest = await base44.entities.WithdrawalRequest.create({
            user_email: user.email,
            bank_account_id: bank_account_id,
            amount: amount,
            status: 'pending',
            requested_at: new Date().toISOString()
        });

        // Deduct amount from user's balance (mark as reserved)
        const newBalance = userBalance - amount;
        await base44.auth.updateMe({
            referral_balance_ngn: newBalance
        });

        return Response.json({
            success: true,
            withdrawal_request: withdrawalRequest,
            message: 'Withdrawal request created successfully. It will be processed within 24-48 hours.'
        });

    } catch (error) {
        console.error('Error creating withdrawal request:', error);
        return Response.json({ 
            success: false,
            error: error.message 
        }, { status: 500 });
    }
});