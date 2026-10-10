import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Loader2, RefreshCw, Wallet, Clock, CheckCircle, Send, CreditCard, AlertCircle, Car, Undo2, PauseCircle,
} from 'lucide-react';
import { invokeFn } from '@/lib/invokeFn';
import { createPageUrl } from '@/utils';
import { useDriverProfile } from '@/lib/useDriverProfile';
import DriverNotice from '@/components/driver/DriverNotice';

// DriverWallet — the driver's money in three numbers and the ledger behind them.
//
// Every figure comes from getDriverWallet, which computes it from the ledger
// on each call. This page adds nothing up and stores nothing.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

const fmtWhen = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
};

const fmtDay = (isoDate) => {
  if (!isoDate) return '';
  try {
    return new Date(`${isoDate}T12:00:00+01:00`).toLocaleDateString('en-GB', {
      timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch { return isoDate; }
};

// How one ledger row reads. The server has already decided the state.
function rowState(row) {
  if (row.status === 'released') {
    return {
      label: 'Released', icon: CheckCircle, note: row.released_at ? fmtWhen(row.released_at) : '',
      className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900',
    };
  }
  if (row.status === 'reversed') {
    return {
      label: 'Reversed', icon: Undo2, note: 'This ride no longer pays',
      className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700',
    };
  }
  if (row.on_hold || row.under_review) {
    return {
      label: 'Under review', icon: PauseCircle, note: 'The team is looking at this ride',
      className: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 border-orange-200 dark:border-orange-900',
    };
  }
  return {
    label: 'Held', icon: Clock, note: row.release_at ? `Releases ${fmtWhen(row.release_at)}` : '',
    className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900',
  };
}

function Tile({ label, value, sub, emphasis }) {
  return (
    <div className={`rounded-2xl p-4 sm:p-5 border ${
      emphasis
        ? 'bg-gradient-to-br from-slate-900 to-slate-800 border-slate-800 text-white'
        : 'bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800'
    }`}>
      <p className={`text-xs sm:text-sm mb-1 ${emphasis ? 'text-slate-300' : 'text-slate-500 dark:text-slate-400'}`}>{label}</p>
      <p className={`text-xl sm:text-2xl font-bold break-words ${emphasis ? 'text-white' : 'text-slate-900 dark:text-white'}`}>{value}</p>
      {sub ? (
        <p className={`text-xs mt-1 ${emphasis ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'}`}>{sub}</p>
      ) : null}
    </div>
  );
}

export default function DriverWalletPage() {
  const { isDriver, isLoading: profileLoading } = useDriverProfile();
  const [wallet, setWallet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    const r = await invokeFn('getDriverWallet');
    if (r.ok) {
      setWallet(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (isDriver) load();
  }, [isDriver, load]);

  if (profileLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400 dark:text-slate-500" />
      </div>
    );
  }
  if (!isDriver) return <DriverNotice />;

  const available = wallet?.available_ngn || 0;
  const threshold = wallet?.threshold_ngn || 10000;
  const pending = wallet?.pending_withdrawal || null;
  const shortfall = wallet?.shortfall_ngn || 0;
  const ledger = wallet?.ledger || [];
  const canWithdraw = !pending && available >= threshold;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-1">Wallet</h1>
            <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-base">
              Pay is held when you are assigned to a ride and released two hours after it ends.
            </p>
          </div>
          <Button
            variant="outline" size="icon" onClick={() => load(true)} disabled={refreshing}
            className="rounded-xl flex-shrink-0" aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              <button type="button" onClick={() => load(true)} className="text-sm font-medium text-red-700 dark:text-red-300 underline mt-1">
                Try again
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400 dark:text-slate-500" />
          </div>
        ) : wallet ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              <Tile label="Available" value={ngn(available)} sub="Ready to withdraw" emphasis />
              <Tile label="Held" value={ngn(wallet.held_ngn)} sub="Releases after each ride" />
              <Tile label="Paid out" value={ngn(wallet.paid_out_ngn)} sub="Sent to your bank" />
            </div>

            {pending && (
              <div className="mb-4 flex items-start gap-2 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-xl p-3">
                <Send className="w-4 h-4 text-blue-700 dark:text-blue-300 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-blue-900 dark:text-blue-100">
                  A withdrawal of {ngn(pending.amount)} is {pending.status === 'processing' ? 'on its way to your bank' : 'waiting to be processed'}.
                  It is already taken off your available balance.
                </p>
              </div>
            )}

            {shortfall > 0 && (
              <div className="mb-4 flex items-start gap-2 bg-orange-50 dark:bg-orange-950/40 border border-orange-200 dark:border-orange-900 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 text-orange-600 dark:text-orange-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-orange-900 dark:text-orange-100">
                  {ngn(shortfall)} of pay was reversed after you had withdrawn it. It will come off your next released pay.
                  Contact the team if this looks wrong.
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 mb-2">
              {canWithdraw ? (
                <Link to={`${createPageUrl('Withdrawals')}?wallet=driver`} className="flex-1">
                  <Button className="w-full rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
                    <Send className="w-4 h-4 mr-2" /> Withdraw to my bank
                  </Button>
                </Link>
              ) : (
                <Button disabled className="flex-1 rounded-xl">
                  <Send className="w-4 h-4 mr-2" /> Withdraw to my bank
                </Button>
              )}
              <Link to={createPageUrl('BankAccounts')} className="flex-1">
                <Button variant="outline" className="w-full rounded-xl">
                  <CreditCard className="w-4 h-4 mr-2" /> Bank accounts
                </Button>
              </Link>
            </div>
            {!canWithdraw && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-6">
                {pending
                  ? 'You can request another withdrawal once this one has finished.'
                  : `You can withdraw once ${ngn(threshold)} is available. You have ${ngn(available)}.`}
              </p>
            )}

            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-6 mb-3">
              Pay by ride
            </h2>

            {ledger.length === 0 ? (
              <Card className="bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
                <CardContent className="py-10 text-center">
                  <Wallet className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-1">No pay recorded yet</h3>
                  <p className="text-sm text-slate-600 dark:text-slate-300 max-w-sm mx-auto">
                    When you are assigned to a paid ride, your pay for it shows here as held.
                    Two hours after the ride ends it moves to available.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {ledger.map((row) => {
                  const state = rowState(row);
                  const StateIcon = state.icon;
                  return (
                    <div
                      key={row.id}
                      className="flex items-center gap-3 border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4 bg-white/80 dark:bg-slate-900/80"
                    >
                      <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
                        <Car className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                          {row.vehicle_name}
                          {row.booking_reference ? (
                            <span className="ml-2 font-mono font-normal text-xs text-slate-500 dark:text-slate-400">{row.booking_reference}</span>
                          ) : null}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {[fmtDay(row.service_date), state.note].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className={`font-bold text-sm sm:text-base ${row.status === 'reversed' ? 'text-slate-400 dark:text-slate-500 line-through' : 'text-slate-900 dark:text-white'}`}>
                          {ngn(row.amount_ngn)}
                        </p>
                        <Badge className={`${state.className} border font-medium mt-1`}>
                          <StateIcon className="w-3 h-3 mr-1" />
                          {state.label}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
                {wallet.ledger_truncated && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 text-center pt-2">
                    Showing your most recent 200 rides. The totals above count all of them.
                  </p>
                )}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
