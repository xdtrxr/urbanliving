# Urban Stays — outstanding work

Last updated: 2026-10-13. Each item has enough context to resume cold.
The numbered items 1 to 6 further down date from 2026-07-29 and have not been re-checked since; rides (Drive), the driver wallet and ride reports have shipped in the meantime.

---

# Built on 2026-10-12 and 13, waiting to go live

Branch `fix/todo-findings`, local, not pushed. It fixes items A, C, D, F, G and H of the list that stood here on 2026-10-12, plus what that work turned up. `npm run check` runs 14 scripts (about 2,000 assertions) and passes. The new screens were opened in a local browser against a stand-in backend. On 2026-10-13 three independent readers reviewed the referral and payment code by running it, with a second reader trying to refute each finding; everything they confirmed is fixed and has a case in the checks. Nothing in the branch has run on the real platform: every backend function still answers 402.

**To go live, in this order**
1. **Set `INTERNAL_FUNCTION_SECRET` on the live app** (Base44 dashboard, Secrets, or `POST /api/apps/{app_id}/secrets` through the connector; any long random value). It is not set today (the list of secret names was read on 2026-10-12). Without it `sendPushNotification`, `requestHostDetails` and `notifyLead` accept calls from anybody, and the two Telegram buttons on a "payment on hold" alert answer "use the Admin screen" instead of working.
2. Merge into `main` and push. When Base44 pulls the push it adds three optional fields to the live database by itself: `AvailabilityRequest.booking_id`, `Booking.payment_extra_refs` and `RideBooking.pay_answered_for`. No rule changes ride on the push.
3. Smoke-test the checkpoint's preview, publish it, run `scripts/check-deploy.sh`.
4. Do the "Not yet tried on the live platform" list below as far as it can be done while functions are blocked (the sign-up test can).

**What changes for the owner**
- **A payment for a stay you have not approved, or that was cancelled, no longer confirms it.** The money is put on hold. You get a Telegram alert with two buttons, and Admin shows a "Payments on hold" card: **Confirm booking** (the guest gets their arrival details) or **Mark refunded** (only after you have sent the money back in Paystack; the app sends none). Approving such a request confirms it with the payment already there. Rejecting it leaves a refund owed and reminds you. The guest is told by email, push and on their bookings page, and cannot pay twice or cancel it away.
- **A referral reward goes to the person on record, once.** It used to be worked out from a code on the guest's own profile, in five places.
- **The vehicle form writes what you chose.** Emptying a box now empties it; a car with no category makes you choose one (the Sprinter says "Guests see it under SUV today"); Powertrain and Fuel policy can be set back to "Not set".
- **Refusals say why.** Every screen shows the server's own sentence instead of "Request failed with status code 409". While the plan block lasts, guests read "This part of the site is not available right now."
- Smaller: a listing with no price says "Price on request"; Nova is told every guest's booked dates, not only the signed-in guest's; your referral figures are real; a ride can be reported again after a change of driver; a ₦0 driver assignment is no longer flagged; "Record pay" from a stale window no longer reassigns the ride.

