# Ride Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a driver report a rude or abusive customer, and a guest report a driver, on any paid ride; put every report in front of admin with a Telegram ping; let admin dismiss, warn or block; and keep a ride's driver pay held while a report on it is open.

**Architecture:** A `RideReport` entity that only two functions write: `createRideReport` (checks the caller is a party to the ride and inside the reporting window) and `resolveRideReport` (admin). A block sets `User.ride_blocked`, which `checkRideAvailability` refuses, or deactivates the driver. The sweep and admin's Release now both skip an earning whose ride has an open report. One shared dialog serves the driver's ride card and the guest's driver card; a fourth inner tab on the admin Rides screen is the inbox.

**Tech Stack:** Base44 Deno functions and entity schemas, React 18 + Vite + Tailwind + shadcn/ui, the `UploadFile` integration for photos, Telegram and web push (all existing). Checks: eslint, node scripts that execute the shipped helpers off disk, esbuild parse, vite build.

**Spec:** `docs/superpowers/specs/2026-10-07-driver-wallet-and-reports-design.md` (sections 5, 6 and 8).

**Prerequisite:** every task of `docs/superpowers/plans/2026-10-10-driver-wallet.md` up to A14. This plan edits files that plan creates.

## Global Constraints

- Reporting window: from the ride's `start_at` until `end_at` plus 7 days (`REPORT_WINDOW_AFTER_END_MS`), paid rides with a driver assigned, one report per reporter per ride.
- Categories: `rude | abusive | threatening | unsafe | no_show | damage | other`. Description 10 to 2000 characters. At most 3 photos, each an `https://` URL.
- `RideReport` is admin-only at the API for all four operations: rows carry admin notes. Reporters learn the state of their report through the ride lists.
- Blocking is always an admin decision through `resolveRideReport`. Nothing blocks automatically.
- The Telegram card for a new report is sent as plain text, never Markdown: the description is free text and Telegram drops a message it cannot parse.
- Photos are rendered as `<img>` only, never as HTML, and only when the URL starts with `https://`.
- Every instant is pinned to WAT (`+01:00`); helpers shared between functions are lockstep copies that the check scripts compare character for character. Helpers follow the same convention as the wallet plan: a top-level `function` (or `async function`) whose first line is the whole signature, closing `}` alone in column 0, plain JavaScript body.
- Function answers use `{ success: true, data }` or `{ success: false, error, code }` with an HTTP status. The browser calls functions through `invokeFn` (`src/lib/invokeFn.js`), which returns the server's sentence on a refusal.
- Dark mode: every `bg-*`, `text-*`, `border-*` on a surface has a `dark:` twin; primary buttons invert. Never `{n && n > 0 && ...}`.
- No new npm dependencies. One commit per task, prefix `feat(rides):`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to read the steps

As in the wallet plan: **Create `path`:**, **Replace `path` with:** and **Edit `path`** — find: … replace with: … each followed by exact content; a find-block occurs exactly once in its file. Functions are parsed with `node_modules/.bin/esbuild <file> --format=esm --target=esnext --outfile=/dev/null`; a local build needs `set -a; . ./.env; set +a; npm run build`.

## Review Focus

Five things the spec implies, that a person will hit, and that are easy to get wrong. Each has a pinned check in the task that owns the code.

1. **A description full of `*`, `_`, backticks and brackets, or 2,000 characters long.** Admin must still get the Telegram card. Pinned in Task B02 (`reportCardText` cases: no Markdown is emitted, the text is cut at 300 characters).
2. **A "photo" that is `javascript:alert(1)`, an `http://` link, or a URL with a space or a quote in it.** Refused before anything is stored. Pinned in Task B02 (`validateReportInput` cases) and Task B07 (the admin tab only renders `https://` sources).
3. **A report filed at the first or last moment of the window.** Allowed at the ride's start and at exactly seven days after its end, refused one millisecond either side, in WAT. Pinned in Task B02 (`reportWindowOpen` cases with exact UTC instants).
4. **A guest with two reports against them, one resolved as blocked, when admin clears the other.** They stay blocked. Pinned in Task B03 (`guestBlockAfter` cases).
5. **Pay that falls due while a report on its ride is open, and after the report is closed.** Not released while open; released on the next sweep once closed. Pinned in Task B05 (`settleDueEarning` cases with an open, a reviewing and a resolved report).

---

### Task B01: The report table and the block flag

**Files:**
- Modify: `scripts/check-entities.mjs` (ride reports section, above `// ── Rules staged for the next publish`)
- Create: `base44/entities/RideReport.jsonc`
- Modify: `base44/entities/User.jsonc` (after `referral_prompt_seen`)
- Modify: `docs/entity-rules-pending-publish/User.jsonc` (the same field, so the staged copy does not drop it)

