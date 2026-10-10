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

