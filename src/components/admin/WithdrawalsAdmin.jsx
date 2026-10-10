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

  const handleProcess = async () => {
    if (!confirmTarget) return;
    const target = confirmTarget;
    setProcessingId(target.id);
    setConfirmTarget(null);
    // invokeFn never throws: a refusal arrives as r.error, the server's own
    // sentence. For a driver-wallet request that includes "The driver's
    // released earnings do not cover this request", which is the case this
    // screen most needs to be able to show.
    const r = await invokeFn('processWithdrawal', { withdrawal_request_id: target.id });
    if (r.ok) {
      toast({
        title: 'Transfer initiated',
        description: 'Paystack accepted the transfer. Status will flip to Completed when the bank settles.',
      });
    } else {
      toast({
        title: r.code === 'NOT_COVERED' ? 'Not paid: the earnings do not cover it' : 'Transfer rejected',
        description: r.body?.details?.message ? `${r.error}: ${r.body.details.message}` : r.error,
        variant: 'destructive',
      });
    }
    setProcessingId(null);
    await load();
  };

  const filtered = filter === 'all' ? requests : requests.filter((r) => r.status === filter);

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
              const isPending = r.status === 'pending';
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
                    {isPending && (
                      <div className="flex flex-col sm:items-end gap-2 flex-shrink-0 w-full sm:w-auto">
                        <Button
                          size="sm"
                          onClick={() => setConfirmTarget(r)}
                          disabled={processingId === r.id || !bank || !bank.is_verified}
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
                              Process now
                            </>
                          )}
                        </Button>
                        {bank && !bank.is_verified && (
                          <p className="text-[11px] text-rose-600 dark:text-rose-400 sm:text-right">Bank account not verified</p>
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
            <AlertDialogTitle>Process withdrawal?</AlertDialogTitle>
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
    </Card>
  );
}
