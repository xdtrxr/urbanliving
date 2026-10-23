// Who may do what, and the screen that changes it — run with:
//   node scripts/check-manage-users.mjs
//
// The owner asked on 2026-10-23 for a way to let a few people help put up
// properties and vehicles. Making them admin would hand them everything:
// guest bookings and details, payments on hold and refunds, driver payouts,
// and making more admins. So there is a third role, listing_helper, that the
// Property and Vehicle create and update rules name and nothing else does.
//
// This file pins three things:
//   - the access rules in base44/entities/, read as rules: who each one lets
//     through, not only how it is spelled
//   - manageUsers, run as shipped against scripts/lib/function-rig.mjs
//   - src/config/adminAccess.js, which decides what the Admin page shows a
//     role, and the screens that are meant to go through it

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRig, loadFunction, call, stubTelegram } from './lib/function-rig.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// ── The access rules ───────────────────────────────────────────────────────
// The files are .jsonc. None has a comment today; a whole-line one is
// allowed for, the same way scripts/check-vehicle-form.mjs reads them.
const entity = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'base44/entities', `${name}.jsonc`), 'utf8')
  .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'));

// Does this rule let `user` through? Built from what these rules use:
// user_condition, $or and $and. A missing rule or an empty one is read as
// "anyone", and a key this does not know as "nobody can tell", which counts
// as a yes here: the pins below are about who must NOT get through, so the
// reading that can hide a hole is the one to avoid.
function allows(rule, user) {
  if (rule === undefined || rule === null) return true;
  if (typeof rule !== 'object') return true;
  return Object.entries(rule).every(([key, value]) => {
    if (key === '$or') return Array.isArray(value) && value.some((r) => allows(r, user));
    if (key === '$and') return Array.isArray(value) && value.every((r) => allows(r, user));
    if (key === 'user_condition') {
      return !!user && !!value && typeof value === 'object'
        && Object.entries(value).every(([field, want]) => user[field] === want);
    }
    // A data condition (data.guest_email and the like) depends on the row.
    // Some row will match it, so for "can this person ever" it is a yes.
    return true;
  });
}

// Everyone a rule could meet: the three roles, an account with no role on
// it, a role spelled nearly right, and nobody signed in.
const WHO = [
  ['admin', { role: 'admin' }],
  ['listing_helper', { role: 'listing_helper' }],
  ['user', { role: 'user' }],
  ['no role', {}],
  ['listing_helpers', { role: 'listing_helpers' }],
  ['signed out', null],
];
const letsThrough = (rule) => WHO.filter(([, user]) => allows(rule, user)).map(([name]) => name);

console.log('\n— the rules read as rules —');
// The reader has to be able to say no, or every pin below passes for nothing.
check('the reader: an admin-only rule lets only admin through', letsThrough({ user_condition: { role: 'admin' } }), ['admin']);
check('the reader: an empty rule lets everyone through', letsThrough({}).length, WHO.length);
check('the reader: a missing rule lets everyone through', letsThrough(undefined).length, WHO.length);
check('the reader: an $or lets either through', letsThrough({ $or: [{ user_condition: { role: 'admin' } }, { user_condition: { role: 'user' } }] }), ['admin', 'user']);
check('the reader: an owner rule is a way in for anyone signed in or not, so it counts', letsThrough({ 'data.user_email': '{{user.email}}' }).length, WHO.length);

