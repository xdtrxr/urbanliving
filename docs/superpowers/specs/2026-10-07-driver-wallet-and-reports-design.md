# Driver wallet and ride reports — design

Date: 2026-10-07. Status: approved 2026-10-07, amended 2026-10-10 (see Amendments).

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
- Same ₦10,000 withdrawal minimum as referral earnings, and one withdrawal in flight per person across both wallets.

## Amendments (2026-10-10)

Found while reading the code the feature has to live in. None changes what a driver, guest or admin sees; each removes a way for money or private data to go wrong.

1. **The driver balance is computed from the ledger, not stored.** The first draft kept a `driver_balance_ngn` number on the User row and added to it on release. The platform has no atomic increment, so two overlapping sweep runs could add the same pay twice. Available balance is now always `released earnings − withdrawals`, worked out on demand. Releasing a row twice is harmless, a failed transfer needs no refund step, and a reversal after release nets against the driver's next pay instead of being lost.
2. **The driver's pay is not written on the ride.** Guests can read their own RideBooking row through the API, so a `driver_payout_ngn` field there would show them the driver's pay. The figure lives only on the DriverEarning row.
3. **The two new tables are admin-only at the API.** DriverEarning and RideReport both carry internal notes. Drivers and reporters get what they need through functions that return a trimmed view.
4. **A driver with no login email is assigned exactly as today.** Pay tracking applies once admin links an email. Deactivating a driver stops new assignments but never locks them out of money already earned.
5. **A paid ride stays paid.** `verifyRidePayment` and the payment webhook treated "paid" as "paid and confirmed", so once the sweep marks rides completed, replaying an old payment reference would have flipped the ride back to confirmed. Both now key on payment status alone. `getRideDriverContact` accepts completed rides so the guest can still reach the driver card to file a report.
6. **Withdrawal rows are created by the server, not the browser.** `createWithdrawalRequest` now writes the row under the service role, and a stricter rule (only the server may create a WithdrawalRequest) is staged for publish day. Until that rule is live a signed-in user can create a fake pending withdrawal row directly; driver-wallet payouts are protected regardless, because `processWithdrawal` re-checks the ledger before sending money.
7. **Admin can read bank account details.** The Withdrawals admin tab looks up the destination account, but the UserBankAccount rule only let the owner read it, which leaves "Process now" disabled. Admin read is added.
8. **Only a guest's complaint holds the driver's pay.** The first draft froze a ride's pay while any report on it was open. That would have delayed a driver's own money every time they reported an abusive customer, which punishes the behaviour this feature exists to encourage. A report the driver files never touches their pay; a complaint from the guest about the ride holds it until admin closes the report.
9. **Refusals from the server are shown as written.** The SDK throws on any 4xx, so every screen that looked for the reason in a normal response was showing "Request failed with status code 409" instead. A small helper (`invokeFn`) now returns the server's sentence; the new screens and the ones this feature touches use it.
10. **A multi-day booking is 1 to 30 whole days on the server too.** The booking form already stopped at 30; the server accepted any number, and that number multiplies into the guest's price, the driver's pay and how long the vehicle is blocked. A hand-made request for a billion days created an unpayable ride that blocked the car until admin rejected it. The computed driver pay also has a ceiling of ₦50,000,000 per ride; past it, admin has to type the figure.

## Non-goals

- No partner (car owner) wallet, no partner login.
- No driver self-registration. Admin creates the driver record and sets the email.
- No automatic charging of guests for extra hours. Admin may raise the driver's pay for extra time; collecting the extra from the guest stays manual.
- No star ratings. `Driver.rating` and `trips_completed` stay as they are.

## 1. Driver access

**Linking.** `Driver` gains `user_email` (string, lower-cased, admin-written through the existing Drivers admin form) and `previous_user_emails` (the form appends the old address whenever the email is changed, so past withdrawals still count against the driver's balance). One driver per email; the form rejects a duplicate against the loaded roster.

**Detection.** A new function `getDriverProfile` returns the caller's Driver row (public fields only: id, full_name, photo, city, active, admin_approved) or `null`. No new role: the Base44 role enum stays `admin | user`. "Is a driver" means "a Driver row carries my email".

**Navigation.** `src/Layout.jsx` asks `getDriverProfile` once per session and, when a row comes back, prepends two items: **My rides** (`DriverRides`) and **Wallet** (`DriverWallet`). Both pages are members-only by default (not in `PUBLIC_PAGES`) and render a short "This page is for UrbanStays drivers" notice when there is no driver profile.

## 2. Data model

New entity **`DriverEarning`** (`base44/entities/DriverEarning.jsonc`), one row per driver per ride:

| field | notes |
|---|---|
| `driver_id` | FK to Driver |
| `ride_booking_id`, `booking_reference`, `vehicle_name`, `service_date`, `end_at` | snapshot for the ledger list |
| `amount_ngn` | the driver's pay for this ride, whole naira |
| `basis` | `hourly \| daily \| manual`, with `rate_ngn` and `units` recorded for audit |
| `status` | `held \| released \| reversed` |
| `on_hold` (bool), `hold_reason` | admin pause; a held row with `on_hold` never auto-releases |
| `release_at` | `end_at + 2h`, the earliest auto-release moment |
| `held_at`, `released_at`, `reversed_at`, `adjusted_at`, `adjustment_reason`, `admin_notes` | timestamps and audit |

RLS: admin-only for all four operations. Every write goes through a function under the service role; drivers read through `getDriverWallet` and `getDriverRides`.

New entity **`RideReport`** (`base44/entities/RideReport.jsonc`):

| field | notes |
|---|---|
| `ride_booking_id`, `booking_reference` | |
| `reporter_email`, `reporter_role` | `driver \| guest` |
| `reported_email` (guest) or `reported_driver_id` (driver) | exactly one is set |
| `category` | `rude \| abusive \| threatening \| unsafe \| no_show \| damage \| other` |
| `description` | required, 10–2000 chars |
| `evidence_urls` | array, max 3, https only, from the existing `UploadFile` integration |
| `status` | `open \| reviewing \| resolved \| dismissed` |
| `action_taken` | `none \| warning \| blocked` |
| `admin_notes`, `resolved_at`, `resolved_by` | |

RLS: admin-only for all four operations.

Additive fields on existing entities:

- `RideBooking`: `completed_at`, `completed_by` (`system | admin`).
- `User`: `ride_blocked` (bool, default false, field-level write admin-only, same shape as `referral_balance_ngn`).
- `WithdrawalRequest`: `wallet` enum `referral | driver` (default `referral`), `driver_id`.
- `Driver`: `user_email`, `previous_user_emails`.
- `UserBankAccount`: admin read.

All of these are additive and safe to checkpoint before the client publishes: no live client reads them, and the admin-only rules only restrict things that did not exist.

## 3. How a driver's pay is computed

Source of truth is `VehicleCosting` for the ride's vehicle. Server helper `driverPayoutFor` inside `assignRideDriver`, mirrored client-side in `src/config/rides.js` for the preview, same lockstep rule as `estimateRidePrice`:

| `duration_tier` | basis | amount |
|---|---|---|
| `hourly` | hourly | `driver_cost_per_hour_ngn × duration_hours` |
| `12hr`, `24hr` | daily | `driver_cost_per_day_ngn` |
| `multi_day` | daily | `driver_cost_per_day_ngn × duration_days` |
| `weekly` | daily | `× 7` |
| `monthly` | daily | `× 30` |

If the needed rate is zero or the costing row is missing, the computed amount is `null`. The Assign driver dialog shows the computed figure in an editable **Driver pay (₦)** input; a blank computed figure shows the warning "No driver cost set for this vehicle. Enter the pay here or set it under Vehicles → Internal costing." Admin may always override; an override is recorded with `basis: manual`. For a driver who has a login email, assignment with no figure at all is refused (`PAYOUT_REQUIRED`) so a ride is never driven with nobody knowing what the driver is owed. An explicit ₦0 is accepted and records no ledger row. A driver without a login email is assigned as today, with no pay recorded.

`scripts/check-driver-wallet.mjs` asserts the client mirror matches the server table and exercises every other piece of wallet arithmetic, the way `scripts/check-ride-time.mjs` does for pricing.

## 4. Money lifecycle

```
assignRideDriver (paid ride, linked driver) -> DriverEarning held, release_at = end_at + 2h
   reassignment                             -> new driver's row held, then the old driver's row reversed
   admin cancels a paid ride                -> held rows reversed (cancelRideBooking)
sweep pass 4 (end_at passed)                -> RideBooking status completed, completed_by system
sweep pass 5 (release_at passed)            -> not on_hold, no open complaint from the guest, ride still theirs and paid:
                                               status released, push to driver
                                               ride cancelled or driver changed: reversed instead
admin: Release now / Hold / Unhold / Adjust / Reverse     (settleDriverEarning)
driver: Withdraw (wallet = driver)          -> existing WithdrawalRequest flow
```

**Balance.** For one driver: `held` = sum of held rows; `available` = `max(0, released − paid out − in flight)` where paid out is their completed driver-wallet withdrawals and in flight is pending or processing ones. Nothing is stored; `getDriverWallet`, `createWithdrawalRequest`, `processWithdrawal` and the admin overview all run the same `walletTotals` helper, and the check script fails if any copy differs.

**Self-healing.** Assignment writes the new driver's row, then the ride, then reverses the old driver's row. If it stops halfway, the release pass sees an earning whose ride belongs to another driver, or was cancelled, and reverses it rather than paying it.

**A guest's open complaint blocks release.** A `RideReport` filed by the guest, in `open` or `reviewing`, keeps the row held past `release_at`. Resolving or dismissing it lets the next sweep release it, and the driver's wallet shows "Under review" instead of a release date meanwhile. A report the driver files about the guest never holds the driver's own pay.

**Reversal after release.** The row flips to `reversed` and the driver's available balance drops by that amount. If they had already withdrawn it, the shortfall shows in the admin Earnings tab and is netted against their next released pay.

**Withdrawals.** `createWithdrawalRequest` takes `wallet` (`referral` default, `driver`). A driver-wallet request is checked against `walletTotals` and reserves by existing as a pending row; nothing is debited. `processWithdrawal` re-runs the same check before calling Paystack and refuses a request the ledger does not cover. A failed or reversed transfer simply stops counting. Referral withdrawals keep their existing debit-and-refund behaviour, and the two refund paths skip driver-wallet rows so a failed driver payout can never credit referral cash. Same ₦10,000 threshold and one-in-flight rule for both wallets. The Withdrawals page shows a wallet switch only for users who have a driver profile.

## 5. Reports

**Who, when.** A driver can report the guest on any paid ride assigned to them from `start_at` until 7 days after `end_at`. A guest can report the driver on any paid ride with a driver assigned, over the same window. One report per reporter per ride (`createRideReport` returns 409 `ALREADY_REPORTED`).

**Form** (`src/components/rides/RideReportDialog.jsx`, shared): category chips, description, up to 3 photos via `UploadFile` (10 MB each, images only), submit. Copy for drivers: "Report this customer". Copy for guests: "Report a problem with this driver".

**Admin inbox.** New inner tab **Reports** in `RidesAdmin` (`src/components/admin/RideReportsAdmin.jsx`): open first, each card shows ride reference, who reported whom, category, text, evidence thumbnails, and three actions: **Dismiss**, **Warn** (records `action_taken: warning`, no other effect), **Block from rides** (a report against a guest sets `User.ride_blocked`; a report against a driver sets `Driver.active = false`). Changing the action on a guest report away from blocked clears the block. Status changes and notes go through `resolveRideReport`.

**Effect of a block.** `checkRideAvailability` refuses a blocked guest with 403 `RIDE_BLOCKED` and the message "Ride bookings are not available on this account. Please contact support." The Book a Ride request screen already shows the server's sentence.

**Notifications.** New report → plain-text Telegram card to the admin group (plain text because the description is free text and would break Markdown parsing; actions live in the admin tab). Resolution → push to the reporter ("Your report on ride UD-XXXXXX was reviewed").

## 6. Functions

New:

| function | auth | does |
|---|---|---|
| `getDriverProfile` | any user | Driver row for `user.email`, public fields, or null |
| `getDriverRides` | driver | rides where `driver_id` is mine, bucketed by the same `computeBucket` as `getRideBookings`, with guest name, guest phone while the ride is upcoming or in progress, pickup, instructions, and the earning row for each |
| `getDriverWallet` | driver | `available`, `held`, `paid_out`, any withdrawal in flight, ledger rows newest first (no admin notes) |
| `getDriverEarningsAdmin` | admin | the pay ledger across all drivers, plus one summary line per driver (held, available, paid out, shortfall) computed with the same arithmetic as the driver's own wallet |
| `settleDriverEarning` | admin | `action: release \| hold \| unhold \| adjust \| reverse` with `reason`; all transitions guarded by current status |
| `completeRide` | admin | marks a started, paid ride completed now (`completed_by: admin`); does not release money |
| `createRideReport` | party to the ride | validates window and role, creates the row, Telegram notify |
| `resolveRideReport` | admin | status, `action_taken`, notes; applies or clears the block; push to reporter |

Changed:

| function | change |
|---|---|
| `assignRideDriver` | compute or accept `driver_payout_ngn`; create the held `DriverEarning`; on reassignment reverse the previous driver's row; push both drivers |
| `cancelRideBooking` | cancelling a ride reverses its held earnings and tells the driver |
| `autoCancelExpiredBookings` | pass 4 completes rides past `end_at`; pass 5 releases rows past `release_at` |
| `verifyRidePayment`, `paystackWebhook` | "already paid" keys on payment status alone |
| `getRideDriverContact` | also serves completed rides |
| `checkRideAvailability` | refuse `ride_blocked` users |
| `getRideBookings` | tells the guest whether they can still report a ride |
| `createWithdrawalRequest`, `processWithdrawal`, `paystackTransferWebhook` | wallet-aware as described in section 4 |
| `getDashboardStats` | `liabilities.driverHeldNGN` and `driverAvailableNGN` for the admin overview |

## 7. Client

- `src/pages/DriverRides.jsx`: Upcoming / In progress / Past / Cancelled groups. Card: date and time, duration label, vehicle, pickup address and instructions, guest name with a tel: link while the ride is live, pay line ("₦25,000 · held, releases Tue 6:00 PM" / "released" / "under review"), **Report this customer** on current and past cards inside the window.
- `src/pages/DriverWallet.jsx`: three tiles (Available, Held, Paid out), ledger list, **Withdraw** (links to Withdrawals with `?wallet=driver`), **Bank accounts** link, empty state explaining when money appears.
- `src/pages/Withdrawals.jsx`: wallet switch for drivers; passes `wallet` to `createWithdrawalRequest`; history rows show a wallet badge.
- `src/components/booking/RideBookingsSection.jsx`: **Report a problem with this driver** on the driver card once the ride has started.
- `src/components/admin/DriversAdmin.jsx`: login email field with the hint "The driver signs in with this email to see rides and pay".
- `src/components/admin/RidesAdmin.jsx`: Assign dialog gets the Driver pay input; Requests panel gets **Mark completed** on rides in progress or past; two new inner tabs **Earnings** (`DriverEarningsAdmin.jsx`) and **Reports** (`RideReportsAdmin.jsx`).
- `src/components/admin/WithdrawalsAdmin.jsx`: wallet badge per row.
- `src/components/admin/PlatformStatsAdmin.jsx`: driver pay owed, under Referrals and payouts.
- `src/Layout.jsx`: driver nav items; `src/pages.config.js`: register `DriverRides`, `DriverWallet`.

All new UI follows the dark-mode rules from the September design review (every `bg-`/`text-` on a surface carries a `dark:` twin; primaries invert).

## 8. Security

- Drivers never write `Driver`, `DriverEarning`, `RideReport` or any balance directly; the two new entities are admin-only at the API and functions do the work under the service role.
- There is no driver balance field to tamper with. `ride_blocked` carries a field-level admin-only write rule from day one.
- `getDriverRides` and `getDriverWallet` resolve the driver from `user.email` server-side; a `driver_id` from the client is never trusted.
- A withdrawal row only counts against a driver's balance when it carries that driver's id AND was created by a login that is, or was, linked to that driver. A row forged by another account is ignored.
- Guest phone is shown to the driver only for rides assigned to that driver, and only until the ride is over. Driver licence fields stay admin-only, as today.
- Report evidence URLs must be https, are stored as strings, and the admin tab renders them as images, never as HTML.

## 9. Rollout

1. Entity changes are additive; checkpoint them first (safe under the live client).
2. Functions and client ship together on the next Publish. Until then the live app behaves as today.
3. After Publish, apply the staged rule in `docs/entity-rules-pending-publish/WithdrawalRequest.jsonc`.
4. Dashboard schedule for `autoCancelExpiredBookings` keeps its cadence; passes 4 and 5 ride along.
5. Admin sets the login email on each driver and, for cars whose costing row is empty, enters the driver cost once.

## 10. Verification

- `npm run lint`, `npm run check` (includes `check-driver-wallet`, `check-ride-reports`, `check-entities`), `npm run build`.
- Sandbox walk-through with a test driver linked to a test email: request → approve → pay (Paystack test) → assign (pay figure correct, held row created) → run the sweep by HTTP as admin after `end_at + 2h` passes (use a short booking) → ride completed, row released, driver push received → withdraw from the driver wallet → bank transfer initiated.
- Reassignment reverses the first driver's row and holds a new one. Admin cancel of a paid ride reverses it.
- Driver files a report on a current ride → Telegram card arrives → admin blocks the guest → guest's next ride request fails with the contact-support message. Resolve the report → the held row releases on the next sweep.
- Guest files a report from the driver card; admin dismisses it; no block applied.
- Dark-mode sweep of the two driver pages and the three new admin panels with the scanner from the design review.
