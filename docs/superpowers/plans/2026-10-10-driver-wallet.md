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

