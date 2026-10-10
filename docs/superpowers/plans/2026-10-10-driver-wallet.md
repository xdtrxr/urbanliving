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
- Every helper the check script executes is a top-level `function name(...) {` whose first line holds the whole signature and whose closing `}` sits alone in column 0. Its body is plain JavaScript (no type annotations inside the body), because the script swaps only the first line.
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

