import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

const WITHDRAWAL_THRESHOLD_NGN = 10000;

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

        if (amount < WITHDRAWAL_THRESHOLD_NGN) {
            return Response.json({
                error: `Minimum withdrawal amount is ₦${WITHDRAWAL_THRESHOLD_NGN.toLocaleString()}`
            }, { status: 400 });
        }

        // Check user's available balance — must meet threshold AND have enough
        const userBalance = user.referral_balance_ngn || 0;
        if (userBalance < WITHDRAWAL_THRESHOLD_NGN) {
            return Response.json({
                error: `You need at least ₦${WITHDRAWAL_THRESHOLD_NGN.toLocaleString()} in referral earnings to withdraw. Current balance: ₦${userBalance.toLocaleString()}.`
            }, { status: 400 });
        }
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

        // Race defence: a concurrent withdrawal could have slipped past the
        // pending-check above. Re-read the user, verify pending count is now 1,
        // and only deduct if everything still adds up. If we lost the race,
        // mark this request as failed and surface a clear error.
        const freshUser = await base44.asServiceRole.entities.User.filter({ email: user.email });
        const liveBalance = freshUser[0]?.referral_balance_ngn || 0;
        const livePending = await base44.entities.WithdrawalRequest.filter({
            user_email: user.email,
            status: { $in: ['pending', 'processing'] }
        });

        if (livePending.length > 1 || liveBalance < amount) {
            await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawalRequest.id, {
                status: 'failed',
                error_message: 'Concurrent withdrawal detected — request rejected.',
                processed_at: new Date().toISOString(),
            });
            return Response.json({
                success: false,
                error: 'A concurrent withdrawal request was detected. Please try again in a moment.'
            }, { status: 409 });
        }

        // Deduct amount from user's balance (mark as reserved)
        const newBalance = liveBalance - amount;
        await base44.asServiceRole.entities.User.update(freshUser[0].id, {
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