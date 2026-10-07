# Driver wallet and ride reports — design

Date: 2026-10-07. Status: approved in conversation, pending written review.

## Context

A driver on the roster asked for two things that ride-hailing apps already give him:

1. **See his money.** Once a ride he is assigned to is paid, the pay for that ride should show in a wallet of his own, held, and become his when the booked time is over.
2. **Report a rude or abusive customer.** Knowing a report will be read is a big part of why drivers accept jobs.

Today neither is possible. Drivers are admin-only records with no login, nothing ever marks a ride completed, and the only driver cost in the system is the per-vehicle rate card the admin types into Internal costing.

Decisions taken with the owner on 2026-10-07:

- Drivers sign in to the app with the normal login. Admin links a driver record to an email.
- Wallet is for drivers only. Car partners keep being paid outside the app.
- Held money releases **2 hours after the booked end time**. Admin can release sooner, hold longer, adjust, or reverse.
- Both drivers and guests can file a report on a ride. Same form, same admin inbox.

## Non-goals

- No partner (car owner) wallet, no partner login.
- No driver self-registration. Admin creates the driver record and sets the email.
- No automatic charging of guests for extra hours. Admin may raise the driver's pay for extra time; collecting the extra from the guest stays manual.
- No star ratings. `Driver.rating` and `trips_completed` stay as they are.

## 1. Driver access

**Linking.** `Driver` gains `user_email` (string, admin-written through the existing Drivers admin form). One driver per email; the form rejects a duplicate against the loaded roster.

**Detection.** A new function `getDriverProfile` returns the caller's Driver row (public fields only: id, full_name, photo, city, active, admin_approved) or `null`. No new role: the Base44 role enum stays `admin | user`. "Is a driver" means "a Driver row carries my email and is active and approved".

**Navigation.** `src/Layout.jsx` already loads the user on mount; it also calls `getDriverProfile` and, when a row comes back, prepends two items: **My rides** (`DriverRides`) and **Wallet** (`DriverWallet`). Both pages are members-only by default (not in `PUBLIC_PAGES`) and render a short "This page is for UrbanStays drivers" notice when `getDriverProfile` is null.

## 2. Data model

New entity **`DriverEarning`** (`base44/entities/DriverEarning.jsonc`), one row per driver per ride:

| field | notes |
|---|---|
| `driver_id`, `driver_email` | denormalised so RLS can key on email |
| `ride_booking_id`, `booking_reference`, `vehicle_name`, `service_date`, `end_at` | snapshot for the ledger list |
| `amount_ngn` | the driver's pay for this ride |
| `basis` | `hourly \| daily \| manual`, with `rate_ngn` and `units` recorded for audit |
| `status` | `held \| released \| reversed` |
| `on_hold` (bool), `hold_reason` | admin pause; a held row with `on_hold` never auto-releases |
| `release_at` | `end_at + 2h`, the earliest auto-release moment |
| `held_at`, `released_at`, `reversed_at`, `adjusted_at`, `adjustment_reason`, `admin_notes` | timestamps and audit |

RLS: read where `data.driver_email == {{user.email}}` or admin; create, update, delete admin-only. Every write goes through a function under the service role.

New entity **`RideReport`** (`base44/entities/RideReport.jsonc`):

| field | notes |
|---|---|
| `ride_booking_id`, `booking_reference` | |
| `reporter_email`, `reporter_role` | `driver \| guest` |
| `reported_email` (guest) or `reported_driver_id` (driver) | exactly one is set |
| `category` | `rude \| abusive \| threatening \| unsafe \| no_show \| damage \| other` |
| `description` | required, max 2000 chars |
| `evidence_urls` | array, max 3, from the existing `UploadFile` integration |
| `status` | `open \| reviewing \| resolved \| dismissed` |
| `action_taken` | `none \| warning \| blocked` |
| `admin_notes`, `resolved_at`, `resolved_by` | |
| `telegram_message_id` | the admin-group card |

RLS: read where `data.reporter_email == {{user.email}}` or admin; create, update, delete admin-only (created by function).

Additive fields on existing entities:

- `RideBooking`: `driver_payout_ngn` (snapshot at assignment), `completed_at`, `completed_by` (`system \| admin`).
- `User`: `driver_balance_ngn` (number, default 0, field-level write admin-only, same shape as `referral_balance_ngn`), `ride_blocked` (bool, default false, admin-only write), `ride_block_reason`.
- `WithdrawalRequest`: `wallet` enum `referral \| driver`, default `referral`.
- `Driver`: `user_email`.

All of these are additive and safe to checkpoint before the client publishes: no live client reads them, and the admin-only write rules only restrict fields that did not exist.

## 3. How a driver's pay is computed

Source of truth is `VehicleCosting` for the ride's vehicle. Server function (new helper inside `assignRideDriver`, mirrored client-side as `driverPayoutFor` in `src/config/rides.js` for the preview, same lockstep rule as `estimateRidePrice`):

