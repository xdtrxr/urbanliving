# Driver Wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every driver on the roster a sign-in, a per-ride pay ledger that is held when a paid ride is assigned to them and released two hours after the booked end time, and a way to withdraw the released money to their bank.

**Architecture:** Admin links a Driver record to a normal app login by email; two members-only pages read the driver's rides and wallet through two new functions. Money lives in a `DriverEarning` ledger (one row per driver per ride, `held → released | reversed`). The available balance is never stored: it is released rows minus the driver's withdrawals, recomputed by one `walletTotals` helper wherever it is needed. The existing five-minute sweep completes rides and releases rows, and the existing withdrawal stack learns a second wallet. Admin gets a pay figure in the assign dialog, a Mark completed button and an Earnings tab.

**Tech Stack:** Base44 Deno functions (`npm:@base44/sdk@0.8.27`), Base44 entity schemas (JSON with per-operation access rules), React 18 + Vite + Tailwind + shadcn/ui, `@tanstack/react-query` v5, Paystack transfers, Telegram and web push (all existing). Checks: eslint, node scripts under `scripts/` that execute the shipped helpers off disk, esbuild parse for functions, vite build.

**Spec:** `docs/superpowers/specs/2026-10-07-driver-wallet-and-reports-design.md` (read the Amendments section first).

## Global Constraints

- NGN only. Amounts are whole naira; every sum is over `Math.round`ed integers.
- Every instant is pinned to WAT (`+01:00`). Derive a ride's window with `windowOf(ride)`; never `new Date(service_date)`.
- A Base44 function directory cannot import from another. Shared helpers are copied with a `// lockstep copy, see <origin>` comment, and `scripts/check-driver-wallet.mjs` fails if two copies differ by one character or if the shipped copy computes a wrong value.
- Every helper the check script executes is a top-level `function name(...) {` (or `async function name(...) {`) whose first line holds the whole signature and whose closing `}` sits alone in column 0. Its body is plain JavaScript (no type annotations inside the body), because the script swaps only the first line.
- All writes to `Driver`, `DriverEarning`, `RideBooking` and `WithdrawalRequest` made by this feature go through functions under `asServiceRole`. `DriverEarning` is admin-only at the API for all four operations.
- No stored driver balance anywhere. No driver pay figure on `RideBooking` (guests can read their own row).
- Entity changes are additive only, so a checkpoint cannot break the client that is live today.
- Function responses use the envelope `{ success: true, data }` or `{ success: false, error: '<sentence a person can act on>', code: 'SCREAMING_CASE' }` with an HTTP status (400 validation, 401, 403, 404, 409 state conflict, 500).
- A bare `entity.filter(query)` returns 50 rows. Anything that can exceed a handful goes through the `fetchAll` paginator.
- Dark mode: every `bg-*`, `text-*`, `border-*` on a surface has a `dark:` twin; primary buttons are `bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200`. Never write `{n && n > 0 && ...}` (it renders a literal 0); compare first.
- Release buffer 2 hours (`RELEASE_BUFFER_MS` on the server, `RELEASE_BUFFER_HOURS` on the client). Withdrawal minimum ₦10,000 (`WITHDRAWAL_THRESHOLD_NGN`) for both wallets. One withdrawal in flight per person across both wallets. Pay ceiling per ride ₦50,000,000 (`MAX_PAYOUT_NGN`).
- No new npm dependencies.
- One commit per task, message prefix `feat(rides):`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to read the steps

File changes are written as one of three operations, each followed by the exact content:

- **Create `path`:** the file does not exist; create it with exactly this content.
- **Replace `path` with:** overwrite the whole file with exactly this content.
- **Edit `path`** — find: … replace with: … The find-block occurs exactly once in the file. Replace it with the second block and change nothing else.

Commands that are not available here: there is no Deno locally, so a function is checked with `node_modules/.bin/esbuild <file> --format=esm --target=esnext --outfile=/dev/null` (exit 0 means it parses) and its pure helpers are executed by the check script. A local build needs the env file: `set -a; . ./.env; set +a; npm run build`.

## Review Focus

Five things the spec implies, that a person will hit, and that are easy to get wrong. Each has a pinned check in the task that owns the code.

1. **A login email typed with capitals or a trailing space** (`Emeka@Gmail.com `). The driver must still find their rides, and withdrawals made under an earlier email must still count against their balance. Pinned in Task A08 (`driverEmails`, `driverWithdrawals` cases) and Task A06 (the form stores it trimmed and lower-cased).
2. **Pay reversed after the driver already withdrew it.** Available must read ₦0, never a negative number, and the shortfall must be carried so their next released pay nets against it. Pinned in Task A08 (`walletTotals` shortfall cases).
3. **Admin types `25,000`, `-5`, `abc` or `9e12` as the pay.** The request is refused with `INVALID_PAYOUT`; no `NaN` or absurd figure reaches the ledger. Pinned in Task A02 (`parsePayoutOverride` cases).
4. **A ride row written before `start_at` and `end_at` existed, and a ride that ends at midnight.** The window is derived in WAT, so the ride completes and the pay releases at the right instant; a row with no readable time never completes on its own. Pinned in Task A05 (`rideEnded`, `isReleasable` cases with exact UTC instants).
5. **An old Paystack reference replayed on a ride that is already completed or was cancelled after payment.** Nothing changes: the ride is not flipped back to confirmed and no notification fires. Pinned in Task A05 (`rideAlreadyPaid` cases against both shipped copies).

---

### Task A01: Entities and the entity check script

**Files:**
- Create: `scripts/check-entities.mjs`
- Create: `base44/entities/DriverEarning.jsonc`
- Modify: `base44/entities/RideBooking.jsonc` (after `linked_property_booking_id`)
- Modify: `base44/entities/WithdrawalRequest.jsonc` (after `admin_notes`)
- Modify: `base44/entities/Driver.jsonc` (after `admin_approved`)
- Modify: `base44/entities/UserBankAccount.jsonc` (the `read` rule)
- Modify: `package.json` (the `check` script)

**Interfaces:**
- Consumes: nothing.
- Produces: entity `DriverEarning` with fields `driver_id, ride_booking_id, booking_reference, vehicle_name, service_date, end_at, amount_ngn, basis ('hourly'|'daily'|'manual'), rate_ngn, units, status ('held'|'released'|'reversed'), on_hold, hold_reason, release_at, held_at, released_at, reversed_at, adjusted_at, adjustment_reason, admin_notes`; `RideBooking.completed_at`, `RideBooking.completed_by ('system'|'admin')`; `WithdrawalRequest.wallet ('referral'|'driver', default 'referral')`, `WithdrawalRequest.driver_id`; `Driver.user_email`, `Driver.previous_user_emails (string[])`; admin read on `UserBankAccount`. `npm run check` now also runs `scripts/check-entities.mjs`.

- [ ] **Step 1: Write the failing check**

**Create `scripts/check-entities.mjs`:**

```js
// Entity schema checks — run with: node scripts/check-entities.mjs
//
// WHY THIS LIVES IN THE REPO
// A Base44 checkpoint applies whatever is in base44/entities/ to the live
// database. A typo in an access rule is therefore a production incident, not a
// failed build, and nothing else in this repo so much as parses these files.
// This script parses every schema and pins the rules that money and privacy
// depend on, so a careless edit fails CI instead of going live.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'base44/entities');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  ${detail}`}`);
};

// The files are .jsonc, so comments are legal. Strip them without touching a
// "//" that sits inside a string (descriptions contain URLs).
function stripComments(src) {
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      i += 1;
    } else if (c === '"') {
      inString = true;
      out += c;
      i += 1;
    } else if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

// ── Every schema: parses, is named after its file, requires only real fields ─
console.log('\n— structure —');
const entities = {};
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonc')).sort()) {
  const stem = file.replace(/\.jsonc$/, '');
  let parsed;
  try {
    parsed = JSON.parse(stripComments(fs.readFileSync(path.join(DIR, file), 'utf8')));
  } catch (err) {
    check(`${file} parses`, false, err.message);
    continue;
  }
  entities[stem] = parsed;
  const missing = (parsed.required || []).filter((k) => !(k in (parsed.properties || {})));
  check(
    `${file}`,
    parsed.name === stem && missing.length === 0,
    parsed.name !== stem ? `name is "${parsed.name}"` : `required but not defined: ${missing.join(', ')}`,
  );
}

const ADMIN = JSON.stringify({ user_condition: { role: 'admin' } });
const adminOnly = (rule) => JSON.stringify(rule) === ADMIN;
const OWNER = JSON.stringify({ 'data.user_email': '{{user.email}}' });
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && b.every((v, i) => a[i] === v);
const prop = (entity, field) => entities[entity]?.properties?.[field];
const fieldNames = (entity) => Object.keys(entities[entity]?.properties || {});
const OPS = ['create', 'read', 'update', 'delete'];

// ── Driver wallet ──────────────────────────────────────────────────────────
console.log('\n— driver wallet —');
check('DriverEarning exists', !!entities.DriverEarning);
for (const f of [
  'driver_id', 'ride_booking_id', 'booking_reference', 'vehicle_name', 'service_date', 'end_at',
  'amount_ngn', 'basis', 'rate_ngn', 'units', 'status', 'on_hold', 'hold_reason', 'release_at',
  'held_at', 'released_at', 'reversed_at', 'adjusted_at', 'adjustment_reason', 'admin_notes',
]) {
  check(`DriverEarning.${f}`, !!prop('DriverEarning', f));
}
check('DriverEarning.status is held | released | reversed',
  sameList(prop('DriverEarning', 'status')?.enum, ['held', 'released', 'reversed']));
check('DriverEarning.status defaults to held', prop('DriverEarning', 'status')?.default === 'held');
check('DriverEarning.basis is hourly | daily | manual',
  sameList(prop('DriverEarning', 'basis')?.enum, ['hourly', 'daily', 'manual']));
// Rows carry admin notes, so not even the driver reads them through the API.
for (const op of OPS) {
  check(`DriverEarning ${op} is admin-only`, adminOnly(entities.DriverEarning?.rls?.[op]));
}

check('RideBooking.completed_at is a date-time', prop('RideBooking', 'completed_at')?.format === 'date-time');
check('RideBooking.completed_by is system | admin',
  sameList(prop('RideBooking', 'completed_by')?.enum, ['system', 'admin']));
// A guest can read their own RideBooking row, so the driver's pay must never
// become a column on it. The figure lives on DriverEarning only.
check('RideBooking carries no driver pay figure',
  !fieldNames('RideBooking').some((k) => /payout|driver_pay|driver_cost/.test(k)));
// Guests must never be able to write a ride row directly.
check('RideBooking update is admin-only', adminOnly(entities.RideBooking?.rls?.update));

check('WithdrawalRequest.wallet is referral | driver',
  sameList(prop('WithdrawalRequest', 'wallet')?.enum, ['referral', 'driver']));
check('WithdrawalRequest.wallet defaults to referral', prop('WithdrawalRequest', 'wallet')?.default === 'referral');
check('WithdrawalRequest.driver_id', prop('WithdrawalRequest', 'driver_id')?.type === 'string');
check('WithdrawalRequest update is admin-only', adminOnly(entities.WithdrawalRequest?.rls?.update));

check('Driver.user_email', prop('Driver', 'user_email')?.type === 'string');
check('Driver.previous_user_emails is a string array',
  prop('Driver', 'previous_user_emails')?.type === 'array'
  && prop('Driver', 'previous_user_emails')?.items?.type === 'string');
for (const op of OPS) {
  check(`Driver ${op} is admin-only`, adminOnly(entities.Driver?.rls?.[op]));
}

// The available balance is derived from the ledger on demand. A stored number
// would need an atomic increment the platform does not have.
check('User has no stored driver balance', !fieldNames('User').some((k) => /driver_balance/.test(k)));
check('User.referral_balance_ngn is admin-write',
  adminOnly(prop('User', 'referral_balance_ngn')?.rls?.write));

const bankRead = entities.UserBankAccount?.rls?.read;
check('UserBankAccount read: owner or admin',
  Array.isArray(bankRead?.$or) && bankRead.$or.some(adminOnly)
  && bankRead.$or.some((r) => JSON.stringify(r) === OWNER));
for (const op of ['create', 'update', 'delete']) {
  check(`UserBankAccount ${op} stays owner-only`, JSON.stringify(entities.UserBankAccount?.rls?.[op]) === OWNER);
}

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-entities.mjs`

Expected: every line under `— structure —` is `ok`, then failures such as ` FAIL  DriverEarning exists`, ` FAIL  RideBooking.completed_at is a date-time`, ` FAIL  UserBankAccount read: owner or admin`, ending `FAIL — … passed, … failed` and exit code 1. If a structure line fails, stop: an existing schema is malformed and that is a separate problem.

- [ ] **Step 3: Add the ledger entity**

**Create `base44/entities/DriverEarning.jsonc`:**

```json
{
  "name": "DriverEarning",
  "type": "object",
  "description": "One row per driver per ride: what the driver is paid for it and where that money stands. Created HELD by assignRideDriver when a paid ride gets a driver who has a login, RELEASED by the sweep two hours after the booked end time (or by admin), REVERSED when the ride is cancelled or handed to another driver. A driver's available balance is never stored anywhere: it is released rows minus their driver-wallet withdrawals, recomputed on demand by walletTotals, so replaying a release cannot pay twice. Admin-only in every direction because rows carry internal notes; drivers read a trimmed view through getDriverWallet and getDriverRides.",
  "properties": {
    "driver_id": {
      "type": "string",
      "description": "FK to Driver. The wallet is keyed on this, never on an email, so relinking a driver to a new login keeps their history."
    },
    "ride_booking_id": {
      "type": "string",
      "description": "FK to RideBooking."
    },
    "booking_reference": {
      "type": "string",
      "description": "Snapshot of RideBooking.booking_reference (UD-XXXXXX) so the ledger reads without a join."
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
    "end_at": {
      "type": "string",
      "format": "date-time",
      "description": "Booked end of the ride at the moment of assignment, pinned to WAT like every ride instant."
    },
    "amount_ngn": {
      "type": "number",
      "description": "The driver's pay for this ride in whole naira."
    },
    "basis": {
      "type": "string",
      "enum": [
        "hourly",
        "daily",
        "manual"
      ],
      "description": "How amount_ngn was reached: rate_ngn x units from the vehicle's costing row, or a figure admin typed."
    },
    "rate_ngn": {
      "type": "number",
      "description": "The per-hour or per-day driver cost used. Equals amount_ngn for a manual figure."
    },
    "units": {
      "type": "number",
      "description": "Hours or days multiplied by rate_ngn. 1 for a manual figure."
    },
    "status": {
      "type": "string",
      "enum": [
        "held",
        "released",
        "reversed"
      ],
      "default": "held",
      "description": "held: counted as pending pay. released: counted toward the withdrawable balance. reversed: counted nowhere."
    },
    "on_hold": {
      "type": "boolean",
      "default": false,
      "description": "Admin pause. A held row with on_hold true is skipped by the release pass until admin lifts it."
    },
    "hold_reason": {
      "type": "string",
      "description": "Why admin paused the release. Not shown to the driver."
    },
    "release_at": {
      "type": "string",
      "format": "date-time",
      "description": "Earliest moment the sweep may release the row: end_at plus two hours."
    },
    "held_at": {
      "type": "string",
      "format": "date-time"
    },
    "released_at": {
      "type": "string",
      "format": "date-time"
    },
    "reversed_at": {
      "type": "string",
      "format": "date-time"
    },
    "adjusted_at": {
      "type": "string",
      "format": "date-time",
      "description": "Last time admin changed amount_ngn."
    },
    "adjustment_reason": {
      "type": "string",
      "description": "Mandatory whenever admin changes amount_ngn, mirroring RideBooking.price_adjustment_reason."
    },
    "admin_notes": {
      "type": "string",
      "description": "Internal. Reassignment, cancellation and reversal reasons accumulate here. Never returned to the driver."
    }
  },
  "required": [
    "driver_id",
    "ride_booking_id",
    "amount_ngn",
    "status",
    "release_at"
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

- [ ] **Step 4: Add the fields to the existing entities**

**Edit `base44/entities/RideBooking.jsonc`** — find:

```json
    "linked_property_booking_id": {
      "type": "string",
      "description": "Optional FK to a Booking row when the ride was added from an existing property stay (Phase 3 hook)"
    }
  },
```

replace with:

```json
    "linked_property_booking_id": {
      "type": "string",
      "description": "Optional FK to a Booking row when the ride was added from an existing property stay (Phase 3 hook)"
    },
    "completed_at": {
      "type": "string",
      "format": "date-time",
      "description": "When the ride was marked completed. Set by the sweep once the booked window is over, or by admin through completeRide."
    },
    "completed_by": {
      "type": "string",
      "enum": [
        "system",
        "admin"
      ],
      "description": "Who completed it. The driver's pay is deliberately NOT stored on this row: a guest can read their own RideBooking, and the pay lives on DriverEarning."
    }
  },
```

**Edit `base44/entities/WithdrawalRequest.jsonc`** — find:

```json
    "admin_notes": {
      "type": "string",
      "description": "Internal notes from admin review"
    }
  },
```

replace with:

```json
    "admin_notes": {
      "type": "string",
      "description": "Internal notes from admin review"
    },
    "wallet": {
      "type": "string",
      "enum": [
        "referral",
        "driver"
      ],
      "default": "referral",
      "description": "Which money this pays out. referral: debited from User.referral_balance_ngn at request time and refunded on failure. driver: nothing is debited; the row itself is the reservation against the driver's released earnings, and a failed row simply stops counting. Rows written before this field existed are referral."
    },
    "driver_id": {
      "type": "string",
      "description": "FK to Driver, set only when wallet is driver. The driver's balance counts withdrawals by this id."
    }
  },
```

**Edit `base44/entities/Driver.jsonc`** — find:

```json
    "admin_approved": {
      "type": "boolean",
      "default": false,
      "description": "Admin must explicitly approve a driver before they can be assigned to bookings"
    }
  },
```

replace with:

```json
    "admin_approved": {
      "type": "boolean",
      "default": false,
      "description": "Admin must explicitly approve a driver before they can be assigned to bookings"
    },
    "user_email": {
      "type": "string",
      "description": "The login this driver signs in with, stored trimmed and lower-cased. Empty until admin links one; an unlinked driver is assigned as before and their pay is not tracked in the app."
    },
    "previous_user_emails": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Every login this driver was linked to before the current one. DriversAdmin appends the old address when user_email changes, so withdrawals made under it still count against the driver's balance."
    }
  },
```

**Edit `base44/entities/UserBankAccount.jsonc`** — find:

```json
    "read": {
      "data.user_email": "{{user.email}}"
    },
```

replace with:

```json
    "read": {
      "$or": [
        {
          "data.user_email": "{{user.email}}"
        },
        {
          "user_condition": {
            "role": "admin"
          }
        }
      ]
    },
```

- [ ] **Step 5: Put the script in the check chain**

**Edit `package.json`** — find:

```json
    "check": "node scripts/check-ride-time.mjs && node scripts/check-stay-price.mjs",
```

replace with:

```json
    "check": "node scripts/check-ride-time.mjs && node scripts/check-stay-price.mjs && node scripts/check-entities.mjs",
```

- [ ] **Step 6: Run it and watch it pass**

Run: `npm run check`

Expected: the two existing scripts print `PASS`, then `check-entities` prints only `ok` lines and `PASS — … passed, 0 failed`. Exit code 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-entities.mjs base44/entities/DriverEarning.jsonc base44/entities/RideBooking.jsonc base44/entities/WithdrawalRequest.jsonc base44/entities/Driver.jsonc base44/entities/UserBankAccount.jsonc package.json
git commit -m "feat(rides): driver earnings ledger entity and schema checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A02: The pay model, server and client copies

**Files:**
- Create: `scripts/check-driver-wallet.mjs`
- Modify: `base44/functions/assignRideDriver/entry.ts` (three pure helpers after `windowsOverlap`; not wired into the handler yet)
- Modify: `base44/functions/checkRideAvailability/entry.ts` (cap on multi-day bookings)
- Modify: `src/config/rides.js` (client mirror after `markupFor`)
- Modify: `package.json` (the `check` script)

**Interfaces:**
- Consumes: `VehicleCosting.driver_cost_per_hour_ngn`, `VehicleCosting.driver_cost_per_day_ngn` (existing).
- Produces, in `assignRideDriver/entry.ts`: `const RELEASE_BUFFER_MS`, `const MAX_PAYOUT_NGN`, `driverPayoutFor(costing, tier, hours, days) → { amount, basis: 'hourly'|'daily', rate, units } | null`, `releaseAtFor(endAtIso) → ISO string | null`, `parsePayoutOverride(raw) → { ok: boolean, value: number | null }` (`value: null` with `ok: true` means "nothing typed").
- Produces, in `src/config/rides.js`: `export const RELEASE_BUFFER_HOURS = 2`, `export const MAX_PAYOUT_NGN = 50000000`, `export function driverPayoutFor(costing, tier, { hours, days } = {})` with the same return shape.
- Produces, in `checkRideAvailability/entry.ts`: `const MAX_MULTI_DAYS = 30`, `multiDaysOk(days) → boolean`, and the refusal `INVALID_DAYS` (400) for a multi-day request outside 1–30 whole days.
- Produces, in `scripts/check-driver-wallet.mjs`: `constLine(fnDir, name)`, helpers `liftSrc(fnDir, fnName, signature)` (handles `function` and `async function`), `make(name, ...sources)`, `identical(fnName, signature, dirs)`, `check(name, got, want)`, `same(name, got, want)`, the constant strings `TIME` and `PAY`, and the marker line `// ---- result ----` that later tasks insert their sections above.

- [ ] **Step 1: Write the failing check**

**Create `scripts/check-driver-wallet.mjs`:**

```js
// Driver wallet model — run with: node scripts/check-driver-wallet.mjs
//
// WHY THIS LIVES IN THE REPO
// Base44 function directories cannot import a shared module, so every helper
// the driver wallet depends on is copied into each function that needs it,
// and the pay table has one more copy on the client. Nothing but this file
// stops those copies drifting, and here a drift is money: a driver quoted one
// figure and paid another, or a balance that two functions disagree about.
//
// This file does not re-implement what it tests. It reads the shipped
// functions off disk and executes them, and where a helper has several
// copies it also demands they are identical character for character.
//
// On the new Function() below: the only input is this repo's own source, read
// from paths this file computes itself. Nothing here is reachable from user
// input, a request body or the network; it is a developer script that never
// ships to the browser or to Deno.

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
// Exact value.
const check = (name, got, want) => report(Object.is(got, want), name, got, want);
// Structural equality, for the small objects the helpers return.
const same = (name, got, want) => report(JSON.stringify(got) === JSON.stringify(want), name, got, want);

// Lift one top-level function out of a shipped entry.ts as plain JavaScript.
// The convention every wallet helper follows makes this exact: the signature
// is the whole first line, the closing brace is alone in column 0, and the
// body carries no type annotations. Only the first line is rewritten.
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

// Evaluate lifted sources together and hand back one of them by name.
const make = (name, ...sources) => new Function(`${sources.join('\n')}\nreturn ${name};`)();

// The same helper must be textually identical in every function that carries it.
const identical = (fnName, signature, dirs) => {
  const [first, ...rest] = dirs.map((d) => liftSrc(d, fnName, signature));
  for (let i = 0; i < rest.length; i += 1) {
    check(`${fnName}: ${dirs[i + 1]} copy matches ${dirs[0]}`, rest[i] === first, true);
  }
};

// One shipped `const NAME = …;` line, so the helpers run against the real
// limits rather than against numbers retyped here.
function constLine(fnDir, name) {
  const file = FN(fnDir);
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`could not find const ${name} in ${path.relative(ROOT, file)}`);
  return line;
}

const TIME = 'const WAT_OFFSET = "+01:00"; const HOUR_MS = 3600000; const DAY_MS = 86400000; const MAX_HOURLY = 8;';
const PAY = `${TIME} ${constLine('assignRideDriver', 'RELEASE_BUFFER_MS')} ${constLine('assignRideDriver', 'MAX_PAYOUT_NGN')}`;

// ── Pay table: server vs the client mirror ─────────────────────────────────
// Admin sees the client figure in the Assign driver dialog; assignRideDriver
// writes the server figure to the ledger. They must be the same number.
console.log('\n— driver pay (server vs client mirror) —');
const driverPayoutFor = make('driverPayoutFor', PAY, liftSrc('assignRideDriver', 'driverPayoutFor', 'costing, tier, hours, days'));
const costing = { driver_cost_per_hour_ngn: 2500, driver_cost_per_day_ngn: 15000 };
const tiers = [
  ...rides.HOURLY_CHOICES.map((h) => ({ tier: 'hourly', hours: h, amount: 2500 * h, basis: 'hourly', units: h })),
  { tier: 'hourly', hours: undefined, amount: 2500, basis: 'hourly', units: 1 },
  { tier: 'hourly', hours: 20, amount: 20000, basis: 'hourly', units: 8 },
  { tier: '12hr', amount: 15000, basis: 'daily', units: 1 },
  { tier: '24hr', amount: 15000, basis: 'daily', units: 1 },
  { tier: 'multi_day', days: 3, amount: 45000, basis: 'daily', units: 3 },
  { tier: 'multi_day', days: 0, amount: 15000, basis: 'daily', units: 1 },
  { tier: 'weekly', amount: 105000, basis: 'daily', units: 7 },
  { tier: 'monthly', amount: 450000, basis: 'daily', units: 30 },
];
for (const c of tiers) {
  const label = `${c.tier}${c.hours !== undefined ? ` ${c.hours}h` : ''}${c.days !== undefined ? ` ${c.days}d` : ''}`;
  const server = driverPayoutFor(costing, c.tier, c.hours, c.days);
  const client = rides.driverPayoutFor(costing, c.tier, { hours: c.hours, days: c.days });
  check(`${label}: amount`, server?.amount, c.amount);
  check(`${label}: basis`, server?.basis, c.basis);
  check(`${label}: units`, server?.units, c.units);
  same(`${label}: client mirror agrees`, client, server);
}

console.log('\n— driver pay edges —');
check('no costing row gives no figure', driverPayoutFor(null, '24hr'), null);
check('no costing row, client', rides.driverPayoutFor(null, '24hr'), null);
check('unknown tier gives no figure', driverPayoutFor(costing, 'fortnight'), null);
check('unknown tier, client', rides.driverPayoutFor(costing, 'fortnight'), null);
check('hourly ride, no hourly driver cost', driverPayoutFor({ driver_cost_per_day_ngn: 15000 }, 'hourly', 3), null);
check('day ride, no daily driver cost', driverPayoutFor({ driver_cost_per_hour_ngn: 2500 }, '24hr'), null);
check('day ride, no daily driver cost, client', rides.driverPayoutFor({ driver_cost_per_hour_ngn: 2500 }, '24hr'), null);
check('zero rate is "not set", not free labour', driverPayoutFor({ driver_cost_per_hour_ngn: 0 }, 'hourly', 2), null);
check('negative rate is refused', driverPayoutFor({ driver_cost_per_day_ngn: -1 }, '24hr'), null);
check('rates stored as strings still work', driverPayoutFor({ driver_cost_per_hour_ngn: '2500' }, 'hourly', 2)?.amount, 5000);
// The duration is whatever the guest typed when booking. It must not be able
// to multiply the driver's pay into nonsense.
check('a duration of Infinity days gives no figure', driverPayoutFor(costing, 'multi_day', undefined, Infinity), null);
check('…client mirror', rides.driverPayoutFor(costing, 'multi_day', { days: Infinity }), null);
check('a duration that multiplies past the ceiling gives no figure', driverPayoutFor(costing, 'multi_day', undefined, 1e6), null);
check('…client mirror', rides.driverPayoutFor(costing, 'multi_day', { days: 1e6 }), null);
check('a mistyped rate past the ceiling gives no figure', driverPayoutFor({ driver_cost_per_day_ngn: 1e12 }, '24hr'), null);
check('…client mirror', rides.driverPayoutFor({ driver_cost_per_day_ngn: 1e12 }, '24hr'), null);
check('the ceiling itself is payable', driverPayoutFor({ driver_cost_per_day_ngn: 50000000 }, '24hr')?.amount, 50000000);
check('client ceiling is the server ceiling', rides.MAX_PAYOUT_NGN, make('MAX_PAYOUT_NGN', PAY));

// ── The booked duration, where the guest types it ──────────────────────────
// Everything above multiplies by a day count that arrives in a request body.
console.log('\n— booked duration —');
const multiDaysOk = make('multiDaysOk', constLine('checkRideAvailability', 'MAX_MULTI_DAYS'),
  liftSrc('checkRideAvailability', 'multiDaysOk', 'days'));
check('1 day is a booking', multiDaysOk(1), true);
check('30 days is the most the form offers', multiDaysOk(30), true);
check('31 days is refused', multiDaysOk(31), false);
check('a billion days is refused', multiDaysOk(1e9), false);
check('Infinity is refused', multiDaysOk(Infinity), false);
check('half days are refused', multiDaysOk(2.5), false);
check('zero is refused', multiDaysOk(0), false);
check('negative is refused', multiDaysOk(-3), false);
check('missing is refused', multiDaysOk(undefined), false);
check('a numeric string from a form still counts', multiDaysOk('7'), true);

// ── Release moment ─────────────────────────────────────────────────────────
console.log('\n— release moment —');
const releaseAtFor = make('releaseAtFor', PAY, liftSrc('assignRideDriver', 'releaseAtFor', 'endAtIso'));
check('two hours after the booked end', releaseAtFor('2026-08-10T10:00:00.000Z'), '2026-08-10T12:00:00.000Z');
// A ride ending 23:30 WAT releases the next calendar day; the instant must not wobble.
check('crosses midnight cleanly', releaseAtFor('2026-08-10T23:30:00+01:00'), '2026-08-11T00:30:00.000Z');
check('unreadable end gives no release time', releaseAtFor('not a date'), null);
check('missing end gives no release time', releaseAtFor(''), null);
// The last representable instant parses; two hours after it does not exist.
check('an end at the edge of the calendar gives none, without throwing', releaseAtFor('+275760-09-13T00:00:00.000Z'), null);
check('client constant agrees with the server buffer',
  (Date.parse(releaseAtFor('2026-08-10T10:00:00.000Z')) - Date.parse('2026-08-10T10:00:00.000Z')) / 3600000,
  rides.RELEASE_BUFFER_HOURS);

// ── The pay figure admin types ─────────────────────────────────────────────
// Review focus 3: nothing but a whole-naira amount in range may reach the ledger.
console.log('\n— typed pay figure —');
const parsePayoutOverride = make('parsePayoutOverride', PAY, liftSrc('assignRideDriver', 'parsePayoutOverride', 'raw'));
const NOTHING = { ok: true, value: null };
const REFUSED = { ok: false, value: null };
same('absent means "use the costing row"', parsePayoutOverride(undefined), NOTHING);
same('null means the same', parsePayoutOverride(null), NOTHING);
same('empty string means the same', parsePayoutOverride(''), NOTHING);
same('spaces only means the same', parsePayoutOverride('   '), NOTHING);
same('a number is taken as typed', parsePayoutOverride(25000), { ok: true, value: 25000 });
same('a numeric string is accepted', parsePayoutOverride(' 25000 '), { ok: true, value: 25000 });
same('zero is a real answer (pay arranged elsewhere)', parsePayoutOverride(0), { ok: true, value: 0 });
same('kobo are rounded away', parsePayoutOverride(2500.4), { ok: true, value: 2500 });
same('the ceiling itself is allowed', parsePayoutOverride(50000000), { ok: true, value: 50000000 });
same('one naira over the ceiling is refused', parsePayoutOverride(50000001), REFUSED);
same('"25,000" is refused, not read as 25', parsePayoutOverride('25,000'), REFUSED);
same('negative is refused', parsePayoutOverride(-5), REFUSED);
same('words are refused', parsePayoutOverride('abc'), REFUSED);
same('9e12 is refused', parsePayoutOverride(9e12), REFUSED);
same('"1e3" is refused, digits only', parsePayoutOverride('1e3'), REFUSED);
same('"0x10" is refused', parsePayoutOverride('0x10'), REFUSED);
same('"+5" is refused', parsePayoutOverride('+5'), REFUSED);
same('NaN is refused', parsePayoutOverride(NaN), REFUSED);
same('Infinity is refused', parsePayoutOverride(Infinity), REFUSED);
same('true is refused', parsePayoutOverride(true), REFUSED);
same('an array is refused', parsePayoutOverride([25000]), REFUSED);
same('an object is refused', parsePayoutOverride({ amount: 25000 }), REFUSED);

// ---- result ----
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: it stops with `Error: could not find const RELEASE_BUFFER_MS in base44/functions/assignRideDriver/entry.ts` and a non-zero exit code. That is the right failure: nothing of the pay model exists yet.

- [ ] **Step 3: Add the three helpers to the function**

They sit with the other pure helpers and are not called by the handler until Task A03.

**Edit `base44/functions/assignRideDriver/entry.ts`** — find:

```ts
function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number, buffer: number): boolean {
    return aStart < bEnd + buffer && aEnd + buffer > bStart;
}
```

replace with:

```ts
function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number, buffer: number): boolean {
    return aStart < bEnd + buffer && aEnd + buffer > bStart;
}

