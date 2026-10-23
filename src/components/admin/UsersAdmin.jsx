import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, RefreshCw, AlertCircle, CheckCircle2, UserPlus, Search, Users } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { invokeFn } from '@/lib/invokeFn';
import { useToast } from '@/components/ui/use-toast';
import { ROLES, roleLabel, ROLE_POWERS, inviteSentNote } from '@/config/adminAccess';

// UsersAdmin — who has an account, what each may do, and invitations.
//
// Everything goes through the manageUsers function, which only answers an
// admin: the list (a guest's row is not readable from the browser), a role
// change (the field-level rule on User.role refuses the browser), and an
// invitation. invokeFn never throws, so a refusal arrives as r.error, the
// server's own sentence, and that is what is shown.
//
// Every change waits for a second step that says plainly what the role can
// do. Admin especially: it reaches guest details, payments and payouts.

const joined = (s) => {
  if (!s) return '—';
  try { return format(parseISO(s), 'MMM d, yyyy'); } catch { return s; }
};

const ROLE_STYLES = {
  admin: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-200 dark:border-red-900',
  listing_helper: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900',
  user: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700',
};

// How a role reads in a sentence: "Make Ada a listings helper?"
const AS_A = { user: 'a regular user', listing_helper: 'a listings helper', admin: 'an admin' };
const asA = (role) => AS_A[role || 'user'] || roleLabel(role);

const sameEmail = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

