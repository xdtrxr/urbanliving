import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// processWithdrawal
// ----------------------------------------------------------------------------
// Admin sends a pending withdrawal to Paystack.
//
// A referral withdrawal was debited from User.referral_balance_ngn when it was
// requested, so it is refunded there if Paystack turns the transfer down.
//
// A driver-wallet withdrawal was not debited from anywhere: the row is the
// reservation against the driver's released earnings. So before any money
// moves, the request is checked against the ledger again here. That is the
// guard that matters, because nothing about the row itself can be trusted: a
// browser can create a WithdrawalRequest row directly until the stricter
// create rule staged in docs/entity-rules-pending-publish is live, and an
// honest request can be overtaken by a reversal of the pay it relied on.

const WITHDRAWAL_THRESHOLD_NGN = 10000;

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, undefined, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

// ── Wallet arithmetic — lockstep copies, see getDriverWallet ────────────────

// Every login this driver is, or was, linked to. Lower-cased, once each.
function driverEmails(driver: any) {
    const all = [driver && driver.user_email].concat((driver && driver.previous_user_emails) || []);
    const out = [];
    for (const raw of all) {
        const email = String(raw || '').trim().toLowerCase();
        if (email && !out.includes(email)) out.push(email);
    }
    return out;
}

// The withdrawal rows that count against this driver's balance: driver-wallet
// rows carrying this driver's id AND made by a login that is, or was, linked
// to this driver. The second condition is not decoration. Until the staged
// rule that stops browsers creating WithdrawalRequest rows is live, any
// signed-in user can create one for their own email with any driver_id on it;
// the email is the one field the access rule pins to the creator.
function driverWithdrawals(driver: any, rows: any[]) {
    if (!driver) return [];
    const emails = driverEmails(driver);
    return (rows || []).filter((w) => !!w
        && w.wallet === 'driver'
        && w.driver_id === driver.id
        && emails.includes(String(w.user_email || '').trim().toLowerCase()));
}

// The driver's position in whole naira. Pass withdrawals through
// driverWithdrawals first. A failed or reversed transfer counts nowhere, so it
// needs no refund. If pay is reversed after it was withdrawn, available stops
// at zero and the difference is carried as shortfall until later pay covers it.
function walletTotals(earnings: any[], withdrawals: any[]) {
    const naira = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    let held = 0;
    let released = 0;
    for (const e of earnings || []) {
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
        else if (e.status === 'released') released += naira(e.amount_ngn);
    }
    let paidOut = 0;
    let reserved = 0;
    for (const w of withdrawals || []) {
        if (!w) continue;
        if (w.status === 'completed') paidOut += naira(w.amount);
        else if (w.status === 'pending' || w.status === 'processing') reserved += naira(w.amount);
    }
    const net = released - paidOut - reserved;
    return {
        held,
        released,
        paid_out: paidOut,
        reserved,
        available: Math.max(0, net),
        shortfall: Math.max(0, -net),
    };
}

// Only a withdrawal that debited a stored balance is refunded to one. A row
// written before wallets existed is a referral withdrawal. Lockstep copy in
// paystackTransferWebhook.
function refundsToBalance(withdrawal: any) {
    return !!withdrawal && withdrawal.wallet !== 'driver';
}

// Why a driver-wallet withdrawal must not be paid, or '' when it may be.
// The request itself is one of the rows walletTotals counts, so "the ledger
// covers it" is the same as "there is no shortfall".
async function driverWithdrawalProblem(sr: any, w: any) {
    const amount = Number(w.amount);
    if (typeof w.amount !== 'number' || !Number.isInteger(amount) || amount < WITHDRAWAL_THRESHOLD_NGN) {
        return 'The amount on this request is not a valid withdrawal.';
    }
    if (!w.driver_id) return 'This request names no driver.';
    const driver = await sr.Driver.get(w.driver_id);
    if (!driver) return 'The driver profile for this request no longer exists.';
    // Only the login linked to the driver right now may start a withdrawal.
    const requester = String(w.user_email || '').trim().toLowerCase();
    if (!requester || requester !== String(driver.user_email || '').trim().toLowerCase()) {
        return 'This login is not the one linked to the driver profile.';
    }
    const earnings = await fetchAll(sr.DriverEarning, { driver_id: driver.id });
    const rows = await fetchAll(sr.WithdrawalRequest, { driver_id: driver.id });
    const totals = walletTotals(earnings, driverWithdrawals(driver, rows));
    if (totals.shortfall > 0) {
        return `The driver's released earnings do not cover this request (short by ₦${totals.shortfall.toLocaleString()}).`;
    }
    return '';
}

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

        // A driver-wallet request is only as good as the ledger behind it.
        // Checked here, after the "still pending" guard and before anything
        // is sent, and a request that fails is closed so it cannot be retried
        // into a payout later.
        if (withdrawalRequest.wallet === 'driver') {
            const problem = await driverWithdrawalProblem(base44.asServiceRole.entities, withdrawalRequest);
            if (problem) {
                await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_request_id, {
                    status: 'failed',
                    error_message: problem,
                    processed_at: new Date().toISOString(),
                });
                return Response.json({ success: false, error: problem, code: 'NOT_COVERED' }, { status: 409 });
            }
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

                // Refund user. A driver-wallet request debited nothing, so it
                // has nothing to credit back: marking it failed is the refund.
                const requestUser = refundsToBalance(withdrawalRequest)
                    ? await base44.asServiceRole.entities.User.filter({ email: withdrawalRequest.user_email })
                    : [];
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
                reason: `UrbanStays withdrawal - ${withdrawalRequest.id.substring(0, 8)}`,
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

            // Refund user. A driver-wallet request debited nothing, so it
            // has nothing to credit back: marking it failed is the refund.
            const requestUser = refundsToBalance(withdrawalRequest)
                ? await base44.asServiceRole.entities.User.filter({ email: withdrawalRequest.user_email })
                : [];
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

        // Paystack accepted the transfer for processing. DO NOT mark
        // `completed` here — the transfer is asynchronous and Paystack
        // may still fail to settle (insufficient float, bank rejects the
        // NUBAN, account closed). The paystackTransferWebhook listens
        // for transfer.success / transfer.failed / transfer.reversed and
        // flips the row to its final state, refunding the user's balance
        // on failure or reversal.
        await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_request_id, {
            transfer_code: transferData.data.transfer_code,
            transfer_id: transferData.data.id.toString(),
            // status stays 'processing' until the webhook confirms outcome
        });

        return Response.json({
            success: true,
            message: 'Transfer initiated — Paystack will confirm settlement asynchronously.',
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