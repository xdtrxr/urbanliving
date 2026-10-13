// Booked ranges for Agent Nova — run with: node scripts/check-booked-ranges.mjs
//
// Nova is told which dates each property is taken for, so that it does not
// recommend a place somebody has already booked. Until getBookedRanges
// existed the chat page read Booking in the browser, where the read rule
// shows a guest their own rows only: Nova knew the guest's own stays and
// nobody else's, and nothing at all for a visitor with no session.
//
// This runs the shipped handler on scripts/lib/function-rig.mjs, and then the
// shipped enrichWithBookedRanges, lifted out of the chat page, against it:
// with the function answering, and with every function refused (HTTP 402),
// which is what the live site does today.
//
// The rig does not model three things this function turns on, so they are
// added below, in this file only: the Booking read rule for a read made as
// the caller, the sort and skip arguments of filter(), and auth.me() throwing
// when nobody is signed in.

import fs from 'node:fs';
import path from 'node:path';
import { createRig, loadFunction, call, ROOT } from './lib/function-rig.mjs';
import { fromResponse, fromThrown } from '../src/lib/fnResult.js';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const rig = createRig();
const handler = await loadFunction(rig, 'getBookedRanges');
check('the bundled entry.ts handed over a handler', typeof handler, 'function');

// ── The platform, where the rig stops short ─────────────────────────────────
// A read that is not made with the service role sees the reader's own bookings
// (all of them for an admin, none for a visitor), filter() honours its sort
// and skip, and auth.me() throws with no session. `reads` records every
// Booking read: 'service' and 'caller' are the function's two ways to read,
// 'browser' is the chat page reading for itself.
const reads = [];
let asCaller = 0;
let lookups = 0;
let browserDown = false;
const plain = rig.client;
const bookingsAs = (as) => ({
  async filter(query, sort, limit = 50, skip = 0) {
    reads.push({ as, query, sort, limit, skip });
    if (as === 'caller') asCaller += 1;
    if (as === 'browser' && browserDown) throw new Error('Network Error');
    let rows = await plain().asServiceRole.entities.Booking.filter(query, undefined, Number.MAX_SAFE_INTEGER);
    if (as !== 'service') rows = rows.filter((b) => rig.user && (rig.user.role === 'admin' || b.guest_email === rig.user.email));
    if (sort) {
      const key = sort.replace(/^-/, '');
      const dir = sort.startsWith('-') ? -1 : 1;
      rows.sort((a, b) => dir * String(a[key]).localeCompare(String(b[key])));
    }
    return rows.slice(skip, skip + limit);
  },
});
rig.client = () => ({
  auth: {
    me: async () => {
      lookups += 1;
      if (!rig.user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      return rig.user;
    },
  },
  entities: { Booking: bookingsAs('caller') },
  asServiceRole: { entities: { Booking: bookingsAs('service') } },
});
const browser = { entities: { Booking: bookingsAs('browser') } };
const RULE = fs.readFileSync(path.join(ROOT, 'base44/entities/Booking.jsonc'), 'utf8').replace(/\s+/g, '');
check('the read rule applied here is the one Booking.jsonc declares: your own rows, or an admin',
  RULE.includes('"read":{"$or":[{"data.guest_email":"{{user.email}}"},{"user_condition":{"role":"admin"}}]}'), true);

// 00:30 on 13 October in Lagos. The server's own clock (UTC) still says the 12th.
Date.now = () => Date.parse('2026-10-12T23:30:00Z');
const day = (n) => new Date(Date.UTC(2026, 9, 13) + n * 86400000).toISOString().slice(0, 10);

// ── Fixtures ────────────────────────────────────────────────────────────────
const ada = { id: 'ada', email: 'ada@example.com', full_name: 'Ada Obi', role: 'user' };
const bola = { id: 'bola', email: 'bola@example.com', full_name: 'Bola Ade', role: 'user' };
const FLAT = 'lekki-flat-0001';
const VILLA = 'ikoyi-villa-0002';
const FREE = 'abuja-loft-0003';
const ODD = 'wuse-studio-0004';
const BUSY = 'maitama-duplex-0005';
const FULL = 'jabi-suite-0006';
// Every row carries what a real one does, so a leak has something to leak.
const stay = (id, guest, property_id, check_in, check_out, fields = {}) => ({
  id, property_id, guest_name: guest.full_name, guest_email: guest.email, check_in, check_out, guests: 2,
  total_price: 1198000, status: 'confirmed', payment_status: 'paid', special_requests: 'Gate code 4471',
  transaction_hash: 'T9900112233', id_document_url: 'https://files.example/id-card.jpg', host_phone_override: '+2348012345678',
  ...fields,
});
rig.db.Booking = [
  stay('bk-bola', bola, FLAT, '2026-12-13', '2026-12-17'),
  stay('bk-ada', ada, FLAT, '2026-11-02', '2026-11-04', { status: 'pending', payment_status: 'unpaid' }),
  stay('bk-cancelled', bola, FLAT, '2026-11-10', '2026-11-12', { status: 'cancelled' }),
  stay('bk-completed', bola, FLAT, '2026-11-20', '2026-11-22', { status: 'completed' }),
  stay('bk-september', bola, FLAT, '2026-09-01', '2026-09-05'),
  stay('bk-left-yesterday', bola, FLAT, '2026-10-09', '2026-10-12'),
  stay('bk-leaves-today', bola, FLAT, '2026-10-10', '2026-10-13'),
  stay('bk-villa', bola, VILLA, '2026-12-24', '2026-12-27'),
  stay('bk-date-time', bola, ODD, '2026-12-01T00:00:00.000Z', '2026-12-03T00:00:00.000Z'),
  stay('bk-no-dates', bola, ODD, 'soon', 'later'),
];
const ask = (property_ids, user = ada, method = 'POST') => call(rig, handler, { property_ids }, user, method);
const rangesOf = (r, id) => (r.data && r.data.ranges && r.data.ranges[id]) || null;
const has = (list, check_in) => (list || []).some((x) => x.check_in === check_in);
const BOTH = { property_id: { $in: [FLAT] }, status: { $in: ['confirmed', 'pending'] } };

// ── Every guest's bookings, not only the caller's ───────────────────────────
console.log('\n— what Ada is told about a flat Bola has booked —');
let r = await ask([FLAT, VILLA, FREE]);
const asAda = r;
const firstReads = reads.splice(0);
const flat = rangesOf(r, FLAT);
check('accepted', r.status, 200);
check('another guest\'s confirmed booking is returned', has(flat, '2026-12-13'), true);
check('a cancelled booking is not', has(flat, '2026-11-10'), false);
check('nor one marked completed', has(flat, '2026-11-20'), false);
check('nor a stay that ended last month', has(flat, '2026-09-01'), false);
check('a stay that checks out today still counts', has(flat, '2026-10-10'), true);
check('one that checked out yesterday does not: it is the 13th in Lagos, whatever the server\'s clock says', has(flat, '2026-10-09'), false);
check('the whole list: pending and confirmed, soonest first', flat, [
  { check_in: '2026-10-10', check_out: '2026-10-13', status: 'confirmed' },
  { check_in: '2026-11-02', check_out: '2026-11-04', status: 'pending' },
  { check_in: '2026-12-13', check_out: '2026-12-17', status: 'confirmed' },
]);
check('each property has its own list', rangesOf(r, VILLA), [{ check_in: '2026-12-24', check_out: '2026-12-27', status: 'confirmed' }]);
check('a property with no bookings gets an empty list', rangesOf(r, FREE), []);
check('one list for every property asked about, and no other', Object.keys(r.data.ranges).sort(), [FLAT, VILLA, FREE].sort());
check('it took one read: with the service role, latest-ending first, with the page size named',
  firstReads.map((c) => [c.as, c.sort, c.limit, c.skip]), [['service', '-check_out', 500, 0]]);
check('and it asked for those properties\' pending and confirmed bookings, not for every row',
  firstReads.map((c) => c.query), [{ property_id: { $in: [FLAT, VILLA, FREE] }, status: { $in: ['confirmed', 'pending'] } }]);
rig.user = ada;
check('the same question asked from Ada\'s browser finds her own booking and nothing of Bola\'s',
  (await browser.entities.Booking.filter(BOTH)).map((b) => b.id), ['bk-ada']);

// ── What leaves ─────────────────────────────────────────────────────────────
// call() hands back the parsed data only, so this one request goes to the
// handler directly and the whole body is read as text.
console.log('\n— what leaves —');
const res = await handler(new Request('http://check.local/function', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ property_ids: [FLAT, VILLA, ODD] }),
}));
const text = await res.text();
const whole = JSON.parse(text);
check('the answer is success and data.ranges, with nothing beside them', [Object.keys(whole), Object.keys(whole.data)], [['success', 'data'], ['ranges']]);
check('a range has three fields: check_in, check_out, status',
  [...new Set(Object.values(whole.data.ranges).flat().flatMap((x) => Object.keys(x)))].sort(), ['check_in', 'check_out', 'status']);
