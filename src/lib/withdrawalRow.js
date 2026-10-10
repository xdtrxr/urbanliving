// What admin can do with one withdrawal row.
//
// MIRROR of canSend, canRecheck and canCredit in
// base44/functions/processWithdrawal/entry.ts. The server decides; these only
// stop the screen offering a button the server would refuse, or hiding one it
// would accept. scripts/check-driver-wallet.mjs runs both over the same rows.
// No imports on purpose: that script loads this file as it is.

export function withdrawalActions(row) {
  const status = row?.status;
  const sent = !!row?.transfer_code;
  return {
    // Not sent yet.
    send: status === 'pending',
    // Marked processing, but Paystack never answered with a transfer code.
    retry: status === 'processing' && !sent,
    // Sent under a reference Paystack knows it by, and not settled.
    recheck: status === 'processing' && sent && !!row?.transfer_reference,
    // A referral request that failed or was reversed and was not credited back.
    credit: !!row && row.wallet !== 'driver' && (status === 'failed' || status === 'reversed') && !row.refunded_at,
  };
}

// The rows that still need admin to press something to get the money out.
export const showsUnderPending = (row) => {
  const a = withdrawalActions(row);
  return a.send || a.retry;
};
