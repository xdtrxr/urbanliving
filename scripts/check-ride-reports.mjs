// Ride reports — run with: node scripts/check-ride-reports.mjs
//
// A report can stop a driver being paid and can lock a guest out of booking,
// so who may file one, when, and what happens to money while it is open are
// all decided by small pure functions, and this file runs the shipped copies
// of them off disk. It also demands that helpers copied between functions are
// identical, because Base44 function directories cannot share a module.
//
// The harness below is the same one scripts/check-driver-wallet.mjs uses. On
// the new Function(): its only input is this repo's own source, read from
// paths this file computes itself; nothing here is reachable from a request.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN = (name) => path.join(ROOT, 'base44/functions', name, 'entry.ts');

let pass = 0;
let fail = 0;
const report = (ok, name, got, want) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const check = (name, got, want) => report(Object.is(got, want), name, got, want);
const same = (name, got, want) => report(JSON.stringify(got) === JSON.stringify(want), name, got, want);

// Lift one top-level function out of a shipped entry.ts as plain JavaScript:
// the signature is the whole first line, the closing brace is alone in column
// 0, and the body carries no type annotations. Only the first line is rewritten.
function liftSrc(fnDir, fnName, signature) {
  const file = FN(fnDir);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${fnName}(`) || l.startsWith(`async function ${fnName}(`));
  if (start === -1) throw new Error(`could not find ${fnName} in ${path.relative(ROOT, file)}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) throw new Error(`${fnName} in ${path.relative(ROOT, file)} has no closing brace in column 0`);
  const head = `${lines[start].startsWith('async ') ? 'async ' : ''}function ${fnName}(${signature}) {`;
  return [head, ...lines.slice(start + 1, end), '}'].join('\n');
}
const make = (name, ...sources) => new Function(`${sources.join('\n')}\nreturn ${name};`)();
const identical = (fnName, signature, dirs) => {
  const [first, ...rest] = dirs.map((d) => liftSrc(d, fnName, signature));
  for (let i = 0; i < rest.length; i += 1) {
    check(`${fnName}: ${dirs[i + 1]} copy matches ${dirs[0]}`, rest[i] === first, true);
  }
};
function constLine(fnDir, name) {
  const file = FN(fnDir);
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`could not find const ${name} in ${path.relative(ROOT, file)}`);
  return line;
}
const consts = (fnDir, names) => names.map((n) => constLine(fnDir, n)).join('\n');

// Just enough of one Base44 entity: exact-match filter (plus { $in: [...] }),
// create, update, get, delete.
function fakeEntity(seed = []) {
  let n = 0;
  const rows = seed.map((r) => ({ ...r }));
  const matches = (row, query) => Object.entries(query || {}).every(([k, v]) => (
    v && typeof v === 'object' && Array.isArray(v.$in) ? v.$in.includes(row[k]) : row[k] === v
  ));
  return {
    rows,
    async filter(query, _sort, limit = 50, skip = 0) {
      return rows.filter((r) => matches(r, query)).slice(skip, skip + limit).map((r) => ({ ...r }));
    },
    async create(data) {
      n += 1;
      const row = { id: `new${n}`, created_date: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), ...data };
      rows.push(row);
      return { ...row };
    },
    async update(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`no row ${id}`);
      Object.assign(row, patch);
      return { ...row };
    },
    async get(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async delete(id) {
      const i = rows.findIndex((r) => r.id === id);
      if (i !== -1) rows.splice(i, 1);
    },
  };
}
const FETCH_ALL = 'async function fetchAll(entity, query) { const out = []; for (let skip = 0; ; skip += 500) { const page = await entity.filter(query, undefined, 500, skip); out.push(...page); if (page.length < 500) break; } return out; }';
const at = (iso) => Date.parse(iso);

// ── Filing a report ────────────────────────────────────────────────────────
console.log('\n— lockstep copies —');
identical('rideDurationMs', 'tier, days, hours', ['getRideBookings', 'createRideReport']);
identical('windowOf', 'r', ['getRideBookings', 'createRideReport']);
identical('findDriverForUser', 'sr, email', ['getDriverProfile', 'createRideReport']);
identical('notifyAdminLine', 'text', ['autoCancelExpiredBookings', 'createRideReport']);

