import React, { useState, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Car, ChevronDown, AlertCircle, Banknote } from 'lucide-react';
import { invokeFn } from '@/lib/invokeFn';
import { createPageUrl } from '@/utils';
import { useDriverProfile } from '@/lib/useDriverProfile';
import DriverNotice from '@/components/driver/DriverNotice';
import DriverRideCard from '@/components/driver/DriverRideCard';

// DriverRides — the driver's jobs: what is on now, what is coming, what is done.
//
// Grouping and order come from getDriverRides. This page never works out for
// itself whether a ride is over, so it cannot disagree with the guest's view
// or with admin's.

const LIVE_GROUPS = [
  { key: 'current', label: 'In progress' },
  { key: 'upcoming', label: 'Upcoming' },
];

export default function DriverRidesPage() {
  const location = useLocation();
  const { driver, isDriver, isLoading: profileLoading } = useDriverProfile();
  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    const r = await invokeFn('getDriverRides');
    if (r.ok) {
      setRides(r.data?.rides || []);
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

  // A push notification links to #ride-<id>. Bring that card into view once
  // the list is on screen, opening the history group if that is where it is.
  useEffect(() => {
    const id = location.hash ? location.hash.slice(1) : '';
    if (!id || rides.length === 0) return;
    const target = rides.find((r) => `ride-${r.id}` === id);
    if (!target) return;
    if (target.bucket === 'past' || target.bucket === 'cancelled') setShowHistory(true);
    const t = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    return () => clearTimeout(t);
  }, [location.hash, rides]);

  if (profileLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400 dark:text-slate-500" />
      </div>
    );
  }
  if (!isDriver) return <DriverNotice />;

  const history = rides.filter((r) => r.bucket === 'past' || r.bucket === 'cancelled');
  const liveCount = rides.length - history.length;
  const paused = driver?.active === false || driver?.admin_approved === false;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-1">My rides</h1>
            <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-base">
              {driver?.full_name ? `${driver.full_name} · ` : ''}rides assigned to you and what each one pays
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Link to={createPageUrl('DriverWallet')}>
              <Button variant="outline" size="sm" className="rounded-xl">
                <Banknote className="w-4 h-4 sm:mr-2" /><span className="hidden sm:inline">Wallet</span>
              </Button>
            </Link>
            <Button
              variant="outline" size="icon" onClick={() => load(true)} disabled={refreshing}
              className="rounded-xl" aria-label="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {paused && (
          <div className="mb-4 flex items-start gap-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              Your profile is paused for new rides. Rides and pay you already have are still here.
            </p>
          </div>
        )}

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
        ) : rides.length === 0 && !error ? (
          <Card className="bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
            <CardContent className="py-12 text-center">
              <Car className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
              <h2 className="font-semibold text-slate-900 dark:text-white mb-1">No rides yet</h2>
              <p className="text-sm text-slate-600 dark:text-slate-300 max-w-sm mx-auto">
                When the team assigns you to a ride it appears here with the pickup details and your pay,
                and you get a notification.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">
            {liveCount === 0 && !error && (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Nothing coming up right now. Your earlier rides are below.
              </p>
            )}

            {LIVE_GROUPS.map((group) => {
              const items = rides.filter((r) => r.bucket === group.key);
              if (items.length === 0) return null;
              return (
                <section key={group.key}>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3">
                    {group.label} ({items.length})
                  </h2>
                  <div className="space-y-3">
                    {items.map((ride) => <DriverRideCard key={ride.id} ride={ride} />)}
                  </div>
                </section>
              );
            })}

            {history.length > 0 && (
              <section>
                <button
                  type="button" onClick={() => setShowHistory((v) => !v)}
                  className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 mb-3"
                  aria-expanded={showHistory}
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
                  Past and cancelled ({history.length})
                </button>
                {showHistory && (
                  <div className="space-y-3">
                    {history.map((ride) => <DriverRideCard key={ride.id} ride={ride} />)}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