const property = entity('Property');
const vehicle = entity('Vehicle');
const costing = entity('VehicleCosting');
const user = entity('User');
for (const [name, schema] of [['Property', property], ['Vehicle', vehicle]]) {
  for (const op of ['create', 'update']) {
    check(`${name} ${op}: admin and listing_helper, nobody else`, letsThrough(schema.rls?.[op]), ['admin', 'listing_helper']);
    check(`${name} ${op} is spelled as Booking's read rule is: an $or of two user_conditions`, schema.rls?.[op], {
      $or: [{ user_condition: { role: 'admin' } }, { user_condition: { role: 'listing_helper' } }],
    });
  }
  check(`${name} delete: admin only`, letsThrough(schema.rls?.delete), ['admin']);
  check(`${name} read stays public`, JSON.stringify(schema.rls?.read), '{}');
}
for (const op of ['create', 'read', 'update', 'delete']) {
  check(`VehicleCosting ${op}: admin only (partner cost and driver pay)`, letsThrough(costing.rls?.[op]), ['admin']);
}
const role = user.properties?.role;
check('User.role offers exactly user, listing_helper and admin', [...(role?.enum || [])].sort(), ['admin', 'listing_helper', 'user']);
check('User.role defaults to user', role?.default, 'user');
check('User.role is written by admin only', letsThrough(role?.rls?.write), ['admin']);
check('User.role says what a listing helper may do', /listing_helper/.test(role?.description || '') && /properties and vehicles/.test(role?.description || ''), true);

// ── manageUsers, as shipped ────────────────────────────────────────────────
const rig = createRig();
stubTelegram(rig);
// Two things the stand-in client does not do the way the platform does.
// auth.me() THROWS for a caller who is not signed in. And invitations go
// through the SDK's users module, which SDK 0.8.27 puts on the caller's
// client only (asServiceRole has none) and which refuses any role but
// 'user' and 'admin' before it sends anything. Each call is kept.
rig.invites = [];
rig.inviteFails = null;
const plainClient = rig.client;
rig.client = () => {
  const client = plainClient();
  const me = client.auth.me;
  client.auth = {
    ...client.auth,
    me: async () => {
      const u = await me();
      if (!u) throw Object.assign(new Error('Unauthorized'), { status: 401, response: { status: 401, data: { message: 'Unauthorized' } } });
      return u;
    },
  };
  client.users = {
    async inviteUser(user_email, invitedRole) {
      if (invitedRole !== 'user' && invitedRole !== 'admin') {
        throw new Error(`Invalid role: "${invitedRole}". Role must be either "user" or "admin".`);
      }
      if (rig.inviteFails) throw rig.inviteFails;
      rig.invites.push([user_email, invitedRole]);
      return { status: 200, data: {} };
    },
  };
  return client;
};
const manage = await loadFunction(rig, 'manageUsers');

const at = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString();
const BOSS = { id: 'boss', email: 'boss@urbanstays.io', full_name: 'Bisi Owner', role: 'admin', created_date: at(1) };
const DEPUTY = { id: 'deputy', email: 'deputy@urbanstays.io', full_name: 'Dapo Deputy', role: 'admin', created_date: at(2) };
const HANA = { id: 'hana', email: 'hana@example.com', full_name: 'Hana Helper', role: 'listing_helper', created_date: at(3) };
const GINA = {
  id: 'gina', email: 'gina@example.com', full_name: 'Gina Guest', role: 'user', created_date: at(4),
  referral_balance_ngn: 25000, push_subscriptions: [{ endpoint: 'https://push.example/1' }], phone_number: '0803',
};
// An account from before roles were written on every row.
const LEE = { id: 'lee', email: 'lee@example.com', full_name: '', created_date: at(5) };
const reset = () => {
  rig.db.User = [BOSS, DEPUTY, HANA, GINA, LEE].map((u) => JSON.parse(JSON.stringify(u)));
  rig.db.Booking = [{ id: 'b1', guest_email: GINA.email, status: 'confirmed' }];
  rig.sent.length = 0;
  rig.telegram.length = 0;
  rig.invites.length = 0;
  rig.inviteFails = null;
};
const roleOf = (id) => (rig.db.User.find((u) => u.id === id) || {}).role;
const ask = (body, as) => call(rig, manage, body, as);
const setRole = (user_id, newRole, as = BOSS) => ask({ action: 'set_role', user_id, role: newRole }, as);
const invite = (email, newRole, as = BOSS) => ask({ action: 'invite', email, role: newRole }, as);