**Interfaces:**
- Consumes: `scripts/check-entities.mjs` and its helpers `check`, `prop`, `adminOnly`, `sameList`, `OPS`, `entities` (wallet plan, Tasks A01 and A09).
- Produces: entity `RideReport` with fields `ride_booking_id, booking_reference, vehicle_name, service_date, reporter_email, reporter_role ('driver'|'guest'), reporter_name, reported_email, reported_driver_id, reported_name, category, description, evidence_urls (string[]), status ('open'|'reviewing'|'resolved'|'dismissed', default 'open'), action_taken ('none'|'warning'|'blocked', default 'none'), admin_notes, resolved_at, resolved_by`; `User.ride_blocked` (boolean, default false, admin-write only).

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-entities.mjs`** — find:

```js
// ── Rules staged for the next publish ──────────────────────────────────────
```

replace with:

```js
// ── Ride reports ───────────────────────────────────────────────────────────
console.log('\n— ride reports —');
check('RideReport exists', !!entities.RideReport);
for (const f of [
  'ride_booking_id', 'booking_reference', 'vehicle_name', 'service_date', 'reporter_email', 'reporter_role',
  'reporter_name', 'reported_email', 'reported_driver_id', 'reported_name', 'category', 'description',
  'evidence_urls', 'status', 'action_taken', 'admin_notes', 'resolved_at', 'resolved_by',
]) {
  check(`RideReport.${f}`, !!prop('RideReport', f));
}
check('RideReport.reporter_role is driver | guest', sameList(prop('RideReport', 'reporter_role')?.enum, ['driver', 'guest']));
check('RideReport.category has the seven categories',
  sameList(prop('RideReport', 'category')?.enum, ['rude', 'abusive', 'threatening', 'unsafe', 'no_show', 'damage', 'other']));
check('RideReport.status is open | reviewing | resolved | dismissed',
  sameList(prop('RideReport', 'status')?.enum, ['open', 'reviewing', 'resolved', 'dismissed']));
check('RideReport.status defaults to open', prop('RideReport', 'status')?.default === 'open');
check('RideReport.action_taken is none | warning | blocked',
  sameList(prop('RideReport', 'action_taken')?.enum, ['none', 'warning', 'blocked']));
check('RideReport.evidence_urls is a string array',
  prop('RideReport', 'evidence_urls')?.type === 'array' && prop('RideReport', 'evidence_urls')?.items?.type === 'string');
// Rows carry admin notes about real people. Not even the reporter reads them
// through the API; the ride lists tell them what they need to know.
for (const op of OPS) {
  check(`RideReport ${op} is admin-only`, adminOnly(entities.RideReport?.rls?.[op]));
}
check('User.ride_blocked is a boolean, off by default',
  prop('User', 'ride_blocked')?.type === 'boolean' && prop('User', 'ride_blocked')?.default === false);
// A guest must not be able to unblock themselves with auth.updateMe.
check('User.ride_blocked is admin-write', adminOnly(prop('User', 'ride_blocked')?.rls?.write));

// ── Rules staged for the next publish ──────────────────────────────────────
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-entities.mjs`

Expected: ` FAIL  RideReport exists` and the lines after it, ending `FAIL — … passed, … failed`.

- [ ] **Step 3: Create the entity**

**Create `base44/entities/RideReport.jsonc`:**

```json
{
  "name": "RideReport",
  "type": "object",
  "description": "A complaint about a ride, filed by one party about the other: a driver about a rude, abusive or absent guest, or a guest about a driver. Written only by createRideReport, which checks the reporter is a party to the ride and inside the reporting window (ride start until 7 days after its end), and by resolveRideReport (admin). While a report on a ride is open or being reviewed, the driver's pay for that ride stays held. Admin-only in every direction because rows carry admin's notes about real people; reporters learn the state of their report through the ride lists.",
  "properties": {
    "ride_booking_id": {
      "type": "string",
      "description": "FK to RideBooking."
    },
    "booking_reference": {
      "type": "string",
      "description": "Snapshot of RideBooking.booking_reference so the inbox reads without a join."
    },
    "vehicle_name": {
      "type": "string",
      "description": "Snapshot of RideBooking.vehicle_name."
    },
    "service_date": {
      "type": "string",
      "format": "date",
      "description": "Snapshot of RideBooking.service_date."
    },
    "reporter_email": {
      "type": "string",
      "description": "Login of the person who filed the report. Taken from the session, never from the request."
    },
    "reporter_role": {
      "type": "string",
      "enum": [
        "driver",
        "guest"
      ],
      "description": "Which side of the ride the reporter was on, decided by the server."
    },
    "reporter_name": {
      "type": "string",
      "description": "Display name of the reporter at the time."
    },
    "reported_email": {
      "type": "string",
      "description": "The guest's login, set when a driver reports a guest. Empty for a report about a driver."
    },
    "reported_driver_id": {
      "type": "string",
      "description": "FK to Driver, set when a guest reports a driver. Empty for a report about a guest."
    },
    "reported_name": {
      "type": "string",
      "description": "Display name of the person reported, at the time."
    },
    "category": {
      "type": "string",
      "enum": [
        "rude",
        "abusive",
        "threatening",
        "unsafe",
        "no_show",
        "damage",
        "other"
      ]
    },
    "description": {
      "type": "string",
      "description": "What happened, in the reporter's words. 10 to 2000 characters."
    },
    "evidence_urls": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Up to three uploaded photos. Each is an https URL; the admin tab renders them as images only."
    },
    "status": {
      "type": "string",
      "enum": [
        "open",
        "reviewing",
        "resolved",
        "dismissed"
      ],
      "default": "open",
      "description": "open and reviewing keep the ride's driver pay held. resolved and dismissed let it release."
    },
    "action_taken": {
      "type": "string",
      "enum": [
        "none",
        "warning",
        "blocked"
      ],
      "default": "none",
      "description": "What admin decided. blocked sets User.ride_blocked for a reported guest, or deactivates a reported driver."
    },
    "admin_notes": {
      "type": "string",
      "description": "Internal. Never shown to either party."
    },
    "resolved_at": {
      "type": "string",
      "format": "date-time"
    },
    "resolved_by": {
      "type": "string",
      "description": "Login of the admin who resolved or dismissed it."
    }
  },
  "required": [
    "ride_booking_id",
    "reporter_email",
    "reporter_role",
    "category",
    "description",
    "status"
  ],
  "rls": {
    "create": {
      "user_condition": {
        "role": "admin"
      }
    },
    "read": {
      "user_condition": {
        "role": "admin"
      }
    },
    "update": {
      "user_condition": {
        "role": "admin"
      }
    },
    "delete": {
      "user_condition": {
        "role": "admin"
      }
    }
  }
}
```

- [ ] **Step 4: Add the block flag, in the live schema and in its staged copy**

The staged `User.jsonc` is copied over the live one on publish day. If it did not carry this field, that copy would delete it; `check-entities` now fails when the two list different fields.

**Edit `base44/entities/User.jsonc`** — find:

```json
    "referral_prompt_seen": {
      "type": "boolean",
      "default": false,
      "description": "Has the user already been prompted to enter a referral code"
    },
