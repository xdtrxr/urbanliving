# Urban Stays — outstanding work

Last updated: 2026-10-23. Each item has enough context to resume cold.
The numbered items 1 to 6 further down date from 2026-07-29 and have not been re-checked since; rides (Drive), the driver wallet and ride reports have shipped in the meantime.

---

# Live since 2026-10-23

Published on 2026-10-23 at 17:25 WAT on the owner's "make it live": commit `f4d423d` (the merge of `fix/finish-line`, with Base44's own package bump from `40b240e` merged in), checkpoint `6adb89df6304811fa2418031`. The preview and the live site passed `scripts/check-deploy.sh` 89 of 89, and the entity changes below were read back live. Built on the owner's "lets finish and complete this project" (2026-10-23), with the four decisions below taken as recommended. `npm run check` runs 17 scripts (about 2,350 assertions) and passes; the build passes; the changed screens pass the linter. Not yet opened in a browser.

**Backend functions run again.** They were blocked (HTTP 402) from at least 2026-10-10 until between 10-17 and 10-21. On 2026-10-23 `scripts/check-deploy.sh` passed 82 of 82, and real guests made eight stay requests that morning (all approved, none paid: six never opened the payment page, two opened it and stopped). Uploads work again too.

**What it does**
- **Rides are held like stays.** A ride payment that may not confirm its ride (never approved, cancelled, expired, the guest blocked from rides since, or the price changed while paying) is held: Telegram alert with Confirm ride / Mark refunded, the "Payments on hold" card, guest email and screens. Approving a held ride confirms it with the money; declining leaves a refund owed. A payment must name its ride. Held rides keep their car's window and are never released by the sweep. `scripts/check-ride-payment.mjs` (69 cases).
- **A referral reward is taken back** when an admin cancels a paid stay or ride; what the referrer already withdrew is a shortfall, told to the admin, and the guest's one reward then stays used. `scripts/check-referral-clawback.mjs`.
- **Referral codes are for new accounts**: an account with a paid, held or refunded booking is refused (`EXISTING_CUSTOMER`), and a visitor already signed in is asked before a link's code is applied.
- **Manage users**: a Users tab for admins (list, change role, invite by email) through the new function `manageUsers`, and a new role, **Listings helper**: may add and edit properties and vehicles and nothing else (no bookings, payments, payouts or users; no delete; no vehicle costing). Only an admin may approve a vehicle, so a helper's new car waits for an admin. Nobody can change their own role or remove the last admin. `scripts/check-manage-users.mjs`.
- **"Delete ALL properties" is gone.**
- **A signed-out caller is refused, not answered with a 500**, in all 47 functions that ask who is calling (the platform's `auth.me()` throws when there is no session).

**What going live did**
1. Merged and pushed. The pull applied these entity changes by itself: `RideBooking.payment_status` gains `pending_confirmation`, `RideBooking.payment_extra_refs` (new), `User.role` gains `listing_helper`, Property and Vehicle create/update allow `listing_helper`, and `Vehicle.admin_approved` becomes admin-only to write. None of them is stricter for anything the live client does today (only admins write vehicles now).
2. **The pull also deployed the function code**, before the publish: the new `manageUsers` answered on the live backend while the old screens were still published. So server and screens are out of step for the minutes between pull and publish; publish straight after the pull.
3. **Still to do: one real payment of each kind** (see "Not yet tried on the live platform").

---

# From the client's WhatsApp chat (read 2026-10-23)

The export `WhatsApp Chat - Nonso Anenechukwu (Hakeem)/` (13 April to 19 October; kept out of git by `.git/info/exclude`) was read in full with both PDFs: 118 asks. Nearly all are built. What is not, or needs an answer:
- **The admin cannot answer a guest's special request before approving** (18/05: "Is there a complimentary meal?"). Rides have a note on approval; stays do not. Small to build.
- **Crypto (stablecoin) payments** (10/05). Not built; called out of scope then, never raised again.
- **Push notifications on by default** (13/06, 27/06). Browsers need the user's permission; the app asks only from the Profile card. A prompt on first sign-in is the most that can be done.
- **Payment window**: the 22/04 brief says 30 minutes; the app gives 1 hour from opening the payment page (3 hours at most from approval). The client saw "pay within 1 hour" on 27/06 and did not object.
- **Paystack on the HOMESHARES business account** (asked 14/08, 15/08, 17/08, 12/09, 28/09, 13/10): no confirmation in the chat. The secret names are set; which account they belong to cannot be read.
- **Rotate the keys that were sent in the chat**: live Paystack keys and the Telegram bot token were posted in plain text (08/05, 14/08, 12/09). Rotate them in Paystack and BotFather and set the new values as secrets.
- **Where the 5% referral reward comes from** (02/06, "very important questions"): a business answer, not code.
- 43 voice notes sit inside feature discussions and could not be listened to here.

---

# Live since 2026-10-13

Published on 2026-10-13 at 22:16 WAT, on the owner's "make it live": commit `bc8bfb6` (the merge of branch `fix/todo-findings`, `0fd9e2d`, with Base44's own "Update base44 packages" commit on top), checkpoint `6ace9f76b094f901a1099c66`. It fixes items A, C, D, F, G and H of the list that stood here on 2026-10-12, plus what that work turned up. `npm run check` runs 14 scripts (about 2,000 assertions) and passes. The new screens were opened in a local browser against a stand-in backend. On 2026-10-13 three independent readers reviewed the referral and payment code by running it, with a second reader trying to refute each finding; everything they confirmed is fixed and has a case in the checks.