console.log('\n— who may call it —');
reset();
for (const body of [{ action: 'list' }, { action: 'set_role', user_id: 'gina', role: 'admin' }, { action: 'invite', email: 'new@example.com', role: 'admin' }]) {
  let r = await ask(body, null);
  check(`signed out, ${body.action}: 401`, r.status, 401);
  r = await ask(body, GINA);
  check(`a guest, ${body.action}: 403 ADMIN_ONLY`, [r.status, r.code], [403, 'ADMIN_ONLY']);
  r = await ask(body, HANA);
  check(`a listings helper, ${body.action}: 403 ADMIN_ONLY`, [r.status, r.code], [403, 'ADMIN_ONLY']);
}
check('none of that changed a role or sent an invitation', [roleOf('gina'), rig.invites.length, rig.sent.length], ['user', 0, 0]);
let r = await setRole('hana', 'admin', HANA);
check('a helper cannot make themselves admin', [r.status, roleOf('hana')], [403, 'listing_helper']);
r = await ask({ action: 'delete_everyone' }, BOSS);
check('an action it does not know', [r.status, r.code], [400, 'BAD_ACTION']);
r = await call(rig, manage, null, BOSS, 'GET');
check('a GET is refused', r.status, 405);

console.log('\n— list —');
r = await ask({ action: 'list' }, BOSS);
check('an admin gets every account, newest first', [r.status, (r.data?.users || []).map((u) => u.id)], [200, ['lee', 'gina', 'hana', 'deputy', 'boss']]);
check('each as id, name, email, role and joined date, nothing more', Object.keys(r.data?.users?.[1] || {}).sort(), ['created_date', 'email', 'full_name', 'id', 'role']);
check('no wallet, phone or push subscription leaves the function', JSON.stringify(r.data).includes('25000') || JSON.stringify(r.data).includes('push.example') || JSON.stringify(r.data).includes('0803'), false);
check('an account with no role on it reads as a user', r.data?.users?.[0], { id: 'lee', full_name: '', email: LEE.email, role: 'user', created_date: LEE.created_date });
check('and the list says it is whole', r.data?.truncated, false);
// More accounts than one page, so a read that relied on the platform's
// default page (50 here) would stop short.
rig.db.User.push(...Array.from({ length: 445 }, (_, i) => ({ id: `u${i}`, email: `u${i}@example.com`, role: 'user', created_date: at(10 + i) })));
r = await ask({ action: 'list' }, BOSS);
check('450 accounts: all 450, across pages', [r.data?.users?.length, new Set((r.data?.users || []).map((u) => u.id)).size, r.data?.truncated], [450, 450, false]);
check('still newest first', r.data?.users?.[0]?.id === 'u444' && r.data?.users?.[449]?.id === 'boss', true);
rig.db.User.push(...Array.from({ length: 800 }, (_, i) => ({ id: `v${i}`, email: `v${i}@example.com`, role: 'user', created_date: at(500 + i) })));
r = await ask({ action: 'list' }, BOSS);
check('1250 accounts: the newest 1000, and it says there are more', [r.data?.users?.length, r.data?.users?.[0]?.id, r.data?.truncated], [1000, 'v799', true]);

console.log('\n— set_role —');
reset();
r = await setRole('gina', 'listing_helper');
check('user to listings helper', [r.status, roleOf('gina'), r.data?.user], [200, 'listing_helper', { id: 'gina', full_name: 'Gina Guest', email: GINA.email, role: 'listing_helper' }]);
check('the admin chat is told who changed whose role, from what to what',
  rig.sent[0], 'Role changed by Bisi Owner (boss@urbanstays.io): Gina Guest (gina@example.com) is now Listings helper (was User).');