```

replace with:

```json
    "referral_prompt_seen": {
      "type": "boolean",
      "default": false,
      "description": "Has the user already been prompted to enter a referral code"
    },
    "ride_blocked": {
      "type": "boolean",
      "default": false,
      "description": "Set by admin through resolveRideReport when a report against this guest ends in a block. checkRideAvailability refuses a ride request from a blocked account. Admin-write only: a guest must not be able to unblock themselves.",
      "rls": {
        "write": {
          "user_condition": {
            "role": "admin"
          }
        }
      }
    },
```

**Edit `docs/entity-rules-pending-publish/User.jsonc`** — find:

```json
    "referral_prompt_seen": {
      "type": "boolean",
      "default": false,
      "description": "Has the user already been prompted to enter a referral code"
    },
```

replace with:

```json
    "referral_prompt_seen": {
      "type": "boolean",
      "default": false,
      "description": "Has the user already been prompted to enter a referral code"
    },
    "ride_blocked": {
      "type": "boolean",
      "default": false,
      "description": "Set by admin through resolveRideReport when a report against this guest ends in a block. checkRideAvailability refuses a ride request from a blocked account. Admin-write only: a guest must not be able to unblock themselves.",
      "rls": {
        "write": {
          "user_condition": {
            "role": "admin"
          }
        }
      }
    },
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npm run check`

Expected: four `PASS` lines. `check-entities` shows every line under `— ride reports —` as `ok`, and `staged User.jsonc lists exactly the live fields`.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-entities.mjs base44/entities/RideReport.jsonc base44/entities/User.jsonc docs/entity-rules-pending-publish/User.jsonc
git commit -m "feat(rides): ride report table and the ride block flag" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task B02: `createRideReport`

**Files:**
- Create: `scripts/check-ride-reports.mjs`
- Create: `base44/functions/createRideReport/entry.ts`
- Modify: `package.json` (the `check` script)

**Interfaces:**
- Consumes: entity `RideReport` (Task B01); `rideDurationMs`, `windowOf` (lockstep copies of `getRideBookings`); `findDriverForUser(sr, email)` (lockstep copy of `getDriverProfile`); `notifyAdminLine(text)` (lockstep copy of `autoCancelExpiredBookings`).
- Produces: function `createRideReport` — any signed-in user; body `{ ride_booking_id, category, description, evidence_urls? }`; answers `{ success: true, data: { report_id, reporter_role } }`. Refusals: `INVALID_CATEGORY`, `DESCRIPTION_LENGTH`, `BAD_URL`, `TOO_MANY_FILES` (400), `NOT_PARTY` (403), `NOT_FOUND` (404), `NOT_PAID`, `NO_DRIVER`, `OUTSIDE_WINDOW`, `ALREADY_REPORTED` (409).
- Produces, in `createRideReport/entry.ts`, helpers later tasks copy or call: `const REPORT_WINDOW_AFTER_END_MS`, `reportWindowOpen(ride, nowMs) → boolean`, `reporterRoleFor(ride, userEmail, driver) → 'guest' | 'driver' | null`, `validateReportInput(body) → { ok: true, value: { category, description, evidence_urls } } | { ok: false, code, error }`, `reportCardText(report) → string`.
- Produces: `scripts/check-ride-reports.mjs` with its own small harness (`check`, `same`, `liftSrc`, `make`, `identical`, `constLine`, `fakeEntity`, `FETCH_ALL`) and the marker line `// ---- result ----`; `npm run check` runs it.

- [ ] **Step 1: Write the failing check**

