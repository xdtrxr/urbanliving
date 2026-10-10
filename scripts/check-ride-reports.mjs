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
import * as rides from '../src/config/rides.js';

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
identical('isId', 'value', ['processWithdrawal', 'createRideReport']);
identical('isId', 'value', ['processWithdrawal', 'resolveRideReport']);

const HOME = 'createRideReport';
const TIME = consts(HOME, ['WAT_OFFSET', 'HOUR_MS', 'DAY_MS', 'MAX_HOURLY', 'REPORT_WINDOW_AFTER_END_MS']);
const LIMITS = consts(HOME, ['CATEGORIES', 'MIN_DESCRIPTION', 'MAX_DESCRIPTION', 'MAX_EVIDENCE', 'MAX_URL_LENGTH', 'UPLOAD_URL', 'CARD_EXCERPT']);
// A link shaped like the ones this platform's file store hands back.
const uploaded = (name) => `https://base44.app/api/apps/69f75159e3beeee0837b5b60/files/mp/public/69f75159e3beeee0837b5b60/${name}`;
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
const validateReportInput = make('validateReportInput', LIMITS, src('isUploadUrl', 'url'), src('validateReportInput', 'body'));
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
  validateReportInput({ ...good, evidence_urls: [uploaded('a.jpg'), uploaded('a.jpg'), uploaded('b.jpg')] }).value.evidence_urls,
  [uploaded('a.jpg'), uploaded('b.jpg')]);
check('a fourth photo is refused',
  validateReportInput({ ...good, evidence_urls: [1, 2, 3, 4].map((n) => uploaded(`${n}.jpg`)) }).code, 'TOO_MANY_FILES');
// Admin's browser fetches every photo on a report. Each of these would let
// the reporter pick the server it is fetched from, or what comes back.
for (const [why, bad] of [
  ['another site', 'https://example.com/a.jpg'],
  ['a tracking pixel', 'https://evil.example/pixel.gif?report=1'],
  ['a host that only starts like ours', 'https://base44.app.evil.example/api/apps/69f75159e3beeee0837b5b60/files/a.jpg'],
  ['our host as a username', 'https://base44.app@evil.example/api/apps/69f75159e3beeee0837b5b60/files/a.jpg'],
  ['our host, but not the file store', 'https://base44.app/api/apps/69f75159e3beeee0837b5b60/entities/User'],
  ['our host, some other page', 'https://base44.app/files/a.jpg'],
  ['a query string on a real upload', `${uploaded('a.jpg')}?x=1`],
  ['a fragment on a real upload', `${uploaded('a.jpg')}#x`],
  ['a path that climbs out of the file store', uploaded('../../../entities/User')],
  ['plain http', uploaded('a.jpg').replace('https:', 'http:')],
]) {
  check(`a "photo" from ${why} is refused`, validateReportInput({ ...good, evidence_urls: [bad] }).code, 'BAD_URL');
}
for (const bad of [
  'javascript:alert(1)', 'http://example.com/a.jpg', 'data:text/html,<script>1</script>', '//example.com/a.jpg',
  'https://example.com/a b.jpg', 'https://example.com/a.jpg" onerror="x', "https://example.com/a.jpg'", 'https://example.com/<a>',
  `https://example.com/${'a'.repeat(600)}`, '', 42, null,
]) {
  check(`a "photo" of ${JSON.stringify(bad).slice(0, 44)} is refused`, validateReportInput({ ...good, evidence_urls: [bad] }).code, 'BAD_URL');
}
check('photos that are not a list are refused', validateReportInput({ ...good, evidence_urls: uploaded('a.jpg') }).code, 'BAD_URL');

