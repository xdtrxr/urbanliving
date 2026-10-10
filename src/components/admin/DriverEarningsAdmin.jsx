import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Loader2, RefreshCw, Banknote, Clock, CheckCircle, Undo2, PauseCircle, AlertTriangle, AlertCircle,
} from 'lucide-react';
import { invokeFn } from '@/lib/invokeFn';
import { useToast } from '@/components/ui/use-toast';

// DriverEarningsAdmin — every driver's pay, ride by ride, and the five things
// admin can do to a row: release it now, hold it, lift the hold, adjust the
// figure, reverse it.
//
// Nothing on this screen adds money up. The per-driver lines and the totals
// come from getDriverEarningsAdmin, which runs the same arithmetic the
// driver's own wallet runs. Every action goes through settleDriverEarning,
// which decides whether the change is allowed.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

const fmtWhen = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return '—'; }
};

const FILTERS = [
  { value: 'held', label: 'Held' },
  { value: 'on-hold', label: 'On hold' },
  { value: 'released', label: 'Released' },
  { value: 'reversed', label: 'Reversed' },
  { value: 'all', label: 'All' },
];

const viewOf = (e) => {
  if (e.status === 'held') return e.on_hold ? 'on-hold' : 'held';
  return e.status;
};

const VIEW_STYLE = {
  held: { label: 'Held', icon: Clock, className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900' },
  'on-hold': { label: 'On hold', icon: PauseCircle, className: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 border-orange-200 dark:border-orange-900' },
  released: { label: 'Released', icon: CheckCircle, className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900' },
  reversed: { label: 'Reversed', icon: Undo2, className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700' },
};

// Which buttons a row gets. settleDriverEarning enforces the same table; this
// only stops admin being offered a move that would be refused.
const ACTIONS_FOR = {
  held: ['release', 'hold', 'adjust', 'reverse'],
  'on-hold': ['unhold', 'release', 'adjust', 'reverse'],
  released: ['reverse'],
  reversed: [],
};

const ACTION_COPY = {
  release: {
    button: 'Release now', title: 'Release this pay now?',
    body: 'It moves to the driver\'s available balance straight away instead of waiting for the release time.',
    done: 'Pay released',
  },
  hold: {
    button: 'Hold', title: 'Hold this pay',
    body: 'It will not be released until you lift the hold. The driver sees "under review".',
    needsReason: true, done: 'Pay put on hold',
  },
  unhold: {
    button: 'Lift hold', title: 'Lift the hold?',
    body: 'The pay is released at its release time, or at the next sweep if that time has passed.',
    done: 'Hold lifted',
  },
  adjust: {
    button: 'Adjust', title: 'Adjust the pay for this ride',
    body: 'Use this for extra hours or an agreed deduction. Only pay that is still held can be changed.',
    needsReason: true, needsAmount: true, done: 'Pay adjusted',
  },
  reverse: {
    button: 'Reverse', title: 'Reverse this pay',
    body: 'The ride no longer pays the driver. This cannot be undone.',
    needsReason: true, danger: true, done: 'Pay reversed',
  },
};

export default function DriverEarningsAdmin() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('held');
  const [pending, setPending] = useState(null); // { earning, action }
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    const r = await invokeFn('getDriverEarningsAdmin');
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = (earning, action) => {
    setReason('');
    setAmount(action === 'adjust' ? String(Math.round(Number(earning.amount_ngn) || 0)) : '');
    setPending({ earning, action });
  };

  const confirm = async () => {
    if (!pending) return;
    const { earning, action } = pending;
    const copy = ACTION_COPY[action];
    if (copy.needsReason && !reason.trim()) {
      toast({ title: 'A reason is needed', description: 'It is kept on the record with the change.', variant: 'destructive' });
      return;
    }
    let amountNgn;
    if (copy.needsAmount) {
      if (!/^\d{1,9}$/.test(amount.trim())) {
        toast({ title: 'Check the amount', description: 'Enter the new pay in whole naira, digits only.', variant: 'destructive' });
        return;
      }
      amountNgn = Number(amount.trim());
    }
    setWorking(true);
    const r = await invokeFn('settleDriverEarning', {
      earning_id: earning.id,
      action,
      reason: reason.trim() || undefined,
      amount_ngn: amountNgn,
    });
    setWorking(false);
    if (!r.ok) {
      toast({ title: 'Not changed', description: r.error, variant: 'destructive' });
      return;
    }
    setPending(null);
    toast({
      title: copy.done,
      description: action === 'reverse' && r.data?.was_released
        ? `${earning.driver_name} could already withdraw this. Their available balance is now ${ngn(earning.amount_ngn)} lower.`
        : `${earning.vehicle_name || 'Ride'} · ${earning.driver_name}`,
    });
    await load(true);
  };

  const earnings = data?.earnings || [];
  const shown = filter === 'all' ? earnings : earnings.filter((e) => viewOf(e) === filter);
  const drivers = data?.drivers || [];
  const copy = pending ? ACTION_COPY[pending.action] : null;

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-slate-900 dark:text-white">
            <Banknote className="w-5 h-5 text-amber-500 dark:text-amber-400 flex-shrink-0" />
            Driver earnings
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Pay is held when a driver is assigned and released two hours after the ride ends. Step in here when it should not be.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-10 w-36 rounded-xl"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            variant="outline" size="icon" onClick={() => load(true)} disabled={refreshing}
            className="rounded-xl flex-shrink-0" aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {error && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400 dark:text-slate-500" />
          </div>
        ) : (
          <>
            {drivers.length > 0 && (
              <div className="mb-6">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                  By driver
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {drivers.map((d) => (
                    <div key={d.driver_id} className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="font-semibold text-sm text-slate-900 dark:text-white truncate">{d.full_name}</p>
                        {!d.has_login && (
                          <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-0 text-xs flex-shrink-0">No login</Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300">
                        {ngn(d.held)} held · {ngn(d.available)} available · {ngn(d.paid_out)} paid out
                        {d.reserved > 0 ? ` · ${ngn(d.reserved)} being withdrawn` : ''}
                      </p>
                      {d.shortfall > 0 && (
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300">
                          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                          <span>
                            {ngn(d.shortfall)} to recover: pay was reversed after it had been withdrawn.
                            It comes off their next released pay.
                          </span>
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {shown.length === 0 ? (
              <p className="text-center text-slate-500 dark:text-slate-400 py-10 text-sm">
                {earnings.length === 0
                  ? 'No driver pay recorded yet. It appears here when a driver with a login is assigned to a paid ride.'
                  : `Nothing under "${FILTERS.find((f) => f.value === filter)?.label}".`}
              </p>
            ) : (
              <div className="space-y-3">
                {shown.map((e) => {
                  const view = viewOf(e);
                  const style = VIEW_STYLE[view] || VIEW_STYLE.held;
                  const StyleIcon = style.icon;
                  const actions = ACTIONS_FOR[view] || [];
                  return (
                    <div key={e.id} className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4">
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <p className="text-lg font-bold text-slate-900 dark:text-white">{ngn(e.amount_ngn)}</p>
                            <Badge className={`${style.className} border font-medium`}>
                              <StyleIcon className="w-3 h-3 mr-1" />
                              {style.label}
                            </Badge>
                            {e.booking_reference && (
                              <Badge variant="outline" className="text-xs font-mono">{e.booking_reference}</Badge>
                            )}
                            {e.basis === 'manual' && (
                              <Badge variant="outline" className="text-xs">Typed figure</Badge>
                            )}
                          </div>
                          <p className="text-sm text-slate-700 dark:text-slate-200 break-words">
                            {e.driver_name} · {e.vehicle_name || 'Ride'}{e.service_date ? ` · ${e.service_date}` : ''}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                            {view === 'released' ? `Released ${fmtWhen(e.released_at)}`
                              : view === 'reversed' ? `Reversed ${fmtWhen(e.reversed_at)}`
                                : `Releases ${fmtWhen(e.release_at)}`}
                            {e.basis && e.basis !== 'manual' && e.units
                              ? ` · ${e.units} × ${ngn(e.rate_ngn)} per ${e.basis === 'hourly' ? 'hour' : 'day'}`
                              : ''}
                          </p>
                          {e.hold_reason && view === 'on-hold' && (
                            <p className="text-xs text-orange-700 dark:text-orange-300 mt-1 break-words">Held because: {e.hold_reason}</p>
                          )}
                          {e.adjustment_reason && (
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 break-words">Adjusted: {e.adjustment_reason}</p>
                          )}
                          {e.admin_notes && (
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 italic break-words">{e.admin_notes}</p>
                          )}
                        </div>
                        {actions.length > 0 && (
                          <div className="flex flex-wrap gap-2 flex-shrink-0">
                            {actions.map((action) => (
                              <Button
                                key={action} size="sm"
                                variant={action === 'release' ? 'default' : 'outline'}
                                onClick={() => open(e, action)}
                                className={
                                  action === 'release'
                                    ? 'rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'
                                    : ACTION_COPY[action].danger
                                      ? 'rounded-xl border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
                                      : 'rounded-xl'
                                }
                              >
                                {ACTION_COPY[action].button}
                              </Button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {data?.earnings_truncated && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 text-center pt-2">
                    Showing the most recent 500 rows. The per-driver lines above count every row.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={!!pending} onOpenChange={(o) => { if (!o && !working) setPending(null); }}>
        <DialogContent className="max-w-md">
          {pending && copy && (
            <>
              <DialogHeader>
                <DialogTitle>{copy.title}</DialogTitle>
                <DialogDescription>
                  {ngn(pending.earning.amount_ngn)} · {pending.earning.driver_name} · {pending.earning.vehicle_name || 'Ride'}
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm text-slate-600 dark:text-slate-300">{copy.body}</p>
              {pending.action === 'reverse' && pending.earning.status === 'released' && (
                <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl p-3">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-amber-900 dark:text-amber-100">
                    This pay was already released. If the driver has withdrawn it, the amount shows as
                    money to recover and comes off their next released pay.
                  </p>
                </div>
              )}
              {copy.needsAmount && (
                <div>
                  <Label htmlFor="de-amount">New pay (₦)</Label>
                  <Input
                    id="de-amount" type="text" inputMode="numeric" autoComplete="off" value={amount}
                    onChange={(ev) => setAmount(ev.target.value)} className="mt-1 rounded-xl"
                  />
                </div>
              )}
              {copy.needsReason && (
                <div>
                  <Label htmlFor="de-reason">Reason</Label>
                  <Textarea
                    id="de-reason" rows={3} value={reason} maxLength={500}
                    onChange={(ev) => setReason(ev.target.value)}
                    placeholder="Kept on the record with this change" className="mt-1 rounded-xl"
                  />
                </div>
              )}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setPending(null)} disabled={working} className="rounded-xl">
                  Cancel
                </Button>
                <Button
                  onClick={confirm} disabled={working}
                  className={copy.danger
                    ? 'rounded-xl bg-red-600 hover:bg-red-700 text-white'
                    : 'rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'}
                >
                  {working ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  {copy.button}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