**Create `scripts/check-ride-reports.mjs`:**

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-ride-reports.mjs`

Expected: `Error: ENOENT: no such file or directory, open '…/base44/functions/createRideReport/entry.ts'`.

- [ ] **Step 3: Create the function**

**Create `base44/functions/createRideReport/entry.ts`:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// createRideReport
// ----------------------------------------------------------------------------
// One party to a ride tells admin about a problem with the other: a driver
// about a rude, abusive or absent guest, or a guest about a driver.
//
// What makes a report trustworthy enough to act on is decided here, not in
// the browser:
//   - WHO   the reporter is taken from the session and must be the guest who
//           booked the ride or the driver assigned to it
//   - WHEN  from the ride's start until seven days after its end
//   - ONCE  one report per reporter per ride
//   - WHAT  a category from a fixed list, 10 to 2000 characters of text, and
//           at most three https photo links
//
// While a report is open the driver's pay for that ride stays held (the sweep
// and settleDriverEarning both check). Nothing is done to either party until
// admin decides, in resolveRideReport.

// ── Ride time model — lockstep copy, see checkRideAvailability ──────────────
const WAT_OFFSET = '+01:00';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const MAX_HOURLY = 8;

function rideDurationMs(tier: string, days?: number, hours?: number): number {
    switch (tier) {
        case 'hourly': return Math.min(MAX_HOURLY, Math.max(1, Number(hours) || 1)) * HOUR_MS;
        case '12hr': return 12 * HOUR_MS;
        case '24hr': return DAY_MS;
        case 'multi_day': return Math.max(1, Number(days) || 1) * DAY_MS;
        case 'weekly': return 7 * DAY_MS;
        case 'monthly': return 30 * DAY_MS;
        default: return NaN;
    }
}

// Prefer the stored instants. Fall back to deriving them for any row written
// before start_at existed.
function windowOf(r: any): { startMs: number; endMs: number } | null {
    let startMs = Date.parse(r.start_at || '');
    if (Number.isNaN(startMs)) startMs = Date.parse(`${r.service_date}T${r.start_time}:00${WAT_OFFSET}`);
    if (Number.isNaN(startMs)) return null;
    let endMs = Date.parse(r.end_at || '');
    if (Number.isNaN(endMs)) {
        const dur = rideDurationMs(r.duration_tier, r.duration_days, r.duration_hours);
        if (Number.isNaN(dur)) return null;
        endMs = startMs + dur;
    }
    return { startMs, endMs };
}

// ── What a report is ────────────────────────────────────────────────────────
const REPORT_WINDOW_AFTER_END_MS = 7 * DAY_MS;
const CATEGORIES = ['rude', 'abusive', 'threatening', 'unsafe', 'no_show', 'damage', 'other'];
const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 2000;
const MAX_EVIDENCE = 3;
const MAX_URL_LENGTH = 600;
const CARD_EXCERPT = 300;

// A ride can be reported from the moment it starts until seven days after it
// ends. Before the start there is nothing to report; long afterwards nobody
// can check what happened. Lockstep copies in getDriverRides and
// getRideBookings decide whether the Report button is shown.
function reportWindowOpen(ride: any, nowMs: number) {
    const w = windowOf(ride);
    if (!w || !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) return false;
    return w.startMs <= nowMs && nowMs <= w.endMs + REPORT_WINDOW_AFTER_END_MS;
}

// Which side of the ride this login was on, or null for neither. The guest is
// matched on the booking's email; the driver on the Driver row their login is
// linked to. Someone who is both reports as the guest.
function reporterRoleFor(ride: any, userEmail: string, driver: any) {
    const me = String(userEmail || '').trim().toLowerCase();
    if (!ride || !me) return null;
    if (String(ride.guest_email || '').trim().toLowerCase() === me) return 'guest';
    if (driver && driver.id && ride.driver_id && ride.driver_id === driver.id) return 'driver';
    return null;
}

// The reporter's input, checked. Photos must be plain https links with no
// spaces, quotes or angle brackets: they are later used as <img src>, and a
// "photo" of javascript:… or a URL that closes an attribute must never be
// stored in the first place.
function validateReportInput(body: any) {
    const category = body && body.category;
    if (typeof category !== 'string' || !CATEGORIES.includes(category)) {
        return { ok: false, code: 'INVALID_CATEGORY', error: 'Choose what kind of problem this was.' };
    }
    const description = typeof (body && body.description) === 'string' ? body.description.trim() : '';
    if (description.length < MIN_DESCRIPTION || description.length > MAX_DESCRIPTION) {
        return {
            ok: false,
            code: 'DESCRIPTION_LENGTH',
            error: `Describe what happened in ${MIN_DESCRIPTION} to ${MAX_DESCRIPTION} characters.`,
        };
    }
    const raw = body && body.evidence_urls;
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
        return { ok: false, code: 'BAD_URL', error: 'The photos could not be read. Remove them and try again.' };
    }
    const urls = [];
    for (const item of raw || []) {
        if (typeof item !== 'string' || item.length > MAX_URL_LENGTH || !/^https:\/\/[^\s"'<>]+$/.test(item)) {
            return { ok: false, code: 'BAD_URL', error: 'One of the photos is not a valid upload. Remove it and try again.' };
        }
        if (!urls.includes(item)) urls.push(item);
    }
    if (urls.length > MAX_EVIDENCE) {
        return { ok: false, code: 'TOO_MANY_FILES', error: `Attach at most ${MAX_EVIDENCE} photos.` };
    }
    return { ok: true, value: { category, description, evidence_urls: urls } };
}

// The card admin gets on Telegram. Plain text on purpose: the description is
// whatever the reporter typed, and an unbalanced * or _ makes Telegram reject
// a Markdown message outright, which would lose the alert.
function reportCardText(report: any) {
    const text = String(report.description || '');
    const excerpt = text.length > CARD_EXCERPT ? `${text.slice(0, CARD_EXCERPT)}…` : text;
    const lines = [
        '🚩 RIDE REPORT',
        '',
        report.reporter_role === 'driver' ? 'A driver reported a guest' : 'A guest reported a driver',
        `Ride: ${report.booking_reference || report.ride_booking_id}${report.vehicle_name ? ` · ${report.vehicle_name}` : ''}`,
        `From: ${report.reporter_name || report.reporter_email}`,
        `About: ${report.reported_name || report.reported_email || 'the driver'}`,
        `Category: ${report.category}`,
        '',
        excerpt,
    ];
    const photos = (report.evidence_urls || []).length;
    if (photos > 0) lines.push('', `Photos attached: ${photos}`);
    lines.push('', 'Review it in Admin → Rides → Reports.');
    return lines.join('\n');
}

// The Driver row this login belongs to, or null. Lockstep copy, see
// getDriverProfile.
async function findDriverForUser(sr: any, email: string) {
    const raw = String(email || '').trim();
    const lower = raw.toLowerCase();
    if (!lower) return null;
    let rows = await sr.Driver.filter({ user_email: lower });
    if ((!rows || rows.length === 0) && raw !== lower) rows = await sr.Driver.filter({ user_email: raw });
    if (!rows || rows.length === 0) return null;
    rows.sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')));
    return rows[0];
}

// One plain-text line to the admin group. Plain text on purpose: these
// messages carry vehicle names and reasons that were never escaped for
// Markdown, and Telegram drops a message it cannot parse.
async function notifyAdminLine(text: string) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
        });
    } catch (err) {
        console.error('Telegram notify failed:', err);
    }
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const body = await req.json().catch(() => ({}));
        const ride_booking_id = body?.ride_booking_id;
        if (!ride_booking_id || typeof ride_booking_id !== 'string') {
            return json({ success: false, error: 'ride_booking_id is required' }, 400);
        }
        const input = validateReportInput(body);
        if (!input.ok) return json({ success: false, error: input.error, code: input.code }, 400);

        const sr = base44.asServiceRole.entities;
        const ride = await sr.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found', code: 'NOT_FOUND' }, 404);

        // Who is asking, decided from the session. Nothing in the request
        // body says which side they were on.
        const driver = await findDriverForUser(sr, user.email);
        const role = reporterRoleFor(ride, user.email, driver);
        if (!role) {
            return json({
                success: false,
                error: 'Only the guest or the driver of this ride can report it.',
                code: 'NOT_PARTY',
            }, 403);
        }
        if (ride.payment_status !== 'paid') {
            return json({ success: false, error: 'Only a paid ride can be reported.', code: 'NOT_PAID' }, 409);
        }
        if (!ride.driver_id) {
            return json({ success: false, error: 'This ride has no driver assigned yet.', code: 'NO_DRIVER' }, 409);
        }
        if (!reportWindowOpen(ride, Date.now())) {
            return json({
                success: false,
                error: 'A ride can be reported from when it starts until 7 days after it ends.',
                code: 'OUTSIDE_WINDOW',
            }, 409);
        }

        const already = await sr.RideReport.filter({ ride_booking_id, reporter_email: user.email });
        if (already.length > 0) {
            return json({
                success: false,
                error: 'You have already reported this ride. The team has it.',
                code: 'ALREADY_REPORTED',
            }, 409);
        }

        // Who the report is about, snapshotted so the inbox reads on its own.
        let reportedName = ride.guest_name || '';
        if (role === 'guest') {
            const theirDriver = await sr.Driver.get(ride.driver_id);
            reportedName = theirDriver?.full_name || 'Driver';
        }

        const row = {
            ride_booking_id,
            booking_reference: ride.booking_reference || '',
            vehicle_name: ride.vehicle_name || '',
            service_date: ride.service_date,
            reporter_email: user.email,
            reporter_role: role,
            reporter_name: role === 'driver' ? (driver?.full_name || '') : (ride.guest_name || user.full_name || ''),
            reported_email: role === 'driver' ? (ride.guest_email || '') : '',
            reported_driver_id: role === 'guest' ? ride.driver_id : '',
            reported_name: reportedName,
            category: input.value.category,
            description: input.value.description,
            evidence_urls: input.value.evidence_urls,
            status: 'open',
            action_taken: 'none',
        };
        const created = await sr.RideReport.create(row);

        // Two taps on Submit can both pass the "already" check. The oldest
        // report stands; a later twin is removed and answered as a duplicate.
        const twins = (await sr.RideReport.filter({ ride_booking_id, reporter_email: user.email }))
            .sort((a: any, b: any) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
                || String(a.id).localeCompare(String(b.id)));
        if (twins.length > 1 && twins[0].id !== created.id) {
            await sr.RideReport.delete(created.id);
            return json({
                success: false,
                error: 'You have already reported this ride. The team has it.',
                code: 'ALREADY_REPORTED',
            }, 409);
        }

        await notifyAdminLine(reportCardText(row));

        return json({ success: true, data: { report_id: created.id, reporter_role: role } });
    } catch (error) {
        console.error('createRideReport error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
```

