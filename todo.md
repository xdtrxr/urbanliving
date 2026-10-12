# Urban Stays — outstanding work

Last updated: 2026-10-12, after the evening publish (sections A to H added that day). Each item has enough context to resume cold.
The numbered items 1 to 6 further down date from 2026-07-29 and have not been re-checked since; rides (Drive), the driver wallet and ride reports have shipped in the meantime.

---

# Went live 2026-10-12, and what it leaves to do

The new menu (Find a Stay and Cars & Chauffeurs first, then the owner's order), the vehicle powertrain field with the Electric badge, and the referral reward fix were published on 2026-10-12 at 19:19 WAT: commit `9bedb30`, Base44 checkpoint `6acd245f5c77fde8dc22d4d0`. `scripts/check-deploy.sh` afterwards: 45 passed, 23 failed, and all 23 are the 402 block in item B. The `powertrain` field reached the live database when Base44 pulled the push, before the publish; no `update_entity_schema` call was needed.

- **Set each car's powertrain** in Admin, Vehicles. Only a car marked Electric shows a badge; a car with nothing set looks exactly as it did.
- **Choose the Sprinter's category on purpose in that same save.** "Sprinter bus Short" in Abuja has no category. It is a van from before the five price tiers and is shown under SUV by a fallback in `src/config/rides.js`. The edit form fills an empty category with "Comfort / Sedan" and always saves it, so pressing Update without looking moves the bus out of SUV. There is no van or minibus tier to give it. See item H.
- **Not decided: driver accounts.** They still see My rides and Wallet above Find a Stay. The owner's list did not cover drivers, so this was left as it was.
- Buttons elsewhere that lead to the stay search keep their own wording (Browse properties, Explore Properties, New Search, Back to Search). Only the menu, the FAQ answer and the two empty-tab buttons on My Bookings say Find a Stay.

---

# Found 2026-10-11 and 2026-10-12: booking options launch and the security sweep

Booking options and seasonal pricing went live on 2026-10-11 (commit `ef08d97`). On 2026-10-12 `create` on Booking and AvailabilityRequest was made server-only on the live database. Everything below was found while doing those two things and is NOT done. Sorted by urgency.

## A. A referral reward can be paid more than once for one stay (close before functions return)
**Effort:** half a day with a check script; one live rule change needs the owner's go-ahead
**Done 2026-10-12:** the first hole here, a reward on a booking that was never paid, is fixed and published (commit `76b1f1e`, live in `9bedb30`; `scripts/check-referral-reward.mjs` runs the real function through 11 cases).
**Why:** `processReferralReward` takes the referrer from `referred_by_code` on the guest's own profile, and its only-once guard looks at the one Referral row for that referrer and that guest (`base44/functions/processReferralReward/entry.ts:62` to `:86`). Nothing asks whether another Referral row already carries the booking, and nothing stops the referrer being the guest (`attributeReferral` has `SELF_REFERRAL`; this function does not). `referred_by_code` has no write rule in `base44/entities/User.jsonc`, so a guest can probably change it with `base44.auth.updateMe` from the browser console. That last link is untested on the platform, like item D. A guest with one stay they really paid for could then call the function once per code, their own included, and 5% of the stay is credited each time. The pre-publish review ran the shipped function in memory: one paid stay of ₦1,198,000 credited ₦59,900 four times.
**Limits:** not reachable today (every function answers 402). Nothing in `src/` calls this function; `verifyPaystackPayment` and `paystackWebhook` pay the reward themselves, once per payment. An admin still presses Process on every withdrawal.
**How:** in `processReferralReward`, refuse when any Referral row already has this `booking_id`, refuse when the referrer is the guest, and take the referrer from the guest's existing Referral row instead of the profile field. Add both cases to `scripts/check-referral-reward.mjs`. Then, with the owner's go-ahead, give `referred_by_code` an admin-only write rule on the live User schema (first confirm how `attributeReferral` writes it) and pin it in `scripts/check-entities.mjs`. Ask first whether the function is needed at all: if nothing calls it, deleting it closes the hole.

## B. The day backend functions are unblocked
**Effort:** an hour, in one sitting, before any guest books
**Why:** every backend function on the live site has answered HTTP 402 ("app owner lacks backend functions capability", the workspace plan) since at least 2026-10-10. No booking request, payment, withdrawal, push or Telegram message works until the plan is fixed. That also means none of the code shipped since then has ever run on the real platform.
**How, in this order:**
1. **Publish again first.** It is not known whether a publish deploys functions while the plan blocks them, and the connector cannot read deployed function code (`GET .../backend-functions` comes back truncated). Since 2026-10-12 only the server may create Booking and AvailabilityRequest rows. An older copy of `checkAvailabilityWebhook` creates them as the guest and would be refused on every request. The publish of 2026-10-12 (`9bedb30`) carried the server-side creation and the referral fix, but whether its functions were deployed cannot be read while the block lasts, so this step stands.
2. Make one real booking request end to end on a listing with bedroom options and a seasonal rate, with dates that cross into the season. Check: the total matches the checkout breakdown, `bedrooms_booked` is set, the Telegram card names the option, the new rows' `created_by` is the service account, approval works, the payment page restates the stay, the confirmation email names the option.
3. With an ordinary (non-admin) account, try `base44.entities.Booking.create({...})` in the browser console. It must be refused. The rule reads back correctly but has never been tried by a real guest account.
4. The same three rules applied on 2026-10-10 (RideBooking, WithdrawalRequest, LoyaltyTransaction: server-only create) have never been exercised live either. Make one ride request and one withdrawal request.
5. Run the sandbox checklists at the end of each task in `docs/superpowers/plans/2026-10-10-driver-wallet.md`, `2026-10-10-ride-reports.md` and `2026-10-10-review-hardening.md`. First: press Process on one withdrawal in two tabs, to prove Paystack refuses a duplicate transfer reference.
6. Run `scripts/check-deploy.sh`. Today it reports 23 failures, all of them the 402.

## C. A payment can confirm a booking the admin never approved (needs a decision)
**Effort:** small code change once decided
**Why:** `verifyPaystackPayment` and `paystackWebhook` confirm a booking when a payment arrives with the right reference, metadata, amount and currency. Neither looks at `approved_at`, or at whether the booking was cancelled or expired. Only `startStayPayment` checks approval (line 57), and that is a page-load step a guest can skip. A guest who pays the true total straight through Paystack, with metadata naming their booking, gets a confirmed booking on a request that was never approved, or on one already cancelled whose dates may have gone to someone else. The full price is paid, so it is not a pricing hole. It bypasses the availability decision, which is what stops double bookings.
**Decision needed:** what happens to money that arrives for an unapproved or cancelled booking. Either hold it (`payment_status: 'pending_confirmation'` already exists in the schema) and alert the admin to approve or refund, or refund automatically.
**Then:** add the check to both functions and a `scripts/check-*.mjs` on `scripts/lib/function-rig.mjs` that runs them.

## D. Can a user make themselves admin? (untested)
**Effort:** 5 minutes to test
**Why:** every admin-only rule in the app (bookings, rides, withdrawals, loyalty, properties) assumes Base44 itself refuses a change to `role` through `auth.updateMe`. In the User schema `role` is an ordinary field with no write rule, unlike `loyalty_points`, `loyalty_tier`, `referral_balance_ngn` and `ride_blocked`, which each have an admin-only write rule. Nobody has tested it.
**How:** sign in as an ordinary test account, run `await base44.auth.updateMe({ role: 'admin' })` in the console, then `await base44.auth.me()`. If the role changed, add `"rls": { "write": { "user_condition": { "role": "admin" } } }` to `role` with `update_entity_schema` straight away and pin it in `scripts/check-entities.mjs` beside the other four.

## E. The review of the final booking-options code was cut short
**Effort:** one review run
**Why:** the first review (seven readers) reported in full and everything it found was fixed, but the session limit stopped most of its skeptic checks and its gap critic. A second review, of the fixed code, returned nothing for the same reason. The last batch of changes (strict dates on the server, the chat card waiting for the listing to load, option row ids in the admin form, the option named in emails and on the payment page, search dates carried to checkout) was verified only by the check scripts and a local test rig, not by an independent reader.
**How:** review `git diff 7788b45..76b1f1e` by area: pricing (both copies), the `checkAvailabilityWebhook` handler, checkout / property page / chat booking card, search and listing cards, the admin property form.

## F. Smaller things found and left alone
- **Approval finds the booking by matching, not by id.** `decideAvailabilityRequest/entry.ts:149` and `telegramWebhook/entry.ts:185` stamp the first pending Booking with the same property, dates and email. Store the booking id on the AvailabilityRequest when both are created and use it.
- **The chat assistant only knows the guest's own bookings.** `AIChatConcierge.jsx:336` reads Booking as the signed-in guest, and the read rule hides everyone else's rows, so the "booked ranges" Nova is given are incomplete and it can recommend a property that is taken. Needs a server function that returns booked date ranges without guest details.
- **Referral statistics always show 0 booked.** `getReferralStatistics/entry.ts:51` reads the referred friend's Booking as the referrer, which the read rule refuses (the error is swallowed). Read it with the service role after checking the referral belongs to the caller.
- **35 older screens still show "Request failed with status code ..." when the server refuses.** They call `base44.functions.invoke` directly. Checkout and the chat booking card were moved to `invokeFn` (`src/lib/invokeFn.js`), which shows the server's own sentence; the rest were not. `grep -rn "base44.functions.invoke(" src`.
- **Search looks at the newest 200 listings** (`propertyService.jsx:327`). Fine at about 30 listings; it logs a warning when the cap is hit.
- **Checkout's approval poll swallows errors** (console only). If the request row ever became unreadable the guest would sit on "pending" with no message.
- **`scripts/check-entities.mjs` only sees one spelling of a guest-side create** (`.entities.<Name>.create(`). Bracket access, a stored handle, or a `.ts` file under `src/` would slip past. None exists today.
- **The app's MCP server settings are not in the repo.** `src/pages/OAuthConsent.jsx` refers to `base44/mcp/config.json`, which does not exist here, so nobody has looked at which entity tools it grants.
- **A listing with no price shows "₦0 per night" and a Book Now button.** The server refuses the request (`NO_PRICE`). The schema requires a price, so this needs bad data to appear.
- **Two unused pricing helpers are still exported and tested:** `estimateStayPrice` in `src/config/stays.js` and `priceForStay` in `checkAvailabilityWebhook`. Remove both together when convenient.
- **Search cards show the normal nightly rate.** A seasonal line appears only when dates are picked on the search page or a season is running today.

## H. Admin vehicle form: older quirks (found reviewing the powertrain change, 2026-10-12)
None of these was caused by the powertrain work and none was touched. All are in `src/components/admin/VehiclesAdmin.jsx`, in the edit loader and `handleSubmit`.
- **Blanking an optional field on an edit is not saved.** A cleared field is sent as `undefined`, which is dropped from the request, and an update only changes the fields it is sent. So clearing the hourly rate, the extra-hour rate, the extra-day rate, the fuel cap, the description, the plate or the service area leaves the old value in place. Example: clear "Hourly rate" on a car to make it day-hire only, save, and guests still see hourly options. Fix: on an edit send an explicit empty value (`null`, as `model_year` already does, after one live write confirms Base44 accepts it; or `''` and `0`).
- **Editing a car that has no fuel policy quietly gives it "Fuel included".** The edit loader fills a missing `fuel_policy` with `fuel_included` and the save always sends it. Every car made through the form already has a policy (the one live car does), so this needs a row created some other way. Fix: load a missing policy as "Not set" and send it only when chosen, as the powertrain field does.
- **A powertrain cannot be set back to "Not set"** once one is picked; it can only be changed to another of the four. Deliberate for now. If it matters, add a "Not set" entry that sends `null`.
- **Editing a car that has no category files it under "Comfort / Sedan".** The edit loader fills a missing `category` with `comfort` (`startEdit`, line 202) and the save always sends it (line 248). The one live car, the Sprinter bus, is such a row: it shows under SUV through the fallback in `src/config/rides.js`, and the first save that does not choose a category moves it to Comfort / Sedan and removes its "Set a category" badge. Fix: pre-fill with `effectiveCategory(vehicle)` so a save leaves the car where guests see it today, or load it as unset and make the admin choose.

## G. Still open from the driver wallet review (2026-10-10)
Lower severity, never scheduled. Detail is in the review notes of that session, not in this repo, so each needs re-reading in the code before fixing.
- Record pay cannot be reached for a driver who is inactive or in another city.
- Record pay from a stale dialog can reassign the ride.
- A ₦0 assignment shows "No pay recorded" for a week.
- A guest cannot report the driver who took over a ride.
- The inbox badge "Holding the driver's pay" stays after a handover.
- A blocked guest who already has the payment page open can still pay.
- `docs/superpowers/plans/2026-10-10-review-hardening.md` and the wallet spec were not updated for commit `ef34f98`.
- `getOrNull` (a missing row answers 404, not a crash) is used in `processWithdrawal` and `checkAvailabilityWebhook` only.

---

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