**None of the function code in it has run on the real platform.** Every backend function still answers 402 (see "Not yet tried on the live platform"). What is live and working today is the client: the screens, the wording, the vehicle form.

**Done at the publish**
- `INTERNAL_FUNCTION_SECRET` is set on the live app (a long random value, set through the connector; the value is written down nowhere). Until then `sendPushNotification`, `requestHostDetails` and `notifyLead` accepted calls from anybody, and the two Telegram buttons on a "payment on hold" alert would have answered "use the Admin screen". Nothing outside the functions sends it: the two schedules do not (those functions check for an admin session instead), and Telegram and Paystack have secrets of their own. If it is ever needed by hand, set a new one in the dashboard. The platform says that setting a secret redeploys the functions; whether it did, under the plan block, cannot be read.
- Base44's pull of the push added three optional fields to the live database by itself: `AvailabilityRequest.booking_id`, `Booking.payment_extra_refs` and `RideBooking.pay_answered_for`. Read back after the pull; every other field and rule is as it was. No rule changes rode on the push.
- Checked after publishing: the preview and the live site serve the same bundle as a local build of the commit; `scripts/check-deploy.sh` has 56 passes and 26 failures, all 26 the 402; search, a listing, the ride page and the FAQ opened signed out with nothing in the console but the signed-out 401.

**Still to do**
- The owner: one sign-up with a fresh email (see "Can be tried today" below). It was promised as part of this go-live.
- The rest of "Not yet tried on the live platform", the day functions are unblocked.

**What changes for the owner**
- **A payment for a stay you have not approved, or that was cancelled, no longer confirms it.** The money is put on hold. You get a Telegram alert with two buttons, and Admin shows a "Payments on hold" card: **Confirm booking** (the guest gets their arrival details) or **Mark refunded** (only after you have sent the money back in Paystack; the app sends none). Approving such a request confirms it with the payment already there. Rejecting it leaves a refund owed and reminds you. The guest is told by email, push and on their bookings page, and cannot pay twice or cancel it away.
- **A referral reward goes to the person on record, once.** It used to be worked out from a code on the guest's own profile, in five places.
- **The vehicle form writes what you chose.** Emptying a box now empties it; a car with no category makes you choose one (the Sprinter says "Guests see it under SUV today"); Powertrain and Fuel policy can be set back to "Not set".
- **Refusals say why.** Every screen shows the server's own sentence instead of "Request failed with status code 409". While the plan block lasts, guests read "This part of the site is not available right now."
- Smaller: a listing with no price says "Price on request"; Nova is told every guest's booked dates, not only the signed-in guest's; your referral figures are real; a ride can be reported again after a change of driver; a ₦0 driver assignment is no longer flagged; "Record pay" from a stale window no longer reassigns the ride.