- [ ] **Step 4: Put the script in the check chain**

**Edit `package.json`** — find:

```json
 && node scripts/check-driver-wallet.mjs",
```

replace with:

```json
 && node scripts/check-driver-wallet.mjs && node scripts/check-ride-reports.mjs",
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npm run check`

Expected: five `PASS` lines, the last from `check-ride-reports`.

Run: `node_modules/.bin/esbuild base44/functions/createRideReport/entry.ts --format=esm --target=esnext --outfile=/dev/null`

Expected: exit code 0.

- [ ] **Step 6: Sandbox checklist (after the next publish)**

1. As the driver of a ride in progress: `await base44.functions.invoke('createRideReport', { ride_booking_id: '<ride>', category: 'rude', description: 'Shouted at me for the whole trip.' })`. Expected: `success: true`, `reporter_role: 'driver'`; a "🚩 RIDE REPORT" message in the admin Telegram group.
2. Send it again. Expected: 409 `ALREADY_REPORTED`.
3. As someone who is neither the guest nor the driver. Expected: 403 `NOT_PARTY`.
4. As the guest of an upcoming ride that has not started. Expected: 409 `OUTSIDE_WINDOW`.
5. From a non-admin console: `await base44.entities.RideReport.list()`. Expected: refused or empty; reports are not readable through the API.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-ride-reports.mjs base44/functions/createRideReport/entry.ts package.json
git commit -m "feat(rides): a driver or a guest can report a ride" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task B03: `resolveRideReport`

