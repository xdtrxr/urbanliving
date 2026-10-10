# Ride Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a driver report a rude or abusive customer, and a guest report a driver, on any paid ride; put every report in front of admin with a Telegram ping; let admin dismiss, warn or block; and keep a ride's driver pay held while the guest has an open complaint about it.

**Architecture:** A `RideReport` entity that only two functions write: `createRideReport` (checks the caller is a party to the ride and inside the reporting window) and `resolveRideReport` (admin). A block sets `User.ride_blocked`, which `checkRideAvailability` refuses, or deactivates the driver. The sweep and admin's Release now both skip an earning whose ride has an open complaint from the guest. A report the driver files never holds the driver's own pay. One shared dialog serves the driver's ride card and the guest's driver card; a fourth inner tab on the admin Rides screen is the inbox.

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

**Verified by replay (2026-10-10):** every Create, Replace and Edit below was applied mechanically, in order, to a clean checkout of commit `e3e890a` (the wallet plan first, then the reports plan). All 195 operations found their text exactly once, the result passed `npm run check`, and it matched the implementation on `feat/driver-wallet` file for file. If a find-block does not match when you run it, the file has changed since; stop and read the diff.

## Review Focus

Five things the spec implies, that a person will hit, and that are easy to get wrong. Each has a pinned check in the task that owns the code.

1. **A description full of `*`, `_`, backticks and brackets, or 2,000 characters long.** Admin must still get the Telegram card. Pinned in Task B02 (`reportCardText` cases: no Markdown is emitted, the text is cut at 300 characters).
2. **A "photo" that is `javascript:alert(1)`, an `http://` link, or a URL with a space or a quote in it.** Refused before anything is stored. Pinned in Task B02 (`validateReportInput` cases) and Task B07 (the admin tab only renders `https://` sources).
3. **A report filed at the first or last moment of the window.** Allowed at the ride's start and at exactly seven days after its end, refused one millisecond either side, in WAT. Pinned in Task B02 (`reportWindowOpen` cases with exact UTC instants).
4. **A guest with two reports against them, one resolved as blocked, when admin clears the other.** They stay blocked. Pinned in Task B03 (`guestBlockAfter` cases).
5. **Pay that falls due while a report on its ride is open, and who filed it.** A guest's complaint holds the pay until admin closes it, then the next sweep releases it. A report the driver filed about the guest never delays the driver's own pay. Pinned in Task B05 (`settleDueEarning` cases for a guest's open, reviewing and resolved complaint, and for a driver's report).

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

### Task B05: A guest's open complaint holds the pay, and the ride lists know about reports

