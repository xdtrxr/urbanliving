import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Bell, BellOff, Loader2, AlertTriangle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from '@/lib/pushConfig';

// PushNotificationsCard — single toggle on the Profile page that lets the
// user opt in / out of Web Push from THIS browser.
//
// Lifecycle:
//   - Mount: feature-detect, then read the current subscription off the SW.
//   - Toggle ON: request browser permission → subscribe via PushManager →
//     POST the subscription JSON to savePushSubscription.
//   - Toggle OFF: unsubscribe locally → POST endpoint to removePushSubscription.
//
// We trust the server to be the source of truth for which devices a user
// has — this card just shows what THIS browser has subscribed locally. If
// the user wants to manage devices across multiple phones / laptops later,
// that's a separate UI (out of scope for v1).
export default function PushNotificationsCard() {
  const { toast } = useToast();
  const [supported, setSupported] = useState(true);
  const [permission, setPermission] = useState('default');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  // Detect support once at mount. iOS Safari only supports Web Push when the
  // app is installed to home-screen (display-mode: standalone) — checking
  // for PushManager alone gives a false positive in mobile Safari tabs.
  useEffect(() => {
    const ok =
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window;
    setSupported(ok);
    if (!ok) {
      setReady(true);
      return;
    }
    setPermission(Notification.permission);
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        setSubscribed(!!sub);
      } catch (err) {
        console.warn('PushNotificationsCard init failed', err);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // Best-effort label so users can tell devices apart on the server side
  // later. Doesn't have to be perfect — pure UI hint.
  const guessDeviceLabel = () => {
    const ua = navigator.userAgent || '';
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches;
    const platform = /iPhone|iPad|iPod/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : 'Web';
    return isStandalone ? `${platform} PWA` : `${platform} browser`;
  };

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        toast({
          title: 'Permission denied',
          description: 'Enable notifications in your browser settings to turn this on.',
          variant: 'destructive',
        });
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      // PushSubscription's toJSON() gives us exactly the shape the server wants.
      const subJson = sub.toJSON();
      const res = await base44.functions.invoke('savePushSubscription', {
        subscription: subJson,
        label: guessDeviceLabel(),
      });
      if (!res?.data?.success) throw new Error(res?.data?.error || 'Failed to save subscription');
      setSubscribed(true);
      toast({
        title: 'Notifications on',
        description: 'You\'ll get a push for bookings, payments, and replies.',
      });
    } catch (err) {
      console.error('enable push failed', err);
      toast({
        title: 'Could not enable notifications',
        description: err?.message || 'Try again in a moment.',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        try {
          await base44.functions.invoke('removePushSubscription', { endpoint });
        } catch (err) {
          // Server-side cleanup is best-effort — local unsubscribe is what
          // actually stops the pings.
          console.warn('removePushSubscription failed (server)', err);
        }
      }
      setSubscribed(false);
      toast({
        title: 'Notifications off',
        description: 'This device won\'t receive pushes anymore.',
      });
    } catch (err) {
      console.error('disable push failed', err);
      toast({
        title: 'Could not disable notifications',
        description: err?.message || 'Try again in a moment.',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const handleToggle = (checked) => {
    if (checked) enable();
    else disable();
  };

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
      <CardHeader className="p-5 sm:p-6 border-b border-slate-100 dark:border-slate-800">
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-slate-900 dark:text-white">
          {subscribed ? <Bell className="w-5 h-5 text-amber-500 dark:text-amber-400" /> : <BellOff className="w-5 h-5 text-slate-400" />}
          Push notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="p-5 sm:p-6 space-y-4">
        {!supported ? (
          <div className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
            <AlertTriangle className="w-4 h-4 text-amber-500 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-slate-900 dark:text-white mb-1">Not available on this device</p>
              <p>Install Urban Stays to your home screen (iOS) or use the desktop / Android app to get push notifications.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-900 dark:text-white">
                  {subscribed ? 'On for this device' : 'Off'}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Bookings, payments, withdrawals, support replies.
                </p>
              </div>
              {ready && (
                <Switch
                  checked={subscribed}
                  onCheckedChange={handleToggle}
                  disabled={busy}
                  aria-label="Toggle push notifications"
                />
              )}
              {busy && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
            </div>
            {permission === 'denied' && (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                Your browser is blocking notifications. Open site settings and allow Notifications, then try again.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