**Files:**
- Modify: `scripts/check-ride-reports.mjs` (resolving section, above `// ---- result ----`)
- Create: `base44/functions/resolveRideReport/entry.ts`

**Interfaces:**
- Consumes: entity `RideReport`, `User.ride_blocked` (Task B01); `Driver.active`; `tryPush`.
- Produces: function `resolveRideReport` — admin only; body `{ report_id, status: 'reviewing' | 'resolved' | 'dismissed', action_taken?: 'none' | 'warning' | 'blocked', admin_notes? }`; answers `{ success: true, data: { report, effect } }` where `effect` is `'none' | 'guest_blocked' | 'guest_unblocked' | 'guest_not_found' | 'driver_deactivated'`. Refusals: `INVALID_STATUS`, `INVALID_ACTION` (400), `NOT_FOUND` (404).
- Helpers: `nextReportState(report, input, adminEmail, nowIso) → { ok: true, patch, was, now } | { ok: false, code }` and `guestBlockAfter(reports, thisReportId, thisAction) → boolean`.

**What a block does.** A report about a guest resolved as `blocked` sets `User.ride_blocked`. Moving that report away from `blocked` clears the flag, unless another resolved report against the same guest still says blocked. A report about a driver resolved as `blocked` sets `Driver.active = false`; it is never switched back on automatically, because admin may have deactivated the driver for other reasons (the switch is on the Drivers tab). Dismissing a report always takes no action.

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
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

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-ride-reports.mjs`

Expected: `Error: ENOENT: no such file or directory, open '…/base44/functions/resolveRideReport/entry.ts'`.

- [ ] **Step 3: Create the function**

**Create `base44/functions/resolveRideReport/entry.ts`:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// resolveRideReport
// ----------------------------------------------------------------------------
// Admin's decision on a ride report: still looking at it, resolved (with no
// action, a warning, or a block), or dismissed.
//
// A block is the only decision with an effect outside the report:
//   - about a GUEST   sets User.ride_blocked, which checkRideAvailability
//                     refuses. Moving the report away from blocked clears the
//                     flag again, unless another resolved report against the
//                     same guest still says blocked.
//   - about a DRIVER  sets Driver.active = false so they stop appearing when
//                     a ride is assigned. It is never switched back on from
//                     here: admin may have deactivated them for other reasons,
//                     and the switch is on the Drivers tab.
//
// Closing a report (resolved or dismissed) is also what lets the driver's pay
// for that ride release: the sweep skips an earning whose ride has an open or
// reviewing report.

const RESOLVE_STATUSES = ['reviewing', 'resolved', 'dismissed'];
const ACTIONS = ['none', 'warning', 'blocked'];
const MAX_NOTES = 1000;

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, undefined, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

// What the report becomes. `was` and `now` are the action before and after,
// so the caller can tell whether a block has to be applied or lifted. Plain
// JavaScript body: scripts/check-ride-reports.mjs lifts and runs it.
function nextReportState(report: any, input: any, adminEmail: string, nowIso: string) {
    const status = input && input.status;
    if (typeof status !== 'string' || !RESOLVE_STATUSES.includes(status)) return { ok: false, code: 'INVALID_STATUS' };
    const asked = input && input.action_taken;
    const named = asked !== undefined && asked !== null;
    if (named && (typeof asked !== 'string' || !ACTIONS.includes(asked))) return { ok: false, code: 'INVALID_ACTION' };
    const was = (report && report.action_taken) || 'none';
    // Dismissing means "nothing to act on", whatever was sent or decided before.
    const now = status === 'dismissed' ? 'none' : (named ? asked : was);
    const notes = typeof (input && input.admin_notes) === 'string'
        ? { admin_notes: input.admin_notes.trim().slice(0, MAX_NOTES) }
        : {};
    const closing = status === 'resolved' || status === 'dismissed'
        ? { resolved_at: nowIso, resolved_by: adminEmail || '' }
        : {};
    return { ok: true, patch: { status, action_taken: now, ...notes, ...closing }, was, now };
}

// Whether the reported guest is blocked once this report holds `thisAction`.
// `reports` is every report against that guest. A block stands for as long as
// any RESOLVED report says so; this report's own row in the list is ignored
// because it may be stale.
function guestBlockAfter(reports: any[], thisReportId: string, thisAction: string) {
    if (thisAction === 'blocked') return true;
    return (reports || []).some((r) => !!r
        && r.id !== thisReportId
        && r.status === 'resolved'
        && r.action_taken === 'blocked');
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);
        if (user.role !== 'admin') return json({ success: false, error: 'Admin access required' }, 403);

        const { report_id, status, action_taken, admin_notes } = await req.json().catch(() => ({}));
        if (!report_id || typeof report_id !== 'string') {
            return json({ success: false, error: 'report_id is required' }, 400);
        }

        const sr = base44.asServiceRole.entities;
        const report = await sr.RideReport.get(report_id);
        if (!report) return json({ success: false, error: 'That report no longer exists.', code: 'NOT_FOUND' }, 404);

        const next = nextReportState(report, { status, action_taken, admin_notes }, user.email, new Date().toISOString());
        if (!next.ok) {
            return json({
                success: false,
                error: next.code === 'INVALID_STATUS' ? 'Choose reviewing, resolved or dismissed.' : 'Choose none, warning or blocked.',
                code: next.code,
            }, 400);
        }

        await sr.RideReport.update(report.id, next.patch);

        // ── The one effect outside the report ───────────────────────────
        let effect = 'none';
        if (report.reported_email && (next.now === 'blocked' || next.was === 'blocked')) {
            // Only touch the flag when this report is, or was, a reason for it.
            const about = await fetchAll(sr.RideReport, { reported_email: report.reported_email });
            const shouldBlock = guestBlockAfter(about, report.id, next.now as string);
            const accounts = await sr.User.filter({ email: report.reported_email });
            const guest = accounts?.[0] || null;
            if (!guest) {
                effect = 'guest_not_found';
            } else if ((guest.ride_blocked === true) !== shouldBlock) {
                await sr.User.update(guest.id, { ride_blocked: shouldBlock });
                effect = shouldBlock ? 'guest_blocked' : 'guest_unblocked';
            }
        } else if (report.reported_driver_id && next.now === 'blocked' && next.was !== 'blocked') {
            const driver = await sr.Driver.get(report.reported_driver_id);
            if (driver && driver.active !== false) {
                await sr.Driver.update(driver.id, { active: false });
                effect = 'driver_deactivated';
            }
        }

        // Tell the reporter it was looked at. Never what was decided about
        // the other person: that is between admin and them.
        const closedNow = (next.patch.status === 'resolved' || next.patch.status === 'dismissed')
            && report.status !== next.patch.status;
        if (closedNow && report.reporter_email) {
            await tryPush(base44, {
                user_email: report.reporter_email,
                title: 'Your report was reviewed',
                body: `The team has looked at your report on ride ${report.booking_reference || ''}. Thank you for telling us.`.replace('  ', ' '),
                url: report.reporter_role === 'driver' ? '/DriverRides' : '/Bookings',
                tag: `ride-report-${report.id}`,
            });
        }

        const updated = await sr.RideReport.get(report.id);
        return json({ success: true, data: { report: updated, effect } });
    } catch (error) {
        console.error('resolveRideReport error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
```