check('in plain text: no Markdown parse mode', rig.telegram[0] && !('parse_mode' in rig.telegram[0]), true);
r = await setRole('gina', 'admin');
check('listings helper to admin', [r.status, roleOf('gina'), r.data?.previous_role], [200, 'admin', 'listing_helper']);
check('and that is announced too', /Gina Guest \(gina@example\.com\) is now Admin \(was Listings helper\)\.$/.test(rig.sent[1] || ''), true);
r = await setRole('gina', 'user');
check('admin back to user', [r.status, roleOf('gina')], [200, 'user']);
r = await setRole('lee', 'listing_helper');
check('an account with no role becomes a listings helper', [r.status, roleOf('lee'), /was User\)/.test(rig.sent[3] || '')], [200, 'listing_helper', true]);
const sentBefore = rig.sent.length;
r = await setRole('hana', 'listing_helper');
check('setting the role it already has writes nothing and announces nothing', [r.status, r.data?.unchanged, rig.sent.length], [200, true, sentBefore]);

for (const bad of ['superadmin', 'Admin', 'listing helper', '', undefined, 7]) {
  r = await setRole('gina', bad);
  check(`role ${JSON.stringify(bad)}: 400 BAD_ROLE`, [r.status, r.code], [400, 'BAD_ROLE']);
}
check('and gina is still a user', roleOf('gina'), 'user');

r = await setRole('boss', 'user');
check('your own role: 409 OWN_ROLE', [r.status, r.code, roleOf('boss')], [409, 'OWN_ROLE', 'admin']);
r = await setRole('boss', 'admin');
check('even to what it already is', [r.status, r.code], [409, 'OWN_ROLE']);
r = await setRole('nobody', 'admin');
check('an unknown user: 404', [r.status, r.code], [404, 'NOT_FOUND']);
for (const id of ['../Booking/b1', 'gina#x', 'gina?role=admin', 'gina/..', '', null]) {
  r = await setRole(id, 'admin');
  check(`an id that is not a plain id (${JSON.stringify(id)}) is refused`, r.status, 404);
}
check('nothing was written through one of them', [roleOf('gina'), JSON.stringify(rig.db.Booking)], ['user', JSON.stringify([{ id: 'b1', guest_email: GINA.email, status: 'confirmed' }])]);

r = await setRole('deputy', 'listing_helper');
check('one admin can step another down while one is left', [r.status, roleOf('deputy')], [200, 'listing_helper']);
// Deputy's session still says admin: the change above happened a moment ago,
// in another tab. Boss is now the only admin in the table.
let userWrites = 0;
rig.failOn = (name, op) => { if (name === 'User' && op === 'update') userWrites += 1; return false; };
r = await setRole('boss', 'user', DEPUTY);
rig.failOn = null;
check('stepping down the only admin left: 409 LAST_ADMIN', [r.status, r.code, roleOf('boss')], [409, 'LAST_ADMIN', 'admin']);
check('refused before anything is written, not written and put back', userWrites, 0);
check('with a sentence that says what to do', /only admin\. Make someone else admin first/.test(r.error || ''), true);

// Two admins stepping each other down at the same moment each see the other
// one still there. Afterwards the app must still have an admin, and every
// answer of yes must still be true.
reset();
const both = await Promise.all([setRole('deputy', 'user', BOSS), setRole('boss', 'user', DEPUTY)]);
const admins = rig.db.User.filter((u) => u.role === 'admin').map((u) => u.id);
check('two admins demoting each other at once leave at least one admin', admins.length >= 1, true);
check('and each yes is still true', both.every((x, i) => x.status !== 200 || roleOf(i === 0 ? 'deputy' : 'boss') === 'user'), true);
check('and each no is LAST_ADMIN', both.filter((x) => x.status !== 200).map((x) => x.code).every((c) => c === 'LAST_ADMIN'), true);