const HOME = 'createRideReport';
const TIME = consts(HOME, ['WAT_OFFSET', 'HOUR_MS', 'DAY_MS', 'MAX_HOURLY', 'REPORT_WINDOW_AFTER_END_MS']);
const LIMITS = consts(HOME, ['CATEGORIES', 'MIN_DESCRIPTION', 'MAX_DESCRIPTION', 'MAX_EVIDENCE', 'MAX_URL_LENGTH', 'CARD_EXCERPT']);
const src = (name, signature) => liftSrc(HOME, name, signature);

// Review focus 3: the window, pinned to exact UTC instants.
console.log('\n— when a ride can be reported —');
const reportWindowOpen = make('reportWindowOpen', TIME,
  src('rideDurationMs', 'tier, days, hours'), src('windowOf', 'r'), src('reportWindowOpen', 'ride, nowMs'));
const ride = { start_at: '2026-08-10T08:00:00.000Z', end_at: '2026-08-10T10:00:00.000Z' };
check('not before the ride starts', reportWindowOpen(ride, at('2026-08-10T07:59:59.999Z')), false);
check('from the moment it starts', reportWindowOpen(ride, at('2026-08-10T08:00:00.000Z')), true);
check('during the ride', reportWindowOpen(ride, at('2026-08-10T09:00:00.000Z')), true);
check('seven days after it ends, to the millisecond', reportWindowOpen(ride, at('2026-08-17T10:00:00.000Z')), true);
check('not one millisecond later', reportWindowOpen(ride, at('2026-08-17T10:00:00.001Z')), false);
// A row with no stored instants: 09:00 WAT is 08:00 UTC, three hours is 11:00 UTC.
const legacy = { service_date: '2026-08-10', start_time: '09:00', duration_tier: 'hourly', duration_hours: 3 };
check('legacy row: opens at 08:00 UTC', reportWindowOpen(legacy, at('2026-08-10T08:00:00.000Z')), true);
check('legacy row: closes seven days after 11:00 UTC', reportWindowOpen(legacy, at('2026-08-17T11:00:00.001Z')), false);
check('a ride with no readable time cannot be reported', reportWindowOpen({}, at('2026-08-10T09:00:00.000Z')), false);

console.log('\n— who can report —');
const reporterRoleFor = make('reporterRoleFor', src('reporterRoleFor', 'ride, userEmail, driver'));
const booked = { guest_email: 'ada@example.com', driver_id: 'drvA' };
check('the guest who booked it', reporterRoleFor(booked, 'ada@example.com', null), 'guest');
check('…however their email was typed', reporterRoleFor(booked, ' Ada@Example.com ', null), 'guest');
check('the driver assigned to it', reporterRoleFor(booked, 'emeka@work.ng', { id: 'drvA' }), 'driver');
check('a driver assigned to a different ride', reporterRoleFor(booked, 'other@work.ng', { id: 'drvB' }), null);
check('a stranger', reporterRoleFor(booked, 'mallory@evil.ng', null), null);
check('a guest who is also a driver reports their own booking as the guest', reporterRoleFor(booked, 'ada@example.com', { id: 'drvA' }), 'guest');
check('a ride with no driver has no driver role', reporterRoleFor({ guest_email: 'ada@example.com' }, 'emeka@work.ng', { id: undefined }), null);
check('no email, no role', reporterRoleFor(booked, '', { id: 'drvA' }), null);

// Review focus 2: nothing but a real upload reaches the table.
console.log('\n— what a report may contain —');
const validateReportInput = make('validateReportInput', LIMITS, src('validateReportInput', 'body'));
const good = { category: 'rude', description: 'He shouted at me the whole trip.' };
same('a plain report is accepted and trimmed',
  validateReportInput({ ...good, description: '  He shouted at me the whole trip.  ' }),
  { ok: true, value: { category: 'rude', description: 'He shouted at me the whole trip.', evidence_urls: [] } });