**Files:**
- Modify: `scripts/check-ride-reports.mjs` (reports and money section, above `// ---- result ----`)
- Modify: `scripts/check-driver-wallet.mjs` (the sweep's settle helper now needs a report table; two allow-lists gain fields)
- Modify: `base44/functions/autoCancelExpiredBookings/entry.ts` (`hasOpenGuestReport`; the release pass skips a ride under review)
- Modify: `base44/functions/settleDriverEarning/entry.ts` (`hasOpenGuestReport`; Release now refuses with `OPEN_REPORT`)
- Modify: `base44/functions/getDriverRides/entry.ts` (`reportWindowOpen`; `can_report`, `already_reported`, `earning.under_review`)
- Modify: `base44/functions/getDriverWallet/entry.ts` (`under_review` on ledger rows)
- Modify: `base44/functions/getRideBookings/entry.ts` (`reportWindowOpen`; `can_report`, `already_reported` for the guest)

**Interfaces:**
- Consumes: entity `RideReport` (Task B01); `reportWindowOpen`, `REPORT_WINDOW_AFTER_END_MS` (Task B02, copied); `settleDueEarning`, `isReleasable`, `releaseDecision` (wallet plan, Task A05); `driverRideView`, `ledgerView` (wallet plan, Tasks A07 and A08).
- Produces: `async hasOpenGuestReport(sr, rideBookingId) → boolean` (true only for a report with `reporter_role: 'guest'` in `open` or `reviewing`), identical in `autoCancelExpiredBookings` and `settleDriverEarning`. `settleDriverEarning` gains the refusal `OPEN_REPORT` (409) for `release`.
- Changes: `driverRideView(ride, bucket, win, earning, flags)` where `flags` is `{ reported, under_review, window_open }`; every ride from `getDriverRides` now carries `already_reported: boolean`, `can_report: boolean`, and `earning.under_review: boolean`. `ledgerView(earning, underReview)`; every ledger row from `getDriverWallet` carries `under_review: boolean`. Every ride from `getRideBookings` with `scope: 'mine'` carries `already_reported` and `can_report`.

- [ ] **Step 1: Write the failing checks**

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Reports and money ──────────────────────────────────────────────────────
// Review focus 5: pay that falls due while a report on its ride is open, and
// who filed that report.
console.log('\n— reports and money —');
identical('hasOpenGuestReport', 'sr, rideBookingId', ['autoCancelExpiredBookings', 'settleDriverEarning']);
for (const dir of ['getDriverRides', 'getRideBookings']) {
  identical('reportWindowOpen', 'ride, nowMs', [HOME, dir]);
  check(`one reporting window: ${dir} agrees with ${HOME}`,
    constLine(dir, 'REPORT_WINDOW_AFTER_END_MS'), constLine(HOME, 'REPORT_WINDOW_AFTER_END_MS'));
}

const SWEEP = 'autoCancelExpiredBookings';
const hasOpenGuestReport = make('hasOpenGuestReport', liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId'));
const reportsOf = (rows) => ({ RideReport: fakeEntity(rows) });
const filed = (reporter_role, status, ride_booking_id = 'ride1') => ({ id: 'r1', ride_booking_id, reporter_role, status });
check('an open complaint from the guest holds the ride', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1'), true);
check('so does one being reviewed', await hasOpenGuestReport(reportsOf([filed('guest', 'reviewing')]), 'ride1'), true);
check('a resolved one does not', await hasOpenGuestReport(reportsOf([filed('guest', 'resolved')]), 'ride1'), false);
check('a dismissed one does not', await hasOpenGuestReport(reportsOf([filed('guest', 'dismissed')]), 'ride1'), false);
check('a complaint about another ride does not', await hasOpenGuestReport(reportsOf([filed('guest', 'open', 'other')]), 'ride1'), false);
// The driver reporting an abusive customer must never delay the driver's own pay.
check('a report the DRIVER filed never holds the driver\'s pay', await hasOpenGuestReport(reportsOf([filed('driver', 'open')]), 'ride1'), false);
check('no reports at all', await hasOpenGuestReport(reportsOf([]), 'ride1'), false);

const settleDueEarning = make('settleDueEarning',
  liftSrc(SWEEP, 'isReleasable', 'earning, nowMs'), liftSrc(SWEEP, 'releaseDecision', 'earning, ride'),
  liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId'), liftSrc(SWEEP, 'settleDueEarning', 'sr, earningId, nowMs'));
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
```

The wallet script's copy of the settle helper has to be built with a report table too, and two allow-lists it pins gain fields.

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
const settleDueEarning = make('settleDueEarning',
  sweepSrc('isReleasable', 'earning, nowMs'), sweepSrc('releaseDecision', 'earning, ride'),
  sweepSrc('settleDueEarning', 'sr, earningId, nowMs'));
const world = (earning, ride) => ({ DriverEarning: fakeEntity([earning]), RideBooking: fakeEntity(ride ? [ride] : []) });
```

replace with:

```js
const settleDueEarning = make('settleDueEarning',
  sweepSrc('isReleasable', 'earning, nowMs'), sweepSrc('releaseDecision', 'earning, ride'),
  sweepSrc('hasOpenGuestReport', 'sr, rideBookingId'), sweepSrc('settleDueEarning', 'sr, earningId, nowMs'));
// No reports on any ride here; scripts/check-ride-reports.mjs covers the cases with one.
const world = (earning, ride) => ({
  DriverEarning: fakeEntity([earning]), RideBooking: fakeEntity(ride ? [ride] : []), RideReport: fakeEntity([]),
});
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  liftSrc('getDriverRides', 'safeIso', 'ms'), liftSrc('getDriverRides', 'driverRideView', 'ride, bucket, win, earning'));
```

replace with:

```js
  liftSrc('getDriverRides', 'safeIso', 'ms'), liftSrc('getDriverRides', 'driverRideView', 'ride, bucket, win, earning, flags'));
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  'booking_reference', 'bucket', 'dropoff_location', 'duration_days', 'duration_hours', 'duration_tier',
```

replace with:

```js
  'already_reported', 'booking_reference', 'bucket', 'can_report', 'dropoff_location', 'duration_days', 'duration_hours', 'duration_tier',
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  ['amount_ngn', 'id', 'on_hold', 'release_at', 'released_at', 'status']);
```

replace with:

```js
  ['amount_ngn', 'id', 'on_hold', 'release_at', 'released_at', 'status', 'under_review']);
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
const ledgerView = make('ledgerView', walletSrc('ledgerView', 'earning'));
```

replace with:

```js
const ledgerView = make('ledgerView', walletSrc('ledgerView', 'earning, underReview'));
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
    'ride_booking_id', 'service_date', 'status', 'vehicle_name']);
```

replace with:

```js
    'ride_booking_id', 'service_date', 'status', 'under_review', 'vehicle_name']);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node scripts/check-ride-reports.mjs`

Expected: `Error: could not find hasOpenGuestReport in base44/functions/autoCancelExpiredBookings/entry.ts`.

Run: `node scripts/check-driver-wallet.mjs`

Expected: the same error, from the wallet script's own settle section.

- [ ] **Step 3: The sweep skips pay on a ride the guest has complained about**

Only a complaint from the guest holds the pay: it is a dispute about the service the driver is being paid for. A report the driver files about the guest must not, or reporting an abusive customer would cost the driver their own money on time. The check sits after the reverse and hold branches on purpose: a cancelled or reassigned ride is still reversed while a complaint is open. Only the release waits.

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
// Settle one due earning: 'released' | 'reversed' | 'held' | 'skipped'.
```

replace with:

```ts
// True while admin has not closed a complaint the GUEST made about this ride.
// That is a dispute about the service the driver is being paid for, so the
// pay waits. A report the DRIVER filed about the guest never holds the
// driver's own pay: that would punish them for speaking up. Lockstep copy in
// settleDriverEarning.
async function hasOpenGuestReport(sr: any, rideBookingId: string) {
    const open = await sr.RideReport.filter({
        ride_booking_id: rideBookingId, reporter_role: 'guest', status: { $in: ['open', 'reviewing'] },
    });
    return Array.isArray(open) && open.length > 0;
}

// Settle one due earning: 'released' | 'reversed' | 'held' | 'skipped'.
```

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
        return 'held';
    }
    await sr.DriverEarning.update(e.id, {
        status: 'released', released_at: nowIso, on_hold: false, hold_reason: '',
    });
```

replace with:

```ts
        return 'held';
    }
    // The guest has complained about this ride and admin has not closed it
    // yet. The pay waits; the next tick after the report is closed releases it.
    if (await hasOpenGuestReport(sr, e.ride_booking_id)) return 'skipped';
    await sr.DriverEarning.update(e.id, {
        status: 'released', released_at: nowIso, on_hold: false, hold_reason: '',
    });
```

- [ ] **Step 4: Admin's Release now refuses too**

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
async function tryPush(sdk: any, opts: Record<string, unknown>) {
```

replace with:

```ts
// True while admin has not closed a complaint the GUEST made about this ride.
// That is a dispute about the service the driver is being paid for, so the
// pay waits. A report the DRIVER filed about the guest never holds the
// driver's own pay: that would punish them for speaking up. Lockstep copy,
// see autoCancelExpiredBookings.
async function hasOpenGuestReport(sr: any, rideBookingId: string) {
    const open = await sr.RideReport.filter({
        ride_booking_id: rideBookingId, reporter_role: 'guest', status: { $in: ['open', 'reviewing'] },
    });
    return Array.isArray(open) && open.length > 0;
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
```

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
                    code: 'RIDE_STATE',
                }, 409);
            }
```

replace with:

```ts
                    code: 'RIDE_STATE',
                }, 409);
            }
            // Releasing around an open complaint would make the report
            // pointless. Admin closes it first, in Rides → Reports.
            if (await hasOpenGuestReport(sr, earning.ride_booking_id)) {
                return json({
                    success: false,
                    error: 'The guest has an open report on this ride. Resolve or dismiss it under Rides → Reports first.',
                    code: 'OPEN_REPORT',
                }, 409);
            }
```

- [ ] **Step 5: `getDriverRides` says which rides can be reported and which pay is under review**

**Edit `base44/functions/getDriverRides/entry.ts`** — find:

```ts
function safeIso(ms: number) {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const PAGE = 500;
```

replace with:

```ts
function safeIso(ms: number) {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Reporting — lockstep copy, see createRideReport ─────────────────────────
const REPORT_WINDOW_AFTER_END_MS = 7 * DAY_MS;

function reportWindowOpen(ride: any, nowMs: number) {
    const w = windowOf(ride);
    if (!w || !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) return false;
    return w.startMs <= nowMs && nowMs <= w.endMs + REPORT_WINDOW_AFTER_END_MS;
}

const PAGE = 500;
```

**Edit `base44/functions/getDriverRides/entry.ts`** — find:

```ts
function driverRideView(ride: any, bucket: string, win: any, earning: any) {
```

replace with:

```ts
function driverRideView(ride: any, bucket: string, win: any, earning: any, flags: any) {
```

**Edit `base44/functions/getDriverRides/entry.ts`** — find:

```ts
        bucket,
        status: ride.status,
        earning: earning ? {
            id: earning.id,
            amount_ngn: Math.max(0, Math.round(Number(earning.amount_ngn) || 0)),
            status: earning.status,
            on_hold: !!earning.on_hold,
            release_at: earning.release_at || null,
            released_at: earning.released_at || null,
        } : null,
```

replace with:

```ts
        bucket,
        status: ride.status,
        // The driver has already told us about this ride.
        already_reported: !!(flags && flags.reported),
        // Whether to offer "Report this customer": a paid ride, inside the
        // window, not reported yet. createRideReport checks all three again.
        can_report: ride.payment_status === 'paid' && !!(flags && flags.window_open) && !(flags && flags.reported),
        earning: earning ? {
            id: earning.id,
            amount_ngn: Math.max(0, Math.round(Number(earning.amount_ngn) || 0)),
            status: earning.status,
            on_hold: !!earning.on_hold,
            release_at: earning.release_at || null,
            released_at: earning.released_at || null,
            // The guest has an open complaint about this ride, so the held pay waits.
            under_review: earning.status === 'held' && !!(flags && flags.under_review),
        } : null,
```

**Edit `base44/functions/getDriverRides/entry.ts`** — find:

```ts
        const [rides, earnings] = await Promise.all([
            fetchAll(sr.RideBooking, { driver_id: driver.id }),
            fetchAll(sr.DriverEarning, { driver_id: driver.id }),
        ]);
```

replace with:

```ts
        const [rides, earnings, myReports, openReports] = await Promise.all([
            fetchAll(sr.RideBooking, { driver_id: driver.id }),
            fetchAll(sr.DriverEarning, { driver_id: driver.id }),
            fetchAll(sr.RideReport, { reporter_email: user.email }),
            fetchAll(sr.RideReport, { reporter_role: 'guest', status: { $in: ['open', 'reviewing'] } }),
        ]);
        const reportedRides = new Set(myReports.map((r: any) => r.ride_booking_id));
        const ridesUnderReview = new Set(openReports.map((r: any) => r.ride_booking_id));
```

**Edit `base44/functions/getDriverRides/entry.ts`** — find:

```ts
            return driverRideView(r, bucket, windowOf(r), earningForRide(earningsByRide.get(r.id) || []));
```

replace with:

```ts
            return driverRideView(r, bucket, windowOf(r), earningForRide(earningsByRide.get(r.id) || []), {
                reported: reportedRides.has(r.id),
                under_review: ridesUnderReview.has(r.id),
                window_open: reportWindowOpen(r, nowMs),
            });
```

- [ ] **Step 6: `getDriverWallet` marks ledger rows under review**

**Edit `base44/functions/getDriverWallet/entry.ts`** — find:

```ts
function ledgerView(earning: any) {
```

replace with:

```ts
function ledgerView(earning: any, underReview: boolean) {
```

**Edit `base44/functions/getDriverWallet/entry.ts`** — find:

```ts
        on_hold: !!earning.on_hold,
        release_at: earning.release_at || null,
        held_at: earning.held_at || earning.created_date || null,
```

replace with:

```ts
        on_hold: !!earning.on_hold,
        // The guest has an open complaint about this ride, so the held pay waits.
        under_review: earning.status === 'held' && !!underReview,
        release_at: earning.release_at || null,
        held_at: earning.held_at || earning.created_date || null,
```

**Edit `base44/functions/getDriverWallet/entry.ts`** — find:

```ts
        const [earnings, withdrawalRows] = await Promise.all([
            fetchAll(sr.DriverEarning, { driver_id: driver.id }),
            fetchAll(sr.WithdrawalRequest, { driver_id: driver.id }),
        ]);
```

replace with:

```ts
        const [earnings, withdrawalRows, openReports] = await Promise.all([
            fetchAll(sr.DriverEarning, { driver_id: driver.id }),
            fetchAll(sr.WithdrawalRequest, { driver_id: driver.id }),
            fetchAll(sr.RideReport, { reporter_role: 'guest', status: { $in: ['open', 'reviewing'] } }),
        ]);
        const ridesUnderReview = new Set(openReports.map((r: any) => r.ride_booking_id));
```

**Edit `base44/functions/getDriverWallet/entry.ts`** — find:

```ts
                ledger: earnings.slice().sort(newestFirst).slice(0, LEDGER_LIMIT).map(ledgerView),
```

replace with:

```ts
                ledger: earnings.slice().sort(newestFirst).slice(0, LEDGER_LIMIT)
                    .map((e) => ledgerView(e, ridesUnderReview.has(e.ride_booking_id))),
```

- [ ] **Step 7: `getRideBookings` tells the guest which rides they can report**

The report lookup is wrapped on its own: a guest's ride list must never fail because the reports table could not be read.

**Edit `base44/functions/getRideBookings/entry.ts`** — find:

```ts
    if (nowMs < w.startMs) return 'upcoming';
    return 'current';
}
```

replace with:

```ts
    if (nowMs < w.startMs) return 'upcoming';
    return 'current';
}

// ── Reporting — lockstep copy, see createRideReport ─────────────────────────
const REPORT_WINDOW_AFTER_END_MS = 7 * DAY_MS;

function reportWindowOpen(ride: any, nowMs: number) {
    const w = windowOf(ride);
    if (!w || !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) return false;
    return w.startMs <= nowMs && nowMs <= w.endMs + REPORT_WINDOW_AFTER_END_MS;
}
```

**Edit `base44/functions/getRideBookings/entry.ts`** — find:

```ts
            rides = await fetchAll(base44.entities.RideBooking, { guest_email: user.email });
        }
```

replace with:

```ts
            rides = await fetchAll(base44.entities.RideBooking, { guest_email: user.email });
        }

        // Which of their own rides this guest has already reported. Read under
        // the service role because RideReport is admin-only at the API, and on
        // its own so that a problem here can never cost them their ride list.
        const reportedRides = new Set<string>();
        if (scope === 'mine') {
            try {
                const mine = await fetchAll(base44.asServiceRole.entities.RideReport, { reporter_email: user.email });
                for (const rep of mine) reportedRides.add(rep.ride_booking_id);
            } catch (err) {
                console.warn('Could not read ride reports (the ride list is unaffected):', err);
            }
        }
```

**Edit `base44/functions/getRideBookings/entry.ts`** — find:

```ts
                driver_assigned: !!r.driver_id,
            };
```

replace with:

```ts
                driver_assigned: !!r.driver_id,
                // Guests only: whether "Report a problem with this driver" is
                // offered. createRideReport checks every part of it again.
                already_reported: scope === 'mine' ? reportedRides.has(r.id) : undefined,
                can_report: scope === 'mine'
                    ? r.payment_status === 'paid' && !!r.driver_id && reportWindowOpen(r, nowMs) && !reportedRides.has(r.id)
                    : undefined,
            };
```

- [ ] **Step 8: Run the checks**

Run: `npm run check`

Expected: five `PASS` lines.

Run: `for f in autoCancelExpiredBookings settleDriverEarning getDriverRides getDriverWallet getRideBookings; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done`

Expected: no `PARSE FAIL` line.

- [ ] **Step 9: Sandbox checklist (after the next publish)**

1. As the guest, file a report on a ride whose pay is due, then POST to `autoCancelExpiredBookings` as admin. Expected: `rides.released` does not count that ride; its earning is still `held`; the driver's wallet shows it as "Under review".
2. As admin, press Release now on that row in Rides → Earnings. Expected: "The guest has an open report on this ride…".
3. Dismiss the report, POST to the sweep again. Expected: the earning is `released`.
4. As the driver, file a report on a different ride whose pay is due (Task B02, step 6.1), then POST to the sweep. Expected: that pay is released on time.

- [ ] **Step 10: Commit**

```bash
git add scripts/check-ride-reports.mjs scripts/check-driver-wallet.mjs base44/functions/autoCancelExpiredBookings/entry.ts base44/functions/settleDriverEarning/entry.ts base44/functions/getDriverRides/entry.ts base44/functions/getDriverWallet/entry.ts base44/functions/getRideBookings/entry.ts
git commit -m "feat(rides): a guest's open complaint holds the driver's pay; ride lists know what can be reported" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task B06: The report dialog, on the driver's ride card and the guest's driver card

**Files:**
- Modify: `scripts/check-ride-reports.mjs` (client limits section, above `// ---- result ----`)
- Modify: `src/config/rides.js` (two constants, appended)
- Create: `src/components/rides/RideReportDialog.jsx`
- Modify: `src/pages/DriverRides.jsx` (open the dialog from a ride card)
- Modify: `src/components/booking/RideBookingsSection.jsx` (a report link on the guest's driver card)

**Interfaces:**
- Consumes: `createRideReport` and its refusal codes (Task B02); `ride.can_report`, `ride.already_reported` from `getDriverRides` and from `getRideBookings` (Task B05); `DriverRideCard`'s `onReport` prop (wallet plan, Task A07); `invokeFn`, `fromThrown` (wallet plan, Task A10); `UploadFile` from `@/api/integrations`.
- Produces: `REPORT_CATEGORIES` and `REPORT_LIMITS` in `src/config/rides.js`; default export `RideReportDialog` with props `{ open, ride, role, onClose, onSubmitted }`, where `role` is `'driver'` or `'guest'` and `onSubmitted(outcome)` receives `'sent'` or `'already'`.

- [ ] **Step 1: Write the failing check**

The dialog stops a report the server would refuse, so its limits must be the server's.

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
import { fileURLToPath } from 'node:url';
```

replace with:

```js
import { fileURLToPath } from 'node:url';
import * as rides from '../src/config/rides.js';
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── The dialog's limits are the server's ───────────────────────────────────
console.log('\n— client limits —');
same('the dialog offers exactly the categories the server accepts', rides.REPORT_CATEGORIES, make('CATEGORIES', LIMITS));
check('shortest description', rides.REPORT_LIMITS?.minDescription, make('MIN_DESCRIPTION', LIMITS));
check('longest description', rides.REPORT_LIMITS?.maxDescription, make('MAX_DESCRIPTION', LIMITS));
check('most photos', rides.REPORT_LIMITS?.maxPhotos, make('MAX_EVIDENCE', LIMITS));

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-ride-reports.mjs`

Expected: ` FAIL  the dialog offers exactly the categories the server accepts  got=undefined …` and three more failures.

- [ ] **Step 3: Add the limits**

**Edit `src/config/rides.js`** — find:

```js
  if (value > MAX_PAYOUT_NGN) {
    return { ok: false, message: `Driver pay cannot be more than ₦${MAX_PAYOUT_NGN.toLocaleString()}.` };
  }
  return { ok: true, value };
}
```

replace with:

```js
  if (value > MAX_PAYOUT_NGN) {
    return { ok: false, message: `Driver pay cannot be more than ₦${MAX_PAYOUT_NGN.toLocaleString()}.` };
  }
  return { ok: true, value };
}

// ── Ride reports ────────────────────────────────────────────────────────────
// MIRROR of the limits in base44/functions/createRideReport/entry.ts. The
// server is the authority; these let the dialog stop a report it would refuse
// before the reporter has typed it twice. scripts/check-ride-reports.mjs
// compares them with the shipped constants.
export const REPORT_CATEGORIES = ['rude', 'abusive', 'threatening', 'unsafe', 'no_show', 'damage', 'other'];
export const REPORT_LIMITS = { minDescription: 10, maxDescription: 2000, maxPhotos: 3 };
```

- [ ] **Step 4: Run the check and watch it pass**

Run: `node scripts/check-ride-reports.mjs`

Expected: `PASS`, including the four lines under `— client limits —`.

- [ ] **Step 5: Create the dialog**

**Create `src/components/rides/RideReportDialog.jsx`:**

```jsx
import React, { useState, useEffect, useRef } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ImagePlus, X, AlertCircle, Flag } from 'lucide-react';
import { UploadFile } from '@/api/integrations';
import { invokeFn } from '@/lib/invokeFn';
import { fromThrown } from '@/lib/fnResult';
import { REPORT_CATEGORIES, REPORT_LIMITS } from '@/config/rides';

// RideReportDialog — one party to a ride tells the team about a problem with
// the other. The same form serves both sides; only the wording changes.
//
// The server decides everything that matters (who may report, when, how
// often): see createRideReport. This form only collects the three things it
// asks for and shows the server's own sentence if it says no.

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// The words on each chip. The values are the server's; a category this map
// has no words for still shows, as its value, rather than disappearing.
const CATEGORY_WORDS = {
  driver: {
    rude: 'Rude', abusive: 'Abusive', threatening: 'Threatening', unsafe: 'Unsafe behaviour',
    no_show: 'Did not show up', damage: 'Damaged the car', other: 'Something else',
  },
  guest: {
    rude: 'Rude', abusive: 'Abusive', threatening: 'Threatening', unsafe: 'Unsafe driving',
    no_show: 'Driver did not show up', damage: 'Damage or loss', other: 'Something else',
  },
};

const COPY = {
  driver: {
    title: 'Report this customer',
    intro: 'Tell us what happened. Only the UrbanStays team sees this, and reporting never affects your pay for the ride.',
    placeholder: 'What did the customer do or say? When, and where?',
  },
  guest: {
    title: 'Report a problem with this driver',
    intro: 'Tell us what happened. Only the UrbanStays team sees this.',
    placeholder: 'What happened on the ride? When, and where?',
  },
};

export default function RideReportDialog({ open, ride, role, onClose, onSubmitted }) {
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  // A clean form each time it opens, whichever ride it opens for.
  const rideId = ride?.id;
  useEffect(() => {
    if (!open) return;
    setCategory('');
    setDescription('');
    setPhotos([]);
    setError(null);
  }, [open, rideId]);

  const side = role === 'driver' ? 'driver' : 'guest';
  const copy = COPY[side];
  const text = description.trim();
  const tooShort = text.length < REPORT_LIMITS.minDescription;
  const busy = uploading || submitting;
  const canSubmit = !!category && !tooShort && text.length <= REPORT_LIMITS.maxDescription && !busy;

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Photos only. Choose a JPG or PNG.');
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError('That photo is over 10 MB. Choose a smaller one.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const { file_url } = await UploadFile({ file });
      if (!file_url) throw new Error('The upload did not return a link.');
      setPhotos((list) => (list.includes(file_url) ? list : [...list, file_url]).slice(0, REPORT_LIMITS.maxPhotos));
    } catch (err) {
      // Show the platform's own reason: an exhausted upload quota will not
      // succeed on a retry, and "please try again" would be a lie.
      setError(`The photo could not be uploaded: ${fromThrown(err).error}`);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!canSubmit || !ride) return;
    setSubmitting(true);
    setError(null);
    const r = await invokeFn('createRideReport', {
      ride_booking_id: ride.id,
      category,
      description: text,
      evidence_urls: photos,
    });
    setSubmitting(false);
    if (r.ok) {
      onSubmitted?.('sent');
    } else if (r.code === 'ALREADY_REPORTED') {
      onSubmitted?.('already');
    } else {
      setError(r.error);
    }
  };

  return (
    <Dialog open={!!open} onOpenChange={(o) => { if (!o && !busy) onClose?.(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flag className="w-4 h-4 text-red-600 dark:text-red-400" />
            {copy.title}
          </DialogTitle>
          <DialogDescription>
            {[ride?.vehicle_name, ride?.booking_reference].filter(Boolean).join(' · ')}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-slate-600 dark:text-slate-300">{copy.intro}</p>

        <div>
          <Label>What kind of problem was it?</Label>
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="What kind of problem was it?">
            {REPORT_CATEGORIES.map((value) => {
              const chosen = category === value;
              return (
                <button
                  key={value} type="button" role="radio" aria-checked={chosen}
                  onClick={() => setCategory(value)}
                  className={`px-3 py-1.5 rounded-full border text-sm font-medium transition-colors ${
                    chosen
                      ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
                      : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500'
                  }`}
                >
                  {CATEGORY_WORDS[side][value] || value}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <Label htmlFor="rr-description">What happened?</Label>
          <Textarea
            id="rr-description" rows={5} value={description} maxLength={REPORT_LIMITS.maxDescription}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={copy.placeholder} className="mt-1 rounded-xl"
          />
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {tooShort
              ? `At least ${REPORT_LIMITS.minDescription} characters.`
              : `${text.length} of ${REPORT_LIMITS.maxDescription} characters.`}
          </p>
        </div>

        <div>
          <Label>Photos, if you have any</Label>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {photos.map((url) => (
              <div key={url} className="relative">
                <img src={url} alt="" className="w-16 h-16 rounded-lg object-cover border border-slate-200 dark:border-slate-800" />
                <button
                  type="button" aria-label="Remove photo"
                  onClick={() => setPhotos((list) => list.filter((u) => u !== url))}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 hover:bg-black text-white flex items-center justify-center"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {photos.length < REPORT_LIMITS.maxPhotos && (
              <>
                <input ref={fileRef} type="file" accept="image/*" onChange={pickPhoto} className="hidden" id="rr-photo" />
                <Button
                  type="button" variant="outline" size="sm" disabled={busy}
                  onClick={() => fileRef.current?.click()} className="rounded-xl"
                >
                  {uploading
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading…</>
                    : <><ImagePlus className="w-4 h-4 mr-2" /> Add a photo</>}
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Up to {REPORT_LIMITS.maxPhotos} photos, 10 MB each.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3" role="alert">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onClose?.()} disabled={busy} className="rounded-xl">
            Cancel
          </Button>
          <Button
            onClick={submit} disabled={!canSubmit}
            className="rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Send report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Open it from the driver's ride card**

**Edit `src/pages/DriverRides.jsx`** — find:

```jsx
import DriverRideCard from '@/components/driver/DriverRideCard';
```

replace with:

```jsx
import DriverRideCard from '@/components/driver/DriverRideCard';
import RideReportDialog from '@/components/rides/RideReportDialog';
import { useToast } from '@/components/ui/use-toast';
```

**Edit `src/pages/DriverRides.jsx`** — find:

```jsx
  const [showHistory, setShowHistory] = useState(false);
```

replace with:

```jsx
  const [showHistory, setShowHistory] = useState(false);
  const [reporting, setReporting] = useState(null); // the ride being reported
  const { toast } = useToast();

  const onReported = (outcome) => {
    setReporting(null);
    toast(outcome === 'already'
      ? { title: 'Already reported', description: 'You have already reported this ride. The team has it.' }
      : { title: 'Report sent', description: 'The team will look into it. Your pay for this ride is not affected.' });
    load(true);
  };
```

**Edit `src/pages/DriverRides.jsx`** — find:

```jsx
                    {items.map((ride) => <DriverRideCard key={ride.id} ride={ride} />)}
```

replace with:

```jsx
                    {items.map((ride) => <DriverRideCard key={ride.id} ride={ride} onReport={setReporting} />)}
```

**Edit `src/pages/DriverRides.jsx`** — find:

```jsx
                    {history.map((ride) => <DriverRideCard key={ride.id} ride={ride} />)}
```

replace with:

```jsx
                    {history.map((ride) => <DriverRideCard key={ride.id} ride={ride} onReport={setReporting} />)}
```

`load` is declared after these lines in the file but before anything calls `onReported`, so the reference is safe. The dialog goes at the end of the page:

**Edit `src/pages/DriverRides.jsx`** — find:

```jsx
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

replace with:

```jsx
              </section>
            )}
          </div>
        )}
      </div>

      <RideReportDialog
        open={!!reporting} ride={reporting} role="driver"
        onClose={() => setReporting(null)} onSubmitted={onReported}
      />
    </div>
  );
}
```

- [ ] **Step 7: Offer it on the guest's driver card**

`DriverCard` only knew the ride's id. It now receives the ride and a callback, and shows a quiet link under the driver's details.

**Edit `src/components/booking/RideBookingsSection.jsx`** — find:

```jsx
  CreditCard, Phone, UserRound,
} from 'lucide-react';
```

replace with:

```jsx
  CreditCard, Phone, UserRound, Flag,
} from 'lucide-react';
import RideReportDialog from '@/components/rides/RideReportDialog';
```

**Edit `src/components/booking/RideBookingsSection.jsx`** — find:

```jsx
const DriverCard = React.memo(function DriverCard({ rideId }) {
```

replace with:

```jsx
const DriverCard = React.memo(function DriverCard({ rideId, canReport, alreadyReported, onReport }) {
```

**Edit `src/components/booking/RideBookingsSection.jsx`** — find:

```jsx
          <span className="text-xs text-emerald-900 dark:text-emerald-100">
            {driver.pickup_instructions}
          </span>
        </div>
      )}
```

replace with:

```jsx
          <span className="text-xs text-emerald-900 dark:text-emerald-100">
            {driver.pickup_instructions}
          </span>
        </div>
      )}

      {/* getRideBookings decides whether this is offered: a paid ride with a
          driver, from its start until a week after it ends, not yet reported. */}
      {alreadyReported ? (
        <p className="mt-3 pt-3 border-t border-emerald-200 dark:border-emerald-900 text-xs text-emerald-900 dark:text-emerald-100">
          You reported a problem with this ride. The team has it.
        </p>
      ) : canReport && onReport ? (
        <div className="mt-3 pt-3 border-t border-emerald-200 dark:border-emerald-900">
          <button
            type="button" onClick={onReport}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:underline py-1"
          >
            <Flag className="w-3.5 h-3.5" /> Report a problem with this driver
          </button>
        </div>
      ) : null}
```

**Edit `src/components/booking/RideBookingsSection.jsx`** — find:

```jsx
const RideCard = React.memo(function RideCard({ ride, onCancel, cancelling }) {
```

replace with:

```jsx
const RideCard = React.memo(function RideCard({ ride, onCancel, cancelling, onReport }) {
```

**Edit `src/components/booking/RideBookingsSection.jsx`** — find:

```jsx
            <DriverCard rideId={ride.id} />
```

replace with:

```jsx
            <DriverCard
              rideId={ride.id}
              canReport={!!ride.can_report}
              alreadyReported={!!ride.already_reported}
              onReport={onReport ? () => onReport(ride) : undefined}
            />
```

**Edit `src/components/booking/RideBookingsSection.jsx`** — find:

```jsx
  const [cancellingId, setCancellingId] = useState(null);
```

replace with:

```jsx
  const [cancellingId, setCancellingId] = useState(null);
  const [reporting, setReporting] = useState(null); // the ride being reported
```

**Edit `src/components/booking/RideBookingsSection.jsx`** — find:

```jsx
                  cancelling={cancellingId === r.id}
                  onCancel={setConfirmCancel}
                />
```

replace with:

```jsx
                  cancelling={cancellingId === r.id}
                  onCancel={setConfirmCancel}
                  onReport={setReporting}
                />
```

**Edit `src/components/booking/RideBookingsSection.jsx`** — find:

```jsx
                  <RideCard key={r.id} ride={r} cancelling={false} onCancel={setConfirmCancel} />
```

replace with:

```jsx
                  <RideCard key={r.id} ride={r} cancelling={false} onCancel={setConfirmCancel} onReport={setReporting} />
```

**Edit `src/components/booking/RideBookingsSection.jsx`** — find:

```jsx
            <AlertDialogAction onClick={doCancel} className="bg-red-600 hover:bg-red-700 text-white">
              Yes, cancel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
```

replace with:

```jsx
            <AlertDialogAction onClick={doCancel} className="bg-red-600 hover:bg-red-700 text-white">
              Yes, cancel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RideReportDialog
        open={!!reporting} ride={reporting} role="guest"
        onClose={() => setReporting(null)}
        onSubmitted={(outcome) => {
          setReporting(null);
          toast(outcome === 'already'
            ? { title: 'Already reported', description: 'You have already reported this ride. The team has it.' }
            : { title: 'Report sent', description: 'Thank you. The team will look into it.' });
          load(true);
        }}
      />
```

- [ ] **Step 8: Lint and build**

Run: `npm run lint`

Expected: no output, exit code 0.

Run: `set -a; . ./.env; set +a; npm run build`

Expected: `✓ built in …`.

- [ ] **Step 9: Look at it (sandbox, after the next publish)**

1. As a driver on a ride in progress: the card shows "Report this customer". Pick a category, type nine characters. Expected: Send report is disabled and the hint reads "At least 10 characters." Finish the description, add a photo, send. Expected: "Report sent"; the card now reads "You reported this ride. The team will be in touch."
2. As the guest of a ride that has started: the driver card shows "Report a problem with this driver". Send one. Expected: "Report sent"; the link is replaced by "You reported a problem with this ride."
3. On a ride that has not started, or ended more than a week ago: neither side sees the button.
4. Both dialogs in dark mode at 375 wide: chips wrap, the selected chip is white with dark text, the error box is readable, nothing scrolls sideways.

- [ ] **Step 10: Commit**

```bash
git add scripts/check-ride-reports.mjs src/config/rides.js src/components/rides/RideReportDialog.jsx src/pages/DriverRides.jsx src/components/booking/RideBookingsSection.jsx
git commit -m "feat(rides): report dialog for drivers and guests" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task B07: The Reports inbox for admin

**Files:**
- Modify: `scripts/check-ride-reports.mjs` (photo sources section, above `// ---- result ----`)
- Modify: `src/config/rides.js` (one helper, appended)
- Create: `src/components/admin/RideReportsAdmin.jsx`
- Modify: `src/components/admin/RidesAdmin.jsx` (fourth inner tab)

**Interfaces:**
- Consumes: entity `RideReport`, read directly with `base44.entities.RideReport.list` (admin-only at the API, and this screen only renders for an admin); `resolveRideReport` and its `effect` answer (Task B03); `invokeFn` (wallet plan, Task A10).
- Produces: `safePhotoUrl(url) → string | null` in `src/config/rides.js`; default export `RideReportsAdmin`; `RidesAdmin` gains a `reports` inner tab.

- [ ] **Step 1: Write the failing check**

`createRideReport` refuses anything that is not a plain https link, but rows can also be written from the Base44 data browser. The inbox therefore checks again before it uses a stored value as an image source.

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Photos on the admin inbox ──────────────────────────────────────────────
// Review focus 2, second line of defence: what the inbox will use as <img src>.
console.log('\n— photo sources —');
check('an uploaded photo is shown', rides.safePhotoUrl('https://base44.app/files/a.jpg'), 'https://base44.app/files/a.jpg');
for (const bad of [
  'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'http://example.com/a.jpg', 'data:image/png;base64,AAAA',
  '//example.com/a.jpg', ' https://example.com/a.jpg', 'https://example.com/a b.jpg',
  'https://example.com/a.jpg" onerror="x', '', null, undefined, 42, {},
]) {
  check(`${JSON.stringify(bad) ?? String(bad)} is not used as an image source`, rides.safePhotoUrl(bad), null);
}

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-ride-reports.mjs`

Expected: `TypeError: rides.safePhotoUrl is not a function`.

- [ ] **Step 3: Add the helper**

**Edit `src/config/rides.js`** — find:

```js
export const REPORT_LIMITS = { minDescription: 10, maxDescription: 2000, maxPhotos: 3 };
```

replace with:

```js
export const REPORT_LIMITS = { minDescription: 10, maxDescription: 2000, maxPhotos: 3 };

// A stored report photo, if it is safe to use as an <img src>: a plain https
// link with no spaces, quotes or angle brackets. Same rule the server applies
// when a report is filed; applied again here because a row can also be typed
// into the data browser. Anything else is simply not shown.
export const safePhotoUrl = (url) =>
  (typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null);
```

- [ ] **Step 4: Run the check and watch it pass**

Run: `node scripts/check-ride-reports.mjs`

Expected: `PASS`, including every line under `— photo sources —`.

- [ ] **Step 5: Create the inbox**

**Create `src/components/admin/RideReportsAdmin.jsx`:**

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, RefreshCw, Flag, AlertCircle, ShieldAlert, UserRound, Car } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { invokeFn } from '@/lib/invokeFn';
import { useToast } from '@/components/ui/use-toast';
import { safePhotoUrl } from '@/config/rides';

// RideReportsAdmin — complaints about rides, from drivers about guests and
// from guests about drivers, and what admin decided about each.
//
// Reads RideReport directly: the entity is admin-only at the API, so this
// list only ever loads for an admin. Every decision goes through
// resolveRideReport, which applies or lifts a block and tells the reporter
// their report was looked at.
//
// A guest's complaint that is still open or being reviewed holds the driver's
// pay for that ride. Closing it here is what lets the pay go.

const fmtWhen = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return '—'; }
};

const FILTERS = [
  { value: 'needs-attention', label: 'Needs attention' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' },
];

const STATUS_STYLE = {
  open: { label: 'Open', className: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-200 dark:border-red-900' },
  reviewing: { label: 'Reviewing', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900' },
  resolved: { label: 'Resolved', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900' },
  dismissed: { label: 'Dismissed', className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700' },
};

const CATEGORY_WORDS = {
  rude: 'Rude', abusive: 'Abusive', threatening: 'Threatening', unsafe: 'Unsafe',
  no_show: 'No-show', damage: 'Damage', other: 'Other',
};

// The decisions admin can take. Each is one call to resolveRideReport.
const DECISIONS = {
  reviewing: {
    button: 'Mark reviewing', title: 'Mark as being reviewed?', status: 'reviewing',
    body: 'Shows the team you are on it. Nothing else changes.',
    done: 'Marked as reviewing',
  },
  dismiss: {
    button: 'Dismiss', title: 'Dismiss this report?', status: 'dismissed',
    body: 'Closes the report with no action taken.',
    done: 'Report dismissed',
  },
  warn: {
    button: 'Warn', title: 'Resolve with a warning', status: 'resolved', action_taken: 'warning',
    body: 'Records that the person was warned. It does not stop them using the app; speak to them yourself.',
    done: 'Resolved with a warning',
  },
  block: {
    button: 'Block', title: 'Resolve and block', status: 'resolved', action_taken: 'blocked', danger: true,
    done: 'Resolved and blocked',
  },
  unblock: {
    button: 'Lift block', title: 'Lift the block?', status: 'resolved', action_taken: 'warning',
    body: 'Keeps the report resolved, with a warning instead of a block.',
    done: 'Block lifted',
  },
};

// Who a block lands on, in words.
const blockBody = (report) => (report.reported_driver_id
  ? `${report.reported_name || 'This driver'} is switched to inactive and stops appearing when rides are assigned. Switch them back on from the Drivers tab if you change your mind.`
  : `${report.reported_name || 'This guest'} can no longer request rides. They are told to contact support.`);

const EFFECT_WORDS = {
  guest_blocked: 'The guest can no longer request rides.',
  guest_unblocked: 'The guest can request rides again.',
  guest_not_found: 'No account was found for that guest email, so nothing was blocked.',
  driver_deactivated: 'The driver is now inactive.',
};

const decisionsFor = (report) => {
  if (report.status === 'open') return ['reviewing', 'dismiss', 'warn', 'block'];
  if (report.status === 'reviewing') return ['dismiss', 'warn', 'block'];
  // A guest block can be lifted from here. A driver is switched back on from
  // the Drivers tab, where it may have been switched off for other reasons.
  if (report.status === 'resolved' && report.action_taken === 'blocked' && !report.reported_driver_id) return ['unblock'];
  return [];
};

export default function RideReportsAdmin() {
  const { toast } = useToast();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('needs-attention');
  const [pending, setPending] = useState(null); // { report, key }
  const [notes, setNotes] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const rows = await base44.entities.RideReport.list('-created_date', 200);
      setReports(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (err) {
      console.error('Could not load ride reports:', err);
      setError(err?.message || 'Could not load the reports.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = (report, key) => {
    setNotes(report.admin_notes || '');
    setPending({ report, key });
  };

  const confirm = async () => {
    if (!pending) return;
    const { report, key } = pending;
    const decision = DECISIONS[key];
    setWorking(true);
    const r = await invokeFn('resolveRideReport', {
      report_id: report.id,
      status: decision.status,
      action_taken: decision.action_taken,
      admin_notes: notes,
    });
    setWorking(false);
    if (!r.ok) {
      toast({ title: 'Not saved', description: r.error, variant: 'destructive' });
      return;
    }
    setPending(null);
    toast({
      title: decision.done,
      description: EFFECT_WORDS[r.data?.effect] || `Ride ${report.booking_reference || ''}`.trim(),
      variant: r.data?.effect === 'guest_not_found' ? 'destructive' : undefined,
    });
    await load(true);
  };

  const needsAttention = (r) => r.status === 'open' || r.status === 'reviewing';
  const shown = filter === 'all' ? reports
    : filter === 'needs-attention' ? reports.filter(needsAttention)
      : reports.filter((r) => r.status === filter);
  const waiting = reports.filter(needsAttention).length;
  const decision = pending ? DECISIONS[pending.key] : null;

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-slate-900 dark:text-white">
            <Flag className="w-5 h-5 text-red-500 dark:text-red-400 flex-shrink-0" />
            Ride reports
            {waiting > 0 ? (
              <Badge className="bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-0">
                {waiting} waiting
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            A guest&apos;s complaint holds the driver&apos;s pay for that ride until you close it here.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-10 w-44 rounded-xl"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            variant="outline" size="icon" onClick={() => load(true)} disabled={refreshing}
            className="rounded-xl flex-shrink-0" aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {error && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400 dark:text-slate-500" />
          </div>
        ) : shown.length === 0 ? (
          <p className="text-center text-slate-500 dark:text-slate-400 py-10 text-sm">
            {filter === 'needs-attention'
              ? 'No reports waiting.'
              : `Nothing under "${FILTERS.find((f) => f.value === filter)?.label}".`}
          </p>
        ) : (
          <div className="space-y-3">
            {shown.map((r) => {
              const style = STATUS_STYLE[r.status] || STATUS_STYLE.open;
              const byDriver = r.reporter_role === 'driver';
              const photos = (Array.isArray(r.evidence_urls) ? r.evidence_urls : []).map(safePhotoUrl).filter(Boolean);
              const actions = decisionsFor(r);
              return (
                <div key={r.id} className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <Badge className={`${style.className} border font-medium`}>{style.label}</Badge>
                    <Badge variant="outline" className="text-xs">{CATEGORY_WORDS[r.category] || r.category}</Badge>
                    {r.booking_reference && (
                      <Badge variant="outline" className="text-xs font-mono">{r.booking_reference}</Badge>
                    )}
                    {r.action_taken === 'blocked' && (
                      <Badge className="bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-0 text-xs">
                        <ShieldAlert className="w-3 h-3 mr-1" /> Blocked
                      </Badge>
                    )}
                    {r.action_taken === 'warning' && (
                      <Badge className="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-0 text-xs">Warned</Badge>
                    )}
                    {!byDriver && (r.status === 'open' || r.status === 'reviewing') && (
                      <Badge variant="outline" className="text-xs">Holding the driver&apos;s pay</Badge>
                    )}
                  </div>

                  <p className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-200">
                    {byDriver
                      ? <Car className="w-4 h-4 flex-shrink-0 mt-0.5 text-slate-400 dark:text-slate-500" />
                      : <UserRound className="w-4 h-4 flex-shrink-0 mt-0.5 text-slate-400 dark:text-slate-500" />}
                    <span className="break-words">
                      <span className="font-semibold text-slate-900 dark:text-white">{r.reporter_name || r.reporter_email}</span>
                      {byDriver ? ' (driver) reported guest ' : ' (guest) reported driver '}
                      <span className="font-semibold text-slate-900 dark:text-white">{r.reported_name || r.reported_email || 'unknown'}</span>
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {[r.vehicle_name, r.service_date, `filed ${fmtWhen(r.created_date)}`].filter(Boolean).join(' · ')}
                  </p>

                  {/* The reporter's own words. Rendered as text; React escapes it. */}
                  <p className="mt-3 text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap break-words">
                    {r.description}
                  </p>

                  {photos.length > 0 && (
                    <div className="mt-3 flex gap-2 flex-wrap">
                      {photos.map((url) => (
                        <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                          <img
                            src={url} alt="Photo attached to the report" loading="lazy"
                            className="w-20 h-20 rounded-lg object-cover border border-slate-200 dark:border-slate-800"
                          />
                        </a>
                      ))}
                    </div>
                  )}

                  {r.admin_notes && (
                    <p className="mt-3 text-xs text-slate-500 dark:text-slate-400 italic break-words">
                      Note: {r.admin_notes}
                    </p>
                  )}
                  {r.resolved_at && (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Closed {fmtWhen(r.resolved_at)}{r.resolved_by ? ` by ${r.resolved_by}` : ''}
                    </p>
                  )}

                  {actions.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap gap-2">
                      {actions.map((key) => (
                        <Button
                          key={key} size="sm" variant="outline" onClick={() => open(r, key)}
                          className={DECISIONS[key].danger
                            ? 'rounded-xl border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
                            : 'rounded-xl'}
                        >
                          {DECISIONS[key].button}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={!!pending} onOpenChange={(o) => { if (!o && !working) setPending(null); }}>
        <DialogContent className="max-w-md">
          {pending && decision && (
            <>
              <DialogHeader>
                <DialogTitle>{decision.title}</DialogTitle>
                <DialogDescription>
                  {pending.report.reporter_name || pending.report.reporter_email} about {pending.report.reported_name || pending.report.reported_email || 'unknown'}
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {pending.key === 'block' ? blockBody(pending.report) : decision.body}
              </p>
              <div>
                <Label htmlFor="rr-notes">Note for the team (optional)</Label>
                <Textarea
                  id="rr-notes" rows={3} value={notes} maxLength={1000}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Never shown to the guest or the driver" className="mt-1 rounded-xl"
                />
              </div>
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setPending(null)} disabled={working} className="rounded-xl">
                  Cancel
                </Button>
                <Button
                  onClick={confirm} disabled={working}
                  className={decision.danger
                    ? 'rounded-xl bg-red-600 hover:bg-red-700 text-white'
                    : 'rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'}
                >
                  {working ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  {decision.button}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
```

- [ ] **Step 6: Add the tab**

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
  Check, X, CalendarClock, UserPlus, Inbox, IdCard, Banknote,
} from 'lucide-react';
```

replace with:

```jsx
  Check, X, CalendarClock, UserPlus, Inbox, IdCard, Banknote, Flag,
} from 'lucide-react';
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
import DriverEarningsAdmin from '@/components/admin/DriverEarningsAdmin';
```

replace with:

```jsx
import DriverEarningsAdmin from '@/components/admin/DriverEarningsAdmin';
import RideReportsAdmin from '@/components/admin/RideReportsAdmin';
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
      <TabsList className="grid w-full grid-cols-3 max-w-xl">
```

replace with:

```jsx
      <TabsList className="grid w-full grid-cols-4 max-w-2xl">
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
        <TabsTrigger value="earnings">
          <Banknote className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Earnings</span>
        </TabsTrigger>
      </TabsList>
```

replace with:

```jsx
        <TabsTrigger value="earnings">
          <Banknote className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Earnings</span>
        </TabsTrigger>
        <TabsTrigger value="reports">
          <Flag className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Reports</span>
        </TabsTrigger>
      </TabsList>
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
      <TabsContent value="earnings">
        <DriverEarningsAdmin />
      </TabsContent>
```

replace with:

```jsx
      <TabsContent value="earnings">
        <DriverEarningsAdmin />
      </TabsContent>

      <TabsContent value="reports">
        <RideReportsAdmin />
      </TabsContent>
```

- [ ] **Step 7: Lint and build**

Run: `npm run lint`

Expected: no output, exit code 0.

Run: `set -a; . ./.env; set +a; npm run build`

Expected: `✓ built in …`.

- [ ] **Step 8: Look at it (sandbox, after the next publish)**

1. Admin → Rides → Reports with one driver report and one guest report open. Expected: both listed under Needs attention; the guest's carries "Holding the driver's pay"; photos show as thumbnails that open in a new tab.
2. Mark one reviewing, then Warn it with a note. Expected: it leaves Needs attention; under Resolved it shows "Warned", the note and who closed it.
3. Block the other. Expected: the dialog says who the block lands on; the toast says what happened ("The guest can no longer request rides." or "The driver is now inactive.").
4. On a resolved, blocked guest report: Lift block. Expected: "The guest can request rides again."
5. In the Base44 data browser, set one report's `evidence_urls` to `["javascript:alert(1)"]` and reload. Expected: no thumbnail for it, nothing runs.
6. Dark mode and 375 wide: four tab icons fit, badges wrap, dialogs are readable.

- [ ] **Step 9: Commit**

```bash
git add scripts/check-ride-reports.mjs src/config/rides.js src/components/admin/RideReportsAdmin.jsx src/components/admin/RidesAdmin.jsx
git commit -m "feat(rides): Reports inbox for admin" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task B08: Ship and verify

No new behaviour. This task takes the reports feature to production and proves it end to end. Like Task A15 of the wallet plan, it needs the Base44 connector authorised, a workspace plan that can run backend functions, and the owner's go-ahead to publish. If both plans ship together, do Task A15's steps 3 to 6 once for both.

**Files:**
- Modify: `scripts/check-deploy.sh` (the reports table, the two reports functions and a client marker)

**Interfaces:**
- Consumes: everything in Tasks B01 to B07 and the wallet plan.
- Produces: the feature live.

- [ ] **Step 1: Teach the deploy check about reports**

**Edit `scripts/check-deploy.sh`** — find:

```bash
readable function refusals|Could not reach the server. Check your connection and try again.
```

replace with:

```bash
readable function refusals|Could not reach the server. Check your connection and try again.
ride report dialog|Report a problem with this driver
```

**Edit `scripts/check-deploy.sh`** — find:

```bash
for e in VehicleCosting DriverEarning; do
```

replace with:

```bash
for e in VehicleCosting DriverEarning RideReport; do
```

**Edit `scripts/check-deploy.sh`** — find:

```bash
         settleDriverEarning completeRide; do
```

replace with:

```bash
         settleDriverEarning completeRide createRideReport resolveRideReport; do
```

- [ ] **Step 2: Everything passes locally**

Run: `bash -n scripts/check-deploy.sh && npm run lint && npm run check && (set -a; . ./.env; set +a; npm run build)`

Expected: no lint output, five `PASS` lines, `✓ built in …`.

Run: `for f in createRideReport resolveRideReport checkRideAvailability autoCancelExpiredBookings settleDriverEarning getDriverRides getDriverWallet getRideBookings; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null --log-level=error || echo "PARSE FAIL $f"; done`

Expected: no output.

- [ ] **Step 3: Schemas, then publish**

Follow Task A15 of the wallet plan, steps 3 to 5, with two additions for this plan: create `RideReport` (`create_entity_schema`) and update `User` (`update_entity_schema`, whole file, so `ride_blocked` arrives with its admin-only write rule). Both changes are additive and safe under the client that is live.

Verify with `list_entity_schemas`: `RideReport` has all four operations admin-only; `User.ride_blocked` carries `rls.write` for admin.

Then Publish, and run `scripts/check-deploy.sh`. Expected: every marker passes and no function answers 404 or 402.

- [ ] **Step 4: Walk a report through, both ways**

1. Driver reports guest: as the driver of a ride in progress, Report this customer, category Abusive, a sentence, one photo. Expected: "Report sent"; a "🚩 RIDE REPORT" message in the admin Telegram group; the report under Admin → Rides → Reports.
2. Run the sweep after that ride's release time. Expected: the driver's pay IS released. A driver's own report does not hold their pay.
3. As admin: Block. Expected: "The guest can no longer request rides."
4. As that guest: request any ride. Expected: "Ride bookings are not available on this account. Please contact support." on the request screen.
5. As admin: Lift block. As the guest: request again. Expected: it goes through.
6. Guest reports driver: as the guest of another ride that has started, Report a problem with this driver. Run the sweep after its release time. Expected: that pay is NOT released; the driver's wallet shows "Under review".
7. As admin: Dismiss it. Run the sweep. Expected: the pay is released.

- [ ] **Step 5: Dark mode**

Screenshot the report dialog (both roles) and Admin → Rides → Reports in light and dark at 1280 and 375 wide, with the scanner from the September design review.

Expected: no light islands other than intentional white primary buttons, no text under 2.5:1, no horizontal scroll at 375.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-deploy.sh
git commit -m "chore(rides): deploy check covers ride reports" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