// ── Driver pay model ────────────────────────────────────────────────────────
// What a driver is paid for a ride, read off the vehicle's VehicleCosting row.
// MIRRORED client-side by driverPayoutFor in src/config/rides.js, which draws
// the figure in the Assign driver dialog before anything is submitted. This
// copy is the one that reaches the ledger; scripts/check-driver-wallet.mjs
// executes both and fails if they disagree for any duration tier.
//
// Held pay becomes releasable two hours after the booked end, so an
// extra-hour settlement or a complaint from either side can land first.
const RELEASE_BUFFER_MS = 2 * HOUR_MS;
const MAX_PAYOUT_NGN = 50000000;

function driverPayoutFor(costing: any, tier: string, hours?: number, days?: number) {
    if (!costing) return null;
    const perHour = Math.round(Number(costing.driver_cost_per_hour_ngn) || 0);
    const perDay = Math.round(Number(costing.driver_cost_per_day_ngn) || 0);
    let basis = 'daily';
    let rate = perDay;
    let units = 1;
    switch (tier) {
        case 'hourly':
            basis = 'hourly';
            rate = perHour;
            units = Math.min(MAX_HOURLY, Math.max(1, Math.round(Number(hours) || 1)));
            break;
        case '12hr':
        case '24hr':
            break;
        case 'multi_day':
            units = Math.max(1, Math.round(Number(days) || 1));
            break;
        case 'weekly':
            units = 7;
            break;
        case 'monthly':
            units = 30;
            break;
        default:
            return null;
    }
    // Zero means "nobody entered a driver cost", never "this driver is free".
    if (rate <= 0) return null;
    // The booked duration is whatever the guest typed at request time and the
    // rate is whatever admin typed. A product that is not a finite amount
    // under the ceiling is not a pay figure: return nothing, so the dialog
    // asks admin to type one.
    const amount = rate * units;
    if (!Number.isFinite(amount) || amount > MAX_PAYOUT_NGN) return null;
    return { amount, basis, rate, units };
}

function releaseAtFor(endAtIso: string) {
    const endMs = Date.parse(endAtIso || '');
    if (Number.isNaN(endMs)) return null;
    // An end at the very edge of the representable range parses, but two
    // hours later does not exist and toISOString would throw on it.
    const release = new Date(endMs + RELEASE_BUFFER_MS);
    if (Number.isNaN(release.getTime())) return null;
    return release.toISOString();
}

// The pay figure admin typed, if any. { ok: true, value: null } means nothing
// was typed and the costing row decides. Anything that is not a whole-naira
// amount between 0 and the ceiling is refused rather than coerced, so NaN or
// "25,000" read as 25 can never reach the ledger.
function parsePayoutOverride(raw: unknown) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null };
    // Plain digits only. Number() would also swallow "1e3", "0x10" and "+5".
    if (typeof raw === 'string' && !/^\d{1,9}(\.\d+)?$/.test(raw.trim())) return { ok: false, value: null };
    const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PAYOUT_NGN) {
        return { ok: false, value: null };
    }
    return { ok: true, value: Math.round(n) };
}
```

- [ ] **Step 4: Add the client mirror**

**Edit `src/config/rides.js`** — find:

```js
    daily: line(vehicle?.price_24hr_ngn, costing?.partner_cost_per_day_ngn, costing?.driver_cost_per_day_ngn),
  };
}
```

replace with:

```js
    daily: line(vehicle?.price_24hr_ngn, costing?.partner_cost_per_day_ngn, costing?.driver_cost_per_day_ngn),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What a driver is paid for a ride, read off the vehicle's VehicleCosting row.
//
// MIRROR of driverPayoutFor in base44/functions/assignRideDriver/entry.ts. The
// server figure is the one written to the driver's ledger; this exists only so
// the Assign driver dialog can show admin the number before they confirm.
// scripts/check-driver-wallet.mjs runs both and fails if they ever disagree.
// ─────────────────────────────────────────────────────────────────────────────
// Held pay becomes releasable this long after the booked end of the ride.
export const RELEASE_BUFFER_HOURS = 2;

// No single ride pays a driver more than this. Mirror of MAX_PAYOUT_NGN in
// assignRideDriver; the check script compares the two.
export const MAX_PAYOUT_NGN = 50000000;

const MAX_HOURLY_HOURS = 8;

export function driverPayoutFor(costing, tier, { hours, days } = {}) {
  if (!costing) return null;
  const perHour = Math.round(Number(costing.driver_cost_per_hour_ngn) || 0);
  const perDay = Math.round(Number(costing.driver_cost_per_day_ngn) || 0);
  let basis = 'daily';
  let rate = perDay;
  let units = 1;
  switch (tier) {
    case 'hourly':
      basis = 'hourly';
      rate = perHour;
      units = Math.min(MAX_HOURLY_HOURS, Math.max(1, Math.round(Number(hours) || 1)));
      break;
    case '12hr':
    case '24hr':
      break;
    case 'multi_day':
      units = Math.max(1, Math.round(Number(days) || 1));
      break;
    case 'weekly':
      units = 7;
      break;
    case 'monthly':
      units = 30;
      break;
    default:
      return null;
  }
  // Zero means "nobody entered a driver cost", never "this driver is free".
  if (rate <= 0) return null;
  // A booked duration or a mistyped rate that multiplies past the ceiling is
  // not a pay figure. Same rule as the server, so the dialog shows "enter the
  // pay" in exactly the cases the server would refuse.
  const amount = rate * units;
  if (!Number.isFinite(amount) || amount > MAX_PAYOUT_NGN) return null;
  return { amount, basis, rate, units };
}
```

- [ ] **Step 5: Bound the booked duration where the guest types it**

The driver's pay, the guest's price and the length of time the vehicle is blocked all multiply by `duration_days`, which arrives in a request body. The booking form stops at 30 (`max={30}` on the days input in `src/pages/RideCheckout.jsx`); the server accepted any number of 1 or more, so a hand-made request for a billion days produced an unpayable ride that blocked the vehicle until admin rejected it.

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
const MAX_HOURLY = 8;
```

replace with:

```ts
const MAX_HOURLY = 8;
// The booking form stops at 30 days (longer hires go by the week or month).
// The server has to say so too: the day count multiplies straight into the
// price, the driver's pay and the length of time the vehicle is blocked.
const MAX_MULTI_DAYS = 30;

function multiDaysOk(days: unknown) {
    const d = Number(days);
    return Number.isInteger(d) && d >= 1 && d <= MAX_MULTI_DAYS;
}
```

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
        if (duration_tier === 'multi_day' && (!Number(duration_days) || Number(duration_days) < 1)) {
            return json({ success: false, error: 'multi_day bookings need duration_days of at least 1' }, 400);
        }
```

replace with:

```ts
        if (duration_tier === 'multi_day' && !multiDaysOk(duration_days)) {
            return json({
                success: false,
                error: `Multi-day bookings are for 1 to ${MAX_MULTI_DAYS} whole days. For longer, book by the week or the month.`,
                code: 'INVALID_DAYS',
            }, 400);
        }
```

- [ ] **Step 6: Put the script in the check chain**

**Edit `package.json`** — find:

```json
 && node scripts/check-entities.mjs",
```

replace with:

```json
 && node scripts/check-entities.mjs && node scripts/check-driver-wallet.mjs",
```

- [ ] **Step 7: Run it and watch it pass**

Run: `npm run check`

Expected: four `PASS` lines, the last one from `check-driver-wallet` with `0 failed`.

Run: `for f in assignRideDriver checkRideAvailability; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done`

Expected: no `PARSE FAIL` line.

- [ ] **Step 8: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/assignRideDriver/entry.ts base44/functions/checkRideAvailability/entry.ts src/config/rides.js package.json
git commit -m "feat(rides): driver pay model with a server and client copy held in lockstep" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A03: `assignRideDriver` holds the driver's pay

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (in-memory entity stand-in and the assignment ledger section, above `// ---- result ----`)
- Modify: `base44/functions/assignRideDriver/entry.ts` (header comment; two ledger helpers after `fetchAll`; the handler)

**Interfaces:**
- Consumes: `driverPayoutFor`, `releaseAtFor`, `parsePayoutOverride`, `RELEASE_BUFFER_MS` (Task A02); entity `DriverEarning`, `Driver.user_email` (Task A01); the file's existing `fetchAll(entity, query)`, `windowOf(ride)`, `tryPush(sdk, opts)`.
- Produces, in `assignRideDriver/entry.ts`: `safeIso(ms) → ISO string | null`, `async holdEarning(sr, ride, driverId, payout, endAtIso, nowIso) → DriverEarning row | null` (throws when `endAtIso` is unreadable) and `async reverseHeldEarnings(sr, rideId, keepDriverId, note, nowIso) → { reversed_ngn, released_ngn, driver_ids }` (pass `''` as `keepDriverId` to reverse every held row on the ride).
- Request body gains optional `driver_payout_ngn`. New refusals: `INVALID_PAYOUT` (400), `PAYOUT_REQUIRED` (409), `BAD_WINDOW` (409). Success `data` gains `pay_tracked: boolean`, `driver_payout_ngn: number | null`, `payout_basis: 'hourly'|'daily'|'manual'|null`, `earning_id: string | null`, `previous_earning_released: boolean`.
- Produces, in `scripts/check-driver-wallet.mjs`: `fakeEntity(seed)` and the constant string `FETCH_ALL`, reused by later tasks.

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Assignment ledger ──────────────────────────────────────────────────────
// holdEarning and reverseHeldEarnings are the only code that creates or
// cancels a driver's pay at assignment time, so they run here against an
// in-memory stand-in for the DriverEarning entity.

// Just enough of one Base44 entity for the ledger helpers: exact-match filter
// (plus { $in: [...] }), create, update, get.
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
  };
}
// The shipped fetchAll carries type annotations in its body, so the lifted
// helpers get this equivalent instead. It is glue, not the code under test.
const FETCH_ALL = 'async function fetchAll(entity, query) { const out = []; for (let skip = 0; ; skip += 500) { const page = await entity.filter(query, undefined, 500, skip); out.push(...page); if (page.length < 500) break; } return out; }';

console.log('\n— assignment ledger —');
const holdEarning = make('holdEarning', PAY, FETCH_ALL,
  liftSrc('assignRideDriver', 'releaseAtFor', 'endAtIso'),
  liftSrc('assignRideDriver', 'holdEarning', 'sr, ride, driverId, payout, endAtIso, nowIso'));
const reverseHeldEarnings = make('reverseHeldEarnings', FETCH_ALL,
  liftSrc('assignRideDriver', 'reverseHeldEarnings', 'sr, rideId, keepDriverId, note, nowIso'));

const rideA = { id: 'ride1', booking_reference: 'UD-AAA111', vehicle_name: 'Prado', service_date: '2026-08-10' };
const END = '2026-08-10T10:00:00.000Z';
const NOW = '2026-08-09T09:00:00.000Z';
const dayPay = { amount: 15000, basis: 'daily', rate: 15000, units: 1 };
const heldRow = (id, driver, extra = {}) => ({
  id, created_date: '2025-12-31T00:00:00.000Z', ride_booking_id: 'ride1', driver_id: driver,
  amount_ngn: 15000, status: 'held', ...extra,
});

{
  const sr = { DriverEarning: fakeEntity() };
  const e = await holdEarning(sr, rideA, 'drvA', dayPay, END, NOW);
  check('first assignment writes one row', sr.DriverEarning.rows.length, 1);
  check('…held', e.status, 'held');
  check('…for the pay figure', e.amount_ngn, 15000);
  check('…with the audit trail', `${e.basis}/${e.rate_ngn}/${e.units}`, 'daily/15000/1');
  check('…releasable two hours after the booked end', e.release_at, '2026-08-10T12:00:00.000Z');
  check('…snapshotting the ride', `${e.booking_reference}/${e.vehicle_name}/${e.service_date}`, 'UD-AAA111/Prado/2026-08-10');
  const again = await holdEarning(sr, rideA, 'drvA', { ...dayPay, amount: 99999 }, END, NOW);
  check('assigning the same driver again writes no second row', sr.DriverEarning.rows.length, 1);
  check('…and the first figure stands', again.amount_ngn, 15000);
}
{
  const sr = { DriverEarning: fakeEntity() };
  check('a ₦0 figure holds nothing', await holdEarning(sr, rideA, 'drvA', { ...dayPay, amount: 0 }, END, NOW), null);
  check('no figure holds nothing', await holdEarning(sr, rideA, 'drvA', null, END, NOW), null);
  check('…and neither writes a row', sr.DriverEarning.rows.length, 0);
}
{
  // Reassignment: A was holding, B takes the ride.
  const sr = { DriverEarning: fakeEntity([heldRow('a1', 'drvA'), heldRow('x1', 'drvA', { ride_booking_id: 'other-ride' })]) };
  const b = await holdEarning(sr, rideA, 'drvB', dayPay, END, NOW);
  const out = await reverseHeldEarnings(sr, 'ride1', 'drvB', 'Reassigned to B', NOW);
  const row = (id) => sr.DriverEarning.rows.find((r) => r.id === id);
  check('reassignment holds pay for the new driver', b.status, 'held');
  check('…reverses the previous driver', row('a1').status, 'reversed');
  check('…stamps when and why', `${row('a1').reversed_at}|${row('a1').admin_notes}`, `${NOW}|Reassigned to B`);
  check('…leaves the new driver held', row(b.id).status, 'held');
  check('…never touches another ride', row('x1').status, 'held');
  same('…and reports what moved', out, { reversed_ngn: 15000, released_ngn: 0, driver_ids: ['drvA'] });
}
{
  // The previous driver's pay had already been released: it is not clawed back
  // silently, it is reported so admin can decide.
  const sr = { DriverEarning: fakeEntity([heldRow('a1', 'drvA', { status: 'released' })]) };
  const out = await reverseHeldEarnings(sr, 'ride1', 'drvB', 'Reassigned to B', NOW);
  check('a released row is left alone on reassignment', sr.DriverEarning.rows[0].status, 'released');
  same('…and reported', out, { reversed_ngn: 0, released_ngn: 15000, driver_ids: [] });
}
{
  // Cancellation passes '' and reverses everyone still holding.
  const sr = { DriverEarning: fakeEntity([heldRow('a1', 'drvA'), heldRow('b1', 'drvB', { amount_ngn: 20000, admin_notes: 'earlier note' })]) };
  const out = await reverseHeldEarnings(sr, 'ride1', '', 'Ride cancelled', NOW);
  check('cancel reverses every held row', sr.DriverEarning.rows.every((r) => r.status === 'reversed'), true);
  check('…keeping earlier notes', sr.DriverEarning.rows[1].admin_notes, 'earlier note | Ride cancelled');
  same('…and totals it', out, { reversed_ngn: 35000, released_ngn: 0, driver_ids: ['drvA', 'drvB'] });
}
{
  // Two admins assign in the same second: this call's first read is stale, so
  // it creates a twin. The oldest row must stand and the twin be reversed.
  const base = fakeEntity([heldRow('old', 'drvB')]);
  let stale = true;
  const racy = { ...base, filter: async (...a) => { if (stale) { stale = false; return []; } return base.filter(...a); } };
  const kept = await holdEarning({ DriverEarning: racy }, rideA, 'drvB', dayPay, END, NOW);
  check('a simultaneous double assign keeps the oldest row', kept.id, 'old');
  check('…and reverses the twin', base.rows.filter((r) => r.status === 'held').length, 1);
  check('…saying why', base.rows.find((r) => r.id !== 'old').admin_notes, 'Duplicate of old');
}
{
  // A ride whose end is not a real date has no moment to release at.
  const sr = { DriverEarning: fakeEntity() };
  let threw = false;
  try { await holdEarning(sr, rideA, 'drvA', dayPay, 'not a date', NOW); } catch { threw = true; }
  check('an unreadable ride end is refused loudly', threw, true);
  check('…and writes nothing', sr.DriverEarning.rows.length, 0);
}
const safeIso = make('safeIso', liftSrc('assignRideDriver', 'safeIso', 'ms'));
check('safeIso: a real instant round-trips', safeIso(Date.parse(END)), END);
check('safeIso: Infinity is not a date', safeIso(Infinity), null);
check('safeIso: NaN is not a date', safeIso(NaN), null);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: every earlier line is `ok`, then `Error: could not find holdEarning in base44/functions/assignRideDriver/entry.ts`.

- [ ] **Step 3: Say what the function now does**

**Edit `base44/functions/assignRideDriver/entry.ts`** — find:

```ts
// Enforces driver availability with the same overlap rule used for vehicles,
// filtered on driver_id — a driver cannot be in two cars at once any more than
// a car can be in two places.
```

replace with:

```ts
// Enforces driver availability with the same overlap rule used for vehicles,
// filtered on driver_id — a driver cannot be in two cars at once any more than
// a car can be in two places.
//
// Also the moment the driver's pay is HELD. For a driver who has a login
// (Driver.user_email), a DriverEarning row is written for the pay figure —
// what admin typed, or the vehicle's driver cost for the booked duration.
// The sweep releases it two hours after the booked end. A driver without a
// login is assigned exactly as before and nothing is recorded.
```

- [ ] **Step 4: Add the two ledger helpers**

**Edit `base44/functions/assignRideDriver/entry.ts`** — find:

```ts
        if (page.length < PAGE) break;
    }
    return out;
}
```

replace with:

```ts
        if (page.length < PAGE) break;
    }
    return out;
}

// ── Driver earnings ledger ──────────────────────────────────────────────────
// Bodies are plain JavaScript on purpose: scripts/check-driver-wallet.mjs
// lifts these two off disk and runs them against an in-memory ledger.

// ISO string for an instant, or null when it is not a representable date. A
// ride's end is derived from the duration the guest booked, so it is checked
// before anything calls toISOString on it.
function safeIso(ms: number) {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Hold the new driver's pay. Returns the earning that now stands for this
// driver on this ride, or null when there is nothing to hold. Safe to call
// twice: a standing row is returned as it is, never duplicated or repriced.
async function holdEarning(sr: any, ride: any, driverId: string, payout: any, endAtIso: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: ride.id });
    const standing = ledger.find((e) => e.driver_id === driverId && e.status !== 'reversed');
    if (standing) return standing;
    if (!payout || !(payout.amount > 0)) return null;
    // No readable end means no moment to release at. Refuse loudly rather
    // than write a row that could never be paid out.
    const releaseAt = releaseAtFor(endAtIso);
    if (!releaseAt) throw new Error('holdEarning: this ride has no readable end time');
    await sr.DriverEarning.create({
        driver_id: driverId,
        ride_booking_id: ride.id,
        booking_reference: ride.booking_reference || '',
        vehicle_name: ride.vehicle_name || '',
        service_date: ride.service_date,
        end_at: endAtIso,
        amount_ngn: payout.amount,
        basis: payout.basis,
        rate_ngn: payout.rate,
        units: payout.units,
        status: 'held',
        on_hold: false,
        release_at: releaseAt,
        held_at: nowIso,
    });
    // Two admins assigning in the same second would both reach this line. The
    // oldest held row for this driver and ride stands; any twin is reversed.
    const twins = await fetchAll(sr.DriverEarning, { ride_booking_id: ride.id, driver_id: driverId, status: 'held' });
    twins.sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
        || String(a.id).localeCompare(String(b.id)));
    for (const extra of twins.slice(1)) {
        await sr.DriverEarning.update(extra.id, {
            status: 'reversed', reversed_at: nowIso, admin_notes: `Duplicate of ${twins[0].id}`,
        });
    }
    return twins[0] || null;
}

// Reverse the pay still HELD on a ride for every driver except keepDriverId
// (pass '' to reverse all of it). Released rows are never clawed back here;
// they are totalled so the caller can tell admin. Lockstep copy in
// cancelRideBooking.
async function reverseHeldEarnings(sr: any, rideId: string, keepDriverId: string, note: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: rideId });
    const out = { reversed_ngn: 0, released_ngn: 0, driver_ids: [] };
    for (const e of ledger) {
        if (keepDriverId && e.driver_id === keepDriverId) continue;
        const amount = Math.max(0, Math.round(Number(e.amount_ngn) || 0));
        if (e.status === 'held') {
            await sr.DriverEarning.update(e.id, {
                status: 'reversed',
                reversed_at: nowIso,
                on_hold: false,
                admin_notes: e.admin_notes ? `${e.admin_notes} | ${note}` : note,
            });
            out.reversed_ngn += amount;
            if (!out.driver_ids.includes(e.driver_id)) out.driver_ids.push(e.driver_id);
        } else if (e.status === 'released') {
            out.released_ngn += amount;
        }
    }
    return out;
}
```

- [ ] **Step 5: Accept the pay figure in the request**

**Edit `base44/functions/assignRideDriver/entry.ts`** — find:

```ts
        const { ride_booking_id, driver_id, pickup_instructions } = await req.json().catch(() => ({}));
```

replace with:

```ts
        const { ride_booking_id, driver_id, pickup_instructions, driver_payout_ngn } = await req.json().catch(() => ({}));
```

- [ ] **Step 6: Resolve the pay and hold it before the ride is updated**

The order matters and is the reason this is safe without transactions: hold the new driver's pay, then put them on the ride, then reverse the previous driver's pay (Step 7). If the function dies after any one of those, the release pass added in Task A05 finds an earning whose ride belongs to someone else and reverses it instead of paying it, and calling this function again reuses the row written here.

**Edit `base44/functions/assignRideDriver/entry.ts`** — find:

```ts
        const reassigning = !!ride.driver_id && ride.driver_id !== driver_id;
        await base44.asServiceRole.entities.RideBooking.update(ride_booking_id, {
            driver_id,
            driver_assigned_at: new Date().toISOString(),
```

replace with:

```ts
        const sr = base44.asServiceRole.entities;
        const reassigning = !!ride.driver_id && ride.driver_id !== driver_id;
        const nowIso = new Date().toISOString();

        // ── Driver pay ──────────────────────────────────────────────────
        // Tracked only for a driver who has a login to see it with. ₦0 is a
        // real answer ("paid inside the partner's rate") and holds nothing;
        // no figure at all is refused so nobody drives for an unknown amount.
        const linkedEmail = typeof driver.user_email === 'string' ? driver.user_email.trim().toLowerCase() : '';
        let payout: any = null;
        if (linkedEmail) {
            const typed = parsePayoutOverride(driver_payout_ngn);
            if (!typed.ok) {
                return json({
                    success: false,
                    error: 'Driver pay must be a whole naira amount between 0 and 50,000,000.',
                    code: 'INVALID_PAYOUT',
                }, 400);
            }
            if (typed.value !== null) {
                payout = { amount: typed.value, basis: 'manual', rate: typed.value, units: 1 };
            } else {
                const costings = await sr.VehicleCosting.filter({ vehicle_id: ride.vehicle_id });
                payout = driverPayoutFor(costings?.[0] || null, ride.duration_tier, ride.duration_hours, ride.duration_days);
                if (!payout) {
                    return json({
                        success: false,
                        error: 'No driver cost is set for this vehicle. Enter the pay for this ride, or set it under Vehicles → Internal costing.',
                        code: 'PAYOUT_REQUIRED',
                    }, 409);
                }
            }
        }

        // The ride's end comes from what the guest booked. One that is not a
        // real date cannot be released against, so stop here with a message
        // rather than let toISOString throw further down.
        const endAtIso = safeIso(win.endMs);
        if (linkedEmail && (!endAtIso || !releaseAtFor(endAtIso))) {
            return json({ success: false, error: 'This ride has an unreadable time window', code: 'BAD_WINDOW' }, 409);
        }

        const earning = linkedEmail
            ? await holdEarning(sr, ride, driver_id, payout, endAtIso, nowIso)
            : null;

        await sr.RideBooking.update(ride_booking_id, {
            driver_id,
            driver_assigned_at: nowIso,
```

The double-booking refusal a few lines above builds its `conflict` object with `toISOString()` on another ride's window. A corrupt row there would turn a clear 409 into a 500, so it uses `safeIso` too.

**Edit `base44/functions/assignRideDriver/entry.ts`** — find:

```ts
                        start_at: new Date(ow.startMs).toISOString(),
                        end_at: new Date(ow.endMs).toISOString(),
```

replace with:

```ts
                        start_at: safeIso(ow.startMs),
                        end_at: safeIso(ow.endMs),
```

- [ ] **Step 7: Reverse what the previous driver was holding**

**Edit `base44/functions/assignRideDriver/entry.ts`** — find:

```ts
                ? { pickup_instructions: pickup_instructions.trim() }
                : {}),
        });
```

replace with:

```ts
                ? { pickup_instructions: pickup_instructions.trim() }
                : {}),
        });

        // Runs for every assignment, linked driver or not: handing a ride to
        // someone else must always take it off the previous driver's ledger.
        const others = await reverseHeldEarnings(sr, ride_booking_id, driver_id, `Reassigned to ${driver.full_name}`, nowIso);
```

- [ ] **Step 8: Tell both drivers, and report the pay in the response**

**Edit `base44/functions/assignRideDriver/entry.ts`** — find:

```ts
            tag: `ride-driver-${ride.id}`,
        });

        return json({
            success: true,
            data: { ride_booking_id, driver_id, driver_name: driver.full_name, reassigned: reassigning },
        });
```

replace with:

```ts
            tag: `ride-driver-${ride.id}`,
        });

        // The driver hears about it too, now that they have somewhere to look.
        const whenShort = new Date(win.startMs).toLocaleString('en-GB', {
            timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
        });
        if (linkedEmail) {
            await tryPush(base44, {
                user_email: linkedEmail,
                title: '🚗 New ride assigned',
                body: earning && earning.status === 'held'
                    ? `${ride.vehicle_name} on ${whenShort} · ₦${(Number(earning.amount_ngn) || 0).toLocaleString()} held until the trip ends`
                    : `${ride.vehicle_name} on ${whenShort}. Tap for the pickup details.`,
                url: `/DriverRides#ride-${ride.id}`,
                tag: `driver-assigned-${ride.id}`,
            });
        }
        if (reassigning) {
            try {
                const previous = await sr.Driver.get(ride.driver_id);
                const previousEmail = typeof previous?.user_email === 'string' ? previous.user_email.trim().toLowerCase() : '';
                if (previousEmail) {
                    await tryPush(base44, {
                        user_email: previousEmail,
                        title: '🔄 Ride reassigned',
                        body: `You are no longer driving the ${ride.vehicle_name} on ${whenShort}.`,
                        url: '/DriverRides',
                        tag: `driver-removed-${ride.id}`,
                    });
                }
            } catch (err) {
                console.warn('Previous driver push failed (non-fatal):', err);
            }
        }

        return json({
            success: true,
            data: {
                ride_booking_id,
                driver_id,
                driver_name: driver.full_name,
                reassigned: reassigning,
                // false means this driver has no login, so nothing was recorded.
                pay_tracked: !!linkedEmail,
                driver_payout_ngn: earning ? Number(earning.amount_ngn) || 0 : (payout ? payout.amount : null),
                payout_basis: earning ? earning.basis || null : (payout ? payout.basis : null),
                earning_id: earning ? earning.id : null,
                // The previous driver's pay was already released and has NOT
                // been taken back. Admin decides in Rides → Earnings.
                previous_earning_released: others.released_ngn > 0,
            },
        });
```

- [ ] **Step 9: Run the checks**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, including every line under `— assignment ledger —`.

Run: `node_modules/.bin/esbuild base44/functions/assignRideDriver/entry.ts --format=esm --target=esnext --outfile=/dev/null`

Expected: exit code 0.

- [ ] **Step 10: Sandbox checklist (after the next publish; the handler cannot run locally)**

1. Give a test driver a login email (Task A06 adds the field; until then set `user_email` on the Driver row in the Base44 data browser).
2. Assign that driver to a paid test ride from Admin → Rides. Expected: toast "Driver assigned"; one `DriverEarning` row for the ride, `status: held`, `release_at` two hours after the ride's `end_at`.
3. Assign a second linked driver to the same ride. Expected: the first row is `reversed` with `admin_notes` "Reassigned to <name>", a new `held` row exists for the second driver.
4. Assign a driver with no login email to another paid ride. Expected: success, no `DriverEarning` row, response `pay_tracked: false`.
5. On a vehicle with no costing row, assign a linked driver without typing a pay figure. Expected: refused with "No driver cost is set for this vehicle…".

- [ ] **Step 11: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/assignRideDriver/entry.ts
git commit -m "feat(rides): assignRideDriver holds the driver's pay in the earnings ledger" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A04: Cancelling a ride reverses its held pay

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (one lockstep assertion, above `// ---- result ----`)
- Modify: `base44/functions/cancelRideBooking/entry.ts` (three helpers after the constants; `notifyAdmin` gains a line; the handler)

**Interfaces:**
- Consumes: `reverseHeldEarnings(sr, rideId, keepDriverId, note, nowIso)` (Task A03, copied here character for character); entity `DriverEarning`; `Driver.user_email`.
- Produces: no new exports. `cancelRideBooking` keeps its request and response shape. The admin Telegram message gains a "Driver pay reversed" or "Driver pay ALREADY RELEASED" line when there was pay on the ride, and a linked driver gets a "Ride cancelled" push.

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Cancellation uses the same reversal as reassignment ────────────────────
console.log('\n— cancellation —');
identical('reverseHeldEarnings', 'sr, rideId, keepDriverId, note, nowIso', ['assignRideDriver', 'cancelRideBooking']);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: could not find reverseHeldEarnings in base44/functions/cancelRideBooking/entry.ts`.

- [ ] **Step 3: Give the function a paginator, a push helper and the reversal**

`cancelRideBooking` has never needed to read more than one row or notify anyone but admin, so it has none of the three.

**Edit `base44/functions/cancelRideBooking/entry.ts`** — find:

```ts
const HOUR_MS = 60 * 60 * 1000;
const MIN_NOTICE_MS = 24 * HOUR_MS;
```

replace with:

```ts
const HOUR_MS = 60 * 60 * 1000;
const MIN_NOTICE_MS = 24 * HOUR_MS;

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

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

