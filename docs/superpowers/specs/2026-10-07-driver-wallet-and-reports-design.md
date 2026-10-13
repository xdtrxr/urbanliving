# Driver wallet and ride reports — design

Date: 2026-10-07. Status: approved 2026-10-07, amended 2026-10-10 (see Amendments; 19 to 22 were written up on 2026-10-12).

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

## Amendments from review (2026-10-10)

Three independent reviewers read the finished work and found seventeen ways for it to go wrong. All are fixed; the plan is `docs/superpowers/plans/2026-10-10-review-hardening.md`. What changed in the design:

11. **A payout is sent once, and no answer never means refund.** Pressing Process twice, or two admins pressing it together, sent two bank transfers: the Paystack reference was built from the clock, so each call was a new transfer. The reference is now `wd-<row id>`, fixed per withdrawal and stored on the row (`transfer_reference`) before Paystack is asked to send. The function asks Paystack what it already holds for that reference before sending and again after any refusal. A withdrawal is marked failed, and a referral refunded, only when Paystack refused it for a stated reason and holds no transfer for it. A timeout, a rate limit or a fault on Paystack's side leaves the row as processing with a **Retry** button, which cannot send it twice. A transfer the bank reverses after it had succeeded now stops counting as paid.
12. **Two assignments at once leave one pay row.** Assignment used to hold the new driver's pay, write the ride, then reverse everyone else's. Two calls doing that together reversed each other's row, and the driver who ended up on the ride had none. Nothing on the platform can lock a ride, so the fix is not an order of writes. After the ride row is written the function loops: read who the ride says is driving, reverse pay held for anyone else, make sure that driver has a standing row, and go round again if anything was written. The call that lost is told so and its guest is not notified. A ride cancelled while this is running is covered in 21.
13. **The same driver again records pay.** A ride assigned before its driver had a login had no way to get a pay row. Submitting the driver who is already on the ride now does exactly that: the checks on whether to send this driver are skipped, the guest is not told a second time, and a standing row is never repriced. The admin rides list marks such rides "No pay recorded" for a week after they end. Pay that was reversed also counts as recorded: see 22.
14. **A reversal always wins.** A release that had already read a row as held could land on top of a reversal made a moment earlier and leave the row saying released. `reversed_at` is never cleared, so it is the one mark that survives: the wallet arithmetic counts no row that carries it, and every write of "released" reads the row again and puts "reversed" back.
15. **A finished ride still counts when checking for clashes.** The sweep marks a ride completed the moment its window ends, and completed rides were left out of the overlap checks, so the turnaround after a ride protected neither its driver nor its car. A completed ride now keeps them busy until it was completed (earlier than its booked end if admin marked it done early), plus the turnaround. A completed ride with no driver stays in the needs-a-driver queue so who drove it can be recorded.
16. **Ride rows are created by the server.** `checkRideAvailability` created the ride as the signed-in guest, which is why the create rule has to let any signed-in user create one, and that rule only pins the guest's email: a row could be made by hand already marked confirmed and paid. The function now creates under the service role, and a rule that only the server may create a RideBooking is staged beside the WithdrawalRequest one. Until it is applied the hole is still open. A guest blocked from rides is now also stopped when they open the payment page and when admin tries to send them a driver, not only when they request a ride.
17. **A report is filed under the ride's own id, holds only the driver it names, and carries only uploaded photos.** The "already reported" check used the id as it arrived in the request, so `<id>#2` fetched the same ride and counted as a new one: reports could be stacked without limit. A guest's complaint held the pay of whoever was on the ride, so after a handover it held the wrong driver's. And a report "photo" could be any https link, which admin's browser then fetched from a server the reporter chose. The ride row's own id is now used throughout, the hold is matched on `reported_driver_id`, and a photo must be a link to this platform's file store. The rule for that link was tightened in 20.
18. **An id from a request is a plain id.** `entity.get(id)` is a GET on `…/<id>`, so `abc#x` fetches row `abc` while every equality check sees a different string. That is how a hand-made driver-wallet withdrawal carrying the driver's real id plus `#` skipped its own ledger check. Every function that takes an id now refuses anything but letters, digits, `_` and `-`, and checks that the row it got back is the row it asked for.

## Amendments from the second review (2026-10-10)

Four more reviewers were then asked to break those fixes. Their payout findings were closed first, by Task R06 of the same plan: a paper trail for the referral balance in a new `WithdrawalLedger` entity, and a credit back that is made exactly once. That work is described in the plan and has not been written into this document. The four changes below are Task R07 of the plan, commit `ef34f98`. Findings of lower severity were never scheduled; on 2026-10-12 `todo.md` carried a list of them.