- [ ] **Step 4: Run the checks**

Run: `node scripts/check-ride-reports.mjs`

Expected: `PASS`, including every line under `— resolving —`.

Run: `node_modules/.bin/esbuild base44/functions/resolveRideReport/entry.ts --format=esm --target=esnext --outfile=/dev/null`

Expected: exit code 0.

- [ ] **Step 5: Sandbox checklist (after the next publish)**

1. As admin: `await base44.functions.invoke('resolveRideReport', { report_id: '<a driver's report about a guest>', status: 'resolved', action_taken: 'blocked', admin_notes: 'Second complaint' })`. Expected: `effect: 'guest_blocked'`; the guest's User row has `ride_blocked: true`; the driver receives "Your report was reviewed".
2. The same call with `action_taken: 'warning'`. Expected: `effect: 'guest_unblocked'`.
3. On a guest's report about a driver, `action_taken: 'blocked'`. Expected: `effect: 'driver_deactivated'`; the driver shows "Inactive" on the Drivers tab.
4. As a non-admin. Expected: 403.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-ride-reports.mjs base44/functions/resolveRideReport/entry.ts
git commit -m "feat(rides): admin resolves a ride report, with warn and block" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task B04: A blocked guest cannot request a ride, and the request screen says why

**Files:**
- Modify: `scripts/check-ride-reports.mjs` (blocked accounts section, above `// ---- result ----`)
- Modify: `base44/functions/checkRideAvailability/entry.ts` (one helper; the check after sign-in)
- Modify: `src/pages/RideCheckout.jsx` (read the server's reason when a request is refused)

**Interfaces:**
- Consumes: `User.ride_blocked` (Task B01); `fromThrown(err)` from `src/lib/fnResult.js` (wallet plan, Task A10).
- Produces: `checkRideAvailability` refuses a blocked account with 403 `RIDE_BLOCKED` and the sentence "Ride bookings are not available on this account. Please contact support." Helper `isRideBlocked(account) → boolean`.

**Why the request screen changes.** `RideCheckout` showed `err.message` when a request was refused. Every refusal from `checkRideAvailability` is a 4xx, which the SDK throws, so a guest whose car was double-booked, who had too many open requests, or who is blocked read "Request failed with status code 409". The sentence they should read is in the thrown error's response body; `fromThrown` gets it.

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Blocked accounts ───────────────────────────────────────────────────────
console.log('\n— blocked accounts —');
const isRideBlocked = make('isRideBlocked', liftSrc('checkRideAvailability', 'isRideBlocked', 'account'));
check('an account admin blocked is refused', isRideBlocked({ ride_blocked: true }), true);
check('an ordinary account is not', isRideBlocked({ ride_blocked: false }), false);
check('an account from before the flag existed is not', isRideBlocked({ email: 'ada@example.com' }), false);
// Only the boolean true blocks. A string that happens to be truthy must not.
check('the string "false" does not block', isRideBlocked({ ride_blocked: 'false' }), false);
check('a missing account row does not block', isRideBlocked(undefined), false);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-ride-reports.mjs`

Expected: `Error: could not find isRideBlocked in base44/functions/checkRideAvailability/entry.ts`.

- [ ] **Step 3: Refuse a blocked account before anything else is looked at**

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
function multiDaysOk(days: unknown) {
    const d = Number(days);
    return Number.isInteger(d) && d >= 1 && d <= MAX_MULTI_DAYS;
}
```

replace with:

```ts
function multiDaysOk(days: unknown) {
    const d = Number(days);
    return Number.isInteger(d) && d >= 1 && d <= MAX_MULTI_DAYS;
}

// Admin blocked this account from rides when resolving a report against it
// (resolveRideReport). Only the boolean true blocks.
function isRideBlocked(account: any) {
    return !!account && account.ride_blocked === true;
}
```

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        const body = await req.json().catch(() => ({}));
```

replace with:

```ts
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);

        // Read the account fresh under the service role rather than trusting
        // the copy on the session: a block must take effect at once.
        const accounts = await base44.asServiceRole.entities.User.filter({ email: user.email });
        if (isRideBlocked(accounts?.[0])) {
            return json({
                success: false,
                error: 'Ride bookings are not available on this account. Please contact support.',
                code: 'RIDE_BLOCKED',
            }, 403);
        }

        const body = await req.json().catch(() => ({}));