// Reverse the pay still HELD on a ride for every driver except keepDriverId
// (pass '' to reverse all of it). Released rows are never clawed back here;
// they are totalled so the caller can tell admin. Lockstep copy, see
// assignRideDriver; scripts/check-driver-wallet.mjs fails if the two differ.
async function reverseHeldEarnings(sr: any, rideId: string, keepDriverId: string, note: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: rideId });
    const out = { reversed_ngn: 0, released_ngn: 0, driver_ids: [] };
    for (const e of ledger) {
        if (keepDriverId && e.driver_id === keepDriverId) continue;
        const amount = Math.max(0, Math.round(Number(e.amount_ngn) || 0));
        if (e.status === 'held') {
            await sr.DriverEarning.update(e.id, {
                status: 'reversed',
                reversed_at: nowIso,
                on_hold: false,
                admin_notes: e.admin_notes ? `${e.admin_notes} | ${note}` : note,
            });
            out.reversed_ngn += amount;
            if (!out.driver_ids.includes(e.driver_id)) out.driver_ids.push(e.driver_id);
        } else if (e.status === 'released') {
            out.released_ngn += amount;
        }
    }
    return out;
}
```

- [ ] **Step 4: Let the admin message carry a pay line**

**Edit `base44/functions/cancelRideBooking/entry.ts`** — find:

```ts
async function notifyAdmin(ride: any, byAdmin: boolean) {
```

replace with:

```ts
async function notifyAdmin(ride: any, byAdmin: boolean, payLine = '') {
```

**Edit `base44/functions/cancelRideBooking/entry.ts`** — find:

```ts
        `The vehicle is free again for that window.`;
```

replace with:

```ts
        `The vehicle is free again for that window.` + payLine;
```

- [ ] **Step 5: Reverse the pay when the ride is cancelled**

**Edit `base44/functions/cancelRideBooking/entry.ts`** — find:

```ts
        await notifyAdmin(ride, isAdmin && ride.guest_email !== user.email);
```

replace with:

```ts
        // The driver's pay follows the ride. A failure here must not undo the
        // cancellation: the release pass in autoCancelExpiredBookings reverses
        // any held row whose ride is cancelled, so this is belt and braces.
        // Only a ride that ever had a driver can have pay on it.
        let payLine = '';
        if (ride.driver_id) {
            try {
                const sr = base44.asServiceRole.entities;
                const pay = await reverseHeldEarnings(sr, ride_booking_id, '', 'Ride cancelled', new Date().toISOString());
                if (pay.reversed_ngn > 0) {
                    payLine += `\n• Driver pay reversed: ₦${pay.reversed_ngn.toLocaleString()}`;
                }
                if (pay.released_ngn > 0) {
                    payLine += `\n• Driver pay ALREADY RELEASED: ₦${pay.released_ngn.toLocaleString()} — review in Rides → Earnings`;
                }
                const driver = await sr.Driver.get(ride.driver_id);
                const driverEmail = typeof driver?.user_email === 'string' ? driver.user_email.trim().toLowerCase() : '';
                if (driverEmail) {
                    await tryPush(base44, {
                        user_email: driverEmail,
                        title: '🚫 Ride cancelled',
                        body: `The ${ride.vehicle_name} booking you were assigned to has been cancelled.`,
                        url: '/DriverRides',
                        tag: `driver-cancelled-${ride.id}`,
                    });
                }
            } catch (err) {
                console.error('Driver pay reversal on cancel failed (the sweep will retry):', err);
                payLine = '\n• Driver pay could not be reversed just now; the next sweep will do it';
            }
        }

        await notifyAdmin(ride, isAdmin && ride.guest_email !== user.email, payLine);
```

- [ ] **Step 6: Run the checks**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, with `ok   reverseHeldEarnings: cancelRideBooking copy matches assignRideDriver`.

Run: `node_modules/.bin/esbuild base44/functions/cancelRideBooking/entry.ts --format=esm --target=esnext --outfile=/dev/null`

Expected: exit code 0.

- [ ] **Step 7: Sandbox checklist (after the next publish)**

1. As admin, cancel a paid ride that has a linked driver and a `held` earning. Expected: the earning is `reversed` with `admin_notes` "Ride cancelled"; the Telegram message ends with "Driver pay reversed: ₦…"; the driver receives "Ride cancelled".
2. As a guest, cancel an unpaid ride more than 24 hours out. Expected: cancelled exactly as before, no pay line in Telegram.

- [ ] **Step 8: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/cancelRideBooking/entry.ts
git commit -m "feat(rides): cancelling a ride reverses the driver's held pay" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A05: The sweep completes rides and releases pay; a paid ride stays paid

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (completion, release and paid-guard sections, above `// ---- result ----`)
- Modify: `base44/functions/autoCancelExpiredBookings/entry.ts` (header comment; time model and five helpers after `ARRIVAL_WINDOW_MS`; passes 4 and 5 in `runRideSweep`)
- Modify: `base44/functions/verifyRidePayment/entry.ts` (the "already paid" guard)
- Modify: `base44/functions/paystackWebhook/entry.ts` (the same guard in `handleRidePayment`)
- Modify: `base44/functions/getRideDriverContact/entry.ts` (also serve completed rides)

**Interfaces:**
- Consumes: entity `DriverEarning`, `RideBooking.completed_at`, `RideBooking.completed_by` (Task A01); `Driver.user_email`; the sweep's existing `fetchAll(entity, query)` and `tryPush(sdk, opts)`; `fakeEntity`, `liftSrc`, `make`, `identical`, `constLine` from the check script (Tasks A02, A03).
- Produces, in `autoCancelExpiredBookings/entry.ts`: `rideDurationMs`, `windowOf` (lockstep copies), `rideEnded(ride, nowMs) → boolean`, `isReleasable(earning, nowMs) → boolean`, `releaseDecision(earning, ride) → 'release' | 'reverse:<why>' | 'hold:<why>'`, `async settleDueEarning(sr, earningId, nowMs) → 'released' | 'reversed' | 'held' | 'skipped'`, `async notifyAdminLine(text)`. The sweep's response `data.rides` gains `completed`, `released`, `pay_reversed`.
- Produces, in `verifyRidePayment/entry.ts` and `paystackWebhook/entry.ts`: `rideAlreadyPaid(ride) → boolean`, identical in both.
- From this task on, `RideBooking.status` really does become `completed`. `getRideDriverContact` serves `confirmed` and `completed` rides.

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Completion ─────────────────────────────────────────────────────────────
// Review focus 4. Every assertion pins an exact UTC instant: a naive parse
// resolves to local time, which on a machine in Nigeria coincides with the
// pinned value, so a wrong implementation would pass there and nowhere else.
console.log('\n— completion (sweep) —');
identical('rideDurationMs', 'tier, days, hours', ['getRideBookings', 'assignRideDriver', 'autoCancelExpiredBookings']);
identical('windowOf', 'r', ['getRideBookings', 'assignRideDriver', 'autoCancelExpiredBookings']);
const SWEEP_TIME = ['HOUR_MS', 'WAT_OFFSET', 'DAY_MS', 'MAX_HOURLY']
  .map((name) => constLine('autoCancelExpiredBookings', name)).join(' ');
const sweepSrc = (name, signature) => liftSrc('autoCancelExpiredBookings', name, signature);
const rideEnded = make('rideEnded', SWEEP_TIME,
  sweepSrc('rideDurationMs', 'tier, days, hours'), sweepSrc('windowOf', 'r'), sweepSrc('rideEnded', 'ride, nowMs'));
const at = (iso) => Date.parse(iso);

const stored = { start_at: '2026-08-10T08:00:00.000Z', end_at: '2026-08-10T10:00:00.000Z' };
check('not over one millisecond before the booked end', rideEnded(stored, at('2026-08-10T09:59:59.999Z')), false);
check('over at the booked end', rideEnded(stored, at('2026-08-10T10:00:00.000Z')), true);
// A row written before start_at and end_at existed. 09:00 WAT is 08:00 UTC,
// so three hours later is 11:00 UTC.
const legacy = { service_date: '2026-08-10', start_time: '09:00', duration_tier: 'hourly', duration_hours: 3 };
check('legacy row: still running at 10:59:59.999 UTC', rideEnded(legacy, at('2026-08-10T10:59:59.999Z')), false);
check('legacy row: over at 11:00 UTC', rideEnded(legacy, at('2026-08-10T11:00:00.000Z')), true);
// 22:00 WAT for four hours ends at 02:00 WAT the next day: 01:00 UTC.
const overnight = { service_date: '2026-08-10', start_time: '22:00', duration_tier: 'hourly', duration_hours: 4 };
check('overnight ride: still running at 00:59:59.999 UTC', rideEnded(overnight, at('2026-08-11T00:59:59.999Z')), false);
check('overnight ride: over at 01:00 UTC', rideEnded(overnight, at('2026-08-11T01:00:00.000Z')), true);
// A 24-hour hire from midnight WAT starts on the previous UTC date.
const fromMidnight = { service_date: '2026-08-10', start_time: '00:00', duration_tier: '24hr' };
check('midnight start: still running at 22:59:59.999 UTC', rideEnded(fromMidnight, at('2026-08-10T22:59:59.999Z')), false);
check('midnight start: over at 23:00 UTC the same date', rideEnded(fromMidnight, at('2026-08-10T23:00:00.000Z')), true);
const FAR = at('2099-01-01T00:00:00.000Z');
check('a row with no time on it never completes by itself', rideEnded({}, FAR), false);
check('an unknown duration tier never completes by itself',
  rideEnded({ service_date: '2026-08-10', start_time: '09:00', duration_tier: 'fortnight' }, FAR), false);
check('a garbage date never completes by itself',
  rideEnded({ service_date: 'soon', start_time: 'late', duration_tier: '24hr' }, FAR), false);

// ── Release ────────────────────────────────────────────────────────────────
console.log('\n— release (sweep) —');
const isReleasable = make('isReleasable', sweepSrc('isReleasable', 'earning, nowMs'));
const releaseDecision = make('releaseDecision', sweepSrc('releaseDecision', 'earning, ride'));
const DUE = at('2026-08-10T12:00:00.000Z');
const due = (extra = {}) => ({
  id: 'e1', ride_booking_id: 'ride1', driver_id: 'drvA', amount_ngn: 15000,
  status: 'held', on_hold: false, release_at: '2026-08-10T12:00:00.000Z', ...extra,
});
const drivenRide = (extra = {}) => ({ id: 'ride1', driver_id: 'drvA', status: 'completed', payment_status: 'paid', ...extra });

check('releasable at the release moment', isReleasable(due(), DUE), true);
check('not one millisecond before', isReleasable(due(), DUE - 1), false);
check('not while admin has it on hold', isReleasable(due({ on_hold: true }), DUE), false);
check('not when already released', isReleasable(due({ status: 'released' }), DUE), false);
check('not when reversed', isReleasable(due({ status: 'reversed' }), DUE), false);
check('not without a release time', isReleasable(due({ release_at: '' }), DUE), false);
check('not for a row that is gone', isReleasable(null, DUE), false);

check('a paid ride with the same driver releases', releaseDecision(due(), drivenRide()), 'release');
check('…whether or not the sweep has completed it yet', releaseDecision(due(), drivenRide({ status: 'confirmed' })), 'release');
check('a cancelled ride reverses', releaseDecision(due(), drivenRide({ status: 'cancelled' })), 'reverse:ride cancelled');
check('a ride handed to another driver reverses', releaseDecision(due(), drivenRide({ driver_id: 'drvB' })), 'reverse:ride reassigned');
check('a ride that no longer exists reverses', releaseDecision(due(), null), 'reverse:ride no longer exists');
check('a refunded ride is put on hold for admin', releaseDecision(due(), drivenRide({ payment_status: 'refunded' })), 'hold:ride is not paid');

const settleDueEarning = make('settleDueEarning',
  sweepSrc('isReleasable', 'earning, nowMs'), sweepSrc('releaseDecision', 'earning, ride'),
  sweepSrc('settleDueEarning', 'sr, earningId, nowMs'));
const world = (earning, ride) => ({ DriverEarning: fakeEntity([earning]), RideBooking: fakeEntity(ride ? [ride] : []) });
{
  const sr = world(due(), drivenRide());
  check('a due earning is released', await settleDueEarning(sr, 'e1', DUE), 'released');
  check('…and stamped', sr.DriverEarning.rows[0].released_at, '2026-08-10T12:00:00.000Z');
  // The balance is derived from the ledger, so a second run has nothing to add.
  check('the next sweep tick skips it', await settleDueEarning(sr, 'e1', DUE + 300000), 'skipped');
  check('…leaving the first release time', sr.DriverEarning.rows[0].released_at, '2026-08-10T12:00:00.000Z');
}
{
  const sr = world(due(), drivenRide());
  check('an earning that is not due yet is skipped', await settleDueEarning(sr, 'e1', DUE - 1), 'skipped');
  check('…and stays held', sr.DriverEarning.rows[0].status, 'held');
}
{
  // The page was fetched, then admin paused the row before the sweep reached it.
  const sr = world(due({ on_hold: true, hold_reason: 'guest disputes the trip' }), drivenRide());
  check('a row paused since the page was read is skipped', await settleDueEarning(sr, 'e1', DUE), 'skipped');
  check('…and stays held', sr.DriverEarning.rows[0].status, 'held');
}
{
  const sr = world(due({ admin_notes: 'first note' }), drivenRide({ status: 'cancelled' }));
  check('pay on a cancelled ride is reversed, not released', await settleDueEarning(sr, 'e1', DUE), 'reversed');
  check('…with the reason appended', sr.DriverEarning.rows[0].admin_notes, 'first note | Sweep: ride cancelled');
}
{
  // Assignment stopped after step 2: the ride is the new driver's, the old row is still held.
  const sr = world(due(), drivenRide({ driver_id: 'drvB' }));
  check('pay for a driver no longer on the ride is reversed', await settleDueEarning(sr, 'e1', DUE), 'reversed');
}
{
  const sr = world(due(), drivenRide({ payment_status: 'refunded' }));
  check('pay on a refunded ride is put on hold', await settleDueEarning(sr, 'e1', DUE), 'held');
  check('…with the reason', `${sr.DriverEarning.rows[0].on_hold}/${sr.DriverEarning.rows[0].hold_reason}`, 'true/ride is not paid');
  check('…and is then left for admin', await settleDueEarning(sr, 'e1', DUE + 300000), 'skipped');
}
{
  // A read that fails is not the same as a ride that is gone.
  const sr = world(due(), drivenRide());
  sr.RideBooking.get = async () => { throw new Error('network'); };
  const warn = console.warn;
  console.warn = () => {}; // the helper logs the failed read; keep this output to results
  const outcome = await settleDueEarning(sr, 'e1', DUE);
  console.warn = warn;
  check('a failed ride read never reverses pay', outcome, 'skipped');
  check('…the row stays held for the next tick', sr.DriverEarning.rows[0].status, 'held');
}

// ── A paid ride stays paid ─────────────────────────────────────────────────
// Review focus 5. Both payment paths used to test "paid AND confirmed", which
// stopped being the same thing as "paid" the moment rides could be completed.
console.log('\n— paid stays paid —');
identical('rideAlreadyPaid', 'ride', ['verifyRidePayment', 'paystackWebhook']);
const rideAlreadyPaid = make('rideAlreadyPaid', liftSrc('verifyRidePayment', 'rideAlreadyPaid', 'ride'));
check('paid and confirmed', rideAlreadyPaid({ payment_status: 'paid', status: 'confirmed' }), true);
check('paid and completed: an old reference must not reopen it', rideAlreadyPaid({ payment_status: 'paid', status: 'completed' }), true);
check('paid then cancelled by admin: must not be resurrected', rideAlreadyPaid({ payment_status: 'paid', status: 'cancelled' }), true);
check('approved and unpaid is still payable', rideAlreadyPaid({ payment_status: 'unpaid', status: 'pending' }), false);
check('refunded is not "paid"', rideAlreadyPaid({ payment_status: 'refunded', status: 'cancelled' }), false);
check('a missing ride is not "paid"', rideAlreadyPaid(null), false);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: could not find rideDurationMs in base44/functions/autoCancelExpiredBookings/entry.ts`.

- [ ] **Step 3: Say what the sweep now covers**

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
// The platform's 5-minute sweep. Despite the name it now covers three things:
```

replace with:

```ts
// The platform's 5-minute sweep. Despite the name it now covers five things:
```

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
//   3. Rides  — a driver-arriving-soon push ~30 minutes before pickup.
```

replace with:

```ts
//   3. Rides  — a driver-arriving-soon push ~30 minutes before pickup.
//   4. Rides  — a paid ride whose booked window is over is marked completed.
//   5. Rides  — driver pay held on a ride is released two hours after its end.
```

- [ ] **Step 4: Add the time model and the completion and release helpers**

`rideDurationMs` and `windowOf` must match the copies in `getRideBookings` and `assignRideDriver` character for character; the check script compares them.

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
const ARRIVAL_WINDOW_MS = 35 * 60 * 1000;
```

replace with:

```ts
const ARRIVAL_WINDOW_MS = 35 * 60 * 1000;

// ── Ride time model — lockstep copy, see checkRideAvailability ──────────────
const WAT_OFFSET = '+01:00';
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
// before start_at existed, so a legacy ride still completes on time.
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

// ── Completion and driver pay release ───────────────────────────────────────
// The decisions are separate functions with plain JavaScript bodies so that
// scripts/check-driver-wallet.mjs can lift them off disk and run them.

// The booked window is over. A row with no readable time is never "over":
// it waits for admin rather than completing on a guess.
function rideEnded(ride: any, nowMs: number) {
    const w = windowOf(ride);
    return !!w && Number.isFinite(w.endMs) && w.endMs <= nowMs;
}

// A held earning that has waited out its two hours and is not paused.
function isReleasable(earning: any, nowMs: number) {
    if (!earning || earning.status !== 'held' || earning.on_hold) return false;
    const t = Date.parse(earning.release_at || '');
    return !Number.isNaN(t) && t <= nowMs;
}

// What to do with a due earning, given the ride it is for. This is the net
// under assignRideDriver and cancelRideBooking: if either stopped halfway, the
// pay they should have reversed is reversed here instead of being released.
function releaseDecision(earning: any, ride: any) {
    if (!ride) return 'reverse:ride no longer exists';
    if (ride.status === 'cancelled') return 'reverse:ride cancelled';
    if (ride.driver_id !== earning.driver_id) return 'reverse:ride reassigned';
    if (ride.payment_status !== 'paid') return 'hold:ride is not paid';
    return 'release';
}

// Settle one due earning: 'released' | 'reversed' | 'held' | 'skipped'.
// Re-reads the row first, because admin may have paused, adjusted or reversed
// it since the page was fetched. Releasing is a status flip and nothing else:
// the driver's balance is derived from the ledger, so running this twice for
// the same row cannot pay twice.
async function settleDueEarning(sr: any, earningId: string, nowMs: number) {
    const e = await sr.DriverEarning.get(earningId);
    if (!isReleasable(e, nowMs)) return 'skipped';
    let ride;
    try {
        ride = await sr.RideBooking.get(e.ride_booking_id);
    } catch (err) {
        // A read that failed is not a ride that is gone. Never reverse on it.
        console.warn(`Could not read ride ${e.ride_booking_id} for earning ${e.id}; trying again next tick`, err);
        return 'skipped';
    }
    const nowIso = new Date(nowMs).toISOString();
    const parts = releaseDecision(e, ride).split(':');
    if (parts[0] === 'reverse') {
        const note = `Sweep: ${parts[1]}`;
        await sr.DriverEarning.update(e.id, {
            status: 'reversed',
            reversed_at: nowIso,
            on_hold: false,
            admin_notes: e.admin_notes ? `${e.admin_notes} | ${note}` : note,
        });
        return 'reversed';
    }
    if (parts[0] === 'hold') {
        await sr.DriverEarning.update(e.id, { on_hold: true, hold_reason: parts[1] });
        return 'held';
    }
    await sr.DriverEarning.update(e.id, {
        status: 'released', released_at: nowIso, on_hold: false, hold_reason: '',
    });
    return 'released';
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
```

- [ ] **Step 5: Add the two passes to the ride sweep**

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
async function runRideSweep(sdk: any): Promise<{ scanned: number; cancelled: number; warned: number; arriving: number }> {
    const now = Date.now();
    let cancelled = 0;
    let warned = 0;
    let arriving = 0;
```

replace with:

```ts
async function runRideSweep(sdk: any): Promise<Record<string, number>> {
    const now = Date.now();
    let cancelled = 0;
    let warned = 0;
    let arriving = 0;
    let completed = 0;
    let released = 0;
    let payReversed = 0;
```

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
    return { scanned: pending.length + confirmed.length, cancelled, warned, arriving };
```

replace with:

```ts
    // Pass 4 — a paid ride whose booked window is over is completed. Until
    // this pass existed nothing ever wrote the status; rides aged into "past"
    // by the clock alone.
    for (const r of confirmed) {
        if (!rideEnded(r, now)) continue;
        try {
            await sdk.asServiceRole.entities.RideBooking.update(r.id, {
                status: 'completed',
                completed_at: new Date().toISOString(),
                completed_by: 'system',
            });
            completed += 1;
        } catch (err) {
            console.error(`Failed to complete ride ${r.id}:`, err);
        }
    }

    // Pass 5 — release driver pay that has waited out its two hours. Wrapped
    // as a whole so that a failed page read here cannot cost the counts from
    // the passes above.
    try {
        const sr = sdk.asServiceRole.entities;
        const held = await fetchAll(sr.DriverEarning, { status: 'held' });
        for (const row of held) {
            if (!isReleasable(row, now)) continue;
            try {
                const outcome = await settleDueEarning(sr, row.id, now);
                const amount = `₦${(Number(row.amount_ngn) || 0).toLocaleString()}`;
                if (outcome === 'reversed') payReversed += 1;
                if (outcome === 'held') {
                    await notifyAdminLine(
                        `⏸ DRIVER PAY ON HOLD\n\n${amount} for ${row.vehicle_name || 'a ride'} (${row.booking_reference || row.ride_booking_id}) ` +
                        `was due for release, but the ride is not marked paid. Review it in Admin → Rides → Earnings.`,
                    );
                }
                if (outcome !== 'released') continue;
                released += 1;
                const driver = await sr.Driver.get(row.driver_id);
                const driverEmail = typeof driver?.user_email === 'string' ? driver.user_email.trim().toLowerCase() : '';
                if (driverEmail) {
                    await tryPush(sdk, {
                        user_email: driverEmail,
                        title: `💸 ${amount} is now available`,
                        body: `Your pay for the ${row.vehicle_name || 'ride'}${row.service_date ? ` on ${row.service_date}` : ''} has been released to your wallet.`,
                        url: '/DriverWallet',
                        tag: `driver-released-${row.id}`,
                    });
                }
            } catch (err) {
                console.error(`Failed to settle driver earning ${row.id}:`, err);
            }
        }
    } catch (err) {
        console.error('Driver pay release pass failed:', err);
    }

    return {
        scanned: pending.length + confirmed.length,
        cancelled, warned, arriving, completed, released, pay_reversed: payReversed,
    };
```

- [ ] **Step 6: A paid ride stays paid, in both payment paths**

Both functions decided "nothing to do" with `payment_status === 'paid' && status === 'confirmed'`. That was the same as "paid" only while every paid ride stayed confirmed forever. With pass 4 writing `completed`, an old Paystack reference sent to `verifyRidePayment` would have passed the guard, verified successfully, set the ride back to `confirmed`, moved `paid_at` to today and re-sent the "ride paid, assign a driver" notifications. The same replay already worked on a ride admin had cancelled after payment. The helper is identical in both files.

**Edit `base44/functions/verifyRidePayment/entry.ts`** — find:

```ts
const GUEST_RIDE_POINTS = 500;
```

replace with:

```ts
const GUEST_RIDE_POINTS = 500;

// A ride that has been paid stays paid, whatever happened to it afterwards.
// The guard used to be "paid AND confirmed", which let an old Paystack
// reference walk straight past it on a ride that had since been completed by
// the sweep or cancelled by admin, and flip that ride back to confirmed.
// Lockstep copy in verifyRidePayment and paystackWebhook.
function rideAlreadyPaid(ride: any) {
    return !!ride && ride.payment_status === 'paid';
}
```

**Edit `base44/functions/verifyRidePayment/entry.ts`** — find:

```ts
        if (ride.payment_status === 'paid' && ride.status === 'confirmed') {
```

replace with:

```ts
        if (rideAlreadyPaid(ride)) {
```

**Edit `base44/functions/paystackWebhook/entry.ts`** — find:

```ts
const GUEST_RIDE_POINTS = 500;
```

replace with:

```ts
const GUEST_RIDE_POINTS = 500;

// A ride that has been paid stays paid, whatever happened to it afterwards.
// The guard used to be "paid AND confirmed", which let an old Paystack
// reference walk straight past it on a ride that had since been completed by
// the sweep or cancelled by admin, and flip that ride back to confirmed.
// Lockstep copy in verifyRidePayment and paystackWebhook.
function rideAlreadyPaid(ride: any) {
    return !!ride && ride.payment_status === 'paid';
}
```

**Edit `base44/functions/paystackWebhook/entry.ts`** — find:

```ts
    if (ride.payment_status === 'paid' && ride.status === 'confirmed') {
```

replace with:

```ts
    if (rideAlreadyPaid(ride)) {
```

- [ ] **Step 7: Keep the driver card reachable after the ride is completed**

The guest's driver card is how they will report a problem with the driver after the trip. It asked for `status === 'confirmed'`, which until now every paid ride kept for ever.

**Edit `base44/functions/getRideDriverContact/entry.ts`** — find:

```ts
        // 2. Paid and confirmed
        if (ride.status !== 'confirmed' || ride.payment_status !== 'paid') {
```

replace with:

```ts
        // 2. Paid, and either still to happen or already driven. A completed
        // ride stays readable so the guest can reach this card after the trip.
        if ((ride.status !== 'confirmed' && ride.status !== 'completed') || ride.payment_status !== 'paid') {
```

- [ ] **Step 8: Run the checks**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, including every line under `— completion (sweep) —`, `— release (sweep) —` and `— paid stays paid —`.

Run: `for f in autoCancelExpiredBookings verifyRidePayment paystackWebhook getRideDriverContact; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done`

Expected: no `PARSE FAIL` line.

- [ ] **Step 9: Sandbox checklist (after the next publish)**

1. Book, approve, pay and assign a one-hour test ride starting a few minutes from now, with a linked driver.
2. Three hours and a few minutes after its start, POST to `autoCancelExpiredBookings` as admin. Expected response `data.rides.completed >= 1` and `data.rides.released >= 1`; the ride's `status` is `completed` with `completed_by: system`; the earning is `released`; the driver receives "₦… is now available".
3. POST again straight away. Expected: `completed: 0`, `released: 0`.
4. From the guest's browser console, call `base44.functions.invoke('verifyRidePayment', { ride_booking_id: '<that ride>', reference: '<its transaction_hash>' })`. Expected: `{ success: true, data: { already_paid: true } }` and the ride is still `completed`.
5. Open the guest's Bookings page. Expected: the completed ride still shows the driver card.

- [ ] **Step 10: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/autoCancelExpiredBookings/entry.ts base44/functions/verifyRidePayment/entry.ts base44/functions/paystackWebhook/entry.ts base44/functions/getRideDriverContact/entry.ts
git commit -m "feat(rides): the sweep completes rides and releases held driver pay" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A06: Drivers can sign in — the link, the lookup and the hook

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (driver sign-in section, above `// ---- result ----`)
- Create: `base44/functions/getDriverProfile/entry.ts`
- Modify: `src/config/rides.js` (three small email helpers, appended)
- Create: `src/lib/useDriverProfile.js`
- Create: `src/components/driver/DriverNotice.jsx`
- Modify: `src/components/admin/DriversAdmin.jsx` (login email field, validation, history, roster badge)

**Interfaces:**
- Consumes: `Driver.user_email`, `Driver.previous_user_emails` (Task A01); `useAuth()` from `@/lib/AuthContext` (`{ user, isAuthenticated, isLoadingAuth }`); the `QueryClientProvider` already wrapping the app in `src/App.jsx`.
- Produces, server: function `getDriverProfile` — body `{}`, answers `{ success: true, data: null }` or `{ success: true, data: { id, full_name, photo, city, active, admin_approved } }`. Helper `async findDriverForUser(sr, email) → Driver row | null`, which Tasks A07, A08 and A09 copy character for character.
- Produces, client: `normaliseEmail(raw) → string`, `looksLikeEmail(raw) → boolean`, `driverLoginPatch(driver, typedEmail) → { user_email, previous_user_emails }` in `src/config/rides.js`; `useDriverProfile() → { driver, isDriver, isLoading, refetch }` in `src/lib/useDriverProfile.js` (`isDriver` is true for any linked driver, active or not: deactivating stops new assignments, never access to earned money); default export `DriverNotice` in `src/components/driver/DriverNotice.jsx`.

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Driver sign-in ─────────────────────────────────────────────────────────
// Review focus 1: an email typed with capitals or a stray space must still
// find its driver, and changing a driver's login must keep the old address.
console.log('\n— driver sign-in —');
const FIND_DRIVER_SIG = 'sr, email';
const findDriverForUser = make('findDriverForUser', liftSrc('getDriverProfile', 'findDriverForUser', FIND_DRIVER_SIG));
const roster = (rows) => ({ Driver: fakeEntity(rows) });
{
  const sr = roster([{ id: 'd1', created_date: '2026-01-02T00:00:00.000Z', user_email: 'emeka@gmail.com' }]);
  check('a login with capitals and a trailing space finds its driver', (await findDriverForUser(sr, 'Emeka@Gmail.com '))?.id, 'd1');
  check('an exact login finds its driver', (await findDriverForUser(sr, 'emeka@gmail.com'))?.id, 'd1');
  check('someone else finds nothing', await findDriverForUser(sr, 'ada@gmail.com'), null);
  check('no email finds nothing', await findDriverForUser(sr, ''), null);
  check('an undefined email finds nothing', await findDriverForUser(sr, undefined), null);
}
{
  // A row typed straight into the data browser, capitals and all.
  const sr = roster([{ id: 'd2', created_date: '2026-01-02T00:00:00.000Z', user_email: 'Emeka@Gmail.com' }]);
  check('a row stored with capitals is still found by the same login', (await findDriverForUser(sr, 'Emeka@Gmail.com'))?.id, 'd2');
}
{
  // Two rows on one login is an admin mistake. The answer must not flip between calls.
  const sr = roster([
    { id: 'newer', created_date: '2026-03-01T00:00:00.000Z', user_email: 'emeka@gmail.com' },
    { id: 'older', created_date: '2026-01-01T00:00:00.000Z', user_email: 'emeka@gmail.com' },
  ]);
  check('two rows on one login: the oldest wins', (await findDriverForUser(sr, 'emeka@gmail.com'))?.id, 'older');
}

check('normaliseEmail trims and lower-cases', rides.normaliseEmail('  Emeka@Gmail.COM '), 'emeka@gmail.com');
check('normaliseEmail of nothing is empty', rides.normaliseEmail(undefined), '');
check('looksLikeEmail accepts an address', rides.looksLikeEmail('emeka@gmail.com'), true);
check('looksLikeEmail refuses a name', rides.looksLikeEmail('emeka'), false);
check('looksLikeEmail refuses a space inside', rides.looksLikeEmail('emeka okafor@gmail.com'), false);
same('first link: stored lower-cased, no history',
  rides.driverLoginPatch({}, ' Emeka@Gmail.com '), { user_email: 'emeka@gmail.com', previous_user_emails: [] });
same('same address retyped with capitals: nothing moves to history',
  rides.driverLoginPatch({ user_email: 'emeka@gmail.com' }, 'EMEKA@gmail.com'),
  { user_email: 'emeka@gmail.com', previous_user_emails: [] });
same('changed address: the old one is remembered',
  rides.driverLoginPatch({ user_email: 'emeka@gmail.com' }, 'emeka@work.ng'),
  { user_email: 'emeka@work.ng', previous_user_emails: ['emeka@gmail.com'] });
same('changed twice: both are remembered, once each',
  rides.driverLoginPatch({ user_email: 'emeka@work.ng', previous_user_emails: ['emeka@gmail.com'] }, 'e@new.ng'),
  { user_email: 'e@new.ng', previous_user_emails: ['emeka@gmail.com', 'emeka@work.ng'] });
same('unlinked: the address moves to history so past withdrawals still count',
  rides.driverLoginPatch({ user_email: 'emeka@gmail.com' }, ''),
  { user_email: '', previous_user_emails: ['emeka@gmail.com'] });
same('a new driver saved with no login',
  rides.driverLoginPatch(undefined, ''), { user_email: '', previous_user_emails: [] });

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: ENOENT: no such file or directory, open '…/base44/functions/getDriverProfile/entry.ts'`. The function does not exist yet.

- [ ] **Step 3: Create the lookup function**

**Create `base44/functions/getDriverProfile/entry.ts`:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getDriverProfile
// ----------------------------------------------------------------------------
// Answers one question for the signed-in user: "am I a driver here?"
//
// There is no driver role. A driver is an ordinary account whose email admin
// has written on a Driver row (Driver.user_email). The Driver entity is
// admin-only at the API, so the browser cannot look itself up; this function
// does it under the service role and returns a handful of harmless fields, or
// null. The navigation calls it once per session to decide whether to show
// "My rides" and "Wallet".
//
// A deactivated or unapproved driver still gets their profile back: those
// switches stop new assignments (assignRideDriver enforces them), they must
// never lock someone out of pay they have already earned.

// The Driver row this login belongs to, or null. The Drivers admin form stores
// emails trimmed and lower-cased; the second lookup covers a row typed
// straight into the data browser with capitals. Two rows on one login is an
// admin mistake: the oldest wins, so the answer never flips between calls.
// Lockstep copies in getDriverRides, getDriverWallet and
// createWithdrawalRequest; scripts/check-driver-wallet.mjs compares them.
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

        const driver = await findDriverForUser(base44.asServiceRole.entities, user.email);
        if (!driver) return json({ success: true, data: null });

        // Explicit allow-list: licence details, phone and the login history
        // stay on the server.
        return json({
            success: true,
            data: {
                id: driver.id,
                full_name: driver.full_name || '',
                photo: driver.photo || null,
                city: driver.city || null,
                active: driver.active !== false,
                admin_approved: driver.admin_approved !== false,
            },
        });
    } catch (error) {
        console.error('getDriverProfile error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
```

- [ ] **Step 4: Add the email helpers the admin form will use**

**Edit `src/config/rides.js`** — find:

```js
export const needsCategoryMigration = (vehicle) =>
  !vehicle?.category && !!vehicle?.vehicle_type;
```

replace with:

```js
export const needsCategoryMigration = (vehicle) =>
  !vehicle?.category && !!vehicle?.vehicle_type;

// ── Driver logins ───────────────────────────────────────────────────────────
// The server matches a driver to a login by exact string, so the address is
// stored one way only: trimmed and lower-cased.
export const normaliseEmail = (raw) => String(raw || '').trim().toLowerCase();

export const looksLikeEmail = (raw) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw || '').trim());

// What to write on a Driver row when admin sets or changes its login email.
// The address being replaced moves into previous_user_emails, because a
// withdrawal only counts against a driver's balance when it was made by a
// login that is, or was, linked to that driver. Forget the old address and
// the money already paid out under it would look withdrawable again.
export function driverLoginPatch(driver, typedEmail) {
  const next = normaliseEmail(typedEmail);
  const current = normaliseEmail(driver?.user_email);
  const previous = Array.isArray(driver?.previous_user_emails)
    ? driver.previous_user_emails.map(normaliseEmail).filter(Boolean)
    : [];
  const history = current && current !== next && !previous.includes(current)
    ? [...previous, current]
    : previous;
  return { user_email: next, previous_user_emails: history };
}
```

- [ ] **Step 5: Run the check and watch it pass**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, including every line under `— driver sign-in —`.

- [ ] **Step 6: Create the hook**

`src/lib` is where `AuthContext` lives. The query is disabled until auth has resolved, so a signed-out visitor on a public page never calls the function, and any failure reads as "not a driver" rather than an error.

**Create `src/lib/useDriverProfile.js`:**

```js
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';

// useDriverProfile — "is the signed-in user a driver, and which one?"
//
// There is no driver role. getDriverProfile looks the caller up on the Driver
// roster under the service role (the entity is admin-only at the API) and
// returns a few public fields, or null.
//
// isDriver is true for ANY linked driver, active or not. Deactivating a driver
// stops new assignments; it must not hide money they have already earned.
export function useDriverProfile() {
  const { user, isAuthenticated, isLoadingAuth } = useAuth();
  const enabled = !isLoadingAuth && !!isAuthenticated;

  const query = useQuery({
    queryKey: ['driverProfile', user?.email || null],
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      try {
        const res = await base44.functions.invoke('getDriverProfile', {});
        return res?.data?.success ? (res.data.data || null) : null;
      } catch (err) {
        // A failed lookup is "not a driver" for navigation purposes. The
        // driver pages make their own calls and show their own errors.
        console.warn('getDriverProfile failed:', err);
        return null;
      }
    },
  });

  const driver = query.data || null;
  return {
    driver,
    isDriver: !!driver,
    isLoading: isLoadingAuth || (enabled && query.isLoading),
    refetch: query.refetch,
  };
}
```

- [ ] **Step 7: Create the notice shown to non-drivers**

**Create `src/components/driver/DriverNotice.jsx`:**

```jsx
import React from 'react';
import { Link } from 'react-router-dom';
import { Car } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { createPageUrl } from '@/utils';

// Shown on the driver pages to a signed-in user who has no driver profile.
// The pages are reachable by URL, so this is what a curious guest sees.
export default function DriverNotice() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4">
      <Card className="max-w-md w-full bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
        <CardContent className="p-8 text-center">
          <Car className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-4" />
          <h1 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
            This page is for UrbanStays drivers
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-6">
            If you drive for us, ask the team to link this email to your driver profile.
            Your rides and pay appear here as soon as they do.
          </p>
          <Link to={createPageUrl('Dashboard')}>
            <Button className="rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
              Back to my dashboard
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 8: Give the Drivers admin form a login email**

**Edit `src/components/admin/DriversAdmin.jsx`** — find:

```jsx
  AlertCircle, Phone, RefreshCw,
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { CITIES } from '@/config/rides';
```

replace with:

```jsx
  AlertCircle, Phone, RefreshCw, Mail,
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { CITIES, normaliseEmail, looksLikeEmail, driverLoginPatch } from '@/config/rides';
```

**Edit `src/components/admin/DriversAdmin.jsx`** — find:

```jsx
const EMPTY = {
  full_name: '',
  phone: '',
```

replace with:

```jsx
const EMPTY = {
  full_name: '',
  phone: '',
  // The login the driver signs in with. Empty means their pay is not tracked.
  user_email: '',
```

**Edit `src/components/admin/DriversAdmin.jsx`** — find:

```jsx
      full_name: d.full_name || '',
      phone: d.phone || '',
```

replace with:

```jsx
      full_name: d.full_name || '',
      phone: d.phone || '',
      user_email: d.user_email || '',
```

**Edit `src/components/admin/DriversAdmin.jsx`** — find:

```jsx
    setSaving(true);
    try {
      const payload = {
        full_name: form.full_name.trim(),
        phone: form.phone.trim(),
```

replace with:

```jsx
    const loginEmail = normaliseEmail(form.user_email);
    if (loginEmail && !looksLikeEmail(loginEmail)) {
      setError('That login email does not look like an email address.');
      return;
    }
    // One login is one driver. getDriverProfile would otherwise have to pick.
    if (loginEmail && drivers.some((d) => d.id !== editingId && normaliseEmail(d.user_email) === loginEmail)) {
      setError('Another driver is already linked to that login email.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        full_name: form.full_name.trim(),
        phone: form.phone.trim(),
        // user_email plus previous_user_emails: changing a login keeps the old
        // address on the row so withdrawals made under it still count.
        ...driverLoginPatch(drivers.find((d) => d.id === editingId), form.user_email),
```

**Edit `src/components/admin/DriversAdmin.jsx`** — find:

```jsx
                    placeholder="English, Igbo, Pidgin" className="mt-1 rounded-xl" />
                </div>
```

replace with:

```jsx
                    placeholder="English, Igbo, Pidgin" className="mt-1 rounded-xl" />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="d-email" className="flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" /> Login email
                  </Label>
                  <Input id="d-email" type="email" inputMode="email" autoCapitalize="none" autoCorrect="off"
                    spellCheck={false} value={form.user_email}
                    onChange={(e) => set('user_email', e.target.value)}
                    placeholder="emeka@example.com" className="mt-1 rounded-xl" />
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    The driver signs in with this email to see rides and pay. Leave it empty and
                    they are assigned as before, with their pay kept outside the app.
                  </p>
                </div>
```

**Edit `src/components/admin/DriversAdmin.jsx`** — find:

```jsx
                    <Badge className="bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-0">Licence expiring</Badge>
                  )}
```

replace with:

```jsx
                    <Badge className="bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-0">Licence expiring</Badge>
                  )}
                  {d.user_email ? (
                    <Badge variant="outline" className="text-xs">Has login</Badge>
                  ) : (
                    <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-0 text-xs">No login · pay not tracked</Badge>
                  )}
```

- [ ] **Step 9: Lint, parse and build**

Run: `npm run lint`

Expected: no output, exit code 0.

Run: `node_modules/.bin/esbuild base44/functions/getDriverProfile/entry.ts --format=esm --target=esnext --outfile=/dev/null`

Expected: exit code 0.

Run: `set -a; . ./.env; set +a; npm run build`

Expected: `✓ built in …`.

- [ ] **Step 10: Sandbox checklist (after the next publish)**

1. Admin → Rides → Drivers → edit a driver → type `Test.Driver@Example.com ` in Login email → Save. Expected: saved; the Driver row holds `test.driver@example.com`; the roster shows "Has login".
2. Edit a second driver and type the same address. Expected: "Another driver is already linked to that login email."
3. Signed in as that address, run `await base44.functions.invoke('getDriverProfile', {})` in the browser console. Expected: `data.data.id` is the driver's id. Signed in as anyone else: `data.data` is `null`.

- [ ] **Step 11: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/getDriverProfile/entry.ts src/config/rides.js src/lib/useDriverProfile.js src/components/driver/DriverNotice.jsx src/components/admin/DriversAdmin.jsx
git commit -m "feat(rides): link a driver to a login and look the driver up for the signed-in user" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A07: My rides

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (driver ride view section, above `// ---- result ----`)
- Create: `base44/functions/getDriverRides/entry.ts`
- Create: `src/components/driver/DriverRideCard.jsx`
- Create: `src/pages/DriverRides.jsx`
- Modify: `src/pages.config.js` (register the page)
- Modify: `src/Layout.jsx` (navigation item for drivers)

**Interfaces:**
- Consumes: `findDriverForUser(sr, email)` (Task A06, copied); `rideDurationMs`, `windowOf`, `computeBucket` (lockstep copies of `getRideBookings`); `safeIso(ms)` (lockstep copy of `assignRideDriver`); `useDriverProfile()`, `DriverNotice` (Task A06); `durationLabel(tier, { hours, days })` from `@/config/rides`.
- Produces, server: function `getDriverRides` — body `{}`; `403 NOT_A_DRIVER` when the login has no driver row; otherwise `{ success: true, data: { rides: Ride[], counts: { upcoming, current, past, cancelled } } }`. `Ride` is exactly `{ id, booking_reference, vehicle_name, vehicle_image, service_date, start_time, start_at, end_at, duration_tier, duration_hours, duration_days, pickup_location, dropoff_location, pickup_instructions, passengers, special_requests, guest_name, guest_phone, bucket, status, earning }` where `guest_phone` is `null` unless `bucket` is `upcoming` or `current`, and `earning` is `null` or `{ id, amount_ngn, status, on_hold, release_at, released_at }`. Helpers `earningForRide(rows)` and `driverRideView(ride, bucket, win, earning)`.
- Produces, client: default export `DriverRideCard` (`props: { ride, onReport }`; the report button renders only when `ride.can_report && onReport`, both of which arrive with the ride reports plan) and page `DriverRides`, registered under that key.

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── What a driver is shown about a ride ────────────────────────────────────
console.log('\n— driver ride view —');
identical('findDriverForUser', FIND_DRIVER_SIG, ['getDriverProfile', 'getDriverRides']);
identical('rideDurationMs', 'tier, days, hours', ['getRideBookings', 'getDriverRides']);
identical('windowOf', 'r', ['getRideBookings', 'getDriverRides']);
identical('computeBucket', 'r, nowMs', ['getRideBookings', 'getDriverRides']);
identical('safeIso', 'ms', ['assignRideDriver', 'getDriverRides']);

const earningForRide = make('earningForRide', liftSrc('getDriverRides', 'earningForRide', 'rows'));
check('no earning rows: nothing to show', earningForRide([]), null);
check('a held row beats an older reversed one',
  earningForRide([
    { id: 'old', status: 'reversed', created_date: '2026-08-01T00:00:00.000Z' },
    { id: 'live', status: 'held', created_date: '2026-08-02T00:00:00.000Z' },
  ])?.id, 'live');
check('a released row beats a newer reversed duplicate',
  earningForRide([
    { id: 'paid', status: 'released', created_date: '2026-08-01T00:00:00.000Z' },
    { id: 'dup', status: 'reversed', created_date: '2026-08-02T00:00:00.000Z' },
  ])?.id, 'paid');
check('only reversed rows: the latest is shown',
  earningForRide([
    { id: 'r1', status: 'reversed', created_date: '2026-08-01T00:00:00.000Z' },
    { id: 'r2', status: 'reversed', created_date: '2026-08-02T00:00:00.000Z' },
  ])?.id, 'r2');

const driverRideView = make('driverRideView',
  liftSrc('getDriverRides', 'safeIso', 'ms'), liftSrc('getDriverRides', 'driverRideView', 'ride, bucket, win, earning'));
const fullRide = {
  id: 'ride1', booking_reference: 'UD-AAA111', vehicle_name: 'Prado', vehicle_image: 'https://x/p.jpg',
  service_date: '2026-08-10', start_time: '09:00', duration_tier: 'hourly', duration_hours: 3,
  pickup_location: { address: '4 Aso Drive', city: 'Abuja' }, pickup_instructions: 'Gate 2',
  passengers: 2, special_requests: 'Child seat', status: 'confirmed',
  guest_name: 'Ada Obi', guest_phone: '+2348010000000', guest_email: 'ada@example.com',
  total_price: 45000, estimated_price: 45000, transaction_hash: 'T123', admin_response: 'internal',
};
const fullEarning = {
  id: 'e1', amount_ngn: 7500, status: 'held', on_hold: false, release_at: '2026-08-10T13:00:00.000Z',
  admin_notes: 'internal', hold_reason: 'internal', adjustment_reason: 'internal', rate_ngn: 2500, units: 3,
};
const liveWin = { startMs: at('2026-08-10T08:00:00.000Z'), endMs: at('2026-08-10T11:00:00.000Z') };
const upcomingView = driverRideView(fullRide, 'upcoming', liveWin, fullEarning);
check('an upcoming ride shows the guest phone', upcomingView.guest_phone, '+2348010000000');
check('a ride in progress shows the guest phone', driverRideView(fullRide, 'current', liveWin, fullEarning).guest_phone, '+2348010000000');
check('a past ride no longer shows the guest phone', driverRideView(fullRide, 'past', liveWin, fullEarning).guest_phone, null);
check('a cancelled ride does not show the guest phone', driverRideView(fullRide, 'cancelled', liveWin, fullEarning).guest_phone, null);
check('the guest name stays, so a report has a subject', driverRideView(fullRide, 'past', liveWin, fullEarning).guest_name, 'Ada Obi');
check('instants are returned in UTC', `${upcomingView.start_at}|${upcomingView.end_at}`, '2026-08-10T08:00:00.000Z|2026-08-10T11:00:00.000Z');
// Allow-list, not a spread: what the guest paid and how to reach them by email
// are not the driver's to see, and neither are admin's notes on the pay.
same('exactly these ride fields reach the driver', Object.keys(upcomingView).sort(), [
  'booking_reference', 'bucket', 'dropoff_location', 'duration_days', 'duration_hours', 'duration_tier',
  'earning', 'end_at', 'guest_name', 'guest_phone', 'id', 'passengers', 'pickup_instructions',
  'pickup_location', 'service_date', 'special_requests', 'start_at', 'start_time', 'status',
  'vehicle_image', 'vehicle_name',
]);
same('exactly these pay fields reach the driver', Object.keys(upcomingView.earning).sort(),
  ['amount_ngn', 'id', 'on_hold', 'release_at', 'released_at', 'status']);
check('a ride with no earning says so', driverRideView(fullRide, 'upcoming', liveWin, null).earning, null);
check('an unreadable window gives null instants, not a crash', driverRideView(fullRide, 'upcoming', null, null).start_at, null);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: ENOENT: no such file or directory, open '…/base44/functions/getDriverRides/entry.ts'`.

- [ ] **Step 3: Create the function**

**Create `base44/functions/getDriverRides/entry.ts`:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getDriverRides
// ----------------------------------------------------------------------------
// The signed-in driver's rides, each with what it pays and where that pay
// stands. Read-only.
//
// Three rules shape it:
//   1. The driver is resolved from the session email on the server. Nothing
//      the browser sends chooses whose rides come back.
//   2. The ride is returned through an allow-list, not a spread. What the
//      guest paid, their email and admin's notes are not the driver's to see.
//   3. The guest's phone is included only while the ride is still to happen or
//      under way. Afterwards the driver has no reason to hold it.
//
// Buckets come from the same computeBucket as getRideBookings, so the driver,
// the guest and admin can never disagree about whether a ride is over.

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

// Lockstep copy, see getRideBookings.
function computeBucket(r: any, nowMs: number): string {
    if (r.status === 'cancelled') return 'cancelled';
    if (r.status === 'completed') return 'past';
    if (r.status === 'pending' && !r.approved_at) return 'pending-approval';
    const w = windowOf(r);
    if (!w) return 'pending-approval';
    const isPaid = r.payment_status === 'paid';
    // An unpaid ride whose window has passed is dead, not history.
    if (nowMs > w.endMs) return isPaid ? 'past' : 'cancelled';
    if (nowMs < w.startMs) return 'upcoming';
    return 'current';
}

// ISO string for an instant, or null when it is not a representable date.
// Lockstep copy, see assignRideDriver.
function safeIso(ms: number) {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

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

// Which earning row speaks for a ride on the driver's card: one still in play
// if there is one (held or released), otherwise the most recent reversed row.
function earningForRide(rows: any[]) {
    const live = rows.filter((e) => e.status !== 'reversed');
    const pool = live.length > 0 ? live : rows;
    if (pool.length === 0) return null;
    const newestFirst = pool.slice().sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')));
    return newestFirst[0];
}

// Everything the driver may know about one ride. An explicit allow-list, so a
// column added to RideBooking or DriverEarning later cannot leak here by
// default. bucket is one of upcoming | current | past | cancelled.
function driverRideView(ride: any, bucket: string, win: any, earning: any) {
    const live = bucket === 'upcoming' || bucket === 'current';
    return {
        id: ride.id,
        booking_reference: ride.booking_reference || null,
        vehicle_name: ride.vehicle_name || 'Vehicle',
        vehicle_image: ride.vehicle_image || null,
        service_date: ride.service_date || null,
        start_time: ride.start_time || null,
        start_at: win ? safeIso(win.startMs) : null,
        end_at: win ? safeIso(win.endMs) : null,
        duration_tier: ride.duration_tier || null,
        duration_hours: ride.duration_hours || null,
        duration_days: ride.duration_days || null,
        pickup_location: ride.pickup_location || null,
        dropoff_location: ride.dropoff_location || null,
        pickup_instructions: ride.pickup_instructions || null,
        passengers: ride.passengers || 1,
        special_requests: ride.special_requests || null,
        guest_name: ride.guest_name || 'Guest',
        // Needed to find each other at pickup. Not needed once the ride is over.
        guest_phone: live ? (ride.guest_phone || null) : null,
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
    };
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

        const sr = base44.asServiceRole.entities;
        const driver = await findDriverForUser(sr, user.email);
        if (!driver) {
            return json({
                success: false,
                error: 'This account is not linked to a driver profile.',
                code: 'NOT_A_DRIVER',
            }, 403);
        }

        const [rides, earnings] = await Promise.all([
            fetchAll(sr.RideBooking, { driver_id: driver.id }),
            fetchAll(sr.DriverEarning, { driver_id: driver.id }),
        ]);

        const earningsByRide = new Map<string, any[]>();
        for (const e of earnings) {
            const list = earningsByRide.get(e.ride_booking_id) || [];
            list.push(e);
            earningsByRide.set(e.ride_booking_id, list);
        }

        const nowMs = Date.now();
        const counts: Record<string, number> = { upcoming: 0, current: 0, past: 0, cancelled: 0 };
        const views = rides.map((r) => {
            const raw = computeBucket(r, nowMs);
            // A ride only gets a driver after it is paid, so 'pending-approval'
            // here can only mean its time could not be read. Show it as
            // upcoming rather than hide a job from the person doing it.
            const bucket = raw === 'pending-approval' ? 'upcoming' : raw;
            counts[bucket] = (counts[bucket] || 0) + 1;
            return driverRideView(r, bucket, windowOf(r), earningForRide(earningsByRide.get(r.id) || []));
        });

        // What needs the driver now comes first: in progress, then upcoming
        // soonest first, then history newest first.
        const groupOrder: Record<string, number> = { current: 0, upcoming: 1, past: 2, cancelled: 3 };
        views.sort((a, b) => {
            if (a.bucket !== b.bucket) return groupOrder[a.bucket] - groupOrder[b.bucket];
            const byStart = String(a.start_at || '').localeCompare(String(b.start_at || ''));
            return a.bucket === 'current' || a.bucket === 'upcoming' ? byStart : -byStart;
        });

        return json({ success: true, data: { rides: views, counts } });
    } catch (error) {
        console.error('getDriverRides error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
```

- [ ] **Step 4: Run the check and watch it pass**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, including every line under `— driver ride view —`.

- [ ] **Step 5: Create the ride card**

**Create `src/components/driver/DriverRideCard.jsx`:**

```jsx
import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Car, CalendarClock, MapPin, Users, Phone, UserRound, Banknote, Flag, MessageSquare } from 'lucide-react';
import { durationLabel } from '@/config/rides';

// DriverRideCard — one ride as the driver needs to see it: when, where, who,
// and what it pays.
//
// Everything on it comes from getDriverRides, which has already decided what
// the driver may know. This component adds nothing and derives nothing about
// the ride's state; it only words it.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

const fmtWhen = (iso) => {
  if (!iso) return 'Time to be confirmed';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return 'Time to be confirmed'; }
};

const BUCKET_BADGE = {
  current: { label: 'In progress', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900' },
  upcoming: { label: 'Upcoming', className: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-900' },
  past: { label: 'Completed', className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700' },
  cancelled: { label: 'Cancelled', className: 'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-rose-200 dark:border-rose-900' },
};

const PAY_TONE = {
  good: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-900 dark:text-emerald-100',
  held: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-100',
  warn: 'bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-900 text-orange-900 dark:text-orange-100',
  muted: 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300',
};

// The one sentence about money. A ride with no earning row predates pay
// tracking or was assigned at ₦0; either way the driver is told who to ask.
export function payLine(earning) {
  if (!earning) return { tone: 'muted', text: 'Pay for this ride is arranged with the team.' };
  const amount = ngn(earning.amount_ngn);
  if (earning.status === 'released') return { tone: 'good', text: `${amount} released to your wallet` };
  if (earning.status === 'reversed') return { tone: 'muted', text: `${amount} reversed. This ride no longer pays.` };
  if (earning.on_hold || earning.under_review) return { tone: 'warn', text: `${amount} held · under review by the team` };
  return { tone: 'held', text: `${amount} held · releases ${fmtWhen(earning.release_at)}` };
}

export default function DriverRideCard({ ride, onReport }) {
  const badge = BUCKET_BADGE[ride.bucket] || BUCKET_BADGE.upcoming;
  const pickup = [ride.pickup_location?.address, ride.pickup_location?.area, ride.pickup_location?.city]
    .filter(Boolean).join(', ');
  const dropoff = [ride.dropoff_location?.address, ride.dropoff_location?.area].filter(Boolean).join(', ');
  const pay = payLine(ride.earning);
  const cancelled = ride.bucket === 'cancelled';

  return (
    <div
      id={`ride-${ride.id}`}
      className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden bg-white/80 dark:bg-slate-900/80"
    >
      <div className="flex flex-col sm:flex-row">
        {ride.vehicle_image ? (
          <img src={ride.vehicle_image} alt="" className="w-full sm:w-36 h-28 sm:h-auto object-cover flex-shrink-0" />
        ) : (
          <div className="w-full sm:w-36 h-28 sm:h-auto bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
            <Car className="w-8 h-8 text-slate-400 dark:text-slate-500" />
          </div>
        )}

        <div className="p-4 flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
            <p className={`font-semibold break-words min-w-0 flex-1 ${cancelled ? 'text-slate-500 dark:text-slate-400 line-through' : 'text-slate-900 dark:text-white'}`}>
              {ride.vehicle_name}
            </p>
            <div className="flex flex-wrap gap-2 flex-shrink-0">
              {ride.booking_reference && (
                <Badge variant="outline" className="text-xs font-mono">{ride.booking_reference}</Badge>
              )}
              <Badge className={`${badge.className} border font-medium`}>{badge.label}</Badge>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
            <span className="flex items-start gap-1.5">
              <CalendarClock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-words">
                {fmtWhen(ride.start_at)} · {durationLabel(ride.duration_tier, { hours: ride.duration_hours, days: ride.duration_days })}
              </span>
            </span>
            {pickup && (
              <span className="flex items-start gap-1.5">
                <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span className="break-words">
                  Pickup: {pickup}
                  {dropoff ? ` · Drop-off: ${dropoff}` : ''}
                </span>
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 flex-shrink-0" />
              {ride.passengers} passenger{ride.passengers === 1 ? '' : 's'}
            </span>
          </div>

          {ride.pickup_instructions && !cancelled && (
            <div className="mt-3 flex items-start gap-2 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-xl p-3">
              <MapPin className="w-4 h-4 text-blue-700 dark:text-blue-300 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-blue-900 dark:text-blue-100 break-words">{ride.pickup_instructions}</p>
            </div>
          )}

          {ride.special_requests && !cancelled && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400 break-words">
              <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>Guest asked: {ride.special_requests}</span>
            </p>
          )}

          <div className="mt-3 flex items-center gap-3 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
            <div className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
              <UserRound className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-500 dark:text-slate-400">Your passenger</p>
              <p className="font-semibold text-sm text-slate-900 dark:text-white truncate">{ride.guest_name}</p>
            </div>
            {ride.guest_phone ? (
              <a href={`tel:${ride.guest_phone}`} className="flex-shrink-0">
                <Button size="sm" variant="outline" className="rounded-xl">
                  <Phone className="w-4 h-4 mr-1.5" /> Call
                </Button>
              </a>
            ) : null}
          </div>

          <div className={`mt-3 flex items-center gap-2 border rounded-xl px-3 py-2 ${PAY_TONE[pay.tone]}`}>
            <Banknote className="w-4 h-4 flex-shrink-0" />
            <p className="text-sm font-medium break-words">{pay.text}</p>
          </div>

          {ride.already_reported ? (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              You reported this ride. The team will be in touch.
            </p>
          ) : ride.can_report && onReport ? (
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800">
              <Button
                variant="outline" size="sm" onClick={() => onReport(ride)}
                className="rounded-xl border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                <Flag className="w-4 h-4 mr-2" /> Report this customer
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Create the page**

**Create `src/pages/DriverRides.jsx`:**

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Car, ChevronDown, AlertCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useDriverProfile } from '@/lib/useDriverProfile';
import DriverNotice from '@/components/driver/DriverNotice';
import DriverRideCard from '@/components/driver/DriverRideCard';

// DriverRides — the driver's jobs: what is on now, what is coming, what is done.
//
// Grouping and order come from getDriverRides. This page never works out for
// itself whether a ride is over, so it cannot disagree with the guest's view
// or with admin's.

const LIVE_GROUPS = [
  { key: 'current', label: 'In progress' },
  { key: 'upcoming', label: 'Upcoming' },
];

export default function DriverRidesPage() {
  const location = useLocation();
  const { driver, isDriver, isLoading: profileLoading } = useDriverProfile();
  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const res = await base44.functions.invoke('getDriverRides', {});
      if (res?.data?.success) {
        setRides(res.data.data?.rides || []);
        setError(null);
      } else {
        setError(res?.data?.error || 'Could not load your rides.');
      }
    } catch (err) {
      console.error('getDriverRides failed:', err);
      setError(err?.message || 'Could not load your rides.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isDriver) load();
  }, [isDriver, load]);

  // A push notification links to #ride-<id>. Bring that card into view once
  // the list is on screen, opening the history group if that is where it is.
  useEffect(() => {
    const id = location.hash ? location.hash.slice(1) : '';
    if (!id || rides.length === 0) return;
    const target = rides.find((r) => `ride-${r.id}` === id);
    if (!target) return;
    if (target.bucket === 'past' || target.bucket === 'cancelled') setShowHistory(true);
    const t = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    return () => clearTimeout(t);
  }, [location.hash, rides]);

  if (profileLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400 dark:text-slate-500" />
      </div>
    );
  }
  if (!isDriver) return <DriverNotice />;

  const history = rides.filter((r) => r.bucket === 'past' || r.bucket === 'cancelled');
  const liveCount = rides.length - history.length;
  const paused = driver?.active === false || driver?.admin_approved === false;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-1">My rides</h1>
            <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-base">
              {driver?.full_name ? `${driver.full_name} · ` : ''}rides assigned to you and what each one pays
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="outline" size="icon" onClick={() => load(true)} disabled={refreshing}
              className="rounded-xl" aria-label="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {paused && (
          <div className="mb-4 flex items-start gap-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              Your profile is paused for new rides. Rides and pay you already have are still here.
            </p>
          </div>
        )}

        {error && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              <button type="button" onClick={() => load(true)} className="text-sm font-medium text-red-700 dark:text-red-300 underline mt-1">
                Try again
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400 dark:text-slate-500" />
          </div>
        ) : rides.length === 0 && !error ? (
          <Card className="bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
            <CardContent className="py-12 text-center">
              <Car className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
              <h2 className="font-semibold text-slate-900 dark:text-white mb-1">No rides yet</h2>
              <p className="text-sm text-slate-600 dark:text-slate-300 max-w-sm mx-auto">
                When the team assigns you to a ride it appears here with the pickup details and your pay,
                and you get a notification.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">
            {liveCount === 0 && !error && (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Nothing coming up right now. Your earlier rides are below.
              </p>
            )}

            {LIVE_GROUPS.map((group) => {
              const items = rides.filter((r) => r.bucket === group.key);
              if (items.length === 0) return null;
              return (
                <section key={group.key}>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3">
                    {group.label} ({items.length})
                  </h2>
                  <div className="space-y-3">
                    {items.map((ride) => <DriverRideCard key={ride.id} ride={ride} />)}
                  </div>
                </section>
              );
            })}

            {history.length > 0 && (
              <section>
                <button
                  type="button" onClick={() => setShowHistory((v) => !v)}
                  className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 mb-3"
                  aria-expanded={showHistory}
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
                  Past and cancelled ({history.length})
                </button>
                {showHistory && (
                  <div className="space-y-3">
                    {history.map((ride) => <DriverRideCard key={ride.id} ride={ride} />)}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Register the page and add it to the navigation**

A page that is not in `PUBLIC_PAGES` requires a session automatically (`RequireAuth` in `src/App.jsx`), which is what this one needs.

**Edit `src/pages.config.js`** — find:

```js
const Install = lazy(() => import('./pages/Install'));
```

replace with:

```js
const Install = lazy(() => import('./pages/Install'));
const DriverRides = lazy(() => import('./pages/DriverRides'));
```

**Edit `src/pages.config.js`** — find:

```js
    "Withdrawals": Withdrawals,
}
```

replace with:

```js
    "Withdrawals": Withdrawals,
    "DriverRides": DriverRides,
}
```

**Edit `src/Layout.jsx`** — find:

```jsx
import { Search, Calendar, User, Heart, MessageCircle, LayoutGrid, Compass, Settings, Shield, HelpCircle, Trophy, LogOut, Wallet, CreditCard } from "lucide-react";
```

replace with:

```jsx
import { Search, Calendar, User, Heart, MessageCircle, LayoutGrid, Compass, Settings, Shield, HelpCircle, Trophy, LogOut, Wallet, CreditCard, Car, Banknote } from "lucide-react";
```

**Edit `src/Layout.jsx`** — find:

```jsx
import { useAuth } from "@/lib/AuthContext";
```

replace with:

```jsx
import { useAuth } from "@/lib/AuthContext";
import { useDriverProfile } from "@/lib/useDriverProfile";
```

**Edit `src/Layout.jsx`** — find:

```jsx
  // Add admin link if user is admin
  const menuItems = [...navigationItems];
```

replace with:

```jsx
  // Drivers get their own pages first: it is what they open the app for.
  // isDriver stays false for everyone else, so nothing changes for guests.
  const { isDriver } = useDriverProfile();
  const driverItems = isDriver ? [
    {
      title: "My rides",
      url: createPageUrl("DriverRides"),
      icon: Car,
      description: "Rides assigned to you"
    },
  ] : [];

  // Add admin link if user is admin
  const menuItems = [...driverItems, ...navigationItems];
```

- [ ] **Step 8: Lint, parse and build**

Run: `npm run lint`

Expected: no output, exit code 0.

Run: `node_modules/.bin/esbuild base44/functions/getDriverRides/entry.ts --format=esm --target=esnext --outfile=/dev/null`

Expected: exit code 0.

Run: `set -a; . ./.env; set +a; npm run build`

Expected: `✓ built in …`, with a `DriverRides-….js` chunk in the list.

- [ ] **Step 9: Look at it**

Run the dev server (`npm run dev`) and open `http://localhost:5173/DriverRides` signed out. Expected: redirect to `/login?from_url=…`. Signed in as a non-driver: the "This page is for UrbanStays drivers" card, readable in light and in dark. Functions do not run locally, so the list itself is checked in the sandbox:

1. Signed in as a linked driver with one upcoming assigned ride: "My rides" is the first item in the sidebar; the ride shows vehicle, time in WAT, pickup, the passenger's name with a Call button, and "₦… held · releases …".
2. After the ride's end: the card moves under "Past and cancelled", the Call button is gone, and once released the pay line reads "₦… released to your wallet".

- [ ] **Step 10: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/getDriverRides/entry.ts src/components/driver/DriverRideCard.jsx src/pages/DriverRides.jsx src/pages.config.js src/Layout.jsx
git commit -m "feat(rides): My rides page for drivers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A08: The wallet — balance arithmetic, `getDriverWallet` and the page

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (wallet arithmetic section, above `// ---- result ----`)
- Create: `base44/functions/getDriverWallet/entry.ts`
- Create: `src/pages/DriverWallet.jsx`
- Modify: `src/pages.config.js` (register the page)
- Modify: `src/Layout.jsx` (second navigation item for drivers)
- Modify: `src/pages/DriverRides.jsx` (link to the wallet)

**Interfaces:**
- Consumes: `findDriverForUser(sr, email)` (Task A06, copied); entities `DriverEarning`, `WithdrawalRequest.wallet`, `WithdrawalRequest.driver_id`, `Driver.previous_user_emails` (Task A01); `useDriverProfile()`, `DriverNotice` (Task A06).
- Produces, server, in `getDriverWallet/entry.ts` — the origin of the wallet arithmetic that Tasks A09 and A14 copy character for character:
  - `const WITHDRAWAL_THRESHOLD_NGN = 10000`
  - `driverEmails(driver) → string[]` (current and previous logins, lower-cased, de-duplicated)
  - `driverWithdrawals(driver, rows) → rows` (only rows with `wallet === 'driver'`, this driver's id, made by one of the driver's logins)
  - `walletTotals(earnings, withdrawals) → { held, released, paid_out, reserved, available, shortfall }` (pass withdrawals through `driverWithdrawals` first)
  - `ledgerView(earning) → { id, ride_booking_id, booking_reference, vehicle_name, service_date, amount_ngn, status, on_hold, release_at, held_at, released_at, reversed_at }`
- Produces: function `getDriverWallet` — body `{}`; `403 NOT_A_DRIVER`; otherwise `data: { available_ngn, held_ngn, paid_out_ngn, reserved_ngn, shortfall_ngn, threshold_ngn, pending_withdrawal: { id, amount, status, requested_at } | null, ledger: LedgerRow[], ledger_truncated: boolean }`.
- Produces, client: page `DriverWallet`, registered under that key; its Withdraw button links to `/withdrawals?wallet=driver` (Task A10 makes that page understand the parameter).

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Wallet arithmetic ──────────────────────────────────────────────────────
// A driver's balance is never stored. It is these three functions applied to
// the ledger, every time, in every function that needs the number.
console.log('\n— wallet arithmetic —');
identical('findDriverForUser', FIND_DRIVER_SIG, ['getDriverProfile', 'getDriverWallet']);
const WALLET_HOME = 'getDriverWallet';
const walletSrc = (name, signature) => liftSrc(WALLET_HOME, name, signature);
const driverEmails = make('driverEmails', walletSrc('driverEmails', 'driver'));
const driverWithdrawals = make('driverWithdrawals',
  walletSrc('driverEmails', 'driver'), walletSrc('driverWithdrawals', 'driver, rows'));
const walletTotals = make('walletTotals', walletSrc('walletTotals', 'earnings, withdrawals'));

// Review focus 1: logins are matched however they were typed.
same('current and previous logins, lower-cased, once each',
  driverEmails({ user_email: ' Emeka@Gmail.com ', previous_user_emails: ['OLD@x.ng', 'old@x.ng', '', null] }),
  ['emeka@gmail.com', 'old@x.ng']);
same('a driver with no login has no emails', driverEmails({ id: 'd1' }), []);
same('no driver has no emails', driverEmails(null), []);

const emeka = { id: 'drvA', user_email: 'emeka@work.ng', previous_user_emails: ['emeka@gmail.com'] };
const wd = (id, extra = {}) => ({
  id, wallet: 'driver', driver_id: 'drvA', user_email: 'emeka@work.ng', amount: 10000, status: 'completed', ...extra,
});
same('which withdrawal rows count against a driver',
  driverWithdrawals(emeka, [
    wd('current-login'),
    wd('capitals-in-email', { user_email: 'Emeka@Work.NG ' }),
    wd('made-under-the-old-login', { user_email: 'emeka@gmail.com' }),
    wd('another-driver', { driver_id: 'drvB' }),
    // Anyone signed in can create a WithdrawalRequest row for their own email
    // and write any driver_id on it. It must not touch this driver's balance.
    wd('forged-by-a-stranger', { user_email: 'mallory@evil.ng' }),
    wd('referral-wallet-row', { wallet: 'referral' }),
    wd('row-from-before-wallets-existed', { wallet: undefined }),
    null,
  ]).map((w) => w.id),
  ['current-login', 'capitals-in-email', 'made-under-the-old-login']);
same('no driver, no rows', driverWithdrawals(null, [wd('x')]), []);
same('no rows at all', driverWithdrawals(emeka, undefined), []);

const ZERO = { held: 0, released: 0, paid_out: 0, reserved: 0, available: 0, shortfall: 0 };
const earn = (status, amount_ngn) => ({ status, amount_ngn });
same('an empty wallet', walletTotals([], []), ZERO);
same('nothing at all', walletTotals(undefined, undefined), ZERO);
same('held is not available; reversed counts nowhere',
  walletTotals([earn('held', 15000), earn('released', 20000), earn('reversed', 9999)], []),
  { ...ZERO, held: 15000, released: 20000, available: 20000 });
same('paid out and in-flight withdrawals both come off the balance',
  walletTotals([earn('released', 30000)], [wd('a', { amount: 10000 }), wd('b', { amount: 12000, status: 'pending' })]),
  { ...ZERO, released: 30000, paid_out: 10000, reserved: 12000, available: 8000 });
same('a processing withdrawal is still in flight',
  walletTotals([earn('released', 30000)], [wd('b', { amount: 12000, status: 'processing' })]),
  { ...ZERO, released: 30000, reserved: 12000, available: 18000 });
// No refund step exists for the driver wallet: a failed transfer just stops counting.
same('failed and reversed transfers put the money back by themselves',
  walletTotals([earn('released', 30000)], [wd('f', { amount: 30000, status: 'failed' }), wd('r', { amount: 30000, status: 'reversed' })]),
  { ...ZERO, released: 30000, available: 30000 });
// Review focus 2: pay reversed after it was withdrawn.
same('pay reversed after it was withdrawn: ₦0 available, never negative, shortfall recorded',
  walletTotals([earn('reversed', 10000)], [wd('a', { amount: 10000 })]),
  { ...ZERO, paid_out: 10000, available: 0, shortfall: 10000 });
same('…and the next released pay nets against that shortfall',
  walletTotals([earn('reversed', 10000), earn('released', 15000)], [wd('a', { amount: 10000 })]),
  { ...ZERO, released: 15000, paid_out: 10000, available: 5000, shortfall: 0 });
same('amounts stored as strings still count',
  walletTotals([earn('released', '20000')], [wd('a', { amount: '5000' })]),
  { ...ZERO, released: 20000, paid_out: 5000, available: 15000 });
same('kobo are rounded away', walletTotals([earn('released', 15000.4)], []), { ...ZERO, released: 15000, available: 15000 });
same('garbage, negative and infinite amounts count as nothing, never as NaN',
  walletTotals(
    [earn('released', 'abc'), earn('released', -500), earn('released', Infinity), earn('released', 1000)],
    [wd('a', { amount: NaN }), wd('b', { amount: Infinity, status: 'pending' }), wd('c', { amount: -1 })],
  ),
  { ...ZERO, released: 1000, available: 1000 });

const ledgerView = make('ledgerView', walletSrc('ledgerView', 'earning'));
same('exactly these ledger fields reach the driver',
  Object.keys(ledgerView({
    id: 'e1', driver_id: 'drvA', ride_booking_id: 'ride1', booking_reference: 'UD-AAA111', vehicle_name: 'Prado',
    service_date: '2026-08-10', amount_ngn: 15000, status: 'held', on_hold: true, hold_reason: 'internal',
    admin_notes: 'internal', adjustment_reason: 'internal', rate_ngn: 15000, units: 1, basis: 'daily',
    release_at: '2026-08-10T12:00:00.000Z', held_at: '2026-08-09T09:00:00.000Z',
  })).sort(),
  ['amount_ngn', 'booking_reference', 'held_at', 'id', 'on_hold', 'release_at', 'released_at', 'reversed_at',
    'ride_booking_id', 'service_date', 'status', 'vehicle_name']);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: ENOENT: no such file or directory, open '…/base44/functions/getDriverWallet/entry.ts'`.

- [ ] **Step 3: Create the function**

**Create `base44/functions/getDriverWallet/entry.ts`:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getDriverWallet
// ----------------------------------------------------------------------------
// The signed-in driver's money: what is held, what is available to withdraw,
// what has been paid out, and the ledger behind those three numbers.
//
// NOTHING HERE IS STORED. There is no balance column to drift or to tamper
// with. The balance is walletTotals() over the driver's DriverEarning rows and
// their own driver-wallet withdrawals, computed on every call. That is what
// makes release idempotent (flipping a row to released twice adds nothing)
// and makes a failed transfer refund itself (a failed row stops counting).
//
// This file is the HOME of the wallet arithmetic. createWithdrawalRequest,
// processWithdrawal and getDashboardStats carry lockstep copies of
// driverEmails, driverWithdrawals and walletTotals, and
// scripts/check-driver-wallet.mjs fails if any copy differs by a character.

const WITHDRAWAL_THRESHOLD_NGN = 10000;
const LEDGER_LIMIT = 200;

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

// ── Wallet arithmetic ───────────────────────────────────────────────────────
// Bodies are plain JavaScript: the check script lifts and runs them.

// Every login this driver is, or was, linked to. Lower-cased, once each.
function driverEmails(driver: any) {
    const all = [driver && driver.user_email].concat((driver && driver.previous_user_emails) || []);
    const out = [];
    for (const raw of all) {
        const email = String(raw || '').trim().toLowerCase();
        if (email && !out.includes(email)) out.push(email);
    }
    return out;
}

// The withdrawal rows that count against this driver's balance: driver-wallet
// rows carrying this driver's id AND made by a login that is, or was, linked
// to this driver. The second condition is not decoration. Until the staged
// rule that stops browsers creating WithdrawalRequest rows is live, any
// signed-in user can create one for their own email with any driver_id on it;
// the email is the one field the access rule pins to the creator.
function driverWithdrawals(driver: any, rows: any[]) {
    if (!driver) return [];
    const emails = driverEmails(driver);
    return (rows || []).filter((w) => !!w
        && w.wallet === 'driver'
        && w.driver_id === driver.id
        && emails.includes(String(w.user_email || '').trim().toLowerCase()));
}

// The driver's position in whole naira. Pass withdrawals through
// driverWithdrawals first. A failed or reversed transfer counts nowhere, so it
// needs no refund. If pay is reversed after it was withdrawn, available stops
// at zero and the difference is carried as shortfall until later pay covers it.
function walletTotals(earnings: any[], withdrawals: any[]) {
    const naira = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    let held = 0;
    let released = 0;
    for (const e of earnings || []) {
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
        else if (e.status === 'released') released += naira(e.amount_ngn);
    }
    let paidOut = 0;
    let reserved = 0;
    for (const w of withdrawals || []) {
        if (!w) continue;
        if (w.status === 'completed') paidOut += naira(w.amount);
        else if (w.status === 'pending' || w.status === 'processing') reserved += naira(w.amount);
    }
    const net = released - paidOut - reserved;
    return {
        held,
        released,
        paid_out: paidOut,
        reserved,
        available: Math.max(0, net),
        shortfall: Math.max(0, -net),
    };
}

// One ledger row as the driver sees it. An allow-list: hold reasons, admin
// notes and the rate behind the figure stay on the server.
function ledgerView(earning: any) {
    return {
        id: earning.id,
        ride_booking_id: earning.ride_booking_id,
        booking_reference: earning.booking_reference || null,
        vehicle_name: earning.vehicle_name || 'Ride',
        service_date: earning.service_date || null,
        amount_ngn: Math.max(0, Math.round(Number(earning.amount_ngn) || 0)),
        status: earning.status,
        on_hold: !!earning.on_hold,
        release_at: earning.release_at || null,
        held_at: earning.held_at || earning.created_date || null,
        released_at: earning.released_at || null,
        reversed_at: earning.reversed_at || null,
    };
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

        const sr = base44.asServiceRole.entities;
        const driver = await findDriverForUser(sr, user.email);
        if (!driver) {
            return json({
                success: false,
                error: 'This account is not linked to a driver profile.',
                code: 'NOT_A_DRIVER',
            }, 403);
        }

        const [earnings, withdrawalRows] = await Promise.all([
            fetchAll(sr.DriverEarning, { driver_id: driver.id }),
            fetchAll(sr.WithdrawalRequest, { driver_id: driver.id }),
        ]);
        const mine = driverWithdrawals(driver, withdrawalRows);
        const totals = walletTotals(earnings, mine);

        const newestFirst = (a: any, b: any) =>
            String(b.held_at || b.created_date || '').localeCompare(String(a.held_at || a.created_date || ''));
        const inFlight = mine
            .filter((w) => w.status === 'pending' || w.status === 'processing')
            .sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')))[0] || null;

        return json({
            success: true,
            data: {
                available_ngn: totals.available,
                held_ngn: totals.held,
                paid_out_ngn: totals.paid_out,
                reserved_ngn: totals.reserved,
                shortfall_ngn: totals.shortfall,
                threshold_ngn: WITHDRAWAL_THRESHOLD_NGN,
                pending_withdrawal: inFlight ? {
                    id: inFlight.id,
                    amount: Math.max(0, Math.round(Number(inFlight.amount) || 0)),
                    status: inFlight.status,
                    requested_at: inFlight.requested_at || inFlight.created_date || null,
                } : null,
                ledger: earnings.slice().sort(newestFirst).slice(0, LEDGER_LIMIT).map(ledgerView),
                ledger_truncated: earnings.length > LEDGER_LIMIT,
            },
        });
    } catch (error) {
        console.error('getDriverWallet error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
```

- [ ] **Step 4: Run the check and watch it pass**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, including every line under `— wallet arithmetic —`.

- [ ] **Step 5: Create the page**

**Create `src/pages/DriverWallet.jsx`:**

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Loader2, RefreshCw, Wallet, Clock, CheckCircle, Send, CreditCard, AlertCircle, Car, Undo2, PauseCircle,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
import { useDriverProfile } from '@/lib/useDriverProfile';
import DriverNotice from '@/components/driver/DriverNotice';

// DriverWallet — the driver's money in three numbers and the ledger behind them.
//
// Every figure comes from getDriverWallet, which computes it from the ledger
// on each call. This page adds nothing up and stores nothing.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

const fmtWhen = (iso) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
};

const fmtDay = (isoDate) => {
  if (!isoDate) return '';
  try {
    return new Date(`${isoDate}T12:00:00+01:00`).toLocaleDateString('en-GB', {
      timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch { return isoDate; }
};

// How one ledger row reads. The server has already decided the state.
function rowState(row) {
  if (row.status === 'released') {
    return {
      label: 'Released', icon: CheckCircle, note: row.released_at ? fmtWhen(row.released_at) : '',
      className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900',
    };
  }
  if (row.status === 'reversed') {
    return {
      label: 'Reversed', icon: Undo2, note: 'This ride no longer pays',
      className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700',
    };
  }
  if (row.on_hold || row.under_review) {
    return {
      label: 'Under review', icon: PauseCircle, note: 'The team is looking at this ride',
      className: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 border-orange-200 dark:border-orange-900',
    };
  }
  return {
    label: 'Held', icon: Clock, note: row.release_at ? `Releases ${fmtWhen(row.release_at)}` : '',
    className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900',
  };
}

function Tile({ label, value, sub, emphasis }) {
  return (
    <div className={`rounded-2xl p-4 sm:p-5 border ${
      emphasis
        ? 'bg-gradient-to-br from-slate-900 to-slate-800 border-slate-800 text-white'
        : 'bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800'
    }`}>
      <p className={`text-xs sm:text-sm mb-1 ${emphasis ? 'text-slate-300' : 'text-slate-500 dark:text-slate-400'}`}>{label}</p>
      <p className={`text-xl sm:text-2xl font-bold break-words ${emphasis ? 'text-white' : 'text-slate-900 dark:text-white'}`}>{value}</p>
      {sub ? (
        <p className={`text-xs mt-1 ${emphasis ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'}`}>{sub}</p>
      ) : null}
    </div>
  );
}

export default function DriverWalletPage() {
  const { isDriver, isLoading: profileLoading } = useDriverProfile();
  const [wallet, setWallet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const res = await base44.functions.invoke('getDriverWallet', {});
      if (res?.data?.success) {
        setWallet(res.data.data);
        setError(null);
      } else {
        setError(res?.data?.error || 'Could not load your wallet.');
      }
    } catch (err) {
      console.error('getDriverWallet failed:', err);
      setError(err?.message || 'Could not load your wallet.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isDriver) load();
  }, [isDriver, load]);

  if (profileLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400 dark:text-slate-500" />
      </div>
    );
  }
  if (!isDriver) return <DriverNotice />;

  const available = wallet?.available_ngn || 0;
  const threshold = wallet?.threshold_ngn || 10000;
  const pending = wallet?.pending_withdrawal || null;
  const shortfall = wallet?.shortfall_ngn || 0;
  const ledger = wallet?.ledger || [];
  const canWithdraw = !pending && available >= threshold;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mb-1">Wallet</h1>
            <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-base">
              Pay is held when you are assigned to a ride and released two hours after it ends.
            </p>
          </div>
          <Button
            variant="outline" size="icon" onClick={() => load(true)} disabled={refreshing}
            className="rounded-xl flex-shrink-0" aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              <button type="button" onClick={() => load(true)} className="text-sm font-medium text-red-700 dark:text-red-300 underline mt-1">
                Try again
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400 dark:text-slate-500" />
          </div>
        ) : wallet ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              <Tile label="Available" value={ngn(available)} sub="Ready to withdraw" emphasis />
              <Tile label="Held" value={ngn(wallet.held_ngn)} sub="Releases after each ride" />
              <Tile label="Paid out" value={ngn(wallet.paid_out_ngn)} sub="Sent to your bank" />
            </div>

            {pending && (
              <div className="mb-4 flex items-start gap-2 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-xl p-3">
                <Send className="w-4 h-4 text-blue-700 dark:text-blue-300 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-blue-900 dark:text-blue-100">
                  A withdrawal of {ngn(pending.amount)} is {pending.status === 'processing' ? 'on its way to your bank' : 'waiting to be processed'}.
                  It is already taken off your available balance.
                </p>
              </div>
            )}

            {shortfall > 0 && (
              <div className="mb-4 flex items-start gap-2 bg-orange-50 dark:bg-orange-950/40 border border-orange-200 dark:border-orange-900 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 text-orange-600 dark:text-orange-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-orange-900 dark:text-orange-100">
                  {ngn(shortfall)} of pay was reversed after you had withdrawn it. It will come off your next released pay.
                  Contact the team if this looks wrong.
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 mb-2">
              {canWithdraw ? (
                <Link to={`${createPageUrl('Withdrawals')}?wallet=driver`} className="flex-1">
                  <Button className="w-full rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
                    <Send className="w-4 h-4 mr-2" /> Withdraw to my bank
                  </Button>
                </Link>
              ) : (
                <Button disabled className="flex-1 rounded-xl">
                  <Send className="w-4 h-4 mr-2" /> Withdraw to my bank
                </Button>
              )}
              <Link to={createPageUrl('BankAccounts')} className="flex-1">
                <Button variant="outline" className="w-full rounded-xl">
                  <CreditCard className="w-4 h-4 mr-2" /> Bank accounts
                </Button>
              </Link>
            </div>
            {!canWithdraw && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-6">
                {pending
                  ? 'You can request another withdrawal once this one has finished.'
                  : `You can withdraw once ${ngn(threshold)} is available. You have ${ngn(available)}.`}
              </p>
            )}

            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-6 mb-3">
              Pay by ride
            </h2>

            {ledger.length === 0 ? (
              <Card className="bg-white/90 dark:bg-slate-900/90 border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
                <CardContent className="py-10 text-center">
                  <Wallet className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-1">No pay recorded yet</h3>
                  <p className="text-sm text-slate-600 dark:text-slate-300 max-w-sm mx-auto">
                    When you are assigned to a paid ride, your pay for it shows here as held.
                    Two hours after the ride ends it moves to available.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {ledger.map((row) => {
                  const state = rowState(row);
                  const StateIcon = state.icon;
                  return (
                    <div
                      key={row.id}
                      className="flex items-center gap-3 border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4 bg-white/80 dark:bg-slate-900/80"
                    >
                      <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0">
                        <Car className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                          {row.vehicle_name}
                          {row.booking_reference ? (
                            <span className="ml-2 font-mono font-normal text-xs text-slate-500 dark:text-slate-400">{row.booking_reference}</span>
                          ) : null}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {[fmtDay(row.service_date), state.note].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className={`font-bold text-sm sm:text-base ${row.status === 'reversed' ? 'text-slate-400 dark:text-slate-500 line-through' : 'text-slate-900 dark:text-white'}`}>
                          {ngn(row.amount_ngn)}
                        </p>
                        <Badge className={`${state.className} border font-medium mt-1`}>
                          <StateIcon className="w-3 h-3 mr-1" />
                          {state.label}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
                {wallet.ledger_truncated && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 text-center pt-2">
                    Showing your most recent 200 rides. The totals above count all of them.
                  </p>
                )}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Register the page, add it to the navigation, link it from My rides**

**Edit `src/pages.config.js`** — find:

```js
const DriverRides = lazy(() => import('./pages/DriverRides'));
```

replace with:

```js
const DriverRides = lazy(() => import('./pages/DriverRides'));
const DriverWallet = lazy(() => import('./pages/DriverWallet'));
```

**Edit `src/pages.config.js`** — find:

```js
    "DriverRides": DriverRides,
}
```

replace with:

```js
    "DriverRides": DriverRides,
    "DriverWallet": DriverWallet,
}
```

**Edit `src/Layout.jsx`** — find:

```jsx
      description: "Rides assigned to you"
    },
  ] : [];
```

replace with:

```jsx
      description: "Rides assigned to you"
    },
    {
      title: "Wallet",
      url: createPageUrl("DriverWallet"),
      icon: Banknote,
      description: "Held and available pay"
    },
  ] : [];
```

**Edit `src/pages/DriverRides.jsx`** — find:

```jsx
import { useLocation } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Car, ChevronDown, AlertCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
```

replace with:

```jsx
import { Link, useLocation } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Car, ChevronDown, AlertCircle, Banknote } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
```

**Edit `src/pages/DriverRides.jsx`** — find:

```jsx
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="outline" size="icon" onClick={() => load(true)} disabled={refreshing}
```

replace with:

```jsx
          <div className="flex items-center gap-2 flex-shrink-0">
            <Link to={createPageUrl('DriverWallet')}>
              <Button variant="outline" size="sm" className="rounded-xl">
                <Banknote className="w-4 h-4 sm:mr-2" /><span className="hidden sm:inline">Wallet</span>
              </Button>
            </Link>
            <Button
              variant="outline" size="icon" onClick={() => load(true)} disabled={refreshing}
```

- [ ] **Step 7: Lint, parse and build**

Run: `npm run lint`

Expected: no output, exit code 0.

Run: `node_modules/.bin/esbuild base44/functions/getDriverWallet/entry.ts --format=esm --target=esnext --outfile=/dev/null`

Expected: exit code 0.

Run: `set -a; . ./.env; set +a; npm run build`

Expected: `✓ built in …`, with a `DriverWallet-….js` chunk in the list.

- [ ] **Step 8: Look at it (sandbox, after the next publish)**

1. Signed in as a linked driver with one held and one released earning: "Wallet" is the second sidebar item; the three tiles read Available = the released amount, Held = the held amount, Paid out = ₦0; the ledger shows both rows, the held one with "Releases <weekday, date, time>".
2. With less than ₦10,000 available the Withdraw button is disabled and the line under it says how much is needed.
3. Signed in as a non-driver, open `/DriverWallet`. Expected: the "This page is for UrbanStays drivers" card.
4. Switch to dark mode on both states. Expected: no white panels, the Available tile stays dark with white text in both themes by design.

- [ ] **Step 9: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/getDriverWallet/entry.ts src/pages/DriverWallet.jsx src/pages/DriverRides.jsx src/pages.config.js src/Layout.jsx
git commit -m "feat(rides): driver wallet with a balance derived from the earnings ledger" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A09: Withdrawing from the driver wallet (the three functions)

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (withdrawals section, above `// ---- result ----`)
- Modify: `scripts/check-entities.mjs` (staged rule files must carry every live field)
- Replace: `base44/functions/createWithdrawalRequest/entry.ts`
- Modify: `base44/functions/processWithdrawal/entry.ts` (ledger re-check before paying; refunds skip driver-wallet rows)
- Modify: `base44/functions/paystackTransferWebhook/entry.ts` (refund skips driver-wallet rows; wording)
- Create: `docs/entity-rules-pending-publish/WithdrawalRequest.jsonc`
- Modify: `docs/entity-rules-pending-publish/README.md`

**Interfaces:**
- Consumes: `findDriverForUser` (Task A06), `driverEmails`, `driverWithdrawals`, `walletTotals`, `WITHDRAWAL_THRESHOLD_NGN` (Task A08), all copied character for character; `WithdrawalRequest.wallet`, `WithdrawalRequest.driver_id` (Task A01); `fakeEntity`, `FETCH_ALL` (Task A03).
- Produces: `createWithdrawalRequest` accepts `wallet: 'referral' | 'driver'` (default `'referral'`) beside `amount` and `bank_account_id`. Its answers keep their existing shape (`{ success: true, withdrawal_request, message }`, or `{ success: false, error, code }` with a 4xx). New codes: `INVALID_WALLET` (400), `INVALID_AMOUNT` (400), `NOT_A_DRIVER` (403). The row is created under the service role and carries `wallet`, plus `driver_id` for the driver wallet. Helper `parseWithdrawalAmount(raw) → integer | null`.
- Produces, in `processWithdrawal/entry.ts`: `async driverWithdrawalProblem(sr, withdrawal) → string` (`''` means "may be paid") and the refusal `NOT_COVERED` (409), which also marks the row `failed`. `refundsToBalance(withdrawal) → boolean`, identical in `processWithdrawal` and `paystackTransferWebhook`.
- Produces: staged rule `docs/entity-rules-pending-publish/WithdrawalRequest.jsonc` (`create` admin-only), to apply after the next publish.

**Why the row is the reservation.** A referral withdrawal debits `User.referral_balance_ngn` when it is requested and credits it back if the transfer fails. The driver wallet has no stored balance to debit. A pending or processing driver-wallet row simply counts against `walletTotals`, and a failed or reversed one stops counting. So for `wallet: 'driver'` nothing is debited on request and nothing is refunded on failure, and the two refund paths must skip those rows or a failed driver payout would credit referral cash that was never taken.

- [ ] **Step 1: Write the failing checks**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Withdrawals from the driver wallet ─────────────────────────────────────
console.log('\n— withdrawals —');
for (const dir of ['createWithdrawalRequest', 'processWithdrawal']) {
  identical('driverEmails', 'driver', [WALLET_HOME, dir]);
  identical('driverWithdrawals', 'driver, rows', [WALLET_HOME, dir]);
  identical('walletTotals', 'earnings, withdrawals', [WALLET_HOME, dir]);
  check(`one withdrawal minimum: ${dir} agrees with ${WALLET_HOME}`,
    constLine(dir, 'WITHDRAWAL_THRESHOLD_NGN'), constLine(WALLET_HOME, 'WITHDRAWAL_THRESHOLD_NGN'));
}
identical('findDriverForUser', FIND_DRIVER_SIG, ['getDriverProfile', 'createWithdrawalRequest']);
identical('refundsToBalance', 'withdrawal', ['processWithdrawal', 'paystackTransferWebhook']);

const parseWithdrawalAmount = make('parseWithdrawalAmount', liftSrc('createWithdrawalRequest', 'parseWithdrawalAmount', 'raw'));
check('a whole naira amount is taken as it is', parseWithdrawalAmount(15000), 15000);
check('kobo are refused, not rounded', parseWithdrawalAmount(15000.5), null);
check('a string is refused', parseWithdrawalAmount('15000'), null);
check('zero is refused', parseWithdrawalAmount(0), null);
check('negative is refused', parseWithdrawalAmount(-15000), null);
check('NaN is refused', parseWithdrawalAmount(NaN), null);
check('Infinity is refused', parseWithdrawalAmount(Infinity), null);
check('nothing is refused', parseWithdrawalAmount(undefined), null);

// A failed transfer credits a stored balance only if one was debited.
const refundsToBalance = make('refundsToBalance', liftSrc('processWithdrawal', 'refundsToBalance', 'withdrawal'));
check('a referral withdrawal is refunded to the referral balance', refundsToBalance({ wallet: 'referral' }), true);
check('a row from before wallets existed is a referral withdrawal', refundsToBalance({ amount: 10000 }), true);
check('a driver-wallet withdrawal is never credited to referral cash', refundsToBalance({ wallet: 'driver' }), false);
check('a missing row refunds nothing', refundsToBalance(null), false);

// processWithdrawal re-checks a driver-wallet request against the ledger just
// before it sends money. This is what makes a forged or stale row harmless.
const driverWithdrawalProblem = make('driverWithdrawalProblem',
  constLine('processWithdrawal', 'WITHDRAWAL_THRESHOLD_NGN'), FETCH_ALL,
  liftSrc('processWithdrawal', 'driverEmails', 'driver'),
  liftSrc('processWithdrawal', 'driverWithdrawals', 'driver, rows'),
  liftSrc('processWithdrawal', 'walletTotals', 'earnings, withdrawals'),
  liftSrc('processWithdrawal', 'driverWithdrawalProblem', 'sr, w'));
const bank = (requests, earnings, drivers = [{ id: 'drvA', user_email: 'emeka@work.ng', previous_user_emails: ['emeka@gmail.com'] }]) => ({
  Driver: fakeEntity(drivers), DriverEarning: fakeEntity(earnings), WithdrawalRequest: fakeEntity(requests),
});
const request = (extra = {}) => ({
  id: 'w1', wallet: 'driver', driver_id: 'drvA', user_email: 'emeka@work.ng', amount: 20000, status: 'pending', ...extra,
});
const releasedRow = (id, amount_ngn) => ({ id, driver_id: 'drvA', status: 'released', amount_ngn });
const problemFor = async (req, earnings, others = [], drivers) =>
  driverWithdrawalProblem(bank([req, ...others], earnings, drivers), req);

check('a request the ledger covers may be paid', await problemFor(request(), [releasedRow('e1', 20000)]), '');
check('…with the login typed in capitals', await problemFor(request({ user_email: 'Emeka@Work.NG' }), [releasedRow('e1', 20000)]), '');
// Hand-made in the browser console: half a million against ₦20,000 of earnings.
check('a request for more than was ever earned is refused',
  (await problemFor(request({ amount: 500000 }), [releasedRow('e1', 20000)])).includes('short by ₦480,000'), true);
check('held pay does not cover a withdrawal',
  (await problemFor(request(), [{ id: 'e1', driver_id: 'drvA', status: 'held', amount_ngn: 20000 }])).includes('short by ₦20,000'), true);
// Honest request, then admin reversed the ride's pay before processing it.
check('pay reversed after the request was made: refused',
  (await problemFor(request(), [{ id: 'e1', driver_id: 'drvA', status: 'reversed', amount_ngn: 20000 }])).includes('short by ₦20,000'), true);
check('money already paid out is not paid again',
  (await problemFor(request(), [releasedRow('e1', 20000)], [request({ id: 'w0', status: 'completed' })])).includes('short by ₦20,000'), true);
check('a failed earlier attempt does not block a retry',
  await problemFor(request(), [releasedRow('e1', 20000)], [request({ id: 'w0', status: 'failed' })]), '');
check('a stranger naming this driver is refused',
  await problemFor(request({ user_email: 'mallory@evil.ng' }), [releasedRow('e1', 20000)]),
  'This login is not the one linked to the driver profile.');
check('a login the driver was unlinked from cannot start a withdrawal',
  await problemFor(request({ user_email: 'emeka@gmail.com' }), [releasedRow('e1', 20000)]),
  'This login is not the one linked to the driver profile.');
check('a request naming no driver is refused',
  await problemFor(request({ driver_id: '' }), [releasedRow('e1', 20000)]), 'This request names no driver.');
check('a request for a driver who no longer exists is refused',
  await problemFor(request(), [releasedRow('e1', 20000)], [], []), 'The driver profile for this request no longer exists.');
for (const bad of [9999, 20000.5, 'abc', Infinity, -20000, null]) {
  check(`an amount of ${JSON.stringify(bad)} is refused`,
    await problemFor(request({ amount: bad }), [releasedRow('e1', 20000)]),
    'The amount on this request is not a valid withdrawal.');
}

// ---- result ----
```

**Edit `scripts/check-entities.mjs`** — find:

```js
// ── Result ─────────────────────────────────────────────────────────────────
```

replace with:

```js
// ── Rules staged for the next publish ──────────────────────────────────────
// docs/entity-rules-pending-publish/ holds stricter copies of some schemas.
// On publish day each one is copied over the live file. A staged copy that is
// missing a field the live schema has since gained would DELETE that field
// from production, so the two must always list the same fields.
console.log('\n— staged rules —');
const STAGED = path.join(ROOT, 'docs/entity-rules-pending-publish');
const stagedFiles = fs.existsSync(STAGED) ? fs.readdirSync(STAGED).filter((f) => f.endsWith('.jsonc')).sort() : [];
for (const file of stagedFiles) {
  const stem = file.replace(/\.jsonc$/, '');
  let staged;
  try {
    staged = JSON.parse(stripComments(fs.readFileSync(path.join(STAGED, file), 'utf8')));
  } catch (err) {
    check(`staged ${file} parses`, false, err.message);
    continue;
  }
  const live = entities[stem];
  const stagedFields = Object.keys(staged.properties || {}).sort();
  const liveFields = Object.keys(live?.properties || {}).sort();
  const dropped = liveFields.filter((k) => !stagedFields.includes(k));
  const invented = stagedFields.filter((k) => !liveFields.includes(k));
  check(`staged ${file} lists exactly the live fields`, !!live && dropped.length === 0 && invented.length === 0,
    !live ? 'no live schema of that name' : `would drop: [${dropped.join(', ')}] would add: [${invented.join(', ')}]`);
  check(`staged ${file} requires the same fields`, JSON.stringify(staged.required || []) === JSON.stringify(live?.required || []));
}
const stagedWithdrawal = stagedFiles.includes('WithdrawalRequest.jsonc')
  ? JSON.parse(stripComments(fs.readFileSync(path.join(STAGED, 'WithdrawalRequest.jsonc'), 'utf8')))
  : null;
// Until this is live, a signed-in user can create a pending withdrawal row by
// hand. createWithdrawalRequest already creates under the service role, so
// the strict rule breaks nothing once that function is published.
check('staged WithdrawalRequest: only the server may create a row', adminOnly(stagedWithdrawal?.rls?.create));
check('staged WithdrawalRequest: reading is unchanged',
  JSON.stringify(stagedWithdrawal?.rls?.read) === JSON.stringify(entities.WithdrawalRequest?.rls?.read));

// ── Result ─────────────────────────────────────────────────────────────────
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: could not find driverEmails in base44/functions/createWithdrawalRequest/entry.ts`.

Run: `node scripts/check-entities.mjs`

Expected: the three existing staged files pass, then ` FAIL  staged WithdrawalRequest: only the server may create a row` and ` FAIL  staged WithdrawalRequest: reading is unchanged`.

- [ ] **Step 3: Rewrite `createWithdrawalRequest`**

The referral path does exactly what it did (same checks, same debit, same race defence) with three differences: the amount must be a whole number, the row is created under the service role, and the row carries `wallet: 'referral'`.

**Replace `base44/functions/createWithdrawalRequest/entry.ts` with:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// createWithdrawalRequest
// ----------------------------------------------------------------------------
// A user asks for money to be sent to their bank. Admin then processes the
// request (processWithdrawal), and Paystack confirms the outcome later
// (paystackTransferWebhook).
//
// Two wallets, two ways of reserving the money:
//
//   referral  User.referral_balance_ngn is a stored number. The amount is
//             DEBITED here and credited back if the transfer fails.
//   driver    There is no stored balance. What a driver can withdraw is
//             walletTotals() over their released earnings and their earlier
//             driver-wallet withdrawals. Nothing is debited: the pending row
//             written here IS the reservation, and a failed row simply stops
//             counting. processWithdrawal re-checks the ledger before paying.
//
// The row is created under the service role. It used to be created as the
// user, which is why the WithdrawalRequest create rule lets a browser write
// one directly; the stricter rule staged in docs/entity-rules-pending-publish
// can be applied once this version is published.
//
// One withdrawal in flight per person, across both wallets.

const WITHDRAWAL_THRESHOLD_NGN = 10000;

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

// ── Wallet arithmetic — lockstep copies, see getDriverWallet ────────────────

// Every login this driver is, or was, linked to. Lower-cased, once each.
function driverEmails(driver: any) {
    const all = [driver && driver.user_email].concat((driver && driver.previous_user_emails) || []);
    const out = [];
    for (const raw of all) {
        const email = String(raw || '').trim().toLowerCase();
        if (email && !out.includes(email)) out.push(email);
    }
    return out;
}

// The withdrawal rows that count against this driver's balance: driver-wallet
// rows carrying this driver's id AND made by a login that is, or was, linked
// to this driver. The second condition is not decoration. Until the staged
// rule that stops browsers creating WithdrawalRequest rows is live, any
// signed-in user can create one for their own email with any driver_id on it;
// the email is the one field the access rule pins to the creator.
function driverWithdrawals(driver: any, rows: any[]) {
    if (!driver) return [];
    const emails = driverEmails(driver);
    return (rows || []).filter((w) => !!w
        && w.wallet === 'driver'
        && w.driver_id === driver.id
        && emails.includes(String(w.user_email || '').trim().toLowerCase()));
}

// The driver's position in whole naira. Pass withdrawals through
// driverWithdrawals first. A failed or reversed transfer counts nowhere, so it
// needs no refund. If pay is reversed after it was withdrawn, available stops
// at zero and the difference is carried as shortfall until later pay covers it.
function walletTotals(earnings: any[], withdrawals: any[]) {
    const naira = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    let held = 0;
    let released = 0;
    for (const e of earnings || []) {
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
        else if (e.status === 'released') released += naira(e.amount_ngn);
    }
    let paidOut = 0;
    let reserved = 0;
    for (const w of withdrawals || []) {
        if (!w) continue;
        if (w.status === 'completed') paidOut += naira(w.amount);
        else if (w.status === 'pending' || w.status === 'processing') reserved += naira(w.amount);
    }
    const net = released - paidOut - reserved;
    return {
        held,
        released,
        paid_out: paidOut,
        reserved,
        available: Math.max(0, net),
        shortfall: Math.max(0, -net),
    };
}

// The amount asked for: a positive whole number of naira, or null. Kobo are
// refused rather than rounded, so the figure the user typed is the figure
// that is reserved and the figure that is sent.
function parseWithdrawalAmount(raw: unknown) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return null;
    return raw;
}

const refuse = (status: number, error: string, code?: string) =>
    Response.json({ success: false, error, ...(code ? { code } : {}) }, { status });

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);

        const user = await base44.auth.me();
        if (!user) return refuse(401, 'Unauthorized');

        const body = await req.json().catch(() => ({}));
        const bank_account_id = body?.bank_account_id;

        if (body?.wallet !== undefined && body.wallet !== 'referral' && body.wallet !== 'driver') {
            return refuse(400, 'Unknown wallet.', 'INVALID_WALLET');
        }
        const wallet = body?.wallet === 'driver' ? 'driver' : 'referral';
        const label = wallet === 'driver' ? 'driver earnings' : 'referral earnings';

        if (body?.amount === undefined || body?.amount === null || !bank_account_id) {
            return refuse(400, 'Missing required fields: amount and bank_account_id');
        }
        const amount = parseWithdrawalAmount(body.amount);
        if (amount === null) {
            return refuse(400, 'Enter the amount in whole naira.', 'INVALID_AMOUNT');
        }
        if (amount < WITHDRAWAL_THRESHOLD_NGN) {
            return refuse(400, `Minimum withdrawal amount is ₦${WITHDRAWAL_THRESHOLD_NGN.toLocaleString()}`);
        }

        const sr = base44.asServiceRole.entities;

        // ── Which money, and how much of it is there ────────────────────
        let driver: any = null;
        let available = 0;
        if (wallet === 'driver') {
            // Resolved from the session email. Nothing the browser sends
            // chooses whose wallet this is.
            driver = await findDriverForUser(sr, user.email);
            if (!driver) {
                return refuse(403, 'This account is not linked to a driver profile.', 'NOT_A_DRIVER');
            }
            const [earnings, rows] = await Promise.all([
                fetchAll(sr.DriverEarning, { driver_id: driver.id }),
                fetchAll(sr.WithdrawalRequest, { driver_id: driver.id }),
            ]);
            available = walletTotals(earnings, driverWithdrawals(driver, rows)).available;
        } else {
            available = Number(user.referral_balance_ngn) || 0;
        }

        if (available < WITHDRAWAL_THRESHOLD_NGN) {
            return refuse(400, `You need at least ₦${WITHDRAWAL_THRESHOLD_NGN.toLocaleString()} in ${label} to withdraw. Current balance: ₦${available.toLocaleString()}.`);
        }
        if (amount > available) {
            return refuse(400, `Insufficient balance. You have ₦${available.toLocaleString()} available.`);
        }

        // ── The destination must be the caller's own verified account ───
        let bankAccount: any = null;
        try {
            bankAccount = await base44.entities.UserBankAccount.get(bank_account_id);
        } catch (_err) {
            bankAccount = null;
        }
        if (!bankAccount || bankAccount.user_email !== user.email) {
            return refuse(400, 'Invalid bank account');
        }
        if (!bankAccount.is_verified) {
            return refuse(400, 'Bank account is not verified. Please verify your account first.');
        }

        // ── One in flight per person, whichever wallet ──────────────────
        const inFlight = { user_email: user.email, status: { $in: ['pending', 'processing'] } };
        const pendingWithdrawals = await sr.WithdrawalRequest.filter(inFlight);
        if (pendingWithdrawals.length > 0) {
            return refuse(400, 'You have a pending withdrawal request. Please wait for it to complete.');
        }

        const withdrawalRequest = await sr.WithdrawalRequest.create({
            user_email: user.email,
            bank_account_id,
            amount,
            status: 'pending',
            requested_at: new Date().toISOString(),
            wallet,
            ...(driver ? { driver_id: driver.id } : {}),
        });

        // ── Race defence ────────────────────────────────────────────────
        // Two requests sent at the same instant both pass every check above.
        // Now that this row exists, look again: there must be exactly one in
        // flight, and the money must still cover it. If not, this request
        // loses and is marked failed.
        const livePending = await sr.WithdrawalRequest.filter(inFlight);
        let stillCovered = false;
        let referralUser: any = null;
        if (wallet === 'driver') {
            const [earnings, rows] = await Promise.all([
                fetchAll(sr.DriverEarning, { driver_id: driver.id }),
                fetchAll(sr.WithdrawalRequest, { driver_id: driver.id }),
            ]);
            // This request is now one of the rows, so "covered" means the
            // ledger shows no shortfall with it counted.
            stillCovered = walletTotals(earnings, driverWithdrawals(driver, rows)).shortfall === 0;
        } else {
            const fresh = await sr.User.filter({ email: user.email });
            referralUser = fresh[0] || null;
            stillCovered = !!referralUser && (Number(referralUser.referral_balance_ngn) || 0) >= amount;
        }

        if (livePending.length > 1 || !stillCovered) {
            await sr.WithdrawalRequest.update(withdrawalRequest.id, {
                status: 'failed',
                error_message: 'Concurrent withdrawal detected — request rejected.',
                processed_at: new Date().toISOString(),
            });
            return refuse(409, 'A concurrent withdrawal request was detected. Please try again in a moment.');
        }

        // Referral money is reserved by taking it off the stored balance.
        // Driver money needs no write: the pending row above is the reservation.
        if (wallet === 'referral') {
            await sr.User.update(referralUser.id, {
                referral_balance_ngn: (Number(referralUser.referral_balance_ngn) || 0) - amount,
            });
        }

        return Response.json({
            success: true,
            withdrawal_request: withdrawalRequest,
            message: 'Withdrawal request created successfully. It will be processed within 24-48 hours.',
        });
    } catch (error) {
        console.error('Error creating withdrawal request:', error);
        return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
});
```

- [ ] **Step 4: `processWithdrawal` re-checks a driver-wallet request against the ledger**

**Edit `base44/functions/processWithdrawal/entry.ts`** — find:

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

Deno.serve(async (req) => {
```

replace with:

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// processWithdrawal
// ----------------------------------------------------------------------------
// Admin sends a pending withdrawal to Paystack.
//
// A referral withdrawal was debited from User.referral_balance_ngn when it was
// requested, so it is refunded there if Paystack turns the transfer down.
//
// A driver-wallet withdrawal was not debited from anywhere: the row is the
// reservation against the driver's released earnings. So before any money
// moves, the request is checked against the ledger again here. That is the
// guard that matters, because nothing about the row itself can be trusted: a
// browser can create a WithdrawalRequest row directly until the stricter
// create rule staged in docs/entity-rules-pending-publish is live, and an
// honest request can be overtaken by a reversal of the pay it relied on.

const WITHDRAWAL_THRESHOLD_NGN = 10000;

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

// ── Wallet arithmetic — lockstep copies, see getDriverWallet ────────────────

// Every login this driver is, or was, linked to. Lower-cased, once each.
function driverEmails(driver: any) {
    const all = [driver && driver.user_email].concat((driver && driver.previous_user_emails) || []);
    const out = [];
    for (const raw of all) {
        const email = String(raw || '').trim().toLowerCase();
        if (email && !out.includes(email)) out.push(email);
    }
    return out;
}

// The withdrawal rows that count against this driver's balance: driver-wallet
// rows carrying this driver's id AND made by a login that is, or was, linked
// to this driver. The second condition is not decoration. Until the staged
// rule that stops browsers creating WithdrawalRequest rows is live, any
// signed-in user can create one for their own email with any driver_id on it;
// the email is the one field the access rule pins to the creator.
function driverWithdrawals(driver: any, rows: any[]) {
    if (!driver) return [];
    const emails = driverEmails(driver);
    return (rows || []).filter((w) => !!w
        && w.wallet === 'driver'
        && w.driver_id === driver.id
        && emails.includes(String(w.user_email || '').trim().toLowerCase()));
}

// The driver's position in whole naira. Pass withdrawals through
// driverWithdrawals first. A failed or reversed transfer counts nowhere, so it
// needs no refund. If pay is reversed after it was withdrawn, available stops
// at zero and the difference is carried as shortfall until later pay covers it.
function walletTotals(earnings: any[], withdrawals: any[]) {
    const naira = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    let held = 0;
    let released = 0;
    for (const e of earnings || []) {
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
        else if (e.status === 'released') released += naira(e.amount_ngn);
    }
    let paidOut = 0;
    let reserved = 0;
    for (const w of withdrawals || []) {
        if (!w) continue;
        if (w.status === 'completed') paidOut += naira(w.amount);
        else if (w.status === 'pending' || w.status === 'processing') reserved += naira(w.amount);
    }
    const net = released - paidOut - reserved;
    return {
        held,
        released,
        paid_out: paidOut,
        reserved,
        available: Math.max(0, net),
        shortfall: Math.max(0, -net),
    };
}

// Only a withdrawal that debited a stored balance is refunded to one. A row
// written before wallets existed is a referral withdrawal. Lockstep copy in
// paystackTransferWebhook.
function refundsToBalance(withdrawal: any) {
    return !!withdrawal && withdrawal.wallet !== 'driver';
}

// Why a driver-wallet withdrawal must not be paid, or '' when it may be.
// The request itself is one of the rows walletTotals counts, so "the ledger
// covers it" is the same as "there is no shortfall".
async function driverWithdrawalProblem(sr: any, w: any) {
    const amount = Number(w.amount);
    if (typeof w.amount !== 'number' || !Number.isInteger(amount) || amount < WITHDRAWAL_THRESHOLD_NGN) {
        return 'The amount on this request is not a valid withdrawal.';
    }
    if (!w.driver_id) return 'This request names no driver.';
    const driver = await sr.Driver.get(w.driver_id);
    if (!driver) return 'The driver profile for this request no longer exists.';
    // Only the login linked to the driver right now may start a withdrawal.
    const requester = String(w.user_email || '').trim().toLowerCase();
    if (!requester || requester !== String(driver.user_email || '').trim().toLowerCase()) {
        return 'This login is not the one linked to the driver profile.';
    }
    const earnings = await fetchAll(sr.DriverEarning, { driver_id: driver.id });
    const rows = await fetchAll(sr.WithdrawalRequest, { driver_id: driver.id });
    const totals = walletTotals(earnings, driverWithdrawals(driver, rows));
    if (totals.shortfall > 0) {
        return `The driver's released earnings do not cover this request (short by ₦${totals.shortfall.toLocaleString()}).`;
    }
    return '';
}

Deno.serve(async (req) => {
```

**Edit `base44/functions/processWithdrawal/entry.ts`** — find:

```ts
        // Get bank account details
        const bankAccount = await base44.asServiceRole.entities.UserBankAccount.get(withdrawalRequest.bank_account_id);
```

replace with:

```ts
        // A driver-wallet request is only as good as the ledger behind it.
        // Checked here, after the "still pending" guard and before anything
        // is sent, and a request that fails is closed so it cannot be retried
        // into a payout later.
        if (withdrawalRequest.wallet === 'driver') {
            const problem = await driverWithdrawalProblem(base44.asServiceRole.entities, withdrawalRequest);
            if (problem) {
                await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_request_id, {
                    status: 'failed',
                    error_message: problem,
                    processed_at: new Date().toISOString(),
                });
                return Response.json({ success: false, error: problem, code: 'NOT_COVERED' }, { status: 409 });
            }
        }

        // Get bank account details
        const bankAccount = await base44.asServiceRole.entities.UserBankAccount.get(withdrawalRequest.bank_account_id);
```

- [ ] **Step 5: The two refund paths in `processWithdrawal` skip driver-wallet rows**

The same three lines appear twice, at two indentation depths: once where creating the Paystack recipient fails, once where the transfer itself is refused.

**Edit `base44/functions/processWithdrawal/entry.ts`** — find:

```ts
                // Refund user
                const requestUser = await base44.asServiceRole.entities.User.filter({ email: withdrawalRequest.user_email });
                if (requestUser.length > 0) {
```

replace with:

```ts
                // Refund user. A driver-wallet request debited nothing, so it
                // has nothing to credit back: marking it failed is the refund.
                const requestUser = refundsToBalance(withdrawalRequest)
                    ? await base44.asServiceRole.entities.User.filter({ email: withdrawalRequest.user_email })
                    : [];
                if (requestUser.length > 0) {
```

**Edit `base44/functions/processWithdrawal/entry.ts`** — find:

```ts
            // Refund user
            const requestUser = await base44.asServiceRole.entities.User.filter({ email: withdrawalRequest.user_email });
            if (requestUser.length > 0) {
```

replace with:

```ts
            // Refund user. A driver-wallet request debited nothing, so it
            // has nothing to credit back: marking it failed is the refund.
            const requestUser = refundsToBalance(withdrawalRequest)
                ? await base44.asServiceRole.entities.User.filter({ email: withdrawalRequest.user_email })
                : [];
            if (requestUser.length > 0) {
```

- [ ] **Step 6: The transfer webhook skips them too**

**Edit `base44/functions/paystackTransferWebhook/entry.ts`** — find:

```ts
// Refunds the user's referral_balance_ngn for a failed/reversed transfer.
```

replace with:

```ts
// Only a withdrawal that debited a stored balance is refunded to one. A row
// written before wallets existed is a referral withdrawal. Lockstep copy in
// processWithdrawal.
function refundsToBalance(withdrawal: any) {
    return !!withdrawal && withdrawal.wallet !== 'driver';
}

// Refunds the user's referral_balance_ngn for a failed/reversed transfer.
```

**Edit `base44/functions/paystackTransferWebhook/entry.ts`** — find:

```ts
async function refundUser(sdk: any, withdrawal: any) {
    if (withdrawal.refunded_at) {
```

replace with:

```ts
async function refundUser(sdk: any, withdrawal: any) {
    // A driver-wallet payout was never debited from a stored balance. Its
    // failed or reversed row stops counting against the driver's earnings by
    // itself; crediting referral_balance_ngn here would be free money.
    if (!refundsToBalance(withdrawal)) {
        console.log(`Withdrawal ${withdrawal.id} is a driver-wallet payout: nothing to credit back`);
        return;
    }
    if (withdrawal.refunded_at) {
```

**Edit `base44/functions/paystackTransferWebhook/entry.ts`** — find:

```ts
            body: `We've refunded ₦${(Number(withdrawal.amount) || 0).toLocaleString()} to your referral balance. Tap to try again.`,
            url: '/Withdrawals',
```

replace with:

```ts
            body: refundsToBalance(withdrawal)
                ? `We've refunded ₦${(Number(withdrawal.amount) || 0).toLocaleString()} to your referral balance. Tap to try again.`
                : `₦${(Number(withdrawal.amount) || 0).toLocaleString()} is back in your driver wallet. Tap to try again.`,
            url: refundsToBalance(withdrawal) ? '/Withdrawals' : '/DriverWallet',
```

- [ ] **Step 7: Stage the stricter create rule**

It cannot go live before this version of `createWithdrawalRequest` is published: the function that is live today creates the row as the user, and an admin-only create rule would make every withdrawal request fail.

**Create `docs/entity-rules-pending-publish/WithdrawalRequest.jsonc`:**

```json
{
  "name": "WithdrawalRequest",
  "type": "object",
  "description": "STAGED for the next publish: identical to base44/entities/WithdrawalRequest.jsonc except that only the server may create a row. createWithdrawalRequest creates under the service role from the driver wallet work onwards, so nothing a user does needs to create one directly. Copy this file over the live one only after that function is published.",
  "properties": {
    "user_email": {
      "type": "string",
      "description": "Email of the user requesting withdrawal"
    },
    "bank_account_id": {
      "type": "string",
      "description": "Reference to the UserBankAccount used for this withdrawal"
    },
    "amount": {
      "type": "number",
      "description": "Amount to withdraw in NGN"
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "processing",
        "completed",
        "failed",
        "reversed"
      ],
      "default": "pending",
      "description": "Current status of the withdrawal"
    },
    "transfer_code": {
      "type": "string",
      "description": "Paystack transfer code/reference"
    },
    "transfer_id": {
      "type": "string",
      "description": "Paystack transfer ID"
    },
    "error_message": {
      "type": "string",
      "description": "Error details if the withdrawal failed"
    },
    "requested_at": {
      "type": "string",
      "format": "date-time",
      "description": "When the withdrawal was requested"
    },
    "processed_at": {
      "type": "string",
      "format": "date-time",
      "description": "When the withdrawal was completed/failed"
    },
    "refunded_at": {
      "type": "string",
      "format": "date-time",
      "description": "Set by paystackTransferWebhook when a failed/reversed transfer's reserved balance has been credited back to the user. Used as an idempotency guard so re-delivered webhooks can't double-refund."
    },
    "admin_notes": {
      "type": "string",
      "description": "Internal notes from admin review"
    },
    "wallet": {
      "type": "string",
      "enum": [
        "referral",
        "driver"
      ],
      "default": "referral",
      "description": "Which money this pays out. referral: debited from User.referral_balance_ngn at request time and refunded on failure. driver: nothing is debited; the row itself is the reservation against the driver's released earnings, and a failed row simply stops counting. Rows written before this field existed are referral."
    },
    "driver_id": {
      "type": "string",
      "description": "FK to Driver, set only when wallet is driver. The driver's balance counts withdrawals by this id."
    }
  },
  "required": [
    "user_email",
    "bank_account_id",
    "amount"
  ],
  "rls": {
    "create": {
      "user_condition": {
        "role": "admin"
      }
    },
    "read": {
      "$or": [
        {
          "data.user_email": "{{user.email}}"
        },
        {
          "user_condition": {
            "role": "admin"
          }
        }
      ]
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

**Edit `docs/entity-rules-pending-publish/README.md`** — find:

```md
| `User.jsonc` | field-level `write` admin-only on `loyalty_points` and `loyalty_tier` | same as above |
```

replace with:

```md
| `User.jsonc` | field-level `write` admin-only on `loyalty_points` and `loyalty_tier` | same as above |
| `WithdrawalRequest.jsonc` | `create` admin-only | `createWithdrawalRequest` from the driver wallet work (2026-10), which creates the row under the service role. Until this rule is live a signed-in user can create a pending withdrawal row by hand; driver-wallet rows are re-checked against the ledger by `processWithdrawal`, referral rows are not |
```

**Edit `docs/entity-rules-pending-publish/README.md`** — find:

```md
4. Copy the three files here over the same names in `base44/entities/`, commit, and push each
```

replace with:

```md
4. Copy every `.jsonc` file here over the same name in `base44/entities/`, commit, and push each
```

- [ ] **Step 8: Run the checks**

Run: `npm run check`

Expected: four `PASS` lines. `check-entities` now ends with a `— staged rules —` section in which every staged file "lists exactly the live fields".

Run: `for f in createWithdrawalRequest processWithdrawal paystackTransferWebhook; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done`

Expected: no `PARSE FAIL` line.

- [ ] **Step 9: Sandbox checklist (after the next publish)**

1. As a user with ₦10,000 or more of referral balance and a verified bank account, request a withdrawal from the Withdrawals page. Expected: created exactly as before; the row has `wallet: referral`; the referral balance drops by the amount.
2. As a linked driver with ₦10,000 or more released, call `await base44.functions.invoke('createWithdrawalRequest', { amount: 10000, bank_account_id: '<own verified account>', wallet: 'driver' })`. Expected: `success: true`; the row has `wallet: driver` and the driver's id; `User.referral_balance_ngn` is unchanged; `getDriverWallet` shows available reduced by 10,000 and `pending_withdrawal` set.
3. As that driver, from the console, create a row by hand: `await base44.entities.WithdrawalRequest.create({ user_email: '<own email>', bank_account_id: '<own account>', amount: 5000000, status: 'pending', wallet: 'driver', driver_id: '<own driver id>' })`. Then, as admin, press Process now on it. Expected: refused with "The driver's released earnings do not cover this request…", the row is `failed`, nothing is sent to Paystack.
4. Apply the staged rule, then repeat the hand-made create. Expected: refused by the platform.

- [ ] **Step 10: Commit**

```bash
git add scripts/check-driver-wallet.mjs scripts/check-entities.mjs base44/functions/createWithdrawalRequest/entry.ts base44/functions/processWithdrawal/entry.ts base44/functions/paystackTransferWebhook/entry.ts docs/entity-rules-pending-publish/WithdrawalRequest.jsonc docs/entity-rules-pending-publish/README.md
git commit -m "feat(rides): withdraw from the driver wallet, re-checked against the ledger before paying" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A10: The Withdrawals page knows two wallets, and refusals are readable

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (function results section, above `// ---- result ----`)
- Create: `src/lib/fnResult.js`
- Create: `src/lib/invokeFn.js`
- Modify: `src/pages/Withdrawals.jsx`
- Modify: `src/pages/DriverRides.jsx`, `src/pages/DriverWallet.jsx` (load through `invokeFn`)

**Interfaces:**
- Consumes: `useDriverProfile()` (Task A06); function `getDriverWallet` → `data.available_ngn` (Task A08); `createWithdrawalRequest` with `wallet` (Task A09).
- Produces: `fromResponse(res)` and `fromThrown(err)` in `src/lib/fnResult.js`, both returning `{ ok, data, error, code, status, body }`; `async invokeFn(name, body = {})` in `src/lib/invokeFn.js`, which never throws and returns that same shape. Every later task that calls a function from the browser uses `invokeFn`.
- The Withdrawals page reads `?wallet=driver`, shows a two-way switch to drivers only, and sends `wallet` with the request.

**Why `invokeFn` exists.** `base44.functions.invoke` is an axios call with no response interceptor (`@base44/sdk`, `client.js`: `interceptResponses: false` for the functions client). A 2xx resolves to the axios response; anything else rejects. Every function in this app answers a refusal with a 4xx and a sentence (`{ success: false, error, code }`), so that sentence only ever arrives inside the thrown error's `response.data`. Code that checks `res.data.success` in an `else` branch never sees it, and a `catch` that shows `err.message` shows "Request failed with status code 409". `invokeFn` gives one result shape for both outcomes.

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
import * as rides from '../src/config/rides.js';
```

replace with:

```js
import * as rides from '../src/config/rides.js';
import { fromResponse, fromThrown } from '../src/lib/fnResult.js';
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Reading what a function said ───────────────────────────────────────────
// A refusal is a 4xx with a sentence in it, and axios throws on a 4xx. These
// two functions are what stand between the user and "Request failed with
// status code 409".
console.log('\n— function results —');
{
  const r = fromResponse({ status: 200, data: { success: true, data: { rides: [] } } });
  same('a success carries its data', [r.ok, r.data, r.error], [true, { rides: [] }, null]);
}
{
  // createWithdrawalRequest answers { success, withdrawal_request, message } with no `data` key.
  const r = fromResponse({ status: 200, data: { success: true, message: 'Created', withdrawal_request: { id: 'w1' } } });
  same('an older success shape keeps its body', [r.ok, r.data, r.body.message], [true, null, 'Created']);
}
{
  const r = fromResponse({ status: 200, data: { success: false, error: 'Already decided', code: 'ALREADY_DECIDED' } });
  same('a 200 that says no is not ok', [r.ok, r.error, r.code], [false, 'Already decided', 'ALREADY_DECIDED']);
}
{
  const r = fromThrown({
    message: 'Request failed with status code 409',
    response: { status: 409, data: { success: false, error: 'No driver cost is set for this vehicle.', code: 'PAYOUT_REQUIRED' } },
  });
  same('a refusal gives the server sentence, not the axios one',
    [r.ok, r.error, r.code, r.status], [false, 'No driver cost is set for this vehicle.', 'PAYOUT_REQUIRED', 409]);
}
{
  const r = fromThrown({ message: 'Request failed with status code 400', response: { status: 400, data: { error: 'Minimum withdrawal amount is ₦10,000' } } });
  check('an older refusal shape is read too', r.error, 'Minimum withdrawal amount is ₦10,000');
}
{
  // What the platform itself answers when the workspace plan has no functions.
  const r = fromThrown({ message: 'Request failed with status code 402', response: { status: 402, data: { message: 'Functions are blocked - app owner lacks backend functions capability' } } });
  same('a platform refusal is shown as it was sent',
    [r.error, r.status], ['Functions are blocked - app owner lacks backend functions capability', 402]);
}
check('no response at all reads as a connection problem',
  fromThrown({ message: 'Network Error' }).error, 'Could not reach the server. Check your connection and try again.');
check('an error page instead of JSON falls back to the transport message',
  fromThrown({ message: 'Request failed with status code 502', response: { status: 502, data: '<html>Bad gateway</html>' } }).error,
  'Request failed with status code 502');
check('nothing at all still gives a sentence', typeof fromThrown(undefined).error, 'string');
check('a malformed success is not ok', fromResponse({ status: 200, data: null }).ok, false);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/lib/fnResult.js'`.

- [ ] **Step 3: Create the two small modules**

`fnResult.js` imports nothing, so the check script can load it directly. `invokeFn.js` is the only place that touches the SDK.

**Create `src/lib/fnResult.js`:**

```js
// Reading what a backend function said.
//
// Every function in this app answers { success: true, data } on a 2xx, and
// { success: false, error, code } with a 4xx or 5xx when it refuses. The SDK
// call is plain axios, which RESOLVES the first and THROWS the second, so the
// sentence a person is meant to read ("No driver cost is set for this
// vehicle…") arrives inside the thrown error, not in a response.
//
// These two functions turn both outcomes into one shape:
//   { ok, data, error, code, status, body }
// No imports on purpose: scripts/check-driver-wallet.mjs loads this file as it is.

const FALLBACK = 'Something went wrong. Please try again.';
const OFFLINE = 'Could not reach the server. Check your connection and try again.';

// The sentence in a response body, wherever this function put it. Older
// functions use `error` alone; the platform itself uses `message` or `detail`.
const sentenceIn = (body) => {
  if (!body || typeof body !== 'object') return null;
  for (const key of ['error', 'message', 'detail']) {
    if (typeof body[key] === 'string' && body[key].trim()) return body[key];
  }
  return null;
};

// The call resolved: a 2xx.
export function fromResponse(res) {
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : null;
  const status = (res && res.status) || null;
  if (body && body.success === true) {
    return { ok: true, data: body.data === undefined ? null : body.data, error: null, code: null, status, body };
  }
  return { ok: false, data: null, error: sentenceIn(body) || FALLBACK, code: (body && body.code) || null, status, body };
}

// The call threw: a refusal (4xx), a failure (5xx), or no answer at all.
export function fromThrown(err) {
  const response = (err && err.response) || null;
  const raw = (response && response.data) || (err && err.data) || null;
  const body = raw && typeof raw === 'object' ? raw : null;
  const status = (response && response.status) || (err && err.status) || null;
  const transport = err && typeof err.message === 'string' && err.message ? err.message : null;
  // No response and no body means the request never got an answer.
  const error = sentenceIn(body) || (!response && !raw ? OFFLINE : (transport || FALLBACK));
  return { ok: false, data: null, error, code: (body && body.code) || null, status, body };
}
```

**Create `src/lib/invokeFn.js`:**

```js
import { base44 } from '@/api/base44Client';
import { fromResponse, fromThrown } from '@/lib/fnResult';

// invokeFn — call a backend function and get one result shape back, whether
// it succeeded, refused or never answered:
//
//   const r = await invokeFn('assignRideDriver', { ride_booking_id, driver_id });
//   if (r.ok) use(r.data); else toast({ description: r.error });   // r.code for branching
//
// It never throws. See src/lib/fnResult.js for why a bare
// base44.functions.invoke hides the server's reason for a refusal.
export async function invokeFn(name, body = {}) {
  try {
    return fromResponse(await base44.functions.invoke(name, body));
  } catch (err) {
    return fromThrown(err);
  }
}
```

- [ ] **Step 4: Run the check and watch it pass**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, including every line under `— function results —`.

- [ ] **Step 5: The two driver pages load through `invokeFn`**

**Edit `src/pages/DriverRides.jsx`** — find:

```jsx
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
```

replace with:

```jsx
import { invokeFn } from '@/lib/invokeFn';
import { createPageUrl } from '@/utils';
```

**Edit `src/pages/DriverRides.jsx`** — find:

```jsx
    try {
      const res = await base44.functions.invoke('getDriverRides', {});
      if (res?.data?.success) {
        setRides(res.data.data?.rides || []);
        setError(null);
      } else {
        setError(res?.data?.error || 'Could not load your rides.');
      }
    } catch (err) {
      console.error('getDriverRides failed:', err);
      setError(err?.message || 'Could not load your rides.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
```

replace with:

```jsx
    const r = await invokeFn('getDriverRides');
    if (r.ok) {
      setRides(r.data?.rides || []);
      setError(null);
    } else {
      setError(r.error);
    }
    setLoading(false);
    setRefreshing(false);
```

**Edit `src/pages/DriverWallet.jsx`** — find:

```jsx
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
```

replace with:

```jsx
import { invokeFn } from '@/lib/invokeFn';
import { createPageUrl } from '@/utils';
```

**Edit `src/pages/DriverWallet.jsx`** — find:

```jsx
    try {
      const res = await base44.functions.invoke('getDriverWallet', {});
      if (res?.data?.success) {
        setWallet(res.data.data);
        setError(null);
      } else {
        setError(res?.data?.error || 'Could not load your wallet.');
      }
    } catch (err) {
      console.error('getDriverWallet failed:', err);
      setError(err?.message || 'Could not load your wallet.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
```

replace with:

```jsx
    const r = await invokeFn('getDriverWallet');
    if (r.ok) {
      setWallet(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
    setLoading(false);
    setRefreshing(false);
```

- [ ] **Step 6: Teach the Withdrawals page about the driver wallet**

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
import { Link } from 'react-router-dom';
```

replace with:

```jsx
import { Link, useLocation } from 'react-router-dom';
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
import { useToast } from '@/components/ui/use-toast';

const WITHDRAWAL_THRESHOLD_NGN = 10000;
```

replace with:

```jsx
import { useToast } from '@/components/ui/use-toast';
import { useDriverProfile } from '@/lib/useDriverProfile';
import { invokeFn } from '@/lib/invokeFn';

const WITHDRAWAL_THRESHOLD_NGN = 10000;
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);
```

replace with:

```jsx
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);

  // Drivers have a second wallet. ?wallet=driver (the Withdraw button on the
  // driver's Wallet page) opens this page on it. Anyone who is not a driver
  // stays on referral whatever the URL says, and the server checks again.
  const location = useLocation();
  const { isDriver } = useDriverProfile();
  const [chosenWallet, setChosenWallet] = useState(
    () => (new URLSearchParams(location.search).get('wallet') === 'driver' ? 'driver' : 'referral'),
  );
  const [driverWallet, setDriverWallet] = useState(null);
  const wallet = chosenWallet === 'driver' && isDriver ? 'driver' : 'referral';
  const walletLabel = wallet === 'driver' ? 'driver earnings' : 'referral earnings';
  // The driver figure is computed by the server from the earnings ledger; the
  // referral figure is the stored balance, as before.
  const availableBalance = wallet === 'driver'
    ? (driverWallet?.available_ngn || 0)
    : (user?.referral_balance_ngn || 0);
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
  useEffect(() => {
    loadData();
  }, []);
```

replace with:

```jsx
  useEffect(() => {
    loadData();
  }, []);

  const loadDriverWallet = async () => {
    const r = await invokeFn('getDriverWallet');
    if (r.ok) setDriverWallet(r.data);
  };

  useEffect(() => {
    if (isDriver) loadDriverWallet();
  }, [isDriver]);
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
    const amount = parseFloat(formData.amount);
    if (amount < WITHDRAWAL_THRESHOLD_NGN) {
```

replace with:

```jsx
    const amount = Number(formData.amount);
    if (!Number.isInteger(amount)) {
      toast({
        title: 'Whole naira only',
        description: 'Enter the amount without kobo, for example 15000.',
        variant: 'destructive',
      });
      return;
    }
    if (amount < WITHDRAWAL_THRESHOLD_NGN) {
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
    if (amount > (user?.referral_balance_ngn || 0)) {
      toast({
        title: 'Insufficient balance',
        description: `You have ₦${(user?.referral_balance_ngn || 0).toLocaleString()} available.`,
```

replace with:

```jsx
    if (amount > availableBalance) {
      toast({
        title: 'Insufficient balance',
        description: `You have ₦${availableBalance.toLocaleString()} available.`,
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
      const response = await base44.functions.invoke('createWithdrawalRequest', {
        amount: amount,
        bank_account_id: formData.bank_account_id
      });

      if (response.data.success) {
```

replace with:

```jsx
      // invokeFn turns a refusal (a 4xx carrying the reason) into a result
      // rather than an exception, so the branch below shows the server's own
      // sentence: "You have a pending withdrawal request…", not a status code.
      const result = await invokeFn('createWithdrawalRequest', {
        amount,
        bank_account_id: formData.bank_account_id,
        wallet,
      });
      const response = { data: result.ok ? result.body : { success: false, error: result.error } };

      if (response.data.success) {
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
        setShowRequestForm(false);
        await loadData();
```

replace with:

```jsx
        setShowRequestForm(false);
        await loadData();
        if (isDriver) await loadDriverWallet();
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
  const availableBalance = user?.referral_balance_ngn || 0;

  return (
```

replace with:

```jsx
  return (
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
          <p className="text-slate-600 dark:text-slate-300 text-base sm:text-lg">Withdraw your earnings to your bank account</p>
        </div>
```

replace with:

```jsx
          <p className="text-slate-600 dark:text-slate-300 text-base sm:text-lg">Withdraw your earnings to your bank account</p>
        </div>

        {isDriver && (
          <div
            className="mb-4 inline-flex rounded-xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 p-1"
            role="tablist" aria-label="Which earnings to withdraw"
          >
            {[{ id: 'driver', label: 'Driver earnings' }, { id: 'referral', label: 'Referral earnings' }].map((option) => (
              <button
                key={option.id} type="button" role="tab" aria-selected={wallet === option.id}
                onClick={() => {
                  setChosenWallet(option.id);
                  setShowRequestForm(false);
                  setFormData({ amount: '', bank_account_id: '' });
                }}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  wallet === option.id
                    ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
                <p className="text-xs sm:text-sm text-slate-400 dark:text-slate-500 mt-2">From referrals and other earnings</p>
```

replace with:

```jsx
                <p className="text-xs sm:text-sm text-slate-400 dark:text-slate-500 mt-2">
                  {wallet === 'driver' ? 'Released pay from your rides' : 'From referrals and other earnings'}
                </p>
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
                  You need at least ₦{WITHDRAWAL_THRESHOLD_NGN.toLocaleString()} in referral
                  earnings to request a withdrawal. You currently have ₦{availableBalance.toLocaleString()}
```

replace with:

```jsx
                  You need at least ₦{WITHDRAWAL_THRESHOLD_NGN.toLocaleString()} in {walletLabel} to
                  request a withdrawal. You currently have ₦{availableBalance.toLocaleString()}
```

**Edit `src/pages/Withdrawals.jsx`** — find:

```jsx
                                {config.label}
                              </Badge>
```

replace with:

```jsx
                                {config.label}
                              </Badge>
                              {isDriver && (
                                <Badge variant="outline" className="text-xs">
                                  {withdrawal.wallet === 'driver' ? 'Driver earnings' : 'Referral'}
                                </Badge>
                              )}
```

- [ ] **Step 7: Lint and build**

Run: `npm run lint`

Expected: no output, exit code 0.

Run: `set -a; . ./.env; set +a; npm run build`

Expected: `✓ built in …`.

- [ ] **Step 8: Look at it (sandbox, after the next publish)**

1. As a guest who is not a driver, open `/Withdrawals` and `/Withdrawals?wallet=driver`. Expected: both look exactly as the page does today, no switch, referral balance shown.
2. As a linked driver, open the Wallet page and press Withdraw to my bank. Expected: the Withdrawals page opens with "Driver earnings" selected, the balance card shows the wallet's Available figure and "Released pay from your rides".
3. Request ₦10,000 from driver earnings. Expected: "Withdrawal requested"; the history row carries a "Driver earnings" badge; the Wallet page shows the withdrawal in progress.
4. Request again straight away. Expected: a toast reading "You have a pending withdrawal request. Please wait for it to complete." (the server's sentence, not a status code).

- [ ] **Step 9: Commit**

```bash
git add scripts/check-driver-wallet.mjs src/lib/fnResult.js src/lib/invokeFn.js src/pages/Withdrawals.jsx src/pages/DriverRides.jsx src/pages/DriverWallet.jsx
git commit -m "feat(rides): withdraw driver earnings from the Withdrawals page; show a function's own reason when it refuses" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A11: Admin settlement functions — `settleDriverEarning` and `completeRide`

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (admin settlement section, above `// ---- result ----`)
- Create: `base44/functions/settleDriverEarning/entry.ts`
- Create: `base44/functions/completeRide/entry.ts`

**Interfaces:**
- Consumes: entity `DriverEarning`, `RideBooking.completed_at`, `RideBooking.completed_by` (Task A01); `releaseDecision(earning, ride)` (Task A05, copied); `rideDurationMs`, `windowOf` (copies); `MAX_PAYOUT_NGN` (Task A02, same value).
- Produces: function `settleDriverEarning` — admin only; body `{ earning_id, action: 'release' | 'hold' | 'unhold' | 'adjust' | 'reverse', reason?, amount_ngn? }`; answers `{ success: true, data: { earning, was_released } }` where `earning` is the full updated row and `was_released` says the driver could already withdraw it before this call. Refusals: `NOT_FOUND` (404), `INVALID_ACTION`, `REASON_REQUIRED`, `INVALID_AMOUNT` (400), `NOT_HELD`, `ALREADY_REVERSED`, `RIDE_STATE` (409). Helper `nextEarningState(action, earning, input, nowIso) → { ok: true, patch } | { ok: false, code }`.
- Produces: function `completeRide` — admin only; body `{ ride_booking_id }`; answers `{ success: true, data: { ride_booking_id, status: 'completed', already } }`. Refusals: `NOT_FOUND` (404), `CANCELLED`, `NOT_PAID`, `NOT_STARTED` (409). Helper `completionProblem(ride, nowMs) → '' | 'ALREADY' | 'CANCELLED' | 'NOT_PAID' | 'NOT_STARTED'`. Completing a ride never releases money.

**What each action does to the driver's balance.** None of them writes a balance, because there is none. `release` moves the amount from held to available. `reverse` on a held row removes it from held; on a released row it removes it from available, and if the driver had already withdrawn it the difference shows as a shortfall that their next released pay nets against (Task A08).

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Admin settlement ───────────────────────────────────────────────────────
console.log('\n— admin settlement —');
identical('releaseDecision', 'earning, ride', ['autoCancelExpiredBookings', 'settleDriverEarning']);
check('one pay ceiling: settleDriverEarning agrees with assignRideDriver',
  constLine('settleDriverEarning', 'MAX_PAYOUT_NGN'), constLine('assignRideDriver', 'MAX_PAYOUT_NGN'));
const nextEarningState = make('nextEarningState',
  constLine('settleDriverEarning', 'MAX_PAYOUT_NGN'), constLine('settleDriverEarning', 'MAX_REASON_LENGTH'),
  liftSrc('settleDriverEarning', 'nextEarningState', 'action, earning, input, nowIso'));
const AT = '2026-08-10T12:00:00.000Z';
const heldE = { id: 'e1', status: 'held', amount_ngn: 15000, on_hold: false };
const refusal = (code) => ({ ok: false, code });

same('release: held becomes released and any pause is lifted',
  nextEarningState('release', { ...heldE, on_hold: true, hold_reason: 'dispute' }, {}, AT),
  { ok: true, patch: { status: 'released', released_at: AT, on_hold: false, hold_reason: '' } });
same('release: a released row cannot be released again', nextEarningState('release', { ...heldE, status: 'released' }, {}, AT), refusal('NOT_HELD'));
same('hold: needs a reason', nextEarningState('hold', heldE, { reason: '  ' }, AT), refusal('REASON_REQUIRED'));
same('hold: pauses with the reason',
  nextEarningState('hold', heldE, { reason: ' Guest disputes the trip ' }, AT),
  { ok: true, patch: { on_hold: true, hold_reason: 'Guest disputes the trip' } });
same('hold: only held pay can be paused', nextEarningState('hold', { ...heldE, status: 'released' }, { reason: 'x' }, AT), refusal('NOT_HELD'));
same('unhold: lifts the pause',
  nextEarningState('unhold', { ...heldE, on_hold: true }, {}, AT), { ok: true, patch: { on_hold: false, hold_reason: '' } });
same('adjust: changes the figure and records why',
  nextEarningState('adjust', heldE, { amount_ngn: 20000.4, reason: 'Two extra hours' }, AT),
  { ok: true, patch: { amount_ngn: 20000, basis: 'manual', rate_ngn: 20000, units: 1, adjustment_reason: 'Two extra hours', adjusted_at: AT } });
same('adjust: zero is allowed', nextEarningState('adjust', heldE, { amount_ngn: 0, reason: 'Driver did not show' }, AT).ok, true);
same('adjust: needs a reason', nextEarningState('adjust', heldE, { amount_ngn: 20000 }, AT), refusal('REASON_REQUIRED'));
for (const bad of [-1, 50000001, NaN, Infinity, '20000', null, undefined]) {
  same(`adjust: an amount of ${JSON.stringify(bad) ?? String(bad)} is refused`,
    nextEarningState('adjust', heldE, { amount_ngn: bad, reason: 'x' }, AT), refusal('INVALID_AMOUNT'));
}
same('adjust: released pay cannot be repriced', nextEarningState('adjust', { ...heldE, status: 'released' }, { amount_ngn: 1, reason: 'x' }, AT), refusal('NOT_HELD'));
same('reverse: held pay is reversed with the reason on record',
  nextEarningState('reverse', heldE, { reason: 'Ride did not happen' }, AT),
  { ok: true, patch: { status: 'reversed', reversed_at: AT, on_hold: false, admin_notes: 'Ride did not happen' } });
same('reverse: released pay can be reversed too, keeping earlier notes',
  nextEarningState('reverse', { ...heldE, status: 'released', admin_notes: 'Reassigned to Ada' }, { reason: 'Paid in error' }, AT),
  { ok: true, patch: { status: 'reversed', reversed_at: AT, on_hold: false, admin_notes: 'Reassigned to Ada | Paid in error' } });
same('reverse: needs a reason', nextEarningState('reverse', heldE, {}, AT), refusal('REASON_REQUIRED'));
for (const action of ['release', 'hold', 'unhold', 'adjust', 'reverse']) {
  same(`${action}: nothing can be done to reversed pay`,
    nextEarningState(action, { ...heldE, status: 'reversed' }, { reason: 'x', amount_ngn: 1 }, AT), refusal('ALREADY_REVERSED'));
}
same('an unknown action is refused', nextEarningState('delete', heldE, { reason: 'x' }, AT), refusal('INVALID_ACTION'));
same('a reason is cut at 500 characters',
  nextEarningState('hold', heldE, { reason: 'x'.repeat(900) }, AT).patch.hold_reason.length, 500);

identical('rideDurationMs', 'tier, days, hours', ['getRideBookings', 'completeRide']);
identical('windowOf', 'r', ['getRideBookings', 'completeRide']);
const completionProblem = make('completionProblem',
  ['HOUR_MS', 'WAT_OFFSET', 'DAY_MS', 'MAX_HOURLY'].map((n) => constLine('completeRide', n)).join(' '),
  liftSrc('completeRide', 'rideDurationMs', 'tier, days, hours'), liftSrc('completeRide', 'windowOf', 'r'),
  liftSrc('completeRide', 'completionProblem', 'ride, nowMs'));
const live = { status: 'confirmed', payment_status: 'paid', start_at: '2026-08-10T08:00:00.000Z', end_at: '2026-08-10T10:00:00.000Z' };
check('a paid ride that has started can be completed', completionProblem(live, at('2026-08-10T08:30:00.000Z')), '');
check('…or one that is already over', completionProblem(live, at('2026-08-11T00:00:00.000Z')), '');
check('a ride that has not started cannot', completionProblem(live, at('2026-08-10T07:59:59.999Z')), 'NOT_STARTED');
check('a ride with no readable time can: this is what admin is for', completionProblem({ status: 'confirmed', payment_status: 'paid' }, FAR), '');
check('an already completed ride says so', completionProblem({ ...live, status: 'completed' }, FAR), 'ALREADY');
check('a cancelled ride cannot be completed', completionProblem({ ...live, status: 'cancelled' }, FAR), 'CANCELLED');
check('an unpaid ride cannot be completed', completionProblem({ ...live, status: 'pending', payment_status: 'unpaid' }, FAR), 'NOT_PAID');

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: ENOENT: no such file or directory, open '…/base44/functions/settleDriverEarning/entry.ts'`.

- [ ] **Step 3: Create `settleDriverEarning`**

**Create `base44/functions/settleDriverEarning/entry.ts`:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// settleDriverEarning
// ----------------------------------------------------------------------------
// Admin's five moves on one row of a driver's pay:
//
//   release   pay it now instead of waiting for the sweep
//   hold      stop the sweep releasing it (a dispute, a question)
//   unhold    let the sweep carry on
//   adjust    change the figure while it is still held (extra hours, a fine)
//   reverse   this ride no longer pays
//
// No action writes a balance, because no balance is stored: the driver's
// available money is always recomputed from these rows (see getDriverWallet).
// So "release" is a status flip, and reversing pay that was already released
// simply lowers what they can withdraw. If they had withdrawn it already, the
// difference is carried as a shortfall against their next released pay.
//
// Every transition is decided by nextEarningState, a pure function the check
// script runs against the whole table of cases.

const MAX_PAYOUT_NGN = 50000000;
const MAX_REASON_LENGTH = 500;

const REFUSALS: Record<string, { status: number; error: string }> = {
    INVALID_ACTION: { status: 400, error: 'Unknown action.' },
    REASON_REQUIRED: { status: 400, error: 'Give a reason. It is kept on the record.' },
    INVALID_AMOUNT: { status: 400, error: 'The new pay must be a whole naira amount between 0 and 50,000,000.' },
    NOT_HELD: { status: 409, error: 'Only pay that is still held can be changed this way.' },
    ALREADY_REVERSED: { status: 409, error: 'This pay has already been reversed.' },
};

// What the earning becomes. Plain JavaScript body: the check script lifts it.
function nextEarningState(action: string, earning: any, input: any, nowIso: string) {
    const reason = typeof (input && input.reason) === 'string' ? input.reason.trim().slice(0, MAX_REASON_LENGTH) : '';
    const status = earning && earning.status;
    const known = ['release', 'hold', 'unhold', 'adjust', 'reverse'];
    if (!known.includes(action)) return { ok: false, code: 'INVALID_ACTION' };
    if (status === 'reversed') return { ok: false, code: 'ALREADY_REVERSED' };

    if (action === 'reverse') {
        if (!reason) return { ok: false, code: 'REASON_REQUIRED' };
        return {
            ok: true,
            patch: {
                status: 'reversed',
                reversed_at: nowIso,
                on_hold: false,
                admin_notes: earning.admin_notes ? `${earning.admin_notes} | ${reason}` : reason,
            },
        };
    }

    // Everything else only makes sense while the pay is still held.
    if (status !== 'held') return { ok: false, code: 'NOT_HELD' };

    if (action === 'release') {
        return { ok: true, patch: { status: 'released', released_at: nowIso, on_hold: false, hold_reason: '' } };
    }
    if (action === 'hold') {
        if (!reason) return { ok: false, code: 'REASON_REQUIRED' };
        return { ok: true, patch: { on_hold: true, hold_reason: reason } };
    }
    if (action === 'unhold') {
        return { ok: true, patch: { on_hold: false, hold_reason: '' } };
    }
    // adjust
    if (!reason) return { ok: false, code: 'REASON_REQUIRED' };
    const n = input && input.amount_ngn;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PAYOUT_NGN) {
        return { ok: false, code: 'INVALID_AMOUNT' };
    }
    const amount = Math.round(n);
    return {
        ok: true,
        patch: {
            amount_ngn: amount,
            basis: 'manual',
            rate_ngn: amount,
            units: 1,
            adjustment_reason: reason,
            adjusted_at: nowIso,
        },
    };
}

// What to do with an earning, given the ride it is for. Lockstep copy, see
// autoCancelExpiredBookings. Used here so admin cannot release pay the sweep
// would have reversed: a cancelled ride, or one now driven by someone else.
function releaseDecision(earning: any, ride: any) {
    if (!ride) return 'reverse:ride no longer exists';
    if (ride.status === 'cancelled') return 'reverse:ride cancelled';
    if (ride.driver_id !== earning.driver_id) return 'reverse:ride reassigned';
    if (ride.payment_status !== 'paid') return 'hold:ride is not paid';
    return 'release';
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

        const { earning_id, action, reason, amount_ngn } = await req.json().catch(() => ({}));
        if (!earning_id || typeof action !== 'string') {
            return json({ success: false, error: 'earning_id and action are required' }, 400);
        }

        const sr = base44.asServiceRole.entities;
        const earning = await sr.DriverEarning.get(earning_id);
        if (!earning) return json({ success: false, error: 'That pay record no longer exists.', code: 'NOT_FOUND' }, 404);

        const nowIso = new Date().toISOString();
        const next = nextEarningState(action, earning, { reason, amount_ngn }, nowIso);
        if (!next.ok) {
            const refusal = REFUSALS[next.code as string] || { status: 400, error: 'That change is not allowed.' };
            return json({ success: false, error: refusal.error, code: next.code }, refusal.status);
        }

        // Releasing by hand must not pay for a ride the sweep would refuse.
        if (action === 'release') {
            const ride = await sr.RideBooking.get(earning.ride_booking_id);
            const verdict = releaseDecision(earning, ride);
            if (verdict !== 'release') {
                return json({
                    success: false,
                    error: `This pay cannot be released: ${verdict.split(':')[1]}. Reverse it instead.`,
                    code: 'RIDE_STATE',
                }, 409);
            }
        }

        await sr.DriverEarning.update(earning.id, next.patch);
        const updated = await sr.DriverEarning.get(earning.id);

        if (action === 'release') {
            try {
                const driver = await sr.Driver.get(earning.driver_id);
                const driverEmail = typeof driver?.user_email === 'string' ? driver.user_email.trim().toLowerCase() : '';
                if (driverEmail) {
                    const amount = `₦${(Number(earning.amount_ngn) || 0).toLocaleString()}`;
                    await tryPush(base44, {
                        user_email: driverEmail,
                        title: `💸 ${amount} is now available`,
                        body: `Your pay for the ${earning.vehicle_name || 'ride'}${earning.service_date ? ` on ${earning.service_date}` : ''} has been released to your wallet.`,
                        url: '/DriverWallet',
                        tag: `driver-released-${earning.id}`,
                    });
                }
            } catch (err) {
                console.warn('Release push failed (non-fatal):', err);
            }
        }

        return json({
            success: true,
            data: {
                earning: updated,
                // True when the driver could already withdraw this before the
                // call. After a reverse, their available balance has dropped
                // by the amount; the admin screen says so.
                was_released: earning.status === 'released',
            },
        });
    } catch (error) {
        console.error('settleDriverEarning error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
```

- [ ] **Step 4: Create `completeRide`**

**Create `base44/functions/completeRide/entry.ts`:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// completeRide
// ----------------------------------------------------------------------------
// Admin marks a ride completed now, instead of waiting for the sweep to do it
// when the booked window ends. Two cases need it: the guest finished early,
// and a ride whose time the sweep cannot read (it never completes on a guess).
//
// Completing a ride does NOT release the driver's pay. Pay releases two hours
// after the booked end, or when admin releases it in Rides → Earnings.

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

// Why this ride cannot be completed now, or '' when it can. A ride with no
// readable time is allowed through: that is the case admin exists for.
function completionProblem(ride: any, nowMs: number) {
    if (ride.status === 'completed') return 'ALREADY';
    if (ride.status === 'cancelled') return 'CANCELLED';
    if (ride.payment_status !== 'paid') return 'NOT_PAID';
    const w = windowOf(ride);
    if (w && w.startMs > nowMs) return 'NOT_STARTED';
    return '';
}

const REFUSALS: Record<string, string> = {
    CANCELLED: 'This ride was cancelled.',
    NOT_PAID: 'Only a paid ride can be completed.',
    NOT_STARTED: 'This ride has not started yet.',
};

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

        const { ride_booking_id } = await req.json().catch(() => ({}));
        if (!ride_booking_id) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const sr = base44.asServiceRole.entities;
        const ride = await sr.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found', code: 'NOT_FOUND' }, 404);

        const problem = completionProblem(ride, Date.now());
        if (problem === 'ALREADY') {
            return json({ success: true, data: { ride_booking_id, status: 'completed', already: true } });
        }
        if (problem) {
            return json({ success: false, error: REFUSALS[problem], code: problem }, 409);
        }

        await sr.RideBooking.update(ride_booking_id, {
            status: 'completed',
            completed_at: new Date().toISOString(),
            completed_by: 'admin',
        });

        return json({ success: true, data: { ride_booking_id, status: 'completed', already: false } });
    } catch (error) {
        console.error('completeRide error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
```

- [ ] **Step 5: Run the checks**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, including every line under `— admin settlement —`.

Run: `for f in settleDriverEarning completeRide; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done`

Expected: no `PARSE FAIL` line.

- [ ] **Step 6: Sandbox checklist (after the next publish)**

1. As admin: `await base44.functions.invoke('settleDriverEarning', { earning_id: '<a held row>', action: 'hold', reason: 'Guest disputes the trip' })`. Expected: `on_hold: true`; the driver's wallet shows the row as "Under review"; the sweep leaves it alone after its release time.
2. `action: 'unhold'`, then `action: 'adjust', amount_ngn: 20000, reason: 'Two extra hours'`. Expected: the row shows ₦20,000 with `basis: manual`.
3. `action: 'release'`. Expected: `status: released`; the driver's Available rises by ₦20,000 and they get the push.
4. `action: 'reverse', reason: 'Paid in error'` on that released row. Expected: `was_released: true`; the driver's Available falls by ₦20,000.
5. As a non-admin, any of the above. Expected: 403.
6. As admin: `await base44.functions.invoke('completeRide', { ride_booking_id: '<a paid ride in progress>' })`. Expected: the ride is `completed` with `completed_by: admin`; its earning is still `held`.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/settleDriverEarning/entry.ts base44/functions/completeRide/entry.ts
git commit -m "feat(rides): admin can release, hold, adjust or reverse a driver's pay and complete a ride" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A12: Admin screens — the pay figure when assigning, and Mark completed

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (typed pay in the dialog, above `// ---- result ----`)
- Modify: `src/config/rides.js` (one helper, appended)
- Modify: `src/components/admin/RidesAdmin.jsx` (`AssignDriverDialog` and `RideRequestsPanel`)

**Interfaces:**
- Consumes: `driverPayoutFor(costing, tier, { hours, days })`, `MAX_PAYOUT_NGN`, `RELEASE_BUFFER_HOURS` (Task A02); `assignRideDriver` with `driver_payout_ngn` and its `pay_tracked`, `driver_payout_ngn`, `previous_earning_released` answer (Task A03); `completeRide` (Task A11); `invokeFn` (Task A10); `Driver.user_email` (Task A01). The dialog reads `VehicleCosting` and `DriverEarning` directly, which works because both are admin-only at the API and this screen only renders for an admin.
- Produces: `typedDriverPay(hasLogin, typed, computedAmount) → { ok: true, value: number | undefined } | { ok: false, message }` in `src/config/rides.js` (`value: undefined` means "send nothing, the server decides").

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── The pay box in the Assign driver dialog ────────────────────────────────
// Decides what the dialog sends. An empty box sends nothing, so the server
// computes the figure and records its real basis rather than "manual".
console.log('\n— assign dialog pay —');
const NOT_SENT = { ok: true, value: undefined };
same('a driver with no login: nothing is sent, whatever is typed', rides.typedDriverPay(false, '15000', 15000), NOT_SENT);
same('empty box with a costing figure: nothing is sent, the server computes it', rides.typedDriverPay(true, '', 15000), NOT_SENT);
same('spaces count as empty', rides.typedDriverPay(true, '   ', 15000), NOT_SENT);
check('empty box and no costing figure: admin is stopped', rides.typedDriverPay(true, '', null).ok, false);
same('a typed figure is sent', rides.typedDriverPay(true, ' 20000 ', 15000), { ok: true, value: 20000 });
same('zero is a real answer', rides.typedDriverPay(true, '0', null), { ok: true, value: 0 });
same('kobo are rounded', rides.typedDriverPay(true, '20000.4', null), { ok: true, value: 20000 });
for (const bad of ['25,000', '-5', '1e3', 'abc', '99999999999', '50000001']) {
  check(`"${bad}" is stopped before it is sent`, rides.typedDriverPay(true, bad, 15000).ok, false);
}
check('the ceiling itself can be typed', rides.typedDriverPay(true, '50000000', null).value, 50000000);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `TypeError: rides.typedDriverPay is not a function`.

- [ ] **Step 3: Add the helper**

**Edit `src/config/rides.js`** — find:

```js
  return { user_email: next, previous_user_emails: history };
}
```

replace with:

```js
  return { user_email: next, previous_user_emails: history };
}

// What the Assign driver dialog sends as the pay figure.
//   { ok: true, value: undefined }  send nothing: either this driver has no
//                                    login (pay is not tracked), or the box is
//                                    empty and the vehicle's costing decides
//   { ok: true, value: 20000 }      admin typed a figure
//   { ok: false, message }          nothing to go on, or not a usable number
// The server checks all of this again; this exists so admin is told before
// the round trip, in the dialog, next to the box.
export function typedDriverPay(hasLogin, typed, computedAmount) {
  if (!hasLogin) return { ok: true, value: undefined };
  const text = String(typed ?? '').trim();
  if (text === '') {
    if (computedAmount == null) {
      return { ok: false, message: 'Enter the driver pay for this ride. No driver cost is set for this vehicle.' };
    }
    return { ok: true, value: undefined };
  }
  if (!/^\d{1,9}(\.\d+)?$/.test(text)) {
    return { ok: false, message: 'Driver pay must be a naira amount in digits only, for example 15000.' };
  }
  const value = Math.round(Number(text));
  if (value > MAX_PAYOUT_NGN) {
    return { ok: false, message: `Driver pay cannot be more than ₦${MAX_PAYOUT_NGN.toLocaleString()}.` };
  }
  return { ok: true, value };
}
```

- [ ] **Step 4: Run the check and watch it pass**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, including every line under `— assign dialog pay —`.

- [ ] **Step 5: Imports for the admin screen**

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
  Check, X, CalendarClock, UserPlus, Inbox, IdCard,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { categoryLabel, ADJUSTMENT_REASONS } from '@/config/rides';
```

replace with:

```jsx
  Check, X, CalendarClock, UserPlus, Inbox, IdCard, Banknote,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { invokeFn } from '@/lib/invokeFn';
import { useToast } from '@/components/ui/use-toast';
import {
  categoryLabel, ADJUSTMENT_REASONS, driverPayoutFor, typedDriverPay, RELEASE_BUFFER_HOURS,
} from '@/config/rides';
```

- [ ] **Step 6: The dialog works out a suggested pay figure**

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
  const [instructions, setInstructions] = useState('');

  useEffect(() => { setInstructions(ride?.pickup_instructions || ''); }, [ride]);
```

replace with:

```jsx
  const [instructions, setInstructions] = useState('');
  // Driver pay. `suggested` is what the vehicle's costing row works out to for
  // this booking; `pay` is what admin typed. An empty box means "use the
  // suggestion", and the server computes that same figure for itself.
  const [pay, setPay] = useState('');
  const [suggested, setSuggested] = useState(null);

  useEffect(() => { setInstructions(ride?.pickup_instructions || ''); }, [ride]);

  useEffect(() => {
    setPay('');
    setSuggested(null);
    if (!ride) return undefined;
    let cancelled = false;
    (async () => {
      try {
        // Both entities are admin-only at the API, like the Driver roster below.
        const [costings, held] = await Promise.all([
          base44.entities.VehicleCosting.filter({ vehicle_id: ride.vehicle_id }),
          base44.entities.DriverEarning.filter({ ride_booking_id: ride.id, status: 'held' }),
        ]);
        if (cancelled) return;
        setSuggested(driverPayoutFor(costings?.[0] || null, ride.duration_tier, {
          hours: ride.duration_hours, days: ride.duration_days,
        }));
        // Changing the driver: start from the figure the outgoing driver was promised.
        const current = Array.isArray(held) && held.length > 0 ? held[0] : null;
        if (current) setPay(String(Math.round(Number(current.amount_ngn) || 0)));
      } catch (err) {
        console.error('Could not load the driver pay context:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [ride]);
```

- [ ] **Step 7: Send the figure, and show the server's reason when it refuses**

The old version called `base44.functions.invoke` and looked for `res.data.error` in an `else` branch. A refusal is a 4xx, which axios throws, so that branch never ran and admin saw "Request failed with status code 409" for a double-booked driver. `invokeFn` returns the sentence.

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
  const assign = async (driver) => {
    setSaving(driver.id);
    try {
      const res = await base44.functions.invoke('assignRideDriver', {
        ride_booking_id: ride.id,
        driver_id: driver.id,
        pickup_instructions: instructions.trim() || undefined,
      });
      if (res?.data?.success) {
        toast({
          title: ride?.driver_id ? 'Driver changed' : 'Driver assigned',
          description: `${driver.full_name} is on this ride. The guest has been emailed and notified.`,
        });
        onAssigned();
      } else {
        // Server refusals are specific and actionable — show them verbatim
        // rather than a generic failure.
        toast({
          title: 'Could not assign',
          description: res?.data?.error || 'Please try another driver.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({ title: 'Could not assign', description: err?.message || 'Try again.', variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };
```

replace with:

```jsx
  const assign = async (driver) => {
    const typed = typedDriverPay(!!driver.user_email, pay, suggested ? suggested.amount : null);
    if (!typed.ok) {
      toast({ title: 'Driver pay needed', description: typed.message, variant: 'destructive' });
      return;
    }
    setSaving(driver.id);
    // invokeFn never throws. A refusal comes back as r.error, which is the
    // sentence the server wrote: specific and actionable, so it is shown as is.
    const r = await invokeFn('assignRideDriver', {
      ride_booking_id: ride.id,
      driver_id: driver.id,
      pickup_instructions: instructions.trim() || undefined,
      driver_payout_ngn: typed.value,
    });
    setSaving(null);
    if (!r.ok) {
      toast({ title: 'Could not assign', description: r.error, variant: 'destructive' });
      return;
    }
    const d = r.data || {};
    const payNote = !d.pay_tracked
      ? `${driver.full_name} has no login, so their pay is not tracked in the app.`
      : d.driver_payout_ngn > 0
        ? `${ngn(d.driver_payout_ngn)} is held for them and released ${RELEASE_BUFFER_HOURS} hours after the ride ends.`
        : 'No pay was recorded for this ride.';
    toast({
      title: ride?.driver_id ? 'Driver changed' : 'Driver assigned',
      description: `${driver.full_name} is on this ride. The guest has been emailed and notified. ${payNote}`,
    });
    if (d.previous_earning_released) {
      toast({
        title: 'Check the previous driver',
        description: 'Their pay for this ride had already been released and was not taken back. Review it under Earnings.',
        variant: 'destructive',
      });
    }
    onAssigned();
  };
```

- [ ] **Step 8: The pay box, and a note on drivers whose pay is not tracked**

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
            Sent to the guest with the driver&apos;s details. Leaving this blank on a
            reassignment keeps whatever is already there.
          </p>
        </div>
```

replace with:

```jsx
            Sent to the guest with the driver&apos;s details. Leaving this blank on a
            reassignment keeps whatever is already there.
          </p>
        </div>

        <div>
          <Label htmlFor="ad-pay" className="flex items-center gap-1.5">
            <Banknote className="w-3.5 h-3.5" /> Driver pay (₦)
          </Label>
          <Input
            id="ad-pay" type="text" inputMode="numeric" autoComplete="off" value={pay}
            onChange={(e) => setPay(e.target.value)}
            placeholder={suggested ? String(suggested.amount) : 'for example 15000'}
            className="mt-1 rounded-xl"
          />
          {suggested ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Leave empty to use {ngn(suggested.amount)} from this vehicle&apos;s costing
              ({suggested.units} × {ngn(suggested.rate)} per {suggested.basis === 'hourly' ? 'hour' : 'day'}).
              It is held for the driver and released {RELEASE_BUFFER_HOURS} hours after the ride ends.
            </p>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
              No driver cost set for this vehicle. Enter the pay here or set it under Vehicles → Internal costing.
            </p>
          )}
        </div>
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
                    {[d.city, d.years_experience ? `${d.years_experience} yrs` : null,
                      d.trips_completed ? `${d.trips_completed} trips` : null].filter(Boolean).join(' · ')}
```

replace with:

```jsx
                    {[d.city, d.years_experience ? `${d.years_experience} yrs` : null,
                      d.trips_completed ? `${d.trips_completed} trips` : null,
                      d.user_email ? null : 'no login, pay not tracked'].filter(Boolean).join(' · ')}
```

- [ ] **Step 9: Mark completed**

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
  const [assigning, setAssigning] = useState(null); // ride awaiting a driver
```

replace with:

```jsx
  const [assigning, setAssigning] = useState(null); // ride awaiting a driver
  const [completingId, setCompletingId] = useState(null);
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
  // 'needs-driver' is a cross-cutting view, not a bucket the server returns:
```

replace with:

```jsx
  // The sweep completes a ride when its booked window ends. This is for the
  // two cases it cannot handle: the guest finished early, or the ride's time
  // cannot be read. Completing never releases the driver's pay.
  const complete = async (ride) => {
    setCompletingId(ride.id);
    const r = await invokeFn('completeRide', { ride_booking_id: ride.id });
    setCompletingId(null);
    if (r.ok) {
      toast({
        title: 'Ride marked completed',
        description: `The driver's pay is released ${RELEASE_BUFFER_HOURS} hours after the booked end, or sooner from Earnings.`,
      });
    } else {
      toast({ title: 'Could not complete this ride', description: r.error, variant: 'destructive' });
    }
    await load();
  };

  // 'needs-driver' is a cross-cutting view, not a bucket the server returns:
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
                          <UserPlus className="w-4 h-4 mr-2" />
                          {r.driver_assigned ? 'Change driver' : 'Assign driver'}
                        </Button>
                      </div>
                    )}
```

replace with:

```jsx
                          <UserPlus className="w-4 h-4 mr-2" />
                          {r.driver_assigned ? 'Change driver' : 'Assign driver'}
                        </Button>
                      </div>
                    )}

                    {r.payment_status === 'paid' && r.status === 'confirmed'
                      && (r.bucket === 'current' || r.bucket === 'past') && (
                      <div className="flex flex-col gap-2 flex-shrink-0 w-full sm:w-auto">
                        <Button
                          size="sm" variant="outline" disabled={completingId === r.id}
                          onClick={() => complete(r)}
                          className="rounded-xl w-full sm:w-auto"
                        >
                          {completingId === r.id
                            ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            : <Check className="w-4 h-4 mr-2" />}
                          Mark completed
                        </Button>
                      </div>
                    )}
```

- [ ] **Step 10: Lint and build**

Run: `npm run lint`

Expected: no output, exit code 0.

Run: `set -a; . ./.env; set +a; npm run build`

Expected: `✓ built in …`.

- [ ] **Step 11: Look at it (sandbox, after the next publish)**

1. Admin → Rides → a paid ride → Assign driver, on a vehicle with a costing row. Expected: the pay box is empty with the costing figure as its placeholder, and the line under it reads "Leave empty to use ₦… (… × ₦… per day)".
2. Assign a linked driver without typing anything. Expected: "Driver assigned … ₦… is held for them and released 2 hours after the ride ends."
3. On a vehicle with no costing row, try to assign a linked driver with the box empty. Expected: stopped in the dialog with "Enter the driver pay for this ride…".
4. Assign a driver who is already on an overlapping ride. Expected: the toast reads "<name> is already driving another booking in that window.", not a status code.
5. On a ride in progress: Mark completed. Expected: the ride moves to Past; its earning is still held.
6. Both the dialog and the list in dark mode: the pay box, its helper text and the amber warning are readable.

- [ ] **Step 12: Commit**

```bash
git add scripts/check-driver-wallet.mjs src/config/rides.js src/components/admin/RidesAdmin.jsx
git commit -m "feat(rides): set the driver's pay when assigning, and mark a ride completed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A13: The Earnings tab for admin

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (per-driver summaries section, above `// ---- result ----`)
- Create: `base44/functions/getDriverEarningsAdmin/entry.ts`
- Create: `src/components/admin/DriverEarningsAdmin.jsx`
- Modify: `src/components/admin/RidesAdmin.jsx` (third inner tab)

**Interfaces:**
- Consumes: `driverEmails`, `driverWithdrawals`, `walletTotals` (Task A08, copied); `settleDriverEarning` (Task A11); `invokeFn` (Task A10).
- Produces: function `getDriverEarningsAdmin` — admin only; body `{}`; answers `data: { earnings: Array<DriverEarning & { driver_name }>, earnings_truncated: boolean, drivers: Summary[], totals: { held, available, shortfall } }` where `Summary` is `{ driver_id, full_name, has_login, held, available, paid_out, reserved, shortfall }`. Helper `driverWalletSummaries(drivers, earnings, withdrawals) → Summary[]`, which Task A14 copies.
- Produces: default export `DriverEarningsAdmin`; `RidesAdmin` gains an `earnings` inner tab.

- [ ] **Step 1: Write the failing check**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Per-driver summaries for admin ─────────────────────────────────────────
console.log('\n— admin earnings summary —');
const SUMMARY_HOME = 'getDriverEarningsAdmin';
identical('driverEmails', 'driver', [WALLET_HOME, SUMMARY_HOME]);
identical('driverWithdrawals', 'driver, rows', [WALLET_HOME, SUMMARY_HOME]);
identical('walletTotals', 'earnings, withdrawals', [WALLET_HOME, SUMMARY_HOME]);
const SUMMARY_SIG = 'drivers, earnings, withdrawals';
const driverWalletSummaries = make('driverWalletSummaries',
  liftSrc(SUMMARY_HOME, 'driverEmails', 'driver'),
  liftSrc(SUMMARY_HOME, 'driverWithdrawals', 'driver, rows'),
  liftSrc(SUMMARY_HOME, 'walletTotals', 'earnings, withdrawals'),
  liftSrc(SUMMARY_HOME, 'driverWalletSummaries', SUMMARY_SIG));
{
  const drivers = [
    { id: 'drvA', full_name: 'Emeka', user_email: 'emeka@work.ng' },
    { id: 'drvB', full_name: 'Ada', user_email: '' },
    { id: 'drvC', full_name: 'Idle', user_email: 'idle@x.ng' },
  ];
  const earnings = [
    { driver_id: 'drvA', status: 'held', amount_ngn: 15000 },
    { driver_id: 'drvA', status: 'released', amount_ngn: 30000 },
    { driver_id: 'drvB', status: 'reversed', amount_ngn: 10000 },
    { driver_id: 'gone', status: 'held', amount_ngn: 99999 },
  ];
  const withdrawals = [
    { wallet: 'driver', driver_id: 'drvA', user_email: 'emeka@work.ng', amount: 10000, status: 'completed' },
    { wallet: 'driver', driver_id: 'drvA', user_email: 'mallory@evil.ng', amount: 20000, status: 'completed' },
    { wallet: 'referral', driver_id: 'drvA', user_email: 'emeka@work.ng', amount: 5000, status: 'completed' },
  ];
  const out = driverWalletSummaries(drivers, earnings, withdrawals);
  same('one line per driver who has pay on record, most owed first', out.map((s) => s.driver_id), ['drvA', 'drvB']);
  same('the line is the driver wallet arithmetic', out[0],
    { driver_id: 'drvA', full_name: 'Emeka', has_login: true, held: 15000, available: 20000, paid_out: 10000, reserved: 0, shortfall: 0 });
  check('a driver with no login is marked', out[1].has_login, false);
}
{
  // A driver who withdrew pay that was later reversed sorts to the top.
  const drivers = [
    { id: 'drvA', full_name: 'Emeka', user_email: 'emeka@work.ng' },
    { id: 'drvB', full_name: 'Ada', user_email: 'ada@x.ng' },
  ];
  const out = driverWalletSummaries(drivers,
    [{ driver_id: 'drvA', status: 'held', amount_ngn: 900000 }, { driver_id: 'drvB', status: 'reversed', amount_ngn: 10000 }],
    [{ wallet: 'driver', driver_id: 'drvB', user_email: 'ada@x.ng', amount: 10000, status: 'completed' }]);
  same('a shortfall sorts first, whatever else is owed', out.map((s) => `${s.driver_id}:${s.shortfall}`), ['drvB:10000', 'drvA:0']);
}
same('no drivers, no lines', driverWalletSummaries([], [], []), []);
same('nothing at all, no lines', driverWalletSummaries(undefined, undefined, undefined), []);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: ENOENT: no such file or directory, open '…/base44/functions/getDriverEarningsAdmin/entry.ts'`.

- [ ] **Step 3: Create the function**

**Create `base44/functions/getDriverEarningsAdmin/entry.ts`:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// getDriverEarningsAdmin
// ----------------------------------------------------------------------------
// Everything the admin Earnings tab shows: the pay ledger across all drivers,
// and one summary line per driver (held, available, paid out, shortfall).
//
// The summaries are computed here rather than in the browser so that there is
// no client copy of the wallet arithmetic to drift, and so the totals count
// every row even when the list on screen is capped.

const LIST_LIMIT = 500;

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

// ── Wallet arithmetic — lockstep copies, see getDriverWallet ────────────────

// Every login this driver is, or was, linked to. Lower-cased, once each.
function driverEmails(driver: any) {
    const all = [driver && driver.user_email].concat((driver && driver.previous_user_emails) || []);
    const out = [];
    for (const raw of all) {
        const email = String(raw || '').trim().toLowerCase();
        if (email && !out.includes(email)) out.push(email);
    }
    return out;
}

// The withdrawal rows that count against this driver's balance: driver-wallet
// rows carrying this driver's id AND made by a login that is, or was, linked
// to this driver. The second condition is not decoration. Until the staged
// rule that stops browsers creating WithdrawalRequest rows is live, any
// signed-in user can create one for their own email with any driver_id on it;
// the email is the one field the access rule pins to the creator.
function driverWithdrawals(driver: any, rows: any[]) {
    if (!driver) return [];
    const emails = driverEmails(driver);
    return (rows || []).filter((w) => !!w
        && w.wallet === 'driver'
        && w.driver_id === driver.id
        && emails.includes(String(w.user_email || '').trim().toLowerCase()));
}

// The driver's position in whole naira. Pass withdrawals through
// driverWithdrawals first. A failed or reversed transfer counts nowhere, so it
// needs no refund. If pay is reversed after it was withdrawn, available stops
// at zero and the difference is carried as shortfall until later pay covers it.
function walletTotals(earnings: any[], withdrawals: any[]) {
    const naira = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    let held = 0;
    let released = 0;
    for (const e of earnings || []) {
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
        else if (e.status === 'released') released += naira(e.amount_ngn);
    }
    let paidOut = 0;
    let reserved = 0;
    for (const w of withdrawals || []) {
        if (!w) continue;
        if (w.status === 'completed') paidOut += naira(w.amount);
        else if (w.status === 'pending' || w.status === 'processing') reserved += naira(w.amount);
    }
    const net = released - paidOut - reserved;
    return {
        held,
        released,
        paid_out: paidOut,
        reserved,
        available: Math.max(0, net),
        shortfall: Math.max(0, -net),
    };
}

// One line per driver who has any pay or payout on record: the same numbers
// that driver sees in their own wallet. A shortfall (pay reversed after it was
// withdrawn) sorts first, because that is money to recover. Lockstep copy in
// getDashboardStats.
function driverWalletSummaries(drivers: any[], earnings: any[], withdrawals: any[]) {
    const out = [];
    for (const driver of drivers || []) {
        if (!driver) continue;
        const theirEarnings = (earnings || []).filter((e) => !!e && e.driver_id === driver.id);
        const theirWithdrawals = driverWithdrawals(driver, withdrawals);
        if (theirEarnings.length === 0 && theirWithdrawals.length === 0) continue;
        const totals = walletTotals(theirEarnings, theirWithdrawals);
        out.push({
            driver_id: driver.id,
            full_name: driver.full_name || 'Driver',
            has_login: !!String(driver.user_email || '').trim(),
            held: totals.held,
            available: totals.available,
            paid_out: totals.paid_out,
            reserved: totals.reserved,
            shortfall: totals.shortfall,
        });
    }
    out.sort((a, b) => (b.shortfall - a.shortfall)
        || ((b.held + b.available) - (a.held + a.available))
        || String(a.full_name).localeCompare(String(b.full_name)));
    return out;
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

        const sr = base44.asServiceRole.entities;
        const [earnings, drivers, withdrawals] = await Promise.all([
            fetchAll(sr.DriverEarning, {}),
            fetchAll(sr.Driver, {}),
            fetchAll(sr.WithdrawalRequest, { wallet: 'driver' }),
        ]);

        const names = new Map<string, string>();
        for (const d of drivers) names.set(d.id, d.full_name || 'Driver');

        const summaries = driverWalletSummaries(drivers, earnings, withdrawals);
        const totals = { held: 0, available: 0, shortfall: 0 };
        for (const s of summaries) {
            totals.held += s.held;
            totals.available += s.available;
            totals.shortfall += s.shortfall;
        }

        const newestFirst = earnings.slice().sort(
            (a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')),
        );

        return json({
            success: true,
            data: {
                earnings: newestFirst.slice(0, LIST_LIMIT).map((e) => ({
                    ...e,
                    driver_name: names.get(e.driver_id) || 'Deleted driver',
                })),
                earnings_truncated: earnings.length > LIST_LIMIT,
                drivers: summaries,
                totals,
            },
        });
    } catch (error) {
        console.error('getDriverEarningsAdmin error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
```

- [ ] **Step 4: Run the check and watch it pass**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `PASS`, including every line under `— admin earnings summary —`.

- [ ] **Step 5: Create the Earnings panel**

**Create `src/components/admin/DriverEarningsAdmin.jsx`:**

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Loader2, RefreshCw, Banknote, Clock, CheckCircle, Undo2, PauseCircle, AlertTriangle, AlertCircle,
} from 'lucide-react';
import { invokeFn } from '@/lib/invokeFn';
import { useToast } from '@/components/ui/use-toast';

// DriverEarningsAdmin — every driver's pay, ride by ride, and the five things
// admin can do to a row: release it now, hold it, lift the hold, adjust the
// figure, reverse it.
//
// Nothing on this screen adds money up. The per-driver lines and the totals
// come from getDriverEarningsAdmin, which runs the same arithmetic the
// driver's own wallet runs. Every action goes through settleDriverEarning,
// which decides whether the change is allowed.

const ngn = (n) => `₦${(Number(n) || 0).toLocaleString()}`;

const fmtWhen = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return '—'; }
};

const FILTERS = [
  { value: 'held', label: 'Held' },
  { value: 'on-hold', label: 'On hold' },
  { value: 'released', label: 'Released' },
  { value: 'reversed', label: 'Reversed' },
  { value: 'all', label: 'All' },
];

const viewOf = (e) => {
  if (e.status === 'held') return e.on_hold ? 'on-hold' : 'held';
  return e.status;
};

const VIEW_STYLE = {
  held: { label: 'Held', icon: Clock, className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900' },
  'on-hold': { label: 'On hold', icon: PauseCircle, className: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 border-orange-200 dark:border-orange-900' },
  released: { label: 'Released', icon: CheckCircle, className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900' },
  reversed: { label: 'Reversed', icon: Undo2, className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700' },
};

// Which buttons a row gets. settleDriverEarning enforces the same table; this
// only stops admin being offered a move that would be refused.
const ACTIONS_FOR = {
  held: ['release', 'hold', 'adjust', 'reverse'],
  'on-hold': ['unhold', 'release', 'adjust', 'reverse'],
  released: ['reverse'],
  reversed: [],
};

const ACTION_COPY = {
  release: {
    button: 'Release now', title: 'Release this pay now?',
    body: 'It moves to the driver\'s available balance straight away instead of waiting for the release time.',
    done: 'Pay released',
  },
  hold: {
    button: 'Hold', title: 'Hold this pay',
    body: 'It will not be released until you lift the hold. The driver sees "under review".',
    needsReason: true, done: 'Pay put on hold',
  },
  unhold: {
    button: 'Lift hold', title: 'Lift the hold?',
    body: 'The pay is released at its release time, or at the next sweep if that time has passed.',
    done: 'Hold lifted',
  },
  adjust: {
    button: 'Adjust', title: 'Adjust the pay for this ride',
    body: 'Use this for extra hours or an agreed deduction. Only pay that is still held can be changed.',
    needsReason: true, needsAmount: true, done: 'Pay adjusted',
  },
  reverse: {
    button: 'Reverse', title: 'Reverse this pay',
    body: 'The ride no longer pays the driver. This cannot be undone.',
    needsReason: true, danger: true, done: 'Pay reversed',
  },
};

export default function DriverEarningsAdmin() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('held');
  const [pending, setPending] = useState(null); // { earning, action }
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    const r = await invokeFn('getDriverEarningsAdmin');
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = (earning, action) => {
    setReason('');
    setAmount(action === 'adjust' ? String(Math.round(Number(earning.amount_ngn) || 0)) : '');
    setPending({ earning, action });
  };

  const confirm = async () => {
    if (!pending) return;
    const { earning, action } = pending;
    const copy = ACTION_COPY[action];
    if (copy.needsReason && !reason.trim()) {
      toast({ title: 'A reason is needed', description: 'It is kept on the record with the change.', variant: 'destructive' });
      return;
    }
    let amountNgn;
    if (copy.needsAmount) {
      if (!/^\d{1,9}$/.test(amount.trim())) {
        toast({ title: 'Check the amount', description: 'Enter the new pay in whole naira, digits only.', variant: 'destructive' });
        return;
      }
      amountNgn = Number(amount.trim());
    }
    setWorking(true);
    const r = await invokeFn('settleDriverEarning', {
      earning_id: earning.id,
      action,
      reason: reason.trim() || undefined,
      amount_ngn: amountNgn,
    });
    setWorking(false);
    if (!r.ok) {
      toast({ title: 'Not changed', description: r.error, variant: 'destructive' });
      return;
    }
    setPending(null);
    toast({
      title: copy.done,
      description: action === 'reverse' && r.data?.was_released
        ? `${earning.driver_name} could already withdraw this. Their available balance is now ${ngn(earning.amount_ngn)} lower.`
        : `${earning.vehicle_name || 'Ride'} · ${earning.driver_name}`,
    });
    await load(true);
  };

  const earnings = data?.earnings || [];
  const shown = filter === 'all' ? earnings : earnings.filter((e) => viewOf(e) === filter);
  const drivers = data?.drivers || [];
  const copy = pending ? ACTION_COPY[pending.action] : null;

  return (
    <Card className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm border-slate-200 dark:border-slate-800 rounded-3xl shadow-lg">
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-slate-900 dark:text-white">
            <Banknote className="w-5 h-5 text-amber-500 dark:text-amber-400 flex-shrink-0" />
            Driver earnings
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Pay is held when a driver is assigned and released two hours after the ride ends. Step in here when it should not be.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-10 w-36 rounded-xl"><SelectValue /></SelectTrigger>
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
        ) : (
          <>
            {drivers.length > 0 && (
              <div className="mb-6">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                  By driver
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {drivers.map((d) => (
                    <div key={d.driver_id} className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="font-semibold text-sm text-slate-900 dark:text-white truncate">{d.full_name}</p>
                        {!d.has_login && (
                          <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-0 text-xs flex-shrink-0">No login</Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300">
                        {ngn(d.held)} held · {ngn(d.available)} available · {ngn(d.paid_out)} paid out
                        {d.reserved > 0 ? ` · ${ngn(d.reserved)} being withdrawn` : ''}
                      </p>
                      {d.shortfall > 0 && (
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300">
                          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                          <span>
                            {ngn(d.shortfall)} to recover: pay was reversed after it had been withdrawn.
                            It comes off their next released pay.
                          </span>
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {shown.length === 0 ? (
              <p className="text-center text-slate-500 dark:text-slate-400 py-10 text-sm">
                {earnings.length === 0
                  ? 'No driver pay recorded yet. It appears here when a driver with a login is assigned to a paid ride.'
                  : `Nothing under "${FILTERS.find((f) => f.value === filter)?.label}".`}
              </p>
            ) : (
              <div className="space-y-3">
                {shown.map((e) => {
                  const view = viewOf(e);
                  const style = VIEW_STYLE[view] || VIEW_STYLE.held;
                  const StyleIcon = style.icon;
                  const actions = ACTIONS_FOR[view] || [];
                  return (
                    <div key={e.id} className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3 sm:p-4">
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <p className="text-lg font-bold text-slate-900 dark:text-white">{ngn(e.amount_ngn)}</p>
                            <Badge className={`${style.className} border font-medium`}>
                              <StyleIcon className="w-3 h-3 mr-1" />
                              {style.label}
                            </Badge>
                            {e.booking_reference && (
                              <Badge variant="outline" className="text-xs font-mono">{e.booking_reference}</Badge>
                            )}
                            {e.basis === 'manual' && (
                              <Badge variant="outline" className="text-xs">Typed figure</Badge>
                            )}
                          </div>
                          <p className="text-sm text-slate-700 dark:text-slate-200 break-words">
                            {e.driver_name} · {e.vehicle_name || 'Ride'}{e.service_date ? ` · ${e.service_date}` : ''}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                            {view === 'released' ? `Released ${fmtWhen(e.released_at)}`
                              : view === 'reversed' ? `Reversed ${fmtWhen(e.reversed_at)}`
                                : `Releases ${fmtWhen(e.release_at)}`}
                            {e.basis && e.basis !== 'manual' && e.units
                              ? ` · ${e.units} × ${ngn(e.rate_ngn)} per ${e.basis === 'hourly' ? 'hour' : 'day'}`
                              : ''}
                          </p>
                          {e.hold_reason && view === 'on-hold' && (
                            <p className="text-xs text-orange-700 dark:text-orange-300 mt-1 break-words">Held because: {e.hold_reason}</p>
                          )}
                          {e.adjustment_reason && (
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 break-words">Adjusted: {e.adjustment_reason}</p>
                          )}
                          {e.admin_notes && (
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 italic break-words">{e.admin_notes}</p>
                          )}
                        </div>
                        {actions.length > 0 && (
                          <div className="flex flex-wrap gap-2 flex-shrink-0">
                            {actions.map((action) => (
                              <Button
                                key={action} size="sm"
                                variant={action === 'release' ? 'default' : 'outline'}
                                onClick={() => open(e, action)}
                                className={
                                  action === 'release'
                                    ? 'rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'
                                    : ACTION_COPY[action].danger
                                      ? 'rounded-xl border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
                                      : 'rounded-xl'
                                }
                              >
                                {ACTION_COPY[action].button}
                              </Button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {data?.earnings_truncated && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 text-center pt-2">
                    Showing the most recent 500 rows. The per-driver lines above count every row.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={!!pending} onOpenChange={(o) => { if (!o && !working) setPending(null); }}>
        <DialogContent className="max-w-md">
          {pending && copy && (
            <>
              <DialogHeader>
                <DialogTitle>{copy.title}</DialogTitle>
                <DialogDescription>
                  {ngn(pending.earning.amount_ngn)} · {pending.earning.driver_name} · {pending.earning.vehicle_name || 'Ride'}
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm text-slate-600 dark:text-slate-300">{copy.body}</p>
              {pending.action === 'reverse' && pending.earning.status === 'released' && (
                <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl p-3">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-amber-900 dark:text-amber-100">
                    This pay was already released. If the driver has withdrawn it, the amount shows as
                    money to recover and comes off their next released pay.
                  </p>
                </div>
              )}
              {copy.needsAmount && (
                <div>
                  <Label htmlFor="de-amount">New pay (₦)</Label>
                  <Input
                    id="de-amount" type="text" inputMode="numeric" autoComplete="off" value={amount}
                    onChange={(ev) => setAmount(ev.target.value)} className="mt-1 rounded-xl"
                  />
                </div>
              )}
              {copy.needsReason && (
                <div>
                  <Label htmlFor="de-reason">Reason</Label>
                  <Textarea
                    id="de-reason" rows={3} value={reason} maxLength={500}
                    onChange={(ev) => setReason(ev.target.value)}
                    placeholder="Kept on the record with this change" className="mt-1 rounded-xl"
                  />
                </div>
              )}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setPending(null)} disabled={working} className="rounded-xl">
                  Cancel
                </Button>
                <Button
                  onClick={confirm} disabled={working}
                  className={copy.danger
                    ? 'rounded-xl bg-red-600 hover:bg-red-700 text-white'
                    : 'rounded-xl bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'}
                >
                  {working ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  {copy.button}
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
import DriversAdmin from '@/components/admin/DriversAdmin';
```

replace with:

```jsx
import DriversAdmin from '@/components/admin/DriversAdmin';
import DriverEarningsAdmin from '@/components/admin/DriverEarningsAdmin';
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
      <TabsList className="grid w-full grid-cols-2 max-w-md">
        <TabsTrigger value="requests">
          <Inbox className="w-4 h-4 mr-2" /> Requests
        </TabsTrigger>
        <TabsTrigger value="drivers">
          <IdCard className="w-4 h-4 mr-2" /> Drivers
        </TabsTrigger>
      </TabsList>
```

replace with:

```jsx
      <TabsList className="grid w-full grid-cols-3 max-w-xl">
        <TabsTrigger value="requests">
          <Inbox className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Requests</span>
        </TabsTrigger>
        <TabsTrigger value="drivers">
          <IdCard className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Drivers</span>
        </TabsTrigger>
        <TabsTrigger value="earnings">
          <Banknote className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Earnings</span>
        </TabsTrigger>
      </TabsList>
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
      <TabsContent value="drivers">
        <DriversAdmin />
      </TabsContent>
```

replace with:

```jsx
      <TabsContent value="drivers">
        <DriversAdmin />
      </TabsContent>

      <TabsContent value="earnings">
        <DriverEarningsAdmin />
      </TabsContent>
```

- [ ] **Step 7: Lint, parse and build**

Run: `npm run lint`

Expected: no output, exit code 0.

Run: `node_modules/.bin/esbuild base44/functions/getDriverEarningsAdmin/entry.ts --format=esm --target=esnext --outfile=/dev/null`

Expected: exit code 0.

Run: `set -a; . ./.env; set +a; npm run build`

Expected: `✓ built in …`.

- [ ] **Step 8: Look at it (sandbox, after the next publish)**

1. Admin → Rides → Earnings. Expected: a "By driver" line for each driver with pay on record, then the held rows.
2. Hold a row with a reason, then switch the filter to On hold. Expected: the row is there with "Held because: …".
3. Adjust it to a new figure with a reason, lift the hold, release it. Expected: the driver's line moves the amount from held to available.
4. Reverse the released row. Expected: the amber warning in the dialog, then the toast naming the drop in the driver's available balance.
5. On a phone-width window the three inner tabs show icons only, and no row scrolls sideways. In dark mode every panel and both dialogs are readable.

- [ ] **Step 9: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/getDriverEarningsAdmin/entry.ts src/components/admin/DriverEarningsAdmin.jsx src/components/admin/RidesAdmin.jsx
git commit -m "feat(rides): Earnings tab for admin, with a per-driver summary" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

