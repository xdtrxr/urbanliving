import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, RefreshCw, Flag, AlertCircle, ShieldAlert, UserRound, Car } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { invokeFn } from '@/lib/invokeFn';
import { useToast } from '@/components/ui/use-toast';
import { safePhotoUrl, isOpenGuestReport, reportHoldsPay } from '@/config/rides';

// RideReportsAdmin — complaints about rides, from drivers about guests and
// from guests about drivers, and what admin decided about each.
//
// Reads RideReport directly: the entity is admin-only at the API, so this
// list only ever loads for an admin. Every decision goes through
// resolveRideReport, which applies or lifts a block and tells the reporter
// their report was looked at.
//
// A guest's complaint that is still open or being reviewed holds the pay of
// the driver it names for that ride. Closing it here is what lets the pay go.
// The badge says so only while that driver still has pay held on the ride:
// it may have been released before the guest complained, or reversed when
// the ride was handed to another driver, and then the report holds nothing.

const fmtWhen = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return '—'; }
};

const FILTERS = [
  { value: 'needs-attention', label: 'Needs attention' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' },
];

const STATUS_STYLE = {
  open: { label: 'Open', className: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-200 dark:border-red-900' },
  reviewing: { label: 'Reviewing', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900' },
  resolved: { label: 'Resolved', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900' },
  dismissed: { label: 'Dismissed', className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700' },
};

const CATEGORY_WORDS = {
  rude: 'Rude', abusive: 'Abusive', threatening: 'Threatening', unsafe: 'Unsafe',
  no_show: 'No-show', damage: 'Damage', other: 'Other',
};

// The decisions admin can take. Each is one call to resolveRideReport.
const DECISIONS = {
  reviewing: {
    button: 'Mark reviewing', title: 'Mark as being reviewed?', status: 'reviewing',
    body: 'Shows the team you are on it. Nothing else changes.',
    done: 'Marked as reviewing',
  },
  dismiss: {
    button: 'Dismiss', title: 'Dismiss this report?', status: 'dismissed',
    body: 'Closes the report with no action taken.',
    done: 'Report dismissed',
  },
  warn: {
    button: 'Warn', title: 'Resolve with a warning', status: 'resolved', action_taken: 'warning',
    body: 'Records that the person was warned. It does not stop them using the app; speak to them yourself.',
    done: 'Resolved with a warning',
  },
  block: {
    button: 'Block', title: 'Resolve and block', status: 'resolved', action_taken: 'blocked', danger: true,
    done: 'Resolved and blocked',
  },
  unblock: {
    button: 'Lift block', title: 'Lift the block?', status: 'resolved', action_taken: 'warning',
    body: 'Keeps the report resolved, with a warning instead of a block.',
    done: 'Block lifted',
  },
};

// Who a block lands on, in words.
const blockBody = (report) => (report.reported_driver_id
  ? `${report.reported_name || 'This driver'} is switched to inactive and stops appearing when rides are assigned. Switch them back on from the Drivers tab if you change your mind.`
  : `${report.reported_name || 'This guest'} can no longer request rides. They are told to contact support.`);

const EFFECT_WORDS = {
  guest_blocked: 'The guest can no longer request rides.',
  guest_unblocked: 'The guest can request rides again.',
  guest_not_found: 'No account was found for that guest email, so nothing was blocked.',
  driver_deactivated: 'The driver is now inactive.',
};

const decisionsFor = (report) => {
  if (report.status === 'open') return ['reviewing', 'dismiss', 'warn', 'block'];
  if (report.status === 'reviewing') return ['dismiss', 'warn', 'block'];
  // A guest block can be lifted from here. A driver is switched back on from
  // the Drivers tab, where it may have been switched off for other reasons.
  if (report.status === 'resolved' && report.action_taken === 'blocked' && !report.reported_driver_id) return ['unblock'];
  return [];
};

export default function RideReportsAdmin() {
  const { toast } = useToast();
  const [reports, setReports] = useState([]);
  // Pay still held on the rides of open guest reports. null until it has been
  // read, and again if it cannot be: the badge then makes no claim.
  const [heldPay, setHeldPay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('needs-attention');
  const [pending, setPending] = useState(null); // { report, key }
  const [notes, setNotes] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const rows = await base44.entities.RideReport.list('-created_date', 200);
      const list = Array.isArray(rows) ? rows : [];
      setReports(list);
      setError(null);
      // The inbox is on screen from here. What follows only decides the
      // "Holding the driver's pay" badge, and is read on its own so that a
      // problem with the ledger cannot cost admin the reports. DriverEarning
      // is admin-only at the API, like RideReport.
      setLoading(false);
      try {
        const rideIds = [...new Set(list.filter(isOpenGuestReport).map((r) => r.ride_booking_id).filter(Boolean))];
        const held = rideIds.length === 0 ? [] : await base44.entities.DriverEarning.filter(
          { status: 'held', ride_booking_id: { $in: rideIds } }, '-created_date', 500,
        );
        setHeldPay(Array.isArray(held) ? held : null);
      } catch (err) {
        console.warn('Could not read held pay (the reports are unaffected):', err);
        setHeldPay(null);
      }
    } catch (err) {
      console.error('Could not load ride reports:', err);
      setError(err?.message || 'Could not load the reports.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = (report, key) => {
    setNotes(report.admin_notes || '');
    setPending({ report, key });
  };

  const confirm = async () => {
    if (!pending) return;
    const { report, key } = pending;
    const decision = DECISIONS[key];
    setWorking(true);
    const r = await invokeFn('resolveRideReport', {
      report_id: report.id,
      status: decision.status,
      action_taken: decision.action_taken,
      admin_notes: notes,
    });
    setWorking(false);
    if (!r.ok) {
      toast({ title: 'Not saved', description: r.error, variant: 'destructive' });
      return;
    }
    setPending(null);
    toast({
      title: decision.done,
      description: EFFECT_WORDS[r.data?.effect] || `Ride ${report.booking_reference || ''}`.trim(),
      variant: r.data?.effect === 'guest_not_found' ? 'destructive' : undefined,
    });
    await load(true);
  };

  const needsAttention = (r) => r.status === 'open' || r.status === 'reviewing';
  const shown = filter === 'all' ? reports
    : filter === 'needs-attention' ? reports.filter(needsAttention)
      : reports.filter((r) => r.status === filter);
  const waiting = reports.filter(needsAttention).length;
  const decision = pending ? DECISIONS[pending.key] : null;

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-slate-900 dark:text-white">
            <Flag className="w-5 h-5 text-red-500 dark:text-red-400 flex-shrink-0" />
            Ride reports
            {waiting > 0 ? (
              <Badge className="bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-0">
                {waiting} waiting
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            A guest&apos;s complaint holds the driver&apos;s pay for that ride until you close it here.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-10 w-44 rounded-xl"><SelectValue /></SelectTrigger>
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
        ) : shown.length === 0 ? (
          <p className="text-center text-slate-500 dark:text-slate-400 py-10 text-sm">
            {filter === 'needs-attention'
              ? 'No reports waiting.'
              : `Nothing under "${FILTERS.find((f) => f.value === filter)?.label}".`}
          </p>
        ) : (
          <div className="space-y-3">
            {shown.map((r) => {
              const style = STATUS_STYLE[r.status] || STATUS_STYLE.open;
              const byDriver = r.reporter_role === 'driver';
              const photos = (Array.isArray(r.evidence_urls) ? r.evidence_urls : []).map(safePhotoUrl).filter(Boolean);
              const actions = decisionsFor(r);
              return (
                <div key={r.id} className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <Badge className={`${style.className} border font-medium`}>{style.label}</Badge>
                    <Badge variant="outline" className="text-xs">{CATEGORY_WORDS[r.category] || r.category}</Badge>
                    {r.booking_reference && (
                      <Badge variant="outline" className="text-xs font-mono">{r.booking_reference}</Badge>
                    )}
                    {r.action_taken === 'blocked' && (
                      <Badge className="bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-0 text-xs">
                        <ShieldAlert className="w-3 h-3 mr-1" /> Blocked
                      </Badge>
                    )}
                    {r.action_taken === 'warning' && (
                      <Badge className="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-0 text-xs">Warned</Badge>
                    )}
                    {reportHoldsPay(r, heldPay) && (
                      <Badge variant="outline" className="text-xs">Holding the driver&apos;s pay</Badge>
                    )}
                  </div>

                  <p className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-200">
                    {byDriver
                      ? <Car className="w-4 h-4 flex-shrink-0 mt-0.5 text-slate-400 dark:text-slate-500" />
                      : <UserRound className="w-4 h-4 flex-shrink-0 mt-0.5 text-slate-400 dark:text-slate-500" />}
                    <span className="break-words">
                      <span className="font-semibold text-slate-900 dark:text-white">{r.reporter_name || r.reporter_email}</span>
                      {byDriver ? ' (driver) reported guest ' : ' (guest) reported driver '}
                      <span className="font-semibold text-slate-900 dark:text-white">{r.reported_name || r.reported_email || 'unknown'}</span>
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {[r.vehicle_name, r.service_date, `filed ${fmtWhen(r.created_date)}`].filter(Boolean).join(' · ')}
                  </p>

                  {/* The reporter's own words. Rendered as text; React escapes it. */}
                  <p className="mt-3 text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap break-words">
                    {r.description}
                  </p>

                  {photos.length > 0 && (
                    <div className="mt-3 flex gap-2 flex-wrap">
                      {photos.map((url) => (
                        <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                          <img
                            src={url} alt="Photo attached to the report" loading="lazy"
                            className="w-20 h-20 rounded-lg object-cover border border-slate-200 dark:border-slate-800"
                          />
                        </a>
                      ))}
                    </div>
                  )}

                  {r.admin_notes && (
                    <p className="mt-3 text-xs text-slate-500 dark:text-slate-400 italic break-words">
                      Note: {r.admin_notes}
                    </p>
                  )}
                  {r.resolved_at && (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Closed {fmtWhen(r.resolved_at)}{r.resolved_by ? ` by ${r.resolved_by}` : ''}
                    </p>
                  )}

                  {actions.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap gap-2">
                      {actions.map((key) => (
                        <Button
                          key={key} size="sm" variant="outline" onClick={() => open(r, key)}
                          className={DECISIONS[key].danger
                            ? 'rounded-xl border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
                            : 'rounded-xl'}
                        >
                          {DECISIONS[key].button}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={!!pending} onOpenChange={(o) => { if (!o && !working) setPending(null); }}>
        <DialogContent className="max-w-md">
          {pending && decision && (
            <>
              <DialogHeader>
                <DialogTitle>{decision.title}</DialogTitle>
                <DialogDescription>
                  {pending.report.reporter_name || pending.report.reporter_email} about {pending.report.reported_name || pending.report.reported_email || 'unknown'}
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {pending.key === 'block' ? blockBody(pending.report) : decision.body}
              </p>
              <div>
                <Label htmlFor="rr-notes">Note for the team (optional)</Label>
                <Textarea
                  id="rr-notes" rows={3} value={notes} maxLength={1000}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Never shown to the guest or the driver" className="mt-1 rounded-xl"
                />
              </div>
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setPending(null)} disabled={working} className="rounded-xl">
                  Cancel
                </Button>
                <Button
                  onClick={confirm} disabled={working}
                  className={decision.danger
                    ? 'rounded-xl bg-red-600 hover:bg-red-700 text-white'
                    : 'rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'}
                >
                  {working ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  {decision.button}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