export default function UsersAdmin({ currentUser }) {
  const { toast } = useToast();
  const [users, setUsers] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [query, setQuery] = useState('');
  // A change waiting for its second step:
  //   { kind: 'set_role', user, role, refused }
  //   { kind: 'invite', email, role, refused }
  // `refused` is the server's sentence if the step was tried and refused.
  const [pending, setPending] = useState(null);
  const [working, setWorking] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('listing_helper');
  const [inviteSent, setInviteSent] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await invokeFn('manageUsers', { action: 'list' });
    if (r.ok) {
      setUsers(Array.isArray(r.data?.users) ? r.data.users : []);
      setTruncated(!!r.data?.truncated);
      setLoadError(null);
    } else {
      setLoadError(r.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const isMe = (u) => !!currentUser && (u.id === currentUser.id || sameEmail(u.email, currentUser.email));
  const nameOf = (u) => u.full_name || u.email || 'This person';

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => `${u.full_name || ''} ${u.email || ''}`.toLowerCase().includes(q));
  }, [users, query]);

  const counts = useMemo(() => ({
    admin: users.filter((u) => u.role === 'admin').length,
    listing_helper: users.filter((u) => u.role === 'listing_helper').length,
  }), [users]);

  const askRole = (user, role) => {
    if (role === (user.role || 'user')) return;
    setPending({ kind: 'set_role', user, role, refused: null });
  };

  const startInvite = (e) => {
    e.preventDefault();
    setInviteSent(null);
    const email = inviteEmail.trim();
    if (!email) return;
    setPending({ kind: 'invite', email, role: inviteRole, refused: null });
  };

  const confirm = async () => {
    if (!pending) return;
    setWorking(true);
    const r = pending.kind === 'set_role'
      ? await invokeFn('manageUsers', { action: 'set_role', user_id: pending.user.id, role: pending.role })
      : await invokeFn('manageUsers', { action: 'invite', email: pending.email, role: pending.role });
    setWorking(false);
    if (!r.ok) {
      setPending({ ...pending, refused: r.error });
      return;
    }
    if (pending.kind === 'set_role') {
      const role = r.data?.user?.role || pending.role;
      setUsers((prev) => prev.map((u) => (u.id === pending.user.id ? { ...u, role } : u)));
      toast({ title: 'Role changed', description: `${nameOf(pending.user)} is now ${asA(role)}.` });
    } else {
      setInviteSent(inviteSentNote(r.data));
      setInviteEmail('');
    }
    setPending(null);
  };

  const powers = pending ? ROLE_POWERS[pending.role] : null;

  return (
    <div className="space-y-6">
      {/* Invite */}
      <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <UserPlus className="w-5 h-5 flex-shrink-0" />
            Invite someone
          </CardTitle>
          <CardDescription>
            They get an email from Base44 to set up their account. Someone who already has one: change their role in the list below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={startInvite} className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="flex-1 min-w-0">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => { setInviteEmail(e.target.value); setInviteSent(null); }}
                placeholder="name@example.com"
                className="mt-1 rounded-xl"
                autoComplete="off"
              />
            </div>
            <div className="sm:w-48">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger id="invite-role" className="mt-1 rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((role) => <SelectItem key={role} value={role}>{roleLabel(role)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!inviteEmail.trim() || working} className="rounded-xl">
              Send invitation
            </Button>
          </form>
          {inviteSent && (
            <div className="mt-3 flex items-start gap-2 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 rounded-xl p-3">
              <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-green-800 dark:text-green-200">{inviteSent}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Everyone */}
      <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg min-w-0">
              <Users className="w-5 h-5 flex-shrink-0" />
              <span className="truncate">Users ({users.length})</span>
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              disabled={loading}
              className="rounded-xl self-start sm:self-auto flex-shrink-0"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
          <CardDescription>
            {counts.admin} admin{counts.admin === 1 ? '' : 's'} · {counts.listing_helper} listings helper{counts.listing_helper === 1 ? '' : 's'}.
            A listings helper adds and edits properties and vehicles, and sees nothing else.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email"
              className="pl-9 rounded-xl"
              aria-label="Search users"
            />
          </div>

          {loadError && (
            <div className="flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
              <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-800 dark:text-red-200">{loadError}</p>
            </div>
          )}

          {loading && users.length === 0 ? (
            <div className="text-center py-10 text-slate-500 dark:text-slate-400 text-sm">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
              Loading users…
            </div>
          ) : shown.length === 0 && !loadError ? (
            <div className="text-center py-10 text-slate-500 dark:text-slate-400 text-sm">
              {query.trim() ? 'Nobody matches that search.' : 'No users yet.'}
            </div>
          ) : (
            <div className="space-y-2">
              {shown.map((u) => {
                const me = isMe(u);
                const known = ROLES.includes(u.role || 'user');
                return (
                  <div
                    key={u.id}
                    className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-slate-900 dark:text-white break-words min-w-0">{u.full_name || 'No name yet'}</p>
                        {me && <Badge variant="outline" className="text-xs">You</Badge>}
                        <Badge className={`text-xs ${ROLE_STYLES[u.role || 'user'] || ROLE_STYLES.user}`}>{roleLabel(u.role)}</Badge>
                      </div>
                      <p className="text-sm text-slate-600 dark:text-slate-300 break-all">{u.email}</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Joined {joined(u.created_date)}</p>
                    </div>
                    <div className="sm:w-48 flex-shrink-0">
                      {me ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400">Your own role cannot be changed here. Another admin can.</p>
                      ) : (
                        <Select
                          value={known ? (u.role || 'user') : undefined}
                          onValueChange={(role) => askRole(u, role)}
                          disabled={working}
                        >
                          <SelectTrigger className="rounded-xl" aria-label={`Role for ${nameOf(u)}`}>
                            <SelectValue placeholder={roleLabel(u.role)} />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((role) => <SelectItem key={role} value={role}>{roleLabel(role)}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </div>
                );
              })}
              {truncated && (
                <p className="text-xs text-slate-500 dark:text-slate-400 text-center pt-2">
                  Showing the newest {users.length}. Search covers these only.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* The second step, for a role change and for an invitation alike. */}
      <Dialog open={!!pending} onOpenChange={(o) => { if (!o && !working) setPending(null); }}>
        <DialogContent className="max-w-md">
          {pending && powers && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {pending.kind === 'set_role'
                    ? `Make ${nameOf(pending.user)} ${asA(pending.role)}?`
                    : `Invite ${pending.email} as ${asA(pending.role)}?`}
                </DialogTitle>
                <DialogDescription>
                  {pending.kind === 'set_role'
                    ? `${pending.user.email} · now ${roleLabel(pending.user.role)}`
                    : 'Base44 sends them an email to set up their account.'}
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm font-medium text-slate-900 dark:text-white">{powers.summary}</p>
              {powers.can.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">They can</p>
                  <ul className="text-sm text-slate-700 dark:text-slate-200 list-disc pl-5 space-y-0.5">
                    {powers.can.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </div>
              )}
              {powers.cannot.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">They cannot</p>
                  <ul className="text-sm text-slate-700 dark:text-slate-200 list-disc pl-5 space-y-0.5">
                    {powers.cannot.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </div>
              )}
              {pending.kind === 'invite' && pending.role === 'listing_helper' && (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Base44 invitations know only User and Admin, so they join as a User. Once they have signed up, set them to Listings helper in the list.
                </p>
              )}
              {pending.refused && (
                <div className="flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
                  <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-800 dark:text-red-200">{pending.refused}</p>
                </div>
              )}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setPending(null)} disabled={working} className="rounded-xl">
                  Cancel
                </Button>
                <Button
                  onClick={confirm}
                  disabled={working}
                  className={`rounded-xl text-white ${pending.role === 'admin' ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-900 hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'}`}
                >
                  {working ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  {pending.kind === 'invite'
                    ? 'Send invitation'
                    : `Yes, make them ${asA(pending.role)}`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