reset();
globalThis.fetch = async () => { throw new Error('Telegram is down'); };
r = await setRole('gina', 'listing_helper');
check('Telegram failing does not undo or refuse the change', [r.status, roleOf('gina')], [200, 'listing_helper']);
stubTelegram(rig);
delete rig.env.TELEGRAM_BOT_TOKEN;
r = await setRole('gina', 'user');
check('nor does Telegram not being set up', [r.status, roleOf('gina'), rig.sent.length], [200, 'user', 0]);
stubTelegram(rig);

reset();
rig.failOn = (name, op) => name === 'User' && op === 'update';
r = await setRole('gina', 'admin');
rig.failOn = null;
check('a write that fails is a 500 with a calm sentence, not a yes', [r.status, roleOf('gina'), r.error], [500, 'user', 'Something went wrong. Please try again.']);

console.log('\n— invite —');
reset();
r = await invite('  New.Helper@Example.com ', 'listing_helper');
check('a listings helper is invited as a user: the platform knows no other role',
  [r.status, r.data, rig.invites], [200, { invited: true, email: 'new.helper@example.com', role: 'listing_helper', invited_as: 'user' }, [['new.helper@example.com', 'user']]]);
r = await invite('second@example.com', 'admin');
check('an admin is invited as admin', [r.status, r.data?.invited_as, rig.invites[1]], [200, 'admin', ['second@example.com', 'admin']]);
r = await invite('third@example.com', 'user');
check('a user as a user', [r.status, rig.invites[2]], [200, ['third@example.com', 'user']]);
check('each invitation is announced in plain text', [rig.sent.length, /^Invitation sent by Bisi Owner \(boss@urbanstays\.io\): second@example\.com, for Admin\.$/.test(rig.sent[1] || ''), rig.telegram.every((t) => !('parse_mode' in t))], [3, true, true]);
const invitesBefore = rig.invites.length;
for (const bad of ['', 'nobody', 'a@b', 'two words@example.com', 'x'.repeat(250) + '@example.com', null, ['a@example.com']]) {
  r = await invite(bad, 'user');
  check(`email ${JSON.stringify(bad).slice(0, 30)}: 400 BAD_EMAIL`, [r.status, r.code], [400, 'BAD_EMAIL']);
}
for (const bad of ['owner', '', undefined]) {
  r = await invite('fine@example.com', bad);
  check(`invite role ${JSON.stringify(bad)}: 400 BAD_ROLE`, [r.status, r.code], [400, 'BAD_ROLE']);
}
r = await invite('GINA@example.com', 'admin');
check('someone who already has an account: 409, change their role instead', [r.status, r.code, /already has an account/.test(r.error || '')], [409, 'ALREADY_USER', true]);
check('none of those sent an invitation', rig.invites.length, invitesBefore);
rig.inviteFails = Object.assign(new Error('Request failed with status code 429'), { status: 429, response: { status: 429, data: { message: 'Daily invite limit reached' } } });
r = await invite('fourth@example.com', 'listing_helper');
check('the platform refusing: a sentence about the daily limit, with what Base44 said',
  [r.status, r.code, /daily limit/.test(r.error || ''), /Daily invite limit reached/.test(r.error || '')], [502, 'INVITE_FAILED', true, true]);

// ── The screens (source) ───────────────────────────────────────────────────
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const ADMIN_PAGE = source('src/pages/Admin.jsx');
const count = (text, needle) => text.split(needle).length - 1;

console.log('\n— no button deletes every property —');
// Until 2026-10-23 the Admin page had a "Delete All Properties" button that
// listed every Property and deleted them one by one from the browser.
check('the Admin page has no delete-all handler or button', /DeleteAll|Delete All Properties|Danger Zone/i.test(ADMIN_PAGE), false);
check('it deletes a property in one place only: the single-listing dialog', count(ADMIN_PAGE, 'Property.delete('), 1);
check('and that one deletes the property the dialog names', /await base44\.entities\.Property\.delete\(propertyToDelete\.id\);/.test(ADMIN_PAGE), true);

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