```

- [ ] **Step 4: Let the guest read why a request was refused**

**Edit `src/pages/RideCheckout.jsx`** — find:

```jsx
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
```

replace with:

```jsx
import { base44 } from '@/api/base44Client';
import { fromThrown } from '@/lib/fnResult';
import { Card, CardContent } from '@/components/ui/card';
```

**Edit `src/pages/RideCheckout.jsx`** — find:

```jsx
      console.error('Ride request failed:', err);
      setSubmitError(err?.message || 'Something went wrong. Please try again.');
```

replace with:

```jsx
      console.error('Ride request failed:', err);
      // A refusal is a 4xx, which the SDK throws. Its body carries the reason
      // the guest can act on ("That vehicle is already booked for…", "Ride
      // bookings are not available on this account…"); err.message is only
      // "Request failed with status code 409".
      setSubmitError(fromThrown(err).error);
```

- [ ] **Step 5: Run the checks**

Run: `npm run check && npm run lint`

Expected: five `PASS` lines, no lint output.

Run: `node_modules/.bin/esbuild base44/functions/checkRideAvailability/entry.ts --format=esm --target=esnext --outfile=/dev/null`

Expected: exit code 0.

Run: `set -a; . ./.env; set +a; npm run build`

Expected: `✓ built in …`.

- [ ] **Step 6: Sandbox checklist (after the next publish)**

1. Block a test guest (Task B03, step 5.1). As that guest, request a ride. Expected: the request screen shows "Ride bookings are not available on this account. Please contact support." in its error area.
2. Unblock them and request again. Expected: the request goes through.
3. As any guest, request a car that is already booked for that time. Expected: the screen shows the server's double-booking sentence, not a status code.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-ride-reports.mjs base44/functions/checkRideAvailability/entry.ts src/pages/RideCheckout.jsx
git commit -m "feat(rides): a blocked guest cannot request a ride; refusals on the request screen are readable" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