for (const category of ['rude', 'abusive', 'threatening', 'unsafe', 'no_show', 'damage', 'other']) {
  check(`category "${category}" is accepted`, validateReportInput({ ...good, category }).ok, true);
}
check('an unknown category is refused', validateReportInput({ ...good, category: 'annoying' }).code, 'INVALID_CATEGORY');
check('a missing category is refused', validateReportInput({ description: good.description }).code, 'INVALID_CATEGORY');
check('nine characters is too short', validateReportInput({ ...good, description: '123456789' }).code, 'DESCRIPTION_LENGTH');
check('ten characters is enough', validateReportInput({ ...good, description: '1234567890' }).ok, true);
check('2000 characters is allowed', validateReportInput({ ...good, description: 'x'.repeat(2000) }).ok, true);
check('2001 characters is refused', validateReportInput({ ...good, description: 'x'.repeat(2001) }).code, 'DESCRIPTION_LENGTH');
check('spaces do not count toward the minimum', validateReportInput({ ...good, description: '   short    ' }).code, 'DESCRIPTION_LENGTH');
check('a description that is not text is refused', validateReportInput({ ...good, description: { $ne: '' } }).code, 'DESCRIPTION_LENGTH');
same('uploaded photos are kept, once each',
  validateReportInput({ ...good, evidence_urls: ['https://base44.app/files/a.jpg', 'https://base44.app/files/a.jpg', 'https://base44.app/files/b.jpg'] }).value.evidence_urls,
  ['https://base44.app/files/a.jpg', 'https://base44.app/files/b.jpg']);
check('a fourth photo is refused',
  validateReportInput({ ...good, evidence_urls: [1, 2, 3, 4].map((n) => `https://base44.app/files/${n}.jpg`) }).code, 'TOO_MANY_FILES');
for (const bad of [
  'javascript:alert(1)', 'http://example.com/a.jpg', 'data:text/html,<script>1</script>', '//example.com/a.jpg',
  'https://example.com/a b.jpg', 'https://example.com/a.jpg" onerror="x', "https://example.com/a.jpg'", 'https://example.com/<a>',
  `https://example.com/${'a'.repeat(600)}`, '', 42, null,
]) {
  check(`a "photo" of ${JSON.stringify(bad).slice(0, 44)} is refused`, validateReportInput({ ...good, evidence_urls: [bad] }).code, 'BAD_URL');
}
check('photos that are not a list are refused', validateReportInput({ ...good, evidence_urls: 'https://base44.app/files/a.jpg' }).code, 'BAD_URL');
check('no photos is fine', validateReportInput({ ...good, evidence_urls: null }).ok, true);

// Review focus 1: the card admin receives on Telegram.
console.log('\n— the Telegram card —');
const reportCardText = make('reportCardText', LIMITS, src('reportCardText', 'report'));
const card = reportCardText({
  reporter_role: 'driver', booking_reference: 'UD-AAA111', vehicle_name: 'Prado', ride_booking_id: 'ride1',
  reporter_name: 'Emeka Okafor', reported_name: 'Ada Obi', reported_email: 'ada@example.com', category: 'abusive',
  description: 'He said *this* and _that_, then `threw` [things](http://x) at me. '.repeat(10),
  evidence_urls: ['https://base44.app/files/a.jpg', 'https://base44.app/files/b.jpg'],
});
check('says who reported whom', card.includes('A driver reported a guest'), true);
check('names the ride', card.includes('UD-AAA111') && card.includes('Prado'), true);
check('names both people', card.includes('Emeka Okafor') && card.includes('Ada Obi'), true);
check('names the category', card.includes('abusive'), true);
check('counts the photos', card.includes('Photos attached: 2'), true);
check('says where to act', card.includes('Admin → Rides → Reports'), true);
// The description is free text. The card is sent WITHOUT a parse mode, so the
// characters that would break Markdown must simply still be there.
check('markdown characters in the description are passed through untouched', card.includes('*this* and _that_'), true);
check('a long description is cut, with an ellipsis', card.includes('…') && card.length < 800, true);
const guestCard = reportCardText({
  reporter_role: 'guest', ride_booking_id: 'ride1', reporter_email: 'ada@example.com',
  reported_name: 'Emeka Okafor', category: 'unsafe', description: 'Drove far too fast.',
});
check('a guest report says so', guestCard.includes('A guest reported a driver'), true);
check('falls back to the ride id and the email when names are missing', guestCard.includes('ride1') && guestCard.includes('ada@example.com'), true);
check('a short description is not cut', guestCard.includes('Drove far too fast.') && !guestCard.includes('…'), true);

// ---- result ----
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
