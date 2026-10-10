import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldCheck, ShieldAlert, RefreshCw, FileText, Calendar, Users } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { base44 } from '@/api/base44Client';

const ID_TYPE_LABELS = {
  national_id: 'National ID',
  drivers_license: "Driver's License",
  passport: 'Passport',
  voters_card: "Voter's Card",
  other: 'Other ID',
};

const fmtDate = (s) => {
  if (!s) return '—';
  try { return format(parseISO(s), 'MMM d, yyyy'); } catch { return s; }
};

export default function ConfirmedBookingsAdmin() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // Show the last 30 confirmed bookings, newest first. Admin uses this
      // to verify guests' uploaded IDs before check-in.
      const rows = await base44.entities.Booking.filter(
        { status: 'confirmed', payment_status: 'paid' },
        '-paid_at',
        30,
      );
      setBookings(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.error('Failed to load confirmed bookings:', e);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg mb-8">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg min-w-0">
            <ShieldCheck className="w-5 h-5 flex-shrink-0" />
            <span className="truncate">Confirmed Bookings &amp; Guest IDs</span>
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => load()} disabled={loading} className="rounded-xl self-start sm:self-auto flex-shrink-0">
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
        <CardDescription>
          Latest paid bookings — verify the guest's uploaded ID before they check in. Missing IDs are flagged in red.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && bookings.length === 0 ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400 dark:text-slate-500" />
          </div>
        ) : bookings.length === 0 ? (
          <p className="text-center text-slate-500 dark:text-slate-400 text-sm py-6">No confirmed bookings yet.</p>
        ) : (
          <div className="space-y-2">
            {bookings.map((b) => {
              const hasId = !!b.id_document_url;
              return (
                <div key={b.id} className="border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex items-start justify-between gap-3 hover:border-slate-300 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-slate-900 dark:text-white truncate">{b.guest_name || b.guest_email}</p>
                      <Badge className="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-0 text-xs">Paid</Badge>
                      {hasId ? (
                        <Badge className="bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-0 text-xs">
                          {ID_TYPE_LABELS[b.id_document_type] || 'ID uploaded'}
                        </Badge>
                      ) : (
                        <Badge className="bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-0 text-xs flex items-center gap-1">
                          <ShieldAlert className="w-3 h-3" /> ID missing
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-3 flex-wrap">
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {fmtDate(b.check_in)} → {fmtDate(b.check_out)}</span>
                      <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {b.guests} guest{b.guests === 1 ? '' : 's'}</span>
                      {b.bedrooms_booked > 0 && <span>{b.bedrooms_booked}-bedroom option</span>}
                      <span>₦{Number(b.total_price || 0).toLocaleString()}</span>
                      <span className="text-slate-400 dark:text-slate-500">Booking <code>{b.id.slice(0, 8)}…</code></span>
                    </div>
                  </div>
                  {hasId && (
                    <a
                      href={b.id_document_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0"
                    >
                      <Button variant="outline" size="sm" className="rounded-xl">
                        <FileText className="w-4 h-4 mr-1" /> View ID
                      </Button>
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