**Already live since 2026-10-12** (applied to the database directly, with the owner's go-ahead): `User.role` and `User.referred_by_code` can be changed only by an admin or the server.

**Still for the owner from the 2026-10-12 publish:** set each car's powertrain in Admin, Vehicles, and choose the Sprinter's category in the same save.

---

# Needs a decision

## Decision 1: Rides need the same payment hold as stays
**Found 2026-10-12. Not built.** `verifyRidePayment` and the ride branch of `paystackWebhook` confirm a ride whenever the payment is right and the ride is not already paid. They do not look at whether the ride was approved, cancelled or expired, or whether the guest has since been blocked from rides. A guest who pays through Paystack directly for a cancelled ride gets a confirmed one, on a car that may have gone to someone else.
**What exists:** the stay version, to copy. `stayPaymentVerdict`, `holdStayPayment`, the `confirm_held` branch and `markHeldPaymentRefunded` in `base44/functions/`, the screens in `src/config/payments.js`, and `scripts/check-stay-payment.mjs` (80 cases). The payment page already asks the server again before Paystack opens for a ride, which closes the easy way in (a page left open); it cannot stop a payment made outside the page.
**Also in the ride payment path, and to be closed by the same work:** a Paystack transaction whose metadata names no booking is still accepted for a ride (the stay path now refuses one), so one such payment handed in for two rides of the same price at the same moment marks both paid.
**Decision:** whether rides follow the same rule as stays (hold, alert, confirm or refund by hand). That is the recommendation, and about a day of work.

## Decision 2: A referral reward is paid at payment and never taken back
A guest referred by a friend (or by a second account of their own) pays for a stay, the friend's balance gets 5% within seconds, and the stay is then cancelled and refunded. Nothing touches the reward. Choices: take the amount back when an admin cancels a paid stay or ride (recording a shortfall if it was already withdrawn), or hold every reward as pending until check-out.

## Decision 3: May an existing customer enter a referral code?
`attributeReferral` accepts any account at any time, and `ReferralTracker` submits a code from a `?ref=` link silently when the visitor is signed in. So a link sent to people who are already customers earns 5% of each one's next booking, and blocks a genuine referrer from being entered later. The usual rule is "new accounts only": refuse an account that already has a paid stay or ride, and ask before submitting for a signed-in visitor.

## Decision 4: Does a ride count as the "first booking"?
The reward is paid once per referred guest, for the first stay OR ride they pay for. A cheap ride uses up the reward a later stay would have earned. The code has always done this; the wording in the app says "first booking".

---

# Known, and left as it is for now

- **Referral codes are made in the browser** (`src/pages/Dashboard.jsx`) and nothing makes them unique. Since this round a copied code, in any letter case, attributes nobody (`AMBIGUOUS_CODE`), so copying a friend's code can block their link but not take their referrals. The cost of that choice: while a code is copied, every sign-up through the owner's link is lost for good (`ReferralTracker` clears the stored code after one try), and the admin is told only by a line in the function log. The cure: generate the code in a function, with a uniqueness check, then give `referral_code` an admin-only write rule. Not before the dashboard stops writing it: the same `updateMe` call saves `nft_tokens`.
- **The referral balance is a number that is read, then written.** A reward, a withdrawal request and a refund arriving together can overwrite each other. The reward now reads the balance again just before it writes, which narrows this and does not close it. The driver wallet avoids it by adding up rows (`WithdrawalLedger`, `DriverEarning`); the referral wallet would need the same.
- **The payment page and Paystack's webhook for one payment.** In the usual order (the page is still waiting on Paystack when the webhook lands) the page now sees the booking is paid and stops: one admin card, one arrival email, one lot of points. Only at the very same instant do both still run the "paid" steps: the booking is confirmed once and the referral reward paid once (a claim decides), but the admin card and arrival email can arrive twice. A claim row per payment would settle that too.
- **The claims rest on `created_date`.** Two claims are told apart by which the platform stamped first. Nobody has seen how it stamps two rows created in the same millisecond.
- **A referral credit that fails while both payment paths are in flight leaves no record that a reward is owed.** The other path has already stood down. `processReferralReward` (admin-only) can pay it for a stay; it reads `Booking` only, so not for a ride.
- **A webhook payment for the wrong amount is logged and nothing else.** The admin is not told that money arrived. Same for a reference that is already on another booking.
- **A row that another row points at, and that has been deleted, still crashes** in `settleDriverEarning`, the reply handlers of `telegramWebhook`, the ride sweep, `processWithdrawal` and `paystackTransferWebhook`. None of those ids comes from a request. Every function that takes an id from a request now refuses anything but a plain id and answers "not found" for a missing row (`scripts/check-missing-rows.mjs`).
- **Telegram messages sent as Markdown** (the cancellation card, the payment card, the request card) are refused by Telegram outright if a guest's name or email has a stray underscore or asterisk in it. The new payment-on-hold messages are plain text for that reason; the older ones are as they were.
- **Vehicle form:** the fields it always sends (city, active, approved, minimum hours, turnaround, and the three lists) still fall back to the form's default for a row that lacks them. Every row the form has made has them.
- **Search looks at the newest 200 listings** and logs a warning when the cap is hit. Fine at about 30.
- **Search cards show the normal nightly rate.** A seasonal line appears only when dates are picked or a season is running today. By design.
- **The app's own MCP server is not set up** (`GET /api/apps/platform/{app_id}/mcp/config` answers no config, no tools; status inactive). So it grants nothing. `src/pages/OAuthConsent.jsx` still refers to a config file that does not exist.
- **Driver accounts** keep My rides and Wallet above Find a Stay in the menu. Decided 2026-10-12: keep.

---

# Not yet tried on the live platform

Every backend function has answered HTTP 402 ("app owner lacks backend functions capability", the workspace plan) since at least 2026-10-10. None of the code shipped since then has run for real. The day it is unblocked, in one sitting, before any guest books:

1. **Publish again first.** It is not known whether a publish deploys functions while the plan blocks them, and deployed function code cannot be read through the connector. Since 2026-10-12 only the server may create Booking and AvailabilityRequest rows; an older copy of `checkAvailabilityWebhook` would be refused on every request.
2. **One stay request end to end** on a listing with bedroom options and a seasonal rate, dates crossing into the season. Check the total, `bedrooms_booked`, the Telegram card, that the rows are created by the service account, that the request carries `booking_id`, approval, the payment page, the confirmation email.
3. **One payment on hold.** With a test account, request a stay, do NOT approve it, and pay its exact total through Paystack (the payment page will not let you; use a test transaction with `metadata.booking_id` set). Expect: booking not confirmed, a "PAYMENT ON HOLD" Telegram alert with two buttons, the guest email, the card in Admin. Press Confirm booking from Admin, then repeat and press it from Telegram (needs `INTERNAL_FUNCTION_SECRET`). Then one Mark refunded.
4. **One referral.** Sign up through a `?ref=` link, pay for a stay, and check the referrer's balance rises once, by 5%, with one Referral row stamped. This is also the first time the server writes `referral_balance_ngn` and `loyalty_points` since those fields were given admin-only write rules on 2026-10-10: read the balance back. If the platform dropped the write without an error, the row would be stamped and the balance unchanged.
5. With an ordinary account, in the browser console: `base44.entities.Booking.create({...})` must be refused, and so must `base44.auth.updateMe({ role: 'admin' })` and `base44.auth.updateMe({ referred_by_code: 'X' })`. Check what the last two do: refuse the whole call, or drop the field.
6. One ride request, one withdrawal request. Press Process on one withdrawal in two tabs (Paystack must refuse the duplicate reference).
7. The sandbox checklists at the end of each task in `docs/superpowers/plans/2026-10-10-driver-wallet.md`, `2026-10-10-ride-reports.md` and `2026-10-10-review-hardening.md` (now with Task R07).
8. `scripts/check-deploy.sh`. Today its only failures are the 402s.

**Can be tried today, while functions are blocked**
- **One sign-up with a fresh email.** Nobody has signed up since 2026-08-11, and field-level write rules have been on `User` since 2026-10-10 (`role` since 2026-10-12). The platform should set `role` at sign-up by itself; this is the check that it still can. If sign-up fails, clear the rule on `role` with `update_entity_schema` (`"rls": {}` on that property).
- **Set a car's Powertrain to something, save, set it back to "Not set", save.** "Not set" sends `null` to a choice field. Number fields are known to take `null` (the live Sprinter row has some); a choice field has not been tried.

**Not known about the platform, and code leans on it**
- Whether `auth.me()` throws or answers nothing for a caller with no session. Functions written `const user = await auth.me(); if (!user) return 401` answer 500 if it throws.
- Whether a function called by another function (`functions.invoke`) is given the caller's session. The Admin screen's Approve relies on it, or on the secret.
- Whether `entity.filter` honours the sort and skip arguments everywhere they are now passed.

---

# Older items, from 2026-07-29 and not re-checked since

## 1. Verify `dailyBookingReminders` fires
**Effort:** 5 minutes, one-time check
**Why:** The cron was scheduled through the Base44 builder alongside `autoCancelExpiredBookings`. The 5-minute expiry sweep is **verified live** (a stale canary booking got auto-cancelled on the first run), but the daily reminder job hasn't had an observable run yet — it only does anything when a paid booking checks in or out that day.
**How:** On a day with a real check-in, confirm the guest got the "🏠 Check-in today" push, or query the Booking row for a populated `checkin_reminder_pushed_at`.

---

## 2. Nova lead-reply push trigger (deferred)
**Effort:** blocked on a missing feature, not on push infra
**Why:** All other push triggers are wired. This one has nothing to hook into: there is no admin-replies-to-lead flow in the codebase (LeadsAdmin only edits `Lead.status`). When a lead-messaging feature is built, add a `tryPush` call in its send path — the pattern is in any of the wired functions (e.g. `telegramWebhook`'s `postAdminReply`).

---

## 3. Rides — new architecture design (USER, blocks everything below)
**Effort:** design work, user is doing this themselves
**Why:** Stage 1 (Vehicle/Driver/RideBooking entities, /PlanTrip + /Vehicle pages, VehiclesAdmin) shipped, but the user wants to re-architect before Stages 2–3 are built. Do not build on the old flow until the new design lands.

## 4. Rides Stage 2 (blocked on #3)
- `/RideCheckout` page: service_date, start_time, duration_tier, pickup_location → compute `end_at` → create `RideBooking`.
- `checkRideAvailabilityWebhook` Deno function mirroring `checkAvailabilityWebhook` — overlap check per vehicle + Telegram admin approve/reject.
- Bookings page Rides sub-section (Pending / Upcoming / Active / Completed / Cancelled).

## 5. Rides Stage 3 (blocked on #4)
- Paystack ride payment (mirror PaymentPage for RideBooking).
- Admin driver-assignment UI (pick from approved Driver roster → stamp `driver_id` + `driver_assigned_at`).
- Driver contact reveal: only visible to guest when `status === confirmed && paid && driver_id != null`.
- Ride confirmation email; wire "Add a Ride" from property bookings via `linked_property_booking_id`.

## 6. Ride push triggers (blocked on #4/#5)
- Ride approved, ride payment confirmed, driver assigned — one-liner `tryPush` calls in the Stage 2/3 functions.
- Driver arriving soon — hardest: per-booking timing. Simplest approach: extend the 5-min cron to scan confirmed rides with `start_time` within 15 min and push once (idempotency stamp `driver_arrival_push_sent_at` on RideBooking).

---

## Done (shipped + verified, for context)
- **Dark/light mode** — theme infra, toggle on every route (header + floating for bare pages), full page audit incl. pricing-summary fix
- **Mobile/PWA pass** — Admin, Bookings, Payment, Checkout, Leads; Layout `min-w-0`/`overflow-x-hidden` horizontal-scroll fix; safe-area insets everywhere
- **MediaLightbox** — full-bleed portal render (escapes backdrop-blur containing block), swipe, safe-area controls
- **Admin Vehicles** — full CRUD + file-picker media upload
- **Admin Withdrawals tab** — pending payouts list + Process-now (Paystack transfer) + status auto-poll
- **Withdrawals security** — HMAC-verified `paystackTransferWebhook` (success/failed/reversed + refund + `refunded_at` dedup), `processWithdrawal` stays `processing` until webhook confirms, Transfer webhook URL registered on Paystack
- **Push notifications** — VAPID live, `User.push_subscriptions`, sw.js handlers, Profile toggle, save/remove/send functions, 8 inline triggers (payment confirmed, booking approved/declined, payment expired, withdrawal sent/failed, referral earned, support reply) + 3 cron pushes (check-in, check-out, payment-expiring-5min)
- **Crons scheduled via Base44 builder** — `autoCancelExpiredBookings` every 5 min (verified live via canary), `dailyBookingReminders` daily 00:00 UTC
- **Toast fix** — wired to Radix (close button + auto-dismiss now work)
- **PaymentPage** — Badge import fix (white-screen), Stripe removed (Paystack-only)
- **Telegram** — payment-received message now includes guest mobile (profile lookup)
- **Upload errors** — surface real platform message (quota 402) instead of "try again"
- **Base44 plan upgraded (2026-07-29)** — integration quota lifted; UploadFile probe passes the credit gate again, so media uploads, guest emails, and Nova chat are back
