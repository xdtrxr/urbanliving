# Urban Stays — outstanding work

Sorted easiest → hardest. Each item has enough context to resume cold.

---

## 1. Register `paystackTransferWebhook` URL in Paystack Dashboard
**Effort:** 2 minutes, user-only (no code)
**Why:** The webhook function is deployed, but until Paystack knows the URL it'll never POST `transfer.success` / `transfer.failed` events, so `WithdrawalRequest` rows will sit in `processing` forever after the next payout.
**How:** Paystack Dashboard → Settings → API Keys & Webhooks → **Transfer webhook URL** → `https://urbanstays.io/api/functions/paystackTransferWebhook`. The existing charge webhook at `/api/functions/paystackWebhook` is independent and keeps working.

---

## 2. Dark-mode stragglers
**Effort:** ~30 min, single PR
**Why:** The shell + 5 high-traffic pages have dark variants, but several content components still use hardcoded `bg-emerald-50`, `bg-amber-50`, `text-emerald-900` (mostly in arrival-details cards, success/error inline banners, lead status badges). They render fine but feel pasted-on in dark mode.
**How:** `grep -rn 'bg-emerald-50\|bg-amber-50\|bg-red-50\|bg-blue-50' src/` and add `dark:bg-*-950/40 dark:text-*-200 dark:border-*-800` variants where missing. Check Bookings arrival cards, PendingApprovalCard admin response box, ConfirmedBookingsAdmin badges.

---

## 3. PWA push notifications — one-time scaffolding
**Effort:** ~1–2 hrs
**Pieces:**
- Generate a VAPID key pair locally (`npx web-push generate-vapid-keys`); set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in Base44 env.
- Add `push_subscriptions: { type: 'array', items: { type: 'object' } }` to the `User` entity schema. Use service-role writes only — never let a user write someone else's subscription.
- Extend `public/sw.js` (currently a no-op pass-through) with `push` and `notificationclick` event handlers. On `notificationclick`, focus the existing PWA window if open or open the deep-link URL from the payload.

---

## 4. PWA push UI: enable-notifications toggle
**Effort:** ~30 min, depends on #3
**How:** Add a switch on `Profile.jsx` that calls `Notification.requestPermission()`, then `navigator.serviceWorker.ready` → `subscription = pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })`, then POSTs the subscription JSON to a new Deno function `savePushSubscription` that appends to `User.push_subscriptions`. Off-toggle calls `subscription.unsubscribe()` + removes the row.

---

## 5. `sendPushNotification` Deno helper
**Effort:** ~20 min, depends on #3
**How:** New `base44/functions/sendPushNotification/entry.ts` that takes `{ user_email, title, body, url }`, loads the user's `push_subscriptions`, and POSTs to each subscription endpoint with the standard Web Push protocol (HMAC-signed VAPID JWT). Use the `npm:web-push` package. Prune subscriptions that return 404/410. Returns `{ sent, pruned }`.

---

## 6–14. Nine "easy" push triggers
**Effort:** ~5 min each, depends on #5
Each is one-liner injection at the success path of an existing function — call `sendPushNotification` with the right copy. Order them by how often you'd want the user pinged:

| # | Trigger | Fire from |
|---|---|---|
| 6 | Payment confirmed | `verifyPaystackPayment` + `paystackWebhook` success branches |
| 7 | Booking approved | Telegram admin callback (approve) |
| 8 | Booking declined | Telegram admin callback (reject) |
| 9 | Payment expired | `autoCancelExpiredBookings` cron when a row flips cancelled |
| 10 | Withdrawal sent | `paystackTransferWebhook` `transfer.success` branch |
| 11 | Withdrawal failed | `paystackTransferWebhook` `transfer.failed` / `transfer.reversed` |
| 12 | Referral earned | inline referral-reward block in `paystackWebhook` |
| 13 | Support reply | `replyToSupportTicket` success path |
| 14 | Nova lead reply | New trigger when admin replies to a captured lead |

---

## 15–17. Three cron-based triggers
**Effort:** ~30 min each, harder than the inline ones because they need new scheduled jobs.
- **Check-in day reminder** — new daily Deno cron, scans `Booking` for rows where `check_in === today`, sends "Welcome to <property> — host: <phone>" push.
- **Check-out day reminder** — same cron, second pass for `check_out === today`, sends "Check-out by 12:00 PM" push.
- **Payment expiring 5 min** — extend `autoCancelExpiredBookings` (or a separate scheduler) to push at deadline minus 5 min when `status === pending && payment_status === unpaid`.

---

## 18. Rides Stage 2
**Effort:** ~half-day
**Pieces:**
- New `/RideCheckout` page — gathers `service_date`, `start_time`, `duration_tier`, `pickup_location`; calculates `end_at`; creates `RideBooking` row.
- `checkRideAvailabilityWebhook` Deno function mirroring `checkAvailabilityWebhook` — sends Telegram admin alert with approve/reject buttons. Includes overlap check against existing `RideBooking` rows for the same `vehicle_id`.
- Bookings page Rides sub-section (Pending / Upcoming / Active / Completed / Cancelled).

---

## 19. Rides Stage 3
**Effort:** ~half-day, depends on #18
**Pieces:**
- Paystack ride payment flow (mirror `PaymentPage` for `RideBooking`).
- Admin driver-assignment UI on the confirmed ride — picks a `Driver` from the approved roster, stamps `driver_id` + `driver_assigned_at` onto the `RideBooking`.
- **Driver contact reveal**: only show driver name/phone/photo to the guest once `status === confirmed && driver_id != null`.
- Ride confirmation email mirroring the property arrival email.
- Wire "Add a Ride" button in Bookings.jsx to the new `/RideCheckout?property_booking_id=...` flow.

---

## 20–22. Three Rides push triggers
**Effort:** ~5 min each, depends on #19 + push infra (#3–#5).
- **Ride approved** — `checkRideAvailabilityWebhook` approve path.
- **Ride payment confirmed** — Paystack ride payment success path.
- **Driver assigned** — admin assignment UI success path. Title: "Your driver is set — <name> · <plate>".

---

## 23. Driver-arriving-soon push (hardest)
**Effort:** ~2 hrs
**Why hardest:** per-booking scheduled job — needs to fire at `start_time − 15 min` for each individual confirmed ride. Simplest implementation is a frequent (every 5 min) cron that scans for rides whose start window is approaching and pushes once (idempotent via a `driver_arrival_push_sent_at` field on `RideBooking`).

---

## Done (this session, for context)
- Dark / light mode infrastructure + toggle on every route (incl. Landing / Install / Login via FloatingThemeToggle)
- MediaLightbox: full-bleed image + portal to escape ancestor backdrop-blur containing block
- Admin Vehicles: file-picker upload for photos + videos (replaced URL textareas)
- Bookings page mobile pass + project-wide dedupe of duplicate `dark:` variants
- Layout: `min-w-0` + `overflow-x-hidden` fix for horizontal-scroll bug
- Admin tabs spacing on mobile (2-row wrap no longer crashes into panel)
- Withdrawals security pass: HMAC-verified `paystackTransferWebhook`, `processWithdrawal` no longer prematurely marks `completed`, `refunded_at` dedup field, brand string fix (LuxeLiving → UrbanStays), `alert()` → toast in Withdrawals UI
