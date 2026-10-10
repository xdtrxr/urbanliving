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
// Review focus 5: pay that falls due while a report on its ride is open.
console.log('\n— reports and money —');
identical('hasOpenReport', 'sr, rideBookingId', ['autoCancelExpiredBookings', 'settleDriverEarning']);
for (const dir of ['getDriverRides', 'getRideBookings']) {
  identical('reportWindowOpen', 'ride, nowMs', [HOME, dir]);
  check(`one reporting window: ${dir} agrees with ${HOME}`,
    constLine(dir, 'REPORT_WINDOW_AFTER_END_MS'), constLine(HOME, 'REPORT_WINDOW_AFTER_END_MS'));
}

const SWEEP = 'autoCancelExpiredBookings';
const hasOpenReport = make('hasOpenReport', liftSrc(SWEEP, 'hasOpenReport', 'sr, rideBookingId'));
const reportsOf = (rows) => ({ RideReport: fakeEntity(rows) });
check('an open report holds the ride', await hasOpenReport(reportsOf([{ id: 'r1', ride_booking_id: 'ride1', status: 'open' }]), 'ride1'), true);
check('so does one being reviewed', await hasOpenReport(reportsOf([{ id: 'r1', ride_booking_id: 'ride1', status: 'reviewing' }]), 'ride1'), true);
check('a resolved report does not', await hasOpenReport(reportsOf([{ id: 'r1', ride_booking_id: 'ride1', status: 'resolved' }]), 'ride1'), false);
check('a dismissed report does not', await hasOpenReport(reportsOf([{ id: 'r1', ride_booking_id: 'ride1', status: 'dismissed' }]), 'ride1'), false);
check('a report on another ride does not', await hasOpenReport(reportsOf([{ id: 'r1', ride_booking_id: 'other', status: 'open' }]), 'ride1'), false);
check('no reports at all', await hasOpenReport(reportsOf([]), 'ride1'), false);

const settleDueEarning = make('settleDueEarning',
  liftSrc(SWEEP, 'isReleasable', 'earning, nowMs'), liftSrc(SWEEP, 'releaseDecision', 'earning, ride'),
  liftSrc(SWEEP, 'hasOpenReport', 'sr, rideBookingId'), liftSrc(SWEEP, 'settleDueEarning', 'sr, earningId, nowMs'));
const DUE = at('2026-08-10T12:00:00.000Z');
const dueEarning = { id: 'e1', ride_booking_id: 'ride1', driver_id: 'drvA', amount_ngn: 15000, status: 'held', on_hold: false, release_at: '2026-08-10T12:00:00.000Z' };
const drivenRide = { id: 'ride1', driver_id: 'drvA', status: 'completed', payment_status: 'paid' };
const worldWith = (reports, rideOverride = {}) => ({
  DriverEarning: fakeEntity([dueEarning]), RideBooking: fakeEntity([{ ...drivenRide, ...rideOverride }]), RideReport: fakeEntity(reports),
});
{
  const sr = worldWith([{ id: 'r1', ride_booking_id: 'ride1', status: 'open' }]);
  check('due pay is not released while a report is open', await settleDueEarning(sr, 'e1', DUE), 'skipped');
  check('…it stays held', sr.DriverEarning.rows[0].status, 'held');
  // Admin closes the report; the very next tick pays.
  sr.RideReport.rows[0].status = 'resolved';
  check('once the report is resolved the next sweep releases it', await settleDueEarning(sr, 'e1', DUE + 300000), 'released');
}
{
  const sr = worldWith([{ id: 'r1', ride_booking_id: 'ride1', status: 'reviewing' }]);
  check('a report being reviewed holds the pay too', await settleDueEarning(sr, 'e1', DUE), 'skipped');
  sr.RideReport.rows[0].status = 'dismissed';
  check('a dismissed report lets it go', await settleDueEarning(sr, 'e1', DUE + 300000), 'released');
}
{
  // A cancelled ride is reversed whether or not anyone complained about it.
  const sr = worldWith([{ id: 'r1', ride_booking_id: 'ride1', status: 'open' }], { status: 'cancelled' });
  check('a cancelled ride is still reversed with a report open', await settleDueEarning(sr, 'e1', DUE), 'reversed');
}
{
  const sr = worldWith([{ id: 'r1', ride_booking_id: 'someone-elses-ride', status: 'open' }]);
  check('a report on a different ride holds nothing here', await settleDueEarning(sr, 'e1', DUE), 'released');
}

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

// ---- result ----
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