**Already live since 2026-10-12** (applied to the database directly, with the owner's go-ahead): `User.role` and `User.referred_by_code` can be changed only by an admin or the server.

**Still for the owner from the 2026-10-12 publish:** set each car's powertrain in Admin, Vehicles, and choose the Sprinter's category in the same save.

---

# Decided on 2026-10-23 (the recommendations), built on fix/finish-line

## Decision 1: Rides need the same payment hold as stays. DECIDED yes, BUILT
**Found 2026-10-12. Not built.** `verifyRidePayment` and the ride branch of `paystackWebhook` confirm a ride whenever the payment is right and the ride is not already paid. They do not look at whether the ride was approved, cancelled or expired, or whether the guest has since been blocked from rides. A guest who pays through Paystack directly for a cancelled ride gets a confirmed one, on a car that may have gone to someone else.
**What exists:** the stay version, to copy. `stayPaymentVerdict`, `holdStayPayment`, the `confirm_held` branch and `markHeldPaymentRefunded` in `base44/functions/`, the screens in `src/config/payments.js`, and `scripts/check-stay-payment.mjs` (102 cases). The payment page already asks the server again before Paystack opens for a ride, which closes the easy way in (a page left open); it cannot stop a payment made outside the page.
**Also in the ride payment path, and to be closed by the same work:** a Paystack transaction whose metadata names no booking is still accepted for a ride (the stay path now refuses one), so one such payment handed in for two rides of the same price at the same moment marks both paid.
**Decision:** whether rides follow the same rule as stays (hold, alert, confirm or refund by hand). That is the recommendation, and about a day of work.

## Decision 2: A referral reward is paid at payment and never taken back. DECIDED: taken back when an admin cancels a paid booking, BUILT
A guest referred by a friend (or by a second account of their own) pays for a stay, the friend's balance gets 5% within seconds, and the stay is then cancelled and refunded. Nothing touches the reward. Choices: take the amount back when an admin cancels a paid stay or ride (recording a shortfall if it was already withdrawn), or hold every reward as pending until check-out.

## Decision 3: May an existing customer enter a referral code? DECIDED no (new accounts only), BUILT
`attributeReferral` accepts any account at any time, and `ReferralTracker` submits a code from a `?ref=` link silently when the visitor is signed in. So a link sent to people who are already customers earns 5% of each one's next booking, and blocks a genuine referrer from being entered later. The usual rule is "new accounts only": refuse an account that already has a paid stay or ride, and ask before submitting for a signed-in visitor.

## Decision 4: Does a ride count as the "first booking"? DECIDED: left as it is (yes)
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
3. **One payment on hold.** With a test account, request a stay, do NOT approve it, and pay its exact total through Paystack (the payment page will not let you; use a test transaction with `metadata.booking_id` set). Expect: booking not confirmed, a "PAYMENT ON HOLD" Telegram alert with two buttons, the guest email, the card in Admin. Press Confirm booking from Admin, then repeat and press it from Telegram (it needs `INTERNAL_FUNCTION_SECRET`, set since 2026-10-13). Then one Mark refunded.
4. **One referral.** Sign up through a `?ref=` link, pay for a stay, and check the referrer's balance rises once, by 5%, with one Referral row stamped. This is also the first time the server writes `referral_balance_ngn` and `loyalty_points` since those fields were given admin-only write rules on 2026-10-10: read the balance back. If the platform dropped the write without an error, the row would be stamped and the balance unchanged.
5. With an ordinary account, in the browser console: `base44.entities.Booking.create({...})` must be refused, and so must `base44.auth.updateMe({ role: 'admin' })` and `base44.auth.updateMe({ referred_by_code: 'X' })`. Check what the last two do: refuse the whole call, or drop the field.
6. One ride request, one withdrawal request. Press Process on one withdrawal in two tabs (Paystack must refuse the duplicate reference).
7. The sandbox checklists at the end of each task in `docs/superpowers/plans/2026-10-10-driver-wallet.md`, `2026-10-10-ride-reports.md` and `2026-10-10-review-hardening.md` (now with Task R07).
8. `scripts/check-deploy.sh`. Today its only failures are the 402s (26 of them on 2026-10-13, one per function it asks).

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