check('no guest name, email, booking id, price, payment, note, reference, document or phone number is anywhere in it',
  ['Bola', 'Ada', 'example.com', 'bk-', '1198000', 'paid', 'Gate code', 'T9900112233', 'id-card', '+234', 'guest'].filter((s) => text.includes(s)), []);
check('a date-time is answered as its day, and a row with no real dates is left out',
  whole.data.ranges[ODD], [{ check_in: '2026-12-01', check_out: '2026-12-03', status: 'confirmed' }]);

// ── Signed out ──────────────────────────────────────────────────────────────
// The concierge is a public page: Nova recommends to visitors with no session.
console.log('\n— a visitor who is not signed in —');
r = await ask([FLAT, VILLA, FREE], null);
check('is answered, and told exactly what a guest is told', [r.status, r.data], [200, asAda.data]);
check('read from that visitor\'s browser, Booking shows nothing at all', (await browser.entities.Booking.filter(BOTH)).length, 0);

// ── Refusals ────────────────────────────────────────────────────────────────
console.log('\n— requests that are refused —');
reads.length = 0;
const many = (n) => Array.from({ length: n }, (_, i) => `property-${String(i).padStart(4, '0')}`);
r = await ask(many(51));
check('51 properties at once is refused, with a sentence', [r.status, r.code, r.error], [400, 'TOO_MANY_PROPERTIES', 'Ask about at most 50 properties at a time.']);
const LIST = 'property_ids must be a list of property ids.';
const bad = async (name, body) => { const a = await call(rig, handler, body, ada); check(name, [a.status, a.error], [400, LIST]); };
await bad('no list', {});
await bad('a body that is not an object', null);
await bad('one id that is not in a list', { property_ids: FLAT });
for (const junk of [42, null, '', 'two words', '../User/abc', { $ne: '' }, [FLAT]]) {
  await bad(`a list holding ${JSON.stringify(junk)}`, { property_ids: [FLAT, junk] });
}
check('none of them read a booking', reads.length, 0);
r = await ask([]);
check('an empty list is answered with nothing, and reads nothing', [r.status, r.data, reads.length], [200, { ranges: {} }, 0]);
r = await ask(many(50));
check('50 properties is answered: an empty list for each', [r.status, Object.keys(r.data.ranges).length, Object.values(r.data.ranges).flat().length], [200, 50, 0]);
r = await ask([FLAT, FLAT, VILLA]);
check('a property named twice is answered once', [r.status, Object.keys(r.data.ranges).sort(), rangesOf(r, FLAT).length], [200, [FLAT, VILLA].sort(), 3]);
r = await ask(['__proto__', 'constructor', FLAT]);
check('an id is only ever a key: "__proto__" gets its empty list like any other',
  [r.status, Object.keys(r.data.ranges).sort(), rangesOf(r, FLAT).length], [200, ['__proto__', 'constructor', FLAT].sort(), 3]);
