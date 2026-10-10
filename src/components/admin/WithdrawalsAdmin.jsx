import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2, Mail, Wallet, RefreshCw, Send, CheckCircle, XCircle, Clock, AlertTriangle, Landmark } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { invokeFn } from '@/lib/invokeFn';
import { withdrawalActions, showsUnderPending } from '@/lib/withdrawalRow';
import { useToast } from '@/components/ui/use-toast';

// WithdrawalsAdmin — admin tab for working through pending payouts.
//
// What it does:
//   - Lists every WithdrawalRequest (admin RLS allows read across users).
//   - Filterable by status: pending / processing / completed / failed / reversed.
//   - For pending rows, shows a "Process now" button that confirms then
//     invokes the processWithdrawal Deno function.
//   - For each row, enriches the bank_account_id with the matching
//     UserBankAccount so admin can see "Hassan Dare · GTBank · 0123456789"
//     before approving.
//   - Live refresh: re-loads after every action; auto-poll every 30s for
//     async status changes (Paystack webhook flips processing→completed in
//     the background, so the list keeps updating without a manual refresh).
//
// Mobile-friendly: header stacks, rows wrap, action button drops below row
// body on phones.

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'reversed', label: 'Reversed' },
];

const STATUS_BADGE = {
  pending: { icon: Clock, color: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900' },
  processing: { icon: Loader2, color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-900' },
  completed: { icon: CheckCircle, color: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900' },
  failed: { icon: XCircle, color: 'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-rose-200 dark:border-rose-900' },
  reversed: { icon: AlertTriangle, color: 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 border-purple-200 dark:border-purple-900' },
};

const fmtDateTime = (s) => {
  if (!s) return '—';
  try { return format(parseISO(s), 'MMM d, yyyy h:mm a'); } catch { return s; }
};

const maskAccount = (n) => {
  if (!n || typeof n !== 'string') return '—';
  if (n.length <= 4) return n;
  return `${n.slice(0, 2)}******${n.slice(-2)}`;
};

export default function WithdrawalsAdmin() {
  const { toast } = useToast();
  const [requests, setRequests] = useState([]);
  const [bankAccounts, setBankAccounts] = useState({}); // keyed by id
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');
  const [processingId, setProcessingId] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);
  // A referral request the server would not send without a second yes.
  const [unrecordedTarget, setUnrecordedTarget] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const rows = await base44.entities.WithdrawalRequest.list('-created_date', 200);
      setRequests(Array.isArray(rows) ? rows : []);

      // Resolve every referenced bank account in one go. UserBankAccount RLS
      // permits admin to read across users; we batch by unique id.
      const ids = [...new Set((rows || []).map((r) => r.bank_account_id).filter(Boolean))];
      if (ids.length > 0) {
        const accounts = await base44.entities.UserBankAccount.filter({ id: { $in: ids } });
        const map = {};
        (accounts || []).forEach((a) => { map[a.id] = a; });
        setBankAccounts(map);
      }
    } catch (err) {
      console.error('Failed to load withdrawals:', err);
      if (!silent) {
        toast({
          title: 'Could not load withdrawals',
          description: err?.message || 'Try the refresh button.',
          variant: 'destructive',
        });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    // Background poll. processWithdrawal leaves rows in `processing`; the
    // paystackTransferWebhook flips them async. A 30s poll keeps the list
    // current without forcing the admin to refresh manually.
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, [load]);

  // One call behind every button on a row. The server reads the row and
  // decides what the press means: send, retry, ask Paystack, or look again
  // at a credit. invokeFn never throws: a refusal arrives as r.error, the
  // server's own sentence.
  const run = async (target, extra = {}) => {
    if (!target) return;
    setProcessingId(target.id);
    const r = await invokeFn('processWithdrawal', { withdrawal_request_id: target.id, ...extra });
    setProcessingId(null);
    if (!r.ok && r.code === 'UNRECORDED') {
      // Nothing was sent. Admin has to say yes a second time, with the reason
      // in front of them.
      setUnrecordedTarget(target);
      return;
    }
    if (r.ok) {
      const b = r.body || {};
      const notCredited = b.refund !== undefined && !b.credited;
      toast({
        title: b.warning === 'NEEDS_OTP' ? 'Paystack is waiting for a code'
          : b.refund !== undefined ? (b.credited ? 'Credited back' : 'Not credited back')
            : b.already_sent ? 'Checked with Paystack'
              : 'Transfer initiated',
        description: b.message || 'Paystack accepted the transfer. Status will flip to Completed when the bank settles.',
        variant: b.warning || notCredited ? 'destructive' : undefined,
      });
    } else {
      toast({
        title: {
          NOT_COVERED: 'Not paid: the earnings do not cover it',
          UNCONFIRMED: 'Not confirmed yet',
          BANK_MISMATCH: 'Not sent: check this request',
          NOT_SENDABLE: 'Nothing to send',
          NO_TRANSFER: 'Paystack has no such transfer',
        }[r.code] || 'Transfer rejected',
        description: r.body?.details?.message ? `${r.error}: ${r.body.details.message}` : r.error,
        variant: 'destructive',
      });
    }
    await load();
  };

  const handleProcess = async () => {
    const target = confirmTarget;
    setConfirmTarget(null);
    await run(target);
  };

  const sendUnrecorded = async () => {
    const target = unrecordedTarget;
    setUnrecordedTarget(null);
    await run(target, { allow_unrecorded: true });
  };

  // "Pending" is everything that still needs a press to get the money out,
  // which includes a row left as processing when Paystack never answered.
  const filtered = filter === 'all' ? requests
    : filter === 'pending' ? requests.filter(showsUnderPending)
      : requests.filter((r) => r.status === filter);

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-slate-900 dark:text-white">
            <Wallet className="w-5 h-5 text-amber-500 dark:text-amber-400 flex-shrink-0" />
            Withdrawals
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Pending payouts surface here. Hit Process now to fire the Paystack transfer.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-10 w-40 rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => load()}
            disabled={loading}
            className="rounded-xl flex-shrink-0"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading && requests.length === 0 ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-slate-500 dark:text-slate-400 py-10 text-sm">
            {filter === 'pending'
              ? 'No pending withdrawals right now. 🎉'
              : `No withdrawals in "${filter}" state.`}
          </p>
        ) : (
          <div className="space-y-3">
            {filtered.map((r) => {
              const bank = bankAccounts[r.bank_account_id];
              const badge = STATUS_BADGE[r.status] || STATUS_BADGE.pending;
              const BadgeIcon = badge.icon;
              const isProcessing = r.status === 'processing';
              // What the server would do with this row, so the screen offers
              // exactly that. retry: marked processing, but Paystack never
              // answered with a transfer code. recheck: sent and not settled.
              // credit: a failed referral request that was not credited back.
              const act = withdrawalActions(r);
              const isStuck = act.retry;
              return (
                <div
                  key={r.id}
                  className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-lg font-bold text-slate-900 dark:text-white">
                          ₦{(Number(r.amount) || 0).toLocaleString()}
                        </p>
                        <Badge className={`${badge.color} border font-medium flex items-center gap-1`}>
                          <BadgeIcon className={`w-3 h-3 ${isProcessing ? 'animate-spin' : ''}`} />
                          {r.status}
                        </Badge>
                        {r.refunded_at && (
                          <Badge variant="outline" className="text-xs">Refunded</Badge>
                        )}
                        <Badge variant="outline" className="text-xs">
                          {r.wallet === 'driver' ? 'Driver earnings' : 'Referral'}
                        </Badge>
                      </div>
                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
                        <span className="flex items-center gap-1.5 truncate">
                          <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                          <span className="truncate">{r.user_email}</span>
                        </span>
                        <span className="flex items-center gap-1.5 truncate">
                          <Landmark className="w-3.5 h-3.5 flex-shrink-0" />
                          {bank ? (
                            <span className="truncate">
                              {bank.account_name} · {bank.bank_name} · {maskAccount(bank.account_number)}
                            </span>
                          ) : (
                            <span className="italic text-slate-400">Bank account not found</span>
                          )}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" />
                          Requested {fmtDateTime(r.requested_at || r.created_date)}
                        </span>
                        {r.processed_at && (
                          <span className="flex items-center gap-1.5">
                            <CheckCircle className="w-3.5 h-3.5" />
                            Processed {fmtDateTime(r.processed_at)}
                          </span>
                        )}
                      </div>
                      {r.transfer_code && (
                        <p className="mt-2 text-xs text-slate-400 font-mono break-all">
                          ref: {r.transfer_code}
                        </p>
                      )}
                      {r.error_message && (
                        <div className="mt-2 text-xs bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-200 rounded-lg px-2 py-1.5">
                          <strong>Error:</strong> {r.error_message}
                        </div>
                      )}
                    </div>
                    {(act.send || act.retry || act.recheck || act.credit) && (
                      <div className="flex flex-col sm:items-end gap-2 flex-shrink-0 w-full sm:w-auto">
                        {/* A first send needs a verified account on screen. A
                            retry does not: the server asks Paystack what it
                            already holds before it reads the account at all. */}
                        {(act.send || act.retry) && (
                          <Button
                            size="sm"
                            onClick={() => setConfirmTarget(r)}
                            disabled={processingId === r.id || (act.send && (!bank || !bank.is_verified))}
                            className="rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-700 hover:to-emerald-800 text-white w-full sm:w-auto"
                          >
                            {processingId === r.id ? (
                              <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Sending…
                              </>
                            ) : (
                              <>
                                <Send className="w-4 h-4 mr-2" />
                                {isStuck ? 'Retry' : 'Process now'}
                              </>
                            )}
                          </Button>
                        )}
                        {/* Neither of these sends anything, so neither asks
                            "are you sure". */}
                        {(act.recheck || act.credit) && (
                          <Button
                            size="sm" variant="outline"
                            onClick={() => run(r)}
                            disabled={processingId === r.id}
                            className="rounded-xl w-full sm:w-auto"
                          >
                            {processingId === r.id
                              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              : <RefreshCw className="w-4 h-4 mr-2" />}
                            {act.recheck ? 'Check with Paystack' : 'Credit back'}
                          </Button>
                        )}
                        {act.recheck && (
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 sm:text-right sm:max-w-[220px]">
                            Asks Paystack where this transfer stands. It never sends anything.
                          </p>
                        )}
                        {act.credit && (
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 sm:text-right sm:max-w-[220px]">
                            Not credited back. This asks Paystack first, then credits it if nothing went out.
                          </p>
                        )}
                        {act.send && bank && !bank.is_verified && (
                          <p className="text-[11px] text-rose-600 dark:text-rose-400 sm:text-right">Bank account not verified</p>
                        )}
                        {isStuck && (
                          <p className="text-[11px] text-amber-700 dark:text-amber-300 sm:text-right sm:max-w-[220px]">
                            Paystack never confirmed this one. Retrying cannot send it twice.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!confirmTarget} onOpenChange={(open) => { if (!open) setConfirmTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmTarget?.status === 'processing' ? 'Retry this withdrawal?' : 'Process withdrawal?'}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {confirmTarget && (
                <>
                  <span className="block">
                    Send <strong>₦{(Number(confirmTarget.amount) || 0).toLocaleString()}</strong> to{' '}
                    <strong>{bankAccounts[confirmTarget.bank_account_id]?.account_name || confirmTarget.user_email}</strong>
                    {bankAccounts[confirmTarget.bank_account_id] && (
                      <>
                        {' '}at <strong>{bankAccounts[confirmTarget.bank_account_id].bank_name}</strong> ({maskAccount(bankAccounts[confirmTarget.bank_account_id].account_number)}).
                      </>
                    )}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    Paystack will accept the transfer and settle async. The status will flip to Completed when the bank confirms; if it fails, the user's balance is refunded automatically.
                  </span>
                  {confirmTarget.status === 'processing' && (
                    <span className="block text-xs text-amber-700 dark:text-amber-300">
                      Paystack never confirmed the first attempt. It is asked what it already holds for this withdrawal before anything is sent, so the money cannot go out twice.
                    </span>
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleProcess}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              Send transfer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!unrecordedTarget} onOpenChange={(open) => { if (!open) setUnrecordedTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>No record of this money leaving the balance</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {unrecordedTarget && (
                <>
                  <span className="block">
                    The app has no record of taking{' '}
                    <strong>₦{(Number(unrecordedTarget.amount) || 0).toLocaleString()}</strong> off the referral balance of{' '}
                    <strong>{unrecordedTarget.user_email}</strong> for this request. Nothing has been sent.
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    A request made before this version of the app can be genuine. One typed into the database by hand looks exactly the same. Check this person&apos;s referral earnings first. If you send it and it fails, it is not credited back automatically.
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Do not send</AlertDialogCancel>
            <AlertDialogAction
              onClick={sendUnrecorded}
              className="bg-rose-600 hover:bg-rose-700 text-white"
            >
              Send anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