| `duration_tier` | basis | amount |
|---|---|---|
| `hourly` | hourly | `driver_cost_per_hour_ngn × duration_hours` |
| `12hr`, `24hr` | daily | `driver_cost_per_day_ngn` |
| `multi_day` | daily | `driver_cost_per_day_ngn × duration_days` |
| `weekly` | daily | `× 7` |
| `monthly` | daily | `× 30` |

If the needed rate is zero or the costing row is missing, the computed amount is `null`. The Assign driver dialog shows the computed figure in an editable **Driver pay (₦)** input; a blank or zero computed figure shows the warning "No driver cost set for this vehicle. Enter the pay here or set it under Vehicles → Internal costing." Admin may always override; an override is recorded with `basis: manual`. `assignRideDriver` accepts an optional `driver_payout_ngn` and otherwise computes it. Assignment with no figure at all is refused (`PAYOUT_REQUIRED`) so a ride can never be driven with nobody knowing what the driver is owed.

A script `scripts/check-driver-payout.mjs` asserts the client mirror matches the server table, like `scripts/check-ride-time.mjs` does for pricing.

## 4. Money lifecycle

```
assignRideDriver (paid ride)      -> DriverEarning held, release_at = end_at + 2h
                                     RideBooking.driver_payout_ngn
   reassignment                   -> old driver's row reversed, new row held
   admin cancels a paid ride      -> row reversed (cancelRideBooking)
sweep pass 4 (end_at passed)      -> RideBooking status completed, completed_by system
sweep pass 5 (release_at passed)  -> if not on_hold and no open RideReport on the ride:
                                     status released, User.driver_balance_ngn += amount
                                     push to driver
admin: Release now / Hold / Unhold / Adjust / Reverse   (settleDriverEarning)
driver: Withdraw (wallet = driver) -> existing WithdrawalRequest flow, debits driver_balance_ngn
```

**Hold and release ordering.** Pass 5 stamps the row (`status: released`, `released_at`) first and credits the balance second. If the credit throws, the row is flipped to `on_hold` with `hold_reason: 'credit_failed'` and the admin group gets a Telegram line, so a human reconciles instead of a retry loop double-crediting. Pass 5 re-reads the row immediately before writing and skips anything no longer `held`.

**Open report blocks release.** A `RideReport` in `open` or `reviewing` on the ride keeps the row held past `release_at`. Resolving or dismissing the report lets the next sweep release it. The driver's wallet shows "Under review" instead of a release date in that case.

**Reversal after release.** If money was already released, `settleDriverEarning reverse` debits `driver_balance_ngn` (floored at zero; any shortfall is written to `admin_notes` as money to recover manually) and marks the row reversed.

**Withdrawals.** `createWithdrawalRequest` takes `wallet` (`referral` default, `driver`) and reads, checks and debits the matching balance field. `processWithdrawal` and `paystackTransferWebhook` refund to the field named by `withdrawal.wallet`, defaulting to referral for old rows. Same ₦10,000 threshold and one-in-flight rule for both wallets; a driver with a pending referral withdrawal cannot open a driver one, which keeps the existing race defence intact. The Withdrawals page shows a wallet switch only for users who have a driver profile.

## 5. Reports

**Who, when.** A driver can report the guest on any ride assigned to them from `start_at` until 7 days after `end_at`. A guest can report the driver on any paid ride with a driver assigned, over the same window. One report per reporter per ride (`createRideReport` returns 409 `ALREADY_REPORTED`).

**Form** (`src/components/rides/RideReportDialog.jsx`, shared): category chips, description, up to 3 photos via `UploadFile` (10 MB each, images only), submit. Copy for drivers: "Report this customer". Copy for guests: "Report a problem with this driver".

**Admin inbox.** New inner tab **Reports** in `RidesAdmin` (`src/components/admin/RideReportsAdmin.jsx`): open first, each card shows ride reference, who reported whom, category, text, evidence thumbnails, and three actions: **Dismiss**, **Warn** (records `action_taken: warning`, no other effect), **Block from rides** (guest reports only: sets `User.ride_blocked` and `ride_block_reason`; driver reports: sets `Driver.active = false`). Status changes and notes go through `resolveRideReport`.

**Effect of a block.** `checkRideAvailability` refuses a blocked guest with 403 `RIDE_BLOCKED` and the message "Ride bookings are not available on this account. Please contact support." The Book a Ride page shows that message on the request screen rather than a generic error.

**Notifications.** New report → Telegram card to the admin group (same shape as the ride request card, no inline buttons; actions live in the admin tab). Resolution → push to the reporter ("Your report on ride UD-XXXXXX was reviewed").

## 6. Functions

New:

