import React, { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { UploadFile } from '@/api/integrations';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus, List, UserRound, Upload, Loader2, Trash2, Edit3, Save, X,
  AlertCircle, Phone, RefreshCw, Mail,
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { CITIES, normaliseEmail, looksLikeEmail, driverLoginPatch, mayDeleteDriver } from '@/config/rides';

// DriversAdmin — CRUD for the driver roster.
//
// Driver RLS is admin-only for every operation including read, so this is the
// only place the roster is ever visible. Guests see a narrow projection of a
// single driver through getRideDriverContact, and only once their ride is
// paid and assigned.
//
// Without this screen assignRideDriver has nothing to offer and the driver
// half of Rides cannot run at all.

const EMPTY = {
  full_name: '',
  phone: '',
  // The login the driver signs in with. Empty means their pay is not tracked.
  user_email: '',
  photo: '',
  city: CITIES[0],
  languages: '',          // comma-separated in the form, array on the row
  years_experience: '',
  bio: '',
  licence_number: '',
  licence_expiry: '',
  active: true,
  // Schema default is false, but an admin adding a driver by hand has already
  // vetted them — same reasoning as VehiclesAdmin.
  admin_approved: true,
};

const csvToArray = (raw) => (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
const arrayToCsv = (a) => (Array.isArray(a) ? a.join(', ') : '');

// Surface the platform's real message — a 402 integration-quota rejection
// will never succeed on retry, so "please try again" is actively misleading.
const uploadErrorText = (error) =>
  error?.response?.data?.message || error?.data?.message || error?.message || 'Unknown error';

export default function DriversAdmin() {
  const { toast } = useToast();
  const [tab, setTab] = useState('list');
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const photoRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await base44.entities.Driver.list('-created_date', 200);
      setDrivers(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.error('Failed to load drivers:', err);
      toast({ title: 'Could not load drivers', description: err?.message || '', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const reset = () => { setForm(EMPTY); setEditingId(null); setError(null); };

  const startEdit = (d) => {
    setEditingId(d.id);
    setForm({
      full_name: d.full_name || '',
      phone: d.phone || '',
      user_email: d.user_email || '',
      photo: d.photo || '',
      city: d.city || CITIES[0],
      languages: arrayToCsv(d.languages),
      years_experience: d.years_experience ?? '',
      bio: d.bio || '',
      licence_number: d.licence_number || '',
      licence_expiry: d.licence_expiry || '',
      active: d.active !== false,
      admin_approved: d.admin_approved !== false,
    });
    setTab('add');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Pick an image file.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const { file_url } = await UploadFile({ file });
      if (file_url) set('photo', file_url);
    } catch (err) {
      console.error('Driver photo upload failed:', err);
      setError(`Photo upload failed: ${uploadErrorText(err)}`);
    } finally {
      setUploading(false);
      if (photoRef.current) photoRef.current.value = '';
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.full_name.trim() || !form.phone.trim()) {
      setError('Name and phone are both required — the phone is what the guest gets on the day.');
      return;
    }
    const loginEmail = normaliseEmail(form.user_email);
    if (loginEmail && !looksLikeEmail(loginEmail)) {
      setError('That login email does not look like an email address.');
      return;
    }
    // One login is one driver. getDriverProfile would otherwise have to pick.
    if (loginEmail && drivers.some((d) => d.id !== editingId && normaliseEmail(d.user_email) === loginEmail)) {
      setError('Another driver is already linked to that login email.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        full_name: form.full_name.trim(),
        phone: form.phone.trim(),
        // user_email plus previous_user_emails: changing a login keeps the old
        // address on the row so withdrawals made under it still count.
        ...driverLoginPatch(drivers.find((d) => d.id === editingId), form.user_email),
        photo: form.photo || undefined,
        city: form.city,
        languages: csvToArray(form.languages),
        years_experience: form.years_experience === '' ? undefined : Number(form.years_experience),
        bio: form.bio.trim() || undefined,
        licence_number: form.licence_number.trim() || undefined,
        licence_expiry: form.licence_expiry || undefined,
        active: form.active,
        admin_approved: form.admin_approved,
      };
      if (editingId) await base44.entities.Driver.update(editingId, payload);
      else await base44.entities.Driver.create(payload);
      toast({ title: editingId ? 'Driver updated' : 'Driver added' });
      reset();
      await load();
      setTab('list');
    } catch (err) {
      console.error('Save driver failed:', err);
      setError(err?.message || 'Could not save this driver.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeletingId(toDelete.id);
    try {
      // Earnings and withdrawals hang off the profile's id. Delete the profile
      // and the driver's wallet, and any payout waiting on it, are orphaned.
      // Both entities are admin-only at the API, like Driver itself. If either
      // lookup fails this throws, and nothing is deleted.
      const [earnings, withdrawals] = await Promise.all([
        base44.entities.DriverEarning.filter({ driver_id: toDelete.id }, undefined, 1),
        base44.entities.WithdrawalRequest.filter({ driver_id: toDelete.id }, undefined, 1),
      ]);
      if (!mayDeleteDriver(earnings, withdrawals)) {
        toast({
          title: 'This driver has pay on record',
          description: `${toDelete.full_name} has earnings or withdrawals in the app, so the profile cannot be removed. Switch them to inactive instead: they are no longer offered rides and keep access to their wallet.`,
          variant: 'destructive',
        });
        return;
      }
      await base44.entities.Driver.delete(toDelete.id);
      toast({ title: 'Driver removed' });
      await load();
    } catch (err) {
      toast({ title: 'Could not remove driver', description: err?.message || '', variant: 'destructive' });
    } finally {
      setDeletingId(null);
      setToDelete(null);
    }
  };

  const expirySoon = (iso) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return false;
    return t - Date.now() < 30 * 24 * 60 * 60 * 1000;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex gap-2">
          <Button
            variant={tab === 'list' ? 'default' : 'outline'} size="sm"
            onClick={() => setTab('list')} className="rounded-xl"
          >
            <List className="w-4 h-4 mr-2" /> Roster ({drivers.length})
          </Button>
          <Button
            variant={tab === 'add' ? 'default' : 'outline'} size="sm"
            onClick={() => { if (tab !== 'add') reset(); setTab('add'); }}
            className="rounded-xl"
          >
            <Plus className="w-4 h-4 mr-2" /> {editingId ? 'Edit driver' : 'Add driver'}
          </Button>
        </div>
        {tab === 'list' && (
          <Button variant="outline" size="icon" onClick={load} className="rounded-xl self-start sm:self-auto" aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
          <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
        </div>
      )}

      {tab === 'add' ? (
        <Card className="bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-2xl">
          <CardContent className="p-5 sm:p-6">
            <form onSubmit={submit} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="d-name">Full name *</Label>
                  <Input id="d-name" value={form.full_name} onChange={(e) => set('full_name', e.target.value)}
                    placeholder="Emeka Okafor" className="mt-1 rounded-xl" required />
                </div>
                <div>
                  <Label htmlFor="d-phone" className="flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5" /> Phone *
                  </Label>
                  <Input id="d-phone" value={form.phone} onChange={(e) => set('phone', e.target.value)}
                    placeholder="+234 801 234 5678" className="mt-1 rounded-xl" required />
                </div>
                <div>
                  <Label htmlFor="d-city">City *</Label>
                  <Select value={form.city} onValueChange={(v) => set('city', v)}>
                    <SelectTrigger id="d-city" className="mt-1 rounded-xl"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CITIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Assignment blocks a driver whose city differs from the vehicle&apos;s.
                  </p>
                </div>
                <div>
                  <Label htmlFor="d-exp">Years of experience</Label>
                  <Input id="d-exp" type="number" min={0} max={60} value={form.years_experience}
                    onChange={(e) => set('years_experience', e.target.value)} className="mt-1 rounded-xl" />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="d-langs">Languages (comma separated)</Label>
                  <Input id="d-langs" value={form.languages} onChange={(e) => set('languages', e.target.value)}
                    placeholder="English, Igbo, Pidgin" className="mt-1 rounded-xl" />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="d-email" className="flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" /> Login email
                  </Label>
                  <Input id="d-email" type="email" inputMode="email" autoCapitalize="none" autoCorrect="off"
                    spellCheck={false} value={form.user_email}
                    onChange={(e) => set('user_email', e.target.value)}
                    placeholder="emeka@example.com" className="mt-1 rounded-xl" />
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    The driver signs in with this email to see rides and pay. Leave it empty and
                    they are assigned as before, with their pay kept outside the app.
                  </p>
                </div>
              </div>

              <div>
                <Label>Photo</Label>
                <div className="mt-1 flex items-center gap-3 flex-wrap">
                  <input ref={photoRef} type="file" accept="image/*" onChange={pickPhoto} className="hidden" id="d-photo" />
                  <Button type="button" variant="outline" onClick={() => photoRef.current?.click()}
                    disabled={uploading} className="rounded-xl">
                    {uploading
                      ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading…</>
                      : <><Upload className="w-4 h-4 mr-2" /> {form.photo ? 'Replace photo' : 'Choose photo'}</>}
                  </Button>
                  {form.photo && (
                    <div className="relative">
                      <img src={form.photo} alt="" className="w-14 h-14 rounded-full object-cover border border-slate-200 dark:border-slate-800" />
                      <button type="button" onClick={() => set('photo', '')} aria-label="Remove photo"
                        className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-black/70 hover:bg-black text-white flex items-center justify-center">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Shown to the guest once their ride is paid and this driver is assigned.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="d-licence">Licence number</Label>
                  <Input id="d-licence" value={form.licence_number} onChange={(e) => set('licence_number', e.target.value)}
                    className="mt-1 rounded-xl" />
                </div>
                <div>
                  <Label htmlFor="d-expiry">Licence expiry</Label>
                  <Input id="d-expiry" type="date" value={form.licence_expiry}
                    onChange={(e) => set('licence_expiry', e.target.value)} className="mt-1 rounded-xl" />
                </div>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 -mt-2">
                Licence details are for your records only — they are never shown to guests.
              </p>

              <div>
                <Label htmlFor="d-bio">Short bio</Label>
                <Textarea id="d-bio" rows={3} value={form.bio} onChange={(e) => set('bio', e.target.value)}
                  placeholder="Calm city driver, knows Abuja well." className="mt-1 rounded-xl" />
              </div>

              <div className="flex flex-col sm:flex-row gap-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <Switch checked={form.active} onCheckedChange={(v) => set('active', v)} />
                  <span className="text-sm text-slate-700 dark:text-slate-200">Active</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <Switch checked={form.admin_approved} onCheckedChange={(v) => set('admin_approved', v)} />
                  <span className="text-sm text-slate-700 dark:text-slate-200">Approved for assignment</span>
                </label>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 -mt-2">
                A driver must be both active and approved to appear when assigning a ride.
              </p>

              <div className="flex flex-col-reverse sm:flex-row gap-2 pt-2">
                {editingId && (
                  <Button type="button" variant="ghost" onClick={reset} className="w-full sm:w-auto rounded-xl">
                    <X className="w-4 h-4 mr-2" /> Cancel edit
                  </Button>
                )}
                <Button type="submit" disabled={saving} className="w-full sm:w-auto rounded-xl">
                  {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  {editingId ? 'Save changes' : 'Add driver'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
      ) : drivers.length === 0 ? (
        <Card className="bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-2xl">
          <CardContent className="py-12 text-center">
            <UserRound className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
            <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
              No drivers yet. Rides can be booked and paid for, but none can be assigned until you add one.
            </p>
            <Button onClick={() => { reset(); setTab('add'); }} className="rounded-xl">
              <Plus className="w-4 h-4 mr-2" /> Add your first driver
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {drivers.map((d) => (
            <div key={d.id}
              className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              {d.photo ? (
                <img src={d.photo} alt="" className="w-12 h-12 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
                  <UserRound className="w-5 h-5 text-slate-400" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-slate-900 dark:text-white truncate">{d.full_name}</p>
                  {d.active === false && <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-0">Inactive</Badge>}
                  {d.admin_approved === false && (
                    <Badge className="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-0">Not approved</Badge>
                  )}
                  {expirySoon(d.licence_expiry) && (
                    <Badge className="bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-0">Licence expiring</Badge>
                  )}
                  {d.user_email ? (
                    <Badge variant="outline" className="text-xs">Has login</Badge>
                  ) : (
                    <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-0 text-xs">No login · pay not tracked</Badge>
                  )}
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-300 truncate">
                  {[d.city, d.phone, d.years_experience ? `${d.years_experience} yrs` : null]
                    .filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <Button variant="outline" size="sm" onClick={() => startEdit(d)} className="rounded-xl">
                  <Edit3 className="w-4 h-4 sm:mr-2" /><span className="hidden sm:inline">Edit</span>
                </Button>
                <Button variant="outline" size="sm" disabled={deletingId === d.id}
                  onClick={() => setToDelete(d)}
                  className="rounded-xl border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={!!toDelete} onOpenChange={(o) => { if (!o) setToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {toDelete?.full_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Rides already assigned to this driver keep the
              assignment on the row, but the guest&apos;s driver card will stop
              resolving — deactivate instead if they might return. A driver
              with earnings or withdrawals on record cannot be removed at all.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700 text-white">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