// Filing: once per reporter per ride, always under the ride's own id.
console.log('\n— filing once —');
const isId = make('isId', src('isId', 'value'));
// Each of these fetched the same ride as "ride1" and, before this fix, each
// counted as a ride nobody had reported yet.
for (const stacked of ['ride1#1', 'ride1#2', 'ride1?again=1', 'ride1/', ' ride1']) {
  check(`${JSON.stringify(stacked)} is not accepted as a ride id`, isId(stacked), false);
}
const fileRideReport = make('fileRideReport', src('fileRideReport', 'sr, ride, reporter, input'));
const reportedRide = {
  id: 'ride1', booking_reference: 'UD-AAA111', vehicle_name: 'Prado', service_date: '2026-08-10',
  guest_email: 'ada@example.com', guest_name: 'Ada Obi', driver_id: 'drvA',
};
const asGuest = { email: 'ada@example.com', role: 'guest', name: 'Ada Obi', reported_name: 'Emeka Okafor' };
const asDriver = { email: 'emeka@work.ng', role: 'driver', name: 'Emeka Okafor', reported_name: 'Ada Obi' };
const said = { category: 'rude', description: 'He shouted at me the whole trip.', evidence_urls: [] };
{
  const sr = { RideReport: fakeEntity([]) };
  const first = await fileRideReport(sr, reportedRide, asGuest, said);
  check('a first report is filed', `${first.ok}/${sr.RideReport.rows.length}`, 'true/1');
  check('…under the ride\'s own id', sr.RideReport.rows[0].ride_booking_id, 'ride1');
  check('…open, with nothing decided', `${first.row.status}/${first.row.action_taken}`, 'open/none');
  check('…a guest\'s report names the driver, not an email', `${first.row.reported_driver_id}/${first.row.reported_email}`, 'drvA/');
  const second = await fileRideReport(sr, reportedRide, asGuest, { ...said, description: 'And another thing entirely.' });
  check('the same person cannot report the same ride twice', `${second.ok}/${second.code}/${sr.RideReport.rows.length}`, 'false/ALREADY_REPORTED/1');
  const other = await fileRideReport(sr, reportedRide, asDriver, said);
  check('the other side of the ride still can', `${other.ok}/${sr.RideReport.rows.length}`, 'true/2');
  check('…a driver\'s report names the guest, not a driver', `${other.row.reported_email}/${other.row.reported_driver_id}`, 'ada@example.com/');
}
{
  // Two taps on Submit both pass the "already" check. The second to write
  // sees the first one's row, removes its own, and answers as a duplicate.
  const sr = { RideReport: fakeEntity([]) };
  const realCreate = sr.RideReport.create;
  let twin = true;
  sr.RideReport.create = async (data) => {
    if (twin) { twin = false; await realCreate({ ...data, description: 'the other tap' }); }
    return realCreate(data);
  };
  const late = await fileRideReport(sr, reportedRide, asGuest, said);
  check('two taps on Submit leave one report', `${late.ok}/${late.code}/${sr.RideReport.rows.length}`, 'false/ALREADY_REPORTED/1');
  check('…the first one', sr.RideReport.rows[0].description, 'the other tap');
}
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

// ── Resolving a report ─────────────────────────────────────────────────────
console.log('\n— resolving —');
const RESOLVE = 'resolveRideReport';
const nextReportState = make('nextReportState',
  consts(RESOLVE, ['RESOLVE_STATUSES', 'ACTIONS', 'MAX_NOTES']),
  liftSrc(RESOLVE, 'nextReportState', 'report, input, adminEmail, nowIso'));
const NOW = '2026-08-12T09:00:00.000Z';
const openReport = { id: 'r1', status: 'open', action_taken: 'none' };

same('dismiss: closed, no action, stamped with who and when',
  nextReportState(openReport, { status: 'dismissed' }, 'admin@urbanstays.io', NOW),
  { ok: true, patch: { status: 'dismissed', action_taken: 'none', resolved_at: NOW, resolved_by: 'admin@urbanstays.io' }, was: 'none', now: 'none' });
same('dismiss always clears the action, even if one is sent',
  nextReportState({ ...openReport, action_taken: 'blocked' }, { status: 'dismissed', action_taken: 'blocked' }, 'a@x', NOW).now, 'none');
same('warn: resolved with a warning and the note kept',
  nextReportState(openReport, { status: 'resolved', action_taken: 'warning', admin_notes: '  Spoke to him.  ' }, 'a@x', NOW).patch,
  { status: 'resolved', action_taken: 'warning', admin_notes: 'Spoke to him.', resolved_at: NOW, resolved_by: 'a@x' });
same('block: reports the change so the caller can apply it',
  [nextReportState(openReport, { status: 'resolved', action_taken: 'blocked' }, 'a@x', NOW).was,
    nextReportState(openReport, { status: 'resolved', action_taken: 'blocked' }, 'a@x', NOW).now], ['none', 'blocked']);
same('reviewing: not closed, action left as it was',
  nextReportState(openReport, { status: 'reviewing' }, 'a@x', NOW),
  { ok: true, patch: { status: 'reviewing', action_taken: 'none' }, was: 'none', now: 'none' });
same('resolved with no action named keeps the earlier action',
  nextReportState({ ...openReport, status: 'reviewing', action_taken: 'warning' }, { status: 'resolved' }, 'a@x', NOW).now, 'warning');