| function | auth | does |
|---|---|---|
| `getDriverProfile` | any user | Driver row for `user.email`, public fields, or null |
| `getDriverRides` | driver | rides where `driver_id` is mine, bucketed by the same `computeBucket` as `getRideBookings`, with guest name and phone (all assigned rides are paid by construction), pickup, instructions, and the earning row for each |
| `getDriverWallet` | driver | `available` (`driver_balance_ngn`), `held` (sum of held rows), `paid_out` (sum of completed driver withdrawals), ledger rows newest first |
| `settleDriverEarning` | admin | `action: release \| hold \| unhold \| adjust \| reverse` with `reason`; all transitions guarded by current status |
| `completeRide` | admin | marks a confirmed paid ride completed now (`completed_by: admin`); does not release money |
| `createRideReport` | party to the ride | validates window and role, creates the row, Telegram notify, stamps `telegram_message_id` |
| `resolveRideReport` | admin | status, `action_taken`, notes; applies the block when chosen; push to reporter |

Changed:

| function | change |
|---|---|
| `assignRideDriver` | compute or accept `driver_payout_ngn`; create the held `DriverEarning`; on reassignment reverse the previous driver's row; push the new driver |
| `cancelRideBooking` | admin cancellation of a paid ride reverses the held row |
| `autoCancelExpiredBookings` | pass 4 completes rides past `end_at`; pass 5 releases rows past `release_at` |
| `checkRideAvailability` | refuse `ride_blocked` users |
| `createWithdrawalRequest`, `processWithdrawal`, `paystackTransferWebhook` | wallet-aware balance field |
| `getDashboardStats` | `liabilities.driverHeldNGN` and `driverAvailableNGN` for the admin overview |

All money writes stay under `asServiceRole` with the same read-modify-write pattern the referral balance uses today; the ledger row is the audit trail the referral balance never had.

## 7. Client

- `src/pages/DriverRides.jsx`: Upcoming / Current / Past groups. Card: date and time, duration label, vehicle, pickup address and instructions, guest name with a tel: link, pay line ("₦25,000 · held, releases Tue 6:00 PM" / "released" / "under review"), **Report this customer** on current and past cards inside the window.
- `src/pages/DriverWallet.jsx`: three tiles (Available, Held, Paid out), ledger list, **Withdraw** (links to Withdrawals with `?wallet=driver`), **Bank accounts** link, empty state explaining when money appears.
- `src/pages/Withdrawals.jsx`: wallet switch for drivers; passes `wallet` to `createWithdrawalRequest`; history rows show a wallet badge.
- `src/components/booking/RideBookingsSection.jsx`: **Report a problem with this driver** on the driver card once `start_at` has passed.
- `src/components/admin/DriversAdmin.jsx`: `user_email` field with the hint "The driver signs in with this email to see rides and pay".
- `src/components/admin/RidesAdmin.jsx`: Assign dialog gets the Driver pay input; Requests panel gets **Mark completed** on current rides; two new inner tabs **Earnings** (`DriverEarningsAdmin.jsx`: filter by status, actions from `settleDriverEarning`) and **Reports** (`RideReportsAdmin.jsx`). Tab grid goes to four columns.
- `src/components/admin/WithdrawalsAdmin.jsx`: wallet badge per row.
- `src/components/admin/PlatformStatsAdmin.jsx`: driver liabilities line under Referrals and payouts.
- `src/Layout.jsx`: driver nav items; `src/pages.config.js`: register `DriverRides`, `DriverWallet`.

All new UI follows the dark-mode rules from the September design review (every `bg-`/`text-` on a surface carries a `dark:` twin; primaries invert).

## 8. Security

- Drivers never write `Driver`, `DriverEarning`, `RideReport` or any balance field directly; entity RLS is admin-only for writes and functions do the work under the service role.
- `driver_balance_ngn`, `ride_blocked`, `ride_block_reason` carry field-level admin-only write rules from day one.
- `getDriverRides` and `getDriverWallet` resolve the driver from `user.email` server-side; a `driver_id` from the client is never trusted.
- Guest phone is shown to the driver only for rides assigned to that driver. Driver licence fields stay admin-only, as today.
- Report evidence URLs are stored as strings; the admin tab renders them as images, never as HTML.

## 9. Rollout

1. Entity changes are additive; checkpoint them first (safe under the live client).
2. Functions and client ship together on the next Publish. Until then the live app behaves as today.
3. Dashboard schedule for `autoCancelExpiredBookings` keeps its cadence; passes 4 and 5 ride along.
4. Admin sets `user_email` on each driver and, for cars whose costing row is empty, enters the driver cost once.

## 10. Verification

- `npm run lint`, `npm run build`, `node scripts/check-driver-payout.mjs`.
- Sandbox walk-through with a test driver linked to a test email: request → approve → pay (Paystack test) → assign (pay figure correct, held row created) → run the sweep by HTTP as admin after `end_at + 2h` passes (use a short booking) → row released, balance credited, driver push received → withdraw from the driver wallet → bank transfer initiated.
- Reassignment reverses the first driver's row and holds a new one. Admin cancel of a paid ride reverses it.
- Driver files a report on a current ride → Telegram card arrives → admin blocks the guest → guest's next ride request fails with the contact-support message. Resolve the report → the held row releases on the next sweep.
- Guest files a report from the driver card; admin dismisses it; no block applied.
- Dark-mode sweep of the two driver pages and the three new admin panels with the scanner from the design review.
