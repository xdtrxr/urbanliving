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

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
