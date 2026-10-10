import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Loader2, RefreshCw, TrendingUp, Wallet, Clock, XCircle, Users, Gift,
  Building2, Car, MessageSquare, UserPlus, Banknote, AlertTriangle, Percent,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

// PlatformStatsAdmin — platform-wide numbers, distinct from the per-user
// figures on /Dashboard. Backed by getDashboardStats with scope:'all', which
// is admin-gated server-side.
//
// Every figure here is computed from a fully paginated scan. Base44's
// .filter() caps at 50 rows by default, so before the pagination fix these
// numbers were derived from whatever the first 50 records happened to be.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

function Stat({ icon: Icon, label, value, sub, tone = 'slate', wide = false }) {
  const tones = {
    slate: 'text-slate-500 dark:text-slate-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    rose: 'text-rose-600 dark:text-rose-400',
    blue: 'text-blue-600 dark:text-blue-400',
    purple: 'text-purple-600 dark:text-purple-400',
  };
  return (
    <div
      className={`rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 p-4 ${
        wide ? 'sm:col-span-2' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-medium text-slate-600 dark:text-slate-300 leading-tight">{label}</p>
        <Icon className={`w-4 h-4 flex-shrink-0 ${tones[tone]}`} />
      </div>
      <p className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white break-words leading-tight">{value}</p>
      {sub && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">{sub}</p>}
    </div>
  );
}

function Section({ title, description, children }) {
  return (
    <div>
      <div className="mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</h3>
        {description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{children}</div>
    </div>
  );
}

export default function PlatformStatsAdmin() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const res = await base44.functions.invoke('getDashboardStats', { scope: 'all' });
      if (res?.data?.success) {
        setData(res.data.data);
      } else {
        throw new Error(res?.data?.error || 'Failed to load platform stats');
      }
    } catch (err) {
      console.error('PlatformStatsAdmin load failed:', err);
      if (!silent) {
        toast({
          title: 'Could not load platform stats',
          description: err?.message || 'Try the refresh button.',
          variant: 'destructive',
        });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 60000);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !data) {
    return (
      <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
        <CardContent className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
        <CardContent className="py-16 text-center">
          <AlertTriangle className="w-8 h-8 text-amber-500 dark:text-amber-400 mx-auto mb-3" />
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">Platform stats unavailable.</p>
          <Button onClick={() => load()} variant="outline" className="rounded-xl">Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const { revenue, bookings, referrals, withdrawals, liabilities, users, inventory, pipeline } = data;

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-slate-900 dark:text-white">
            <TrendingUp className="w-5 h-5 text-amber-500 dark:text-amber-400 flex-shrink-0" />
            Platform Overview
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Every guest, booking and naira across UrbanStays. Refreshes automatically each minute.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => load()}
          disabled={refreshing}
          className="rounded-xl self-start sm:self-auto flex-shrink-0"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-7">
        <Section
          title="Revenue"
          description="Paid = money that actually cleared Paystack. Pipeline includes approved bookings still awaiting payment."
        >
          <Stat
            icon={Banknote}
            tone="emerald"
            label="Total revenue"
            value={ngn(revenue.paidNGN)}
            sub={`${revenue.paidCount} paid booking${revenue.paidCount === 1 ? '' : 's'}`}
          />
          <Stat
            icon={TrendingUp}
            tone="emerald"
            label="Last 30 days"
            value={ngn(revenue.last30NGN)}
            sub={`${revenue.last30Count} booking${revenue.last30Count === 1 ? '' : 's'} paid`}
          />
          <Stat
            icon={Clock}
            tone="amber"
            label="Awaiting payment"
            value={ngn(revenue.pendingNGN)}
            sub="Approved or pending approval"
          />
          <Stat
            icon={Wallet}
            label="Avg booking value"
            value={ngn(revenue.avgPaidBookingNGN)}
            sub="Across paid bookings only"
          />
        </Section>

        <Section title="Bookings" description="Lifecycle split, plus how many requests convert to paid.">
          <Stat icon={Building2} label="Total requests" value={bookings.total} sub="All time" />
          <Stat
            icon={Percent}
            tone="blue"
            label="Conversion"
            value={`${revenue.conversionRate}%`}
            sub="Requests that became paid"
          />
          <Stat icon={Clock} tone="amber" label="Pending" value={bookings.pending} sub="Awaiting approval or payment" />
          <Stat
            icon={XCircle}
            tone="rose"
            label="Cancelled"
            value={bookings.cancelled}
            sub={`${ngn(revenue.expiredNGN)} lost to expiry`}
          />
          <Stat icon={Building2} label="Upcoming" value={bookings.upcoming} sub="Paid, not yet checked in" />
          <Stat icon={Building2} tone="emerald" label="Staying now" value={bookings.current} sub="Mid-stay" />
          <Stat icon={Building2} label="Completed" value={bookings.past} sub="Checked out" />
          <Stat
            icon={XCircle}
            tone="rose"
            label="Value not converted"
            value={ngn(revenue.cancelledNGN + revenue.expiredNGN)}
            sub="Cancelled + expired"
          />
        </Section>

        <Section
          title="Referrals & payouts"
          description="Outstanding wallet is money owed to users that hasn't been withdrawn — a real liability."
        >
          <Stat
            icon={Gift}
            tone="purple"
            label="Referrals"
            value={referrals.count}
            sub={`${referrals.successful} converted to a booking`}
          />
          <Stat
            icon={Gift}
            tone="purple"
            label="Commission earned"
            value={ngn(referrals.earningsNGN)}
            sub="Lifetime credited to users"
          />
          <Stat
            icon={Banknote}
            tone="emerald"
            label="Paid out"
            value={ngn(withdrawals.completedNGN)}
            sub="Withdrawals settled"
          />
          <Stat
            icon={AlertTriangle}
            tone="amber"
            label="Outstanding wallet"
            value={ngn(liabilities.outstandingWalletNGN)}
            sub={
              withdrawals.pendingCount > 0
                ? `${withdrawals.pendingCount} withdrawal${withdrawals.pendingCount === 1 ? '' : 's'} in flight (${ngn(withdrawals.pendingNGN)})`
                : 'No withdrawals in flight'
            }
          />
          <Stat
            icon={Banknote}
            tone="amber"
            label="Driver pay owed"
            value={ngn((liabilities.driverHeldNGN || 0) + (liabilities.driverAvailableNGN || 0))}
            sub={
              (liabilities.driverShortfallNGN || 0) > 0
                ? `${ngn(liabilities.driverShortfallNGN)} to recover from drivers. See Rides → Earnings`
                : `${ngn(liabilities.driverHeldNGN || 0)} held on rides · ${ngn(liabilities.driverAvailableNGN || 0)} ready to withdraw`
            }
          />
        </Section>

        <Section title="Audience & inventory" description="Who's on the platform and what they can book.">
          <Stat icon={Users} tone="blue" label="Registered users" value={users.total} sub="All accounts" />
          <Stat icon={UserPlus} tone="blue" label="New in 30 days" value={users.new30d} sub="Signups" />
          <Stat
            icon={Building2}
            label="Properties"
            value={inventory.activeProperties}
            sub={`${inventory.properties} total listed`}
          />
          <Stat icon={Car} label="Vehicles" value={inventory.vehicles} sub="Ride inventory" />
        </Section>

        <Section title="Pipeline" description="Work waiting on you.">
          <Stat icon={UserPlus} tone="amber" label="Leads captured" value={pipeline.leads} sub="From Agent Nova" />
          <Stat
            icon={MessageSquare}
            tone={pipeline.openTickets > 0 ? 'rose' : 'slate'}
            label="Open tickets"
            value={pipeline.openTickets}
            sub="Open or in progress"
          />
        </Section>

        <p className="text-[11px] text-slate-400 dark:text-slate-500 pt-1">
          Generated {new Date(data.generated_at).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}