19. **A payment reference pays for the booking it was made for.** `verifyRidePayment` and `verifyPaystackPayment` checked that a reference was a successful payment of the right amount, and never which booking it had paid for. A guest with two rides, or two stays, at one price could pay for one and hand the same reference in for the other, and a ride payment could be handed in for a stay. The payment page attaches the booking's id to every transaction it starts, Paystack hands it back with the verification, and both functions now read it: a reference that names another booking is refused (`REFERENCE_MISMATCH`), and so is one that another booking of the same kind already carries. Not closed: a transaction whose metadata names no booking is still accepted for a booking of that amount, as long as no ride (in the one function) or stay (in the other) carries its reference yet.
20. **A report photo is a plain image file in the file store.** The rule in 17 allowed `%` in a link's path, so `..` could be written as `%2e%2e`, pass the check, and be fetched by admin's browser from somewhere else on the platform's host. It also allowed any file, so an uploaded web page or an SVG could be attached as a photo. A photo's link must now have a plain path (letters, digits, `.`, `_` and `-`; no part starting with a dot; nothing percent-encoded) that ends in jpg, jpeg, png, webp, gif, heic or heif. A phone's own file name may not fit that, so the form uploads each photo under the name `report-photo.<ext>`. This depends on the file store keeping that name in the link it returns, which had not been tried against the real file store when this was written.
21. **An assignment that overlaps a cancellation holds nothing.** A cancelled ride row still carries its `driver_id`, and an assignment landing beside the cancellation writes a new one onto it. The loop in 12 took that as the driver to pay, so pay could stay held, or be held again, on a cancelled ride, with the guest and the driver told a driver was on it; and the cancellation only looked at the ledger when the row it had read had a driver. A cancelled ride now counts as having nobody driving: the assignment reverses every held row and holds none, and `cancelRideBooking` reverses held pay whatever the ride row it read said. An assignment that finds the ride cancelled answers `CANCELLED` and notifies nobody.
22. **Pay that was reversed counts as recorded.** "No pay recorded" meant no held or released row, so a ride whose driver's pay admin had reversed on purpose was flagged, and offered **Record pay**, which held pay for that driver again. A pay row of any status for that driver on that ride now counts as recorded. This changes what the rides list and the Assign dialog show, and nothing else: asked directly, `assignRideDriver` still holds a new row for a driver whose only row was reversed.

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
| `evidence_urls` | array, max 3, each a link to an image file uploaded through the platform's file store (the existing `UploadFile` integration): `https://base44.app/api/apps/<24 hex>/files/…`, at most 600 characters, with a plain path (letters, digits, `.`, `_` and `-`; no part starting with a dot; nothing percent-encoded) that ends in jpg, jpeg, png, webp, gif, heic or heif; any other link is refused |
| `status` | `open \| reviewing \| resolved \| dismissed` |
| `action_taken` | `none \| warning \| blocked` |
| `admin_notes`, `resolved_at`, `resolved_by` | |

RLS: admin-only for all four operations.

Additive fields on existing entities:

- `RideBooking`: `completed_at`, `completed_by` (`system | admin`).
- `User`: `ride_blocked` (bool, default false, field-level write admin-only, same shape as `referral_balance_ngn`).
- `WithdrawalRequest`: `wallet` enum `referral | driver` (default `referral`), `driver_id`, `transfer_reference` (the reference sent to Paystack, `wd-<row id>`).
- `Driver`: `user_email`, `previous_user_emails`.
- `UserBankAccount`: admin read.

All of these are additive and safe to checkpoint before the client publishes: no live client reads them, and the admin-only rules only restrict things that did not exist. Two stricter rules are staged in `docs/entity-rules-pending-publish/` and applied after Publish: only the server may create a `WithdrawalRequest`, and only the server may create a `RideBooking`.

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
   reassignment                             -> new driver's row held, the ride written, then the ledger made to agree with the ride row
   same driver submitted again              -> pay recorded if none stands; nothing else changes
   admin cancels a paid ride                -> held rows reversed (cancelRideBooking)
   cancelled while being assigned           -> every held row reversed, none held; the call answers CANCELLED
sweep pass 4 (end_at passed)                -> RideBooking status completed, completed_by system
sweep pass 5 (release_at passed)            -> not on_hold, no open complaint from the guest, ride still theirs and paid:
                                               status released, push to driver
                                               ride cancelled or driver changed: reversed instead