r = await ask([FLAT], ada, 'OPTIONS');
check('the CORS preflight is answered', r.status, 204);
r = await ask([FLAT], ada, 'GET');
check('anything but a POST is refused', r.status, 405);

// ── A busy property ─────────────────────────────────────────────────────────
// A paid stay is still "confirmed" after the guest has left, so a listing's
// history only grows, and filter() gives 50 rows unless it is told otherwise.
console.log('\n— a busy property —');
for (let i = 1; i <= 550; i += 1) rig.db.Booking.push(stay(`bk-old-${i}`, bola, BUSY, day(-2 * i - 1), day(-2 * i)));
rig.db.Booking.push(stay('bk-next', ada, BUSY, day(30), day(33)), stay('bk-after', bola, BUSY, day(40), day(42), { status: 'pending', payment_status: 'unpaid' }));
reads.length = 0;
r = await ask([BUSY]);
check('550 stays that are over do not crowd out the two still to come', rangesOf(r, BUSY), [
  { check_in: day(30), check_out: day(33), status: 'confirmed' },
  { check_in: day(40), check_out: day(42), status: 'pending' },
]);
check('and one page is enough: it already reaches the stays that are over', reads.map((c) => [c.sort, c.limit, c.skip]), [['-check_out', 500, 0]]);
for (let i = 1; i <= 520; i += 1) rig.db.Booking.push(stay(`bk-full-${i}`, bola, FULL, day(i), day(i + 1)));
reads.length = 0;
r = await ask([FULL]);
const full = rangesOf(r, FULL) || [];
check('520 bookings still to come are all answered, past the first page of 500',
  [full.length, full[0], full[519]], [520, { check_in: day(1), check_out: day(2), status: 'confirmed' }, { check_in: day(520), check_out: day(521), status: 'confirmed' }]);