same('an unknown status is refused', nextReportState(openReport, { status: 'open' }, 'a@x', NOW), { ok: false, code: 'INVALID_STATUS' });
same('a missing status is refused', nextReportState(openReport, {}, 'a@x', NOW), { ok: false, code: 'INVALID_STATUS' });
same('an unknown action is refused', nextReportState(openReport, { status: 'resolved', action_taken: 'ban' }, 'a@x', NOW), { ok: false, code: 'INVALID_ACTION' });
same('an action that is not text is refused', nextReportState(openReport, { status: 'resolved', action_taken: { $ne: 'none' } }, 'a@x', NOW), { ok: false, code: 'INVALID_ACTION' });
check('a note is cut at 1000 characters',
  nextReportState(openReport, { status: 'resolved', admin_notes: 'x'.repeat(3000) }, 'a@x', NOW).patch.admin_notes.length, 1000);

// Review focus 4: one block stands for as long as any report still says so.
const guestBlockAfter = make('guestBlockAfter', liftSrc(RESOLVE, 'guestBlockAfter', 'reports, thisReportId, thisAction'));
const blockedElsewhere = { id: 'r2', status: 'resolved', action_taken: 'blocked' };
check('this report blocks: blocked', guestBlockAfter([openReport], 'r1', 'blocked'), true);
check('this report cleared, nothing else blocks: not blocked', guestBlockAfter([{ ...openReport, action_taken: 'none' }], 'r1', 'none'), false);
check('this report cleared, another still blocks: stays blocked', guestBlockAfter([openReport, blockedElsewhere], 'r1', 'none'), true);
check('a dismissed report elsewhere does not keep the block', guestBlockAfter([openReport, { ...blockedElsewhere, status: 'dismissed' }], 'r1', 'none'), false);
check('this report\'s own stale row is ignored', guestBlockAfter([{ ...openReport, status: 'resolved', action_taken: 'blocked' }], 'r1', 'warning'), false);
check('no reports at all: not blocked', guestBlockAfter(undefined, 'r1', 'none'), false);

// ── Blocked accounts ───────────────────────────────────────────────────────
console.log('\n— blocked accounts —');
const isRideBlocked = make('isRideBlocked', liftSrc('checkRideAvailability', 'isRideBlocked', 'account'));
check('an account admin blocked is refused', isRideBlocked({ ride_blocked: true }), true);
check('an ordinary account is not', isRideBlocked({ ride_blocked: false }), false);
check('an account from before the flag existed is not', isRideBlocked({ email: 'ada@example.com' }), false);
// Only the boolean true blocks. A string that happens to be truthy must not.
check('the string "false" does not block', isRideBlocked({ ride_blocked: 'false' }), false);
check('a missing account row does not block', isRideBlocked(undefined), false);

// ── Reports and money ──────────────────────────────────────────────────────
// Review focus 5: pay that falls due while a report on its ride is open, and
// who filed that report.
console.log('\n— reports and money —');
identical('hasOpenGuestReport', 'sr, rideBookingId, driverId', ['autoCancelExpiredBookings', 'settleDriverEarning']);
identical('ridesUnderReviewFor', 'reports, driverId', ['getDriverWallet', 'getDriverRides']);
for (const dir of ['getDriverRides', 'getRideBookings']) {
  identical('reportWindowOpen', 'ride, nowMs', [HOME, dir]);
  check(`one reporting window: ${dir} agrees with ${HOME}`,
    constLine(dir, 'REPORT_WINDOW_AFTER_END_MS'), constLine(HOME, 'REPORT_WINDOW_AFTER_END_MS'));
}

