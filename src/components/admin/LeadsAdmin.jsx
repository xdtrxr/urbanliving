import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Phone, Mail, MapPin, Users, Calendar, Wallet, Home, RefreshCw } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { base44 } from '@/api/base44Client';

const STATUS_OPTIONS = [
  { value: 'qualifying', label: 'Qualifying' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'shown_options', label: 'Shown options' },
  { value: 'booking_started', label: 'Booking started' },
  { value: 'booked', label: 'Booked' },
  { value: 'lost', label: 'Lost' },
];

const STATUS_STYLES = {
  qualifying: 'bg-slate-100 text-slate-700 dark:text-slate-200',
  qualified: 'bg-blue-100 text-blue-800',
  shown_options: 'bg-indigo-100 text-indigo-800',
  booking_started: 'bg-amber-100 text-amber-800',
  booked: 'bg-emerald-100 text-emerald-800',
  lost: 'bg-rose-100 text-rose-800',
};

const fmt = (s) => {
  if (!s) return '—';
  try { return format(parseISO(s), 'MMM d, yyyy'); } catch { return s; }
};
const money = (n) => (n ? '₦' + Number(n).toLocaleString() : null);
const budgetLabel = (lead) => {
  const a = money(lead.budget_min);
  const b = money(lead.budget_max);
  if (a && b) return `${a} – ${b}`;
  if (b) return `Up to ${b}`;
  if (a) return `From ${a}`;
  return '—';
};

export default function LeadsAdmin() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const all = await base44.entities.Lead.list('-created_date', 200);
      setLeads(Array.isArray(all) ? all : []);
    } catch (e) {
      console.error('Failed to load leads:', e);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, []);

  const updateStatus = async (lead, newStatus) => {
    setUpdatingId(lead.id);
    try {
      await base44.entities.Lead.update(lead.id, { status: newStatus });
      setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, status: newStatus } : l)));
    } catch (e) {
      console.error('Failed to update lead status:', e);
      alert('Failed to update status.');
    } finally {
      setUpdatingId(null);
    }
  };

  const filtered = filter === 'all' ? leads : leads.filter((l) => l.status === filter);

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Users className="w-6 h-6 text-amber-500 flex-shrink-0" /> Leads
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">Captured by Agent Nova — work them through the pipeline.</CardDescription>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-10 w-44 rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => load()} className="rounded-xl flex-shrink-0">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400 dark:text-slate-500" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-slate-500 dark:text-slate-400 dark:text-slate-500 py-10">No leads yet.</p>
        ) : (
          <div className="space-y-3">
            {filtered.map((lead) => (
              <div key={lead.id} className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4 hover:border-slate-300 transition-colors">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-semibold text-slate-900 dark:text-white truncate">{lead.name}</h4>
                      <Badge className={`${STATUS_STYLES[lead.status] || 'bg-slate-100 text-slate-700 dark:text-slate-200'} border-0`}>
                        {STATUS_OPTIONS.find((s) => s.value === lead.status)?.label || lead.status}
                      </Badge>
                      {lead.user_email && (
                        <Badge variant="outline" className="text-xs">Account linked</Badge>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
                      <span className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> {lead.phone || '—'}</span>
                      <span className="flex items-center gap-1.5 truncate"><Mail className="w-3.5 h-3.5 flex-shrink-0" /> <span className="truncate">{lead.email || '—'}</span></span>
                      <span className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" /> {[lead.city, lead.area].filter(Boolean).join(', ') || '—'}</span>
                      <span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" /> {fmt(lead.check_in)} → {fmt(lead.check_out)}</span>
                      <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> {lead.guests || '—'} guests</span>
                      <span className="flex items-center gap-1.5"><Wallet className="w-3.5 h-3.5" /> {budgetLabel(lead)}</span>
                      <span className="flex items-center gap-1.5"><Home className="w-3.5 h-3.5" /> {lead.apartment_type || 'Any'}</span>
                    </div>
                    {lead.special_requests && (
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 italic">"{lead.special_requests}"</p>
                    )}
                    <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                      Captured {fmt(lead.created_date)} · source: {lead.source || 'chat'}
                    </p>
                  </div>
                  <div className="flex flex-row sm:flex-col items-stretch sm:items-end gap-2 sm:flex-shrink-0">
                    <Select
                      value={lead.status}
                      onValueChange={(v) => updateStatus(lead, v)}
                      disabled={updatingId === lead.id}
                    >
                      <SelectTrigger className="h-9 flex-1 sm:flex-initial sm:w-44 rounded-xl text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((s) => (
                          <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <a
                      href={`tel:${lead.phone}`}
                      className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:text-slate-200"
                    >
                      Call
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