check('read a page at a time', reads.map((c) => [c.sort, c.limit, c.skip]), [['-check_out', 500, 0], ['-check_out', 500, 500]]);

// ── Lockstep copy ───────────────────────────────────────────────────────────
console.log('\n— lockstep copy —');
const isIdIn = (name) => (fs.readFileSync(path.join(ROOT, 'base44/functions', name, 'entry.ts'), 'utf8').match(/\nfunction isId\([\s\S]*?\n\}/) || [''])[0];
check('isId matches the copy in processWithdrawal', [isIdIn('getBookedRanges') !== '', isIdIn('getBookedRanges') === isIdIn('processWithdrawal')], [true, true]);

// ── The chat page ───────────────────────────────────────────────────────────
// enrichWithBookedRanges as it ships, lifted out of the page (developer
// script only; the input is this repo's own source). Its invokeFn is built as
// src/lib/invokeFn.js builds it, with the SDK call pointed at the handler:
// like axios, a 2xx resolves and anything else throws. `blocked` is the live
// site today, where the platform refuses every function.
console.log('\n— the chat page —');
const lifted = fs.readFileSync(path.join(ROOT, 'src/pages/AIChatConcierge.jsx'), 'utf8').match(/const enrichWithBookedRanges = async \(props\) => \{[\s\S]*?\n {2}\};/);
if (!lifted) throw new Error('could not find enrichWithBookedRanges in src/pages/AIChatConcierge.jsx');
let blocked = false;
const invoked = [];
const invoke = async (name, body) => {
  invoked.push(name);
  if (blocked) {
    throw Object.assign(new Error('Request failed with status code 402'), { response: { status: 402, data: { message: 'Functions are blocked - app owner lacks backend functions capability' } } });
  }
  const a = await call(rig, handler, body, rig.user);
  if (a.status === 200) return { status: 200, data: { success: true, data: a.data } };
  throw Object.assign(new Error(`Request failed with status code ${a.status}`), { response: { status: a.status, data: { success: false, error: a.error, code: a.code } } });
};
const invokeFn = async (name, body = {}) => {
  try { return fromResponse(await invoke(name, body)); } catch (err) { return fromThrown(err); }
};
const quiet = { log() {}, warn() {}, error() {} };
const enrich = new Function('invokeFn', 'base44', 'console', `${lifted[0]}\nreturn enrichWithBookedRanges;`)(invokeFn, browser, quiet);
const listing = [{ id: FLAT, title: 'Lekki flat', price_per_night: 80000 }, { id: FREE, title: 'Abuja loft', price_per_night: 60000 }];
const checkIns = (props) => props.map((p) => p.booked_ranges.map((x) => x.check_in));
const everyone = [['2026-10-10', '2026-11-02', '2026-12-13'], []];
const adasOwn = [[{ check_in: '2026-11-02', check_out: '2026-11-04', status: 'pending' }], []];

rig.user = ada;
let out = await enrich(listing);
check('it asks getBookedRanges', invoked, ['getBookedRanges']);
check('Nova is given every guest\'s bookings on each property', checkIns(out), everyone);
check('in the shape its prompt already reads: the property, plus booked_ranges',
  out.map((p) => Object.keys(p)), [['id', 'title', 'price_per_night', 'booked_ranges'], ['id', 'title', 'price_per_night', 'booked_ranges']]);
rig.user = null;
check('a visitor who is not signed in gets the same', checkIns(await enrich(listing)), everyone);

rig.user = ada;
blocked = true;
out = await enrich(listing);
check('with every function refused (HTTP 402, the live site today) the chat falls back to the browser read: her own booking, as before',
  out.map((p) => p.booked_ranges), adasOwn);
browserDown = true;
out = await enrich(listing);
check('and if that read fails too, Nova still gets its properties, with no ranges', out.map((p) => [p.id, p.booked_ranges]), [[FLAT, []], [FREE, []]]);
browserDown = false;
blocked = false;
out = await enrich([...listing, ...many(49).map((id) => ({ id }))]);
check('a refusal from the function (51 properties here) falls back the same way', out.slice(0, 2).map((p) => p.booked_ranges), adasOwn);
invoked.length = 0;
out = await enrich([{ id: 'mcp-7', title: 'Not a stored listing' }]);
check('a list with no stored property asks nothing', [invoked.length, out.map((p) => p.booked_ranges)], [0, [[]]]);

check('in all of the above the function never read a booking as the caller, and never asked who was calling', [asCaller, lookups], [0, 0]);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