const SWEEP = 'autoCancelExpiredBookings';
const hasOpenGuestReport = make('hasOpenGuestReport', liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId, driverId'));
const reportsOf = (rows) => ({ RideReport: fakeEntity(rows) });
// A guest's report names the driver it is about; a driver's report names nobody's pay.
const filed = (reporter_role, status, ride_booking_id = 'ride1', reported_driver_id = reporter_role === 'guest' ? 'drvA' : '') => ({
  id: 'r1', ride_booking_id, reporter_role, status, reported_driver_id,
});
check('an open complaint from the guest holds the ride', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1', 'drvA'), true);
check('so does one being reviewed', await hasOpenGuestReport(reportsOf([filed('guest', 'reviewing')]), 'ride1', 'drvA'), true);
check('a resolved one does not', await hasOpenGuestReport(reportsOf([filed('guest', 'resolved')]), 'ride1', 'drvA'), false);
check('a dismissed one does not', await hasOpenGuestReport(reportsOf([filed('guest', 'dismissed')]), 'ride1', 'drvA'), false);
check('a complaint about another ride does not', await hasOpenGuestReport(reportsOf([filed('guest', 'open', 'other')]), 'ride1', 'drvA'), false);
// The driver reporting an abusive customer must never delay the driver's own pay.
check('a report the DRIVER filed never holds the driver\'s pay', await hasOpenGuestReport(reportsOf([filed('driver', 'open')]), 'ride1', 'drvA'), false);
check('no reports at all', await hasOpenGuestReport(reportsOf([]), 'ride1', 'drvA'), false);
// Review focus 5: the complaint is about one driver, and the ride was then
// handed to another.
check('a complaint about driver A does not hold driver B\'s pay', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1', 'drvB'), false);
check('…it still holds driver A\'s', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1', 'drvA'), true);
check('an earning with no driver on it is held by nothing', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1', ''), false);

const settleDueEarning = make('settleDueEarning',
  liftSrc(SWEEP, 'isReleasable', 'earning, nowMs'), liftSrc(SWEEP, 'releaseDecision', 'earning, ride'),
  liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId, driverId'), liftSrc(SWEEP, 'keepReversed', 'sr, earningId'),
  liftSrc(SWEEP, 'settleDueEarning', 'sr, earningId, nowMs'));
const DUE = at('2026-08-10T12:00:00.000Z');
const dueEarning = { id: 'e1', ride_booking_id: 'ride1', driver_id: 'drvA', amount_ngn: 15000, status: 'held', on_hold: false, release_at: '2026-08-10T12:00:00.000Z' };
const drivenRide = { id: 'ride1', driver_id: 'drvA', status: 'completed', payment_status: 'paid' };
const worldWith = (reports, rideOverride = {}) => ({
  DriverEarning: fakeEntity([dueEarning]), RideBooking: fakeEntity([{ ...drivenRide, ...rideOverride }]), RideReport: fakeEntity(reports),
});
{
  const sr = worldWith([filed('guest', 'open')]);
  check('due pay is not released while the guest\'s complaint is open', await settleDueEarning(sr, 'e1', DUE), 'skipped');
  check('…it stays held', sr.DriverEarning.rows[0].status, 'held');
  // Admin closes the report; the very next tick pays.
  sr.RideReport.rows[0].status = 'resolved';
  check('once the report is resolved the next sweep releases it', await settleDueEarning(sr, 'e1', DUE + 300000), 'released');
}
{
  const sr = worldWith([filed('guest', 'reviewing')]);
  check('a complaint being reviewed holds the pay too', await settleDueEarning(sr, 'e1', DUE), 'skipped');
  sr.RideReport.rows[0].status = 'dismissed';
  check('a dismissed complaint lets it go', await settleDueEarning(sr, 'e1', DUE + 300000), 'released');
}
{
  // The driver reported a rude customer. Their pay arrives on time.
  const sr = worldWith([filed('driver', 'open')]);
  check('the driver\'s own report does not delay the driver\'s pay', await settleDueEarning(sr, 'e1', DUE), 'released');
}
{
  // A cancelled ride is reversed whether or not anyone complained about it.
  const sr = worldWith([filed('guest', 'open')], { status: 'cancelled' });
  check('a cancelled ride is still reversed with a complaint open', await settleDueEarning(sr, 'e1', DUE), 'reversed');
}
{
  const sr = worldWith([filed('guest', 'open', 'someone-elses-ride')]);
  check('a complaint about a different ride holds nothing here', await settleDueEarning(sr, 'e1', DUE), 'released');
}
{
  // The guest complained about the driver who was on the ride first (drvZ).
  // The ride was then handed to drvA, whose pay this is.
  const sr = worldWith([filed('guest', 'open', 'ride1', 'drvZ')]);
  check('a complaint about the driver before them does not delay the driver who took over', await settleDueEarning(sr, 'e1', DUE), 'released');
}

const ridesUnderReviewFor = make('ridesUnderReviewFor', liftSrc('getDriverWallet', 'ridesUnderReviewFor', 'reports, driverId'));
same('"under review" is shown for rides where the guest complained about this driver',
  ridesUnderReviewFor([
    filed('guest', 'open', 'ride1', 'drvA'),
    filed('guest', 'reviewing', 'ride2', 'drvA'),
    filed('guest', 'open', 'ride2', 'drvA'),
    filed('guest', 'open', 'ride3', 'drvB'),
    filed('guest', 'resolved', 'ride4', 'drvA'),
    filed('driver', 'open', 'ride5'),
    null,
  ], 'drvA'),
  ['ride1', 'ride2']);
same('…and for nobody when there are no reports', ridesUnderReviewFor(undefined, 'drvA'), []);

console.log('\n— what the ride lists say about reports —');
const driverRideView = make('driverRideView',
  liftSrc('getDriverRides', 'safeIso', 'ms'), liftSrc('getDriverRides', 'driverRideView', 'ride, bucket, win, earning, flags'));
const paidRide = { id: 'ride1', status: 'completed', payment_status: 'paid', guest_name: 'Ada Obi' };
const win = { startMs: at('2026-08-10T08:00:00.000Z'), endMs: at('2026-08-10T10:00:00.000Z') };
const heldPay = { id: 'e1', amount_ngn: 15000, status: 'held' };
const view = (flags, earning = heldPay, r = paidRide) => driverRideView(r, 'past', win, earning, flags);
check('inside the window and not yet reported: offered', view({ window_open: true, reported: false }).can_report, true);
check('already reported: not offered again', view({ window_open: true, reported: true }).can_report, false);
check('…and the card can say so', view({ window_open: true, reported: true }).already_reported, true);
check('outside the window: not offered', view({ window_open: false, reported: false }).can_report, false);
check('an unpaid ride is never reportable', view({ window_open: true, reported: false }, heldPay, { ...paidRide, payment_status: 'unpaid' }).can_report, false);
check('no flags at all: not offered, not reported', `${view(undefined).can_report}/${view(undefined).already_reported}`, 'false/false');
check('held pay on a ride under review says so', view({ under_review: true }).earning.under_review, true);
check('released pay is never "under review"', view({ under_review: true }, { ...heldPay, status: 'released' }).earning.under_review, false);

const ledgerView = make('ledgerView', liftSrc('getDriverWallet', 'ledgerView', 'earning, underReview'));
check('a held ledger row on a ride under review says so', ledgerView({ id: 'e1', status: 'held' }, true).under_review, true);
check('a held row with no report does not', ledgerView({ id: 'e1', status: 'held' }, false).under_review, false);
check('a released row never does', ledgerView({ id: 'e1', status: 'released' }, true).under_review, false);

// ── The dialog's limits are the server's ───────────────────────────────────
console.log('\n— client limits —');
same('the dialog offers exactly the categories the server accepts', rides.REPORT_CATEGORIES, make('CATEGORIES', LIMITS));
check('shortest description', rides.REPORT_LIMITS?.minDescription, make('MIN_DESCRIPTION', LIMITS));
check('longest description', rides.REPORT_LIMITS?.maxDescription, make('MAX_DESCRIPTION', LIMITS));
check('most photos', rides.REPORT_LIMITS?.maxPhotos, make('MAX_EVIDENCE', LIMITS));

// ── Photos on the admin inbox ──────────────────────────────────────────────
// Review focus 2, second line of defence: what the inbox will use as <img src>.
console.log('\n— photo sources —');
check('an uploaded photo is shown', rides.safePhotoUrl(uploaded('a.jpg')), uploaded('a.jpg'));
check('the inbox and the server use one rule for where uploads live', String(rides.UPLOAD_URL), String(make('UPLOAD_URL', LIMITS)));
const isUploadUrl = make('isUploadUrl', LIMITS, src('isUploadUrl', 'url'));
// Whatever the server would store, the inbox shows; whatever it would refuse,
// the inbox will not draw even if the row was typed into the data browser.
for (const link of [
  uploaded('a.jpg'), uploaded('IMG_8199.jpeg'), uploaded('05221f132_IMG%209029.jpeg'),
  'https://example.com/a.jpg', 'https://base44.app/files/a.jpg', `${uploaded('a.jpg')}?x=1`, `${uploaded('a.jpg')}#x`,
  uploaded('../../../entities/User'), 'https://base44.app.evil.example/api/apps/69f75159e3beeee0837b5b60/files/a.jpg',
  uploaded(`${'a'.repeat(600)}.jpg`),
]) {
  check(`server and inbox agree on ${link.slice(0, 60)}${link.length > 60 ? '…' : ''}`, !!rides.safePhotoUrl(link), isUploadUrl(link));
}
check('…and a real upload is one they both accept', isUploadUrl(uploaded('05221f132_IMG_9029.jpeg')), true);
for (const bad of [
  'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'http://example.com/a.jpg', 'data:image/png;base64,AAAA',
  '//example.com/a.jpg', ' https://example.com/a.jpg', 'https://example.com/a b.jpg',
  'https://example.com/a.jpg" onerror="x', '', null, undefined, 42, {},
]) {
  check(`${JSON.stringify(bad) ?? String(bad)} is not used as an image source`, rides.safePhotoUrl(bad), null);
}

// ---- result ----
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