admin: Release now / Hold / Unhold / Adjust / Reverse     (settleDriverEarning)
driver: Withdraw (wallet = driver)          -> existing WithdrawalRequest flow
```

**Balance.** For one driver: `held` = sum of held rows; `available` = `max(0, released − paid out − in flight)` where paid out is their completed driver-wallet withdrawals and in flight is pending or processing ones. Nothing is stored; `getDriverWallet`, `createWithdrawalRequest`, `processWithdrawal` and the admin overview all run the same `walletTotals` helper, and the check script fails if any copy differs.

**Two assignments at once.** Assignment holds the new driver's row, writes the ride, then loops: read who the ride says is driving, reverse pay held for anyone else, make sure that driver has a standing row, repeat if anything was written. However two calls interleave, the driver on the ride ends with one held row and nobody else with any. If a call stops halfway, the release pass sees an earning whose ride belongs to another driver, or was cancelled, and reverses it rather than paying it.

**An assignment and a cancellation at once.** A cancelled ride row keeps its `driver_id`, and an assignment landing beside the cancellation writes a new one onto it. So a cancelled ride counts as having nobody driving: the assignment's loop reverses every held row and holds none, and `cancelRideBooking` reverses held pay whatever the ride row it read said, because an assignment writes its pay row before the ride row. Whichever finishes last, nothing is left held. An assignment that finds the ride cancelled answers `CANCELLED` (409) and notifies nobody. The cancelled row keeps the driver the assignment wrote, so the ride shows under Cancelled in that driver's My rides, with no pay standing on it.

**A guest's open complaint blocks release, for the driver it is about.** A `RideReport` filed by the guest, in `open` or `reviewing`, keeps the pay row of the driver it names (`reported_driver_id`) held past `release_at`. Resolving or dismissing it lets the next sweep release it, and that driver's wallet shows "Under review" instead of a release date meanwhile. If the ride was handed to another driver, the complaint is about the first one and the second is paid on time. A report the driver files about the guest never holds the driver's own pay.

**Reversal after release.** The row flips to `reversed` and the driver's available balance drops by that amount. If they had already withdrawn it, the shortfall shows in the admin Earnings tab and is netted against their next released pay. **A reversal always wins:** a row that carries `reversed_at` counts nowhere in the arithmetic whatever its status says, and every release reads the row again after writing and restores `reversed` if a reversal got in first.

**Withdrawals.** `createWithdrawalRequest` takes `wallet` (`referral` default, `driver`). A driver-wallet request is checked against `walletTotals` and reserves by existing as a pending row; nothing is debited. `processWithdrawal` re-runs the same check before calling Paystack and refuses a request the ledger does not cover. A failed or reversed transfer simply stops counting. Referral withdrawals keep their existing debit-and-refund behaviour, and the two refund paths skip driver-wallet rows so a failed driver payout can never credit referral cash. Same ₦10,000 threshold and one-in-flight rule for both wallets. The Withdrawals page shows a wallet switch only for users who have a driver profile. The transfer reference is `wd-<row id>`. `processWithdrawal` asks Paystack what it holds for that reference before sending and after any refusal, so a second press finds the first transfer instead of making another; a row left as processing with no transfer code can be retried.

## 5. Reports

**Who, when.** A driver can report the guest on any paid ride assigned to them from `start_at` until 7 days after `end_at`. A guest can report the driver on any paid ride with a driver assigned, over the same window. One report per reporter per ride, and for a guest one per driver they had on it (`createRideReport` returns 409 `ALREADY_REPORTED`). The check uses the ride row's own id, never the string that arrived in the request.

**Form** (`src/components/rides/RideReportDialog.jsx`, shared): category chips, description, up to 3 photos via `UploadFile` (10 MB each; JPG, PNG, WEBP, GIF, HEIC or HEIF), submit. Copy for drivers: "Report this customer". Copy for guests: "Report a problem with this driver". Each photo is uploaded under the name `report-photo.<ext>`, because a phone's own file name may not fit the rule for a photo link (section 2). A link that does not fit that rule is refused, at upload and again by the server.

**Admin inbox.** New inner tab **Reports** in `RidesAdmin` (`src/components/admin/RideReportsAdmin.jsx`): open first, each card shows ride reference, who reported whom, category, text, evidence thumbnails, and three actions: **Dismiss**, **Warn** (records `action_taken: warning`, no other effect), **Block from rides** (a report against a guest sets `User.ride_blocked`; a report against a driver sets `Driver.active = false`). Changing the action on a guest report away from blocked clears the block. Status changes and notes go through `resolveRideReport`.

**Effect of a block.** `checkRideAvailability` refuses a blocked guest with 403 `RIDE_BLOCKED` and the message "Ride bookings are not available on this account. Please contact support." `startRidePayment` refuses the same way, so a guest blocked after requesting a ride cannot pay for it, and `assignRideDriver` refuses to send a driver to one (`GUEST_BLOCKED`) until the ride is cancelled or the block lifted. Both screens show the server's sentence.

**Notifications.** New report → plain-text Telegram card to the admin group (plain text because the description is free text and would break Markdown parsing; actions live in the admin tab). Resolution → push to the reporter ("Your report on ride UD-XXXXXX was reviewed").

## 6. Functions

New:

| function | auth | does |
|---|---|---|
| `getDriverProfile` | any user | Driver row for `user.email`, public fields, or null |
| `getDriverRides` | driver | rides where `driver_id` is mine, bucketed by the same `computeBucket` as `getRideBookings`, with guest name, guest phone while the ride is upcoming or in progress, pickup, instructions, and the earning row for each |
| `getDriverWallet` | driver | `available`, `held`, `paid_out`, any withdrawal in flight, ledger rows newest first (no admin notes) |
| `getDriverEarningsAdmin` | admin | the pay ledger across all drivers, plus one summary line per driver (held, available, paid out, shortfall) computed with the same arithmetic as the driver's own wallet |
| `settleDriverEarning` | admin | `action: release \| hold \| unhold \| adjust \| reverse` with `reason`; all transitions guarded by current status; a reversal made at the same moment as another change wins |
| `completeRide` | admin | marks a started, paid ride completed now (`completed_by: admin`); does not release money |
| `createRideReport` | party to the ride | validates window and role, creates the row, Telegram notify |
| `resolveRideReport` | admin | status, `action_taken`, notes; applies or clears the block; push to reporter |

Changed:

| function | change |
|---|---|
| `assignRideDriver` | compute or accept `driver_payout_ngn`; hold the `DriverEarning`, write the ride, then make the ledger agree with the ride row (safe under two calls at once); a ride cancelled meanwhile ends with nothing held and the call answers `CANCELLED`; the same driver again records pay; refuses a blocked guest; push both drivers |
| `cancelRideBooking` | cancelling a ride reverses its held earnings, whether or not the ride row it read had a driver, and tells the driver that row named |
| `autoCancelExpiredBookings` | pass 4 completes rides past `end_at`; pass 5 releases rows past `release_at` |
| `verifyRidePayment`, `paystackWebhook` | "already paid" keys on payment status alone |
| `verifyRidePayment`, `verifyPaystackPayment` | refuse a reference whose metadata names another booking, or that another booking of the same kind already carries (`REFERENCE_MISMATCH`, 400) |
| `getRideDriverContact` | also serves completed rides |
| `startRidePayment` | refuse `ride_blocked` users |
| `checkRideAvailability` | refuse `ride_blocked` users; create the ride row under the service role; completed rides count in the vehicle conflict check |
| `getRideBookings` | tells the guest whether they can still report a ride; tells admin which assigned drivers have a login, and whether each has a pay row of any status for the ride (a reversed row counts as recorded) |
| `createWithdrawalRequest`, `processWithdrawal`, `paystackTransferWebhook` | wallet-aware as described in section 4; fixed transfer reference, ask-before-send, retry of a stuck row; the webhook finds the row from the reference and acts on a reversal after success |
| `getDashboardStats` | `liabilities.driverHeldNGN` and `driverAvailableNGN` for the admin overview |

## 7. Client

- `src/pages/DriverRides.jsx`: Upcoming / In progress / Past / Cancelled groups. Card: date and time, duration label, vehicle, pickup address and instructions, guest name with a tel: link while the ride is live, pay line ("₦25,000 · held, releases Tue 6:00 PM" / "released" / "under review"), **Report this customer** on current and past cards inside the window.
- `src/pages/DriverWallet.jsx`: three tiles (Available, Held, Paid out), ledger list, **Withdraw** (links to Withdrawals with `?wallet=driver`), **Bank accounts** link, empty state explaining when money appears.
- `src/pages/Withdrawals.jsx`: wallet switch for drivers; passes `wallet` to `createWithdrawalRequest`; history rows show a wallet badge.
- `src/components/booking/RideBookingsSection.jsx`: **Report a problem with this driver** on the driver card once the ride has started.
- `src/components/admin/DriversAdmin.jsx`: login email field with the hint "The driver signs in with this email to see rides and pay". A driver with earnings or withdrawals on record cannot be deleted, only switched to inactive.
- `src/components/admin/RidesAdmin.jsx`: Assign dialog gets the Driver pay input; Requests panel gets **Mark completed** on rides in progress or past; two new inner tabs **Earnings** (`DriverEarningsAdmin.jsx`) and **Reports** (`RideReportsAdmin.jsx`). A ride whose driver has a login and no pay row of any status for it shows "No pay recorded" and **Record pay**. Pay that admin reversed counts as recorded, so such a ride shows neither. Every Assign button waits while one assignment is being saved.
- `src/components/admin/WithdrawalsAdmin.jsx`: wallet badge per row; **Retry** on a row left as processing with no transfer code.
- `src/components/admin/PlatformStatsAdmin.jsx`: driver pay owed, under Referrals and payouts.
- `src/pages/PaymentPage.jsx`: a refusal from `startRidePayment` is shown as the server wrote it.
- `src/Layout.jsx`: driver nav items; `src/pages.config.js`: register `DriverRides`, `DriverWallet`.

All new UI follows the dark-mode rules from the September design review (every `bg-`/`text-` on a surface carries a `dark:` twin; primaries invert).

## 8. Security

- Drivers never write `Driver`, `DriverEarning`, `RideReport` or any balance directly; the two new entities are admin-only at the API and functions do the work under the service role.
- There is no driver balance field to tamper with. `ride_blocked` carries a field-level admin-only write rule from day one.
- `getDriverRides` and `getDriverWallet` resolve the driver from `user.email` server-side; a `driver_id` from the client is never trusted.
- A withdrawal row only counts against a driver's balance when it carries that driver's id AND was created by a login that is, or was, linked to that driver. A row forged by another account is ignored.
- Guest phone is shown to the driver only for rides assigned to that driver, and only until the ride is over. Driver licence fields stay admin-only, as today.
- Report evidence must be links to image files in the platform's own file store, with a plain path and an image extension (section 2). They are stored as strings and the admin tab renders them as images, never as HTML. Any other link would make admin's browser fetch from a server the reporter chose, or from somewhere else on the platform's host, or open something that is not a picture.
- A Paystack reference marks a booking paid only if the payment's own metadata does not name another booking and no other booking of the same kind already carries the reference. `verifyRidePayment` and `verifyPaystackPayment` check both; `paystackWebhook` only ever acts on the booking the metadata names. A payment whose metadata names no booking is not refused for that.
- An id that arrives in a request is used only if it is a plain id, and the row that comes back must carry that id.
- Until the two staged create rules are applied, a signed-in user can still create a `RideBooking` or `WithdrawalRequest` row by hand. Driver-wallet withdrawals are re-checked against the ledger regardless; a hand-made ride marked paid is not detectable by the server, which is why those rules go on straight after Publish.

## 9. Rollout

1. Entity changes are additive; checkpoint them first (safe under the live client).
2. Functions and client ship together on the next Publish. Until then the live app behaves as today.
3. After Publish, apply the staged rules in `docs/entity-rules-pending-publish/` (`WithdrawalRequest` and `RideBooking` create become admin-only; the README there is the runbook).
4. Dashboard schedule for `autoCancelExpiredBookings` keeps its cadence; passes 4 and 5 ride along.
5. Admin sets the login email on each driver and, for cars whose costing row is empty, enters the driver cost once. Rides already assigned to a driver before they had a login show "No pay recorded": open each and press **Record pay**.

## 10. Verification

- `npm run lint`, `npm run check` (includes `check-driver-wallet`, `check-ride-reports`, `check-entities`), `npm run build`. The wallet check runs the shipped payout, assignment and release code against itself in every order two calls' requests could arrive, and an assignment against a cancellation in every order with up to five changes of turn.
- Sandbox walk-through with a test driver linked to a test email: request → approve → pay (Paystack test) → assign (pay figure correct, held row created) → run the sweep by HTTP as admin after `end_at + 2h` passes (use a short booking) → ride completed, row released, driver push received → withdraw from the driver wallet → bank transfer initiated.
- Reassignment reverses the first driver's row and holds a new one. Admin cancel of a paid ride reverses it.
- Driver files a report on a current ride → Telegram card arrives → admin blocks the guest → guest's next ride request fails with the contact-support message. Resolve the report → the held row releases on the next sweep.
- Guest files a report from the driver card; admin dismisses it; no block applied.
- The sandbox checklist at the end of each task in the review-hardening plan. The first one (press Process in two tabs) is the only check that Paystack really refuses a second transfer with the same reference. The first step of Task R07's is the only check that the file store returns a photo link the rule accepts.
- Dark-mode sweep of the two driver pages and the three new admin panels with the scanner from the design review.
