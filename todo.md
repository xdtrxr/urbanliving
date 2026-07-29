# Urban Stays — outstanding work

Last updated: 2026-07-29. Sorted easiest → hardest. Each item has enough context to resume cold.

---

## 1. Upgrade the Base44 plan (integration credits exhausted)
**Effort:** 5 minutes, user-only (no code)
**Why:** The account hit its monthly integration-credits quota. Every `UploadFile` (property/vehicle media, guest IDs, profile pictures) returns HTTP 402 `integration_credits_limit_reached` — and `SendEmail` (arrival/expiry emails) plus Nova's `InvokeLLM` draw from the same pool, so guest emails and AI chat are likely failing too. Bookings/payments/push/Telegram are unaffected.
**How:** Base44 dashboard → Workspace → Billing/Usage → upgrade. Quick health check for the quota:
`curl -sS -X POST -F "file=@/dev/null;filename=x.jpg" https://base44.app/api/apps/69f75159e3beeee0837b5b60/integration-endpoints/Core/UploadFile` — 402 = still exhausted, 401 = healthy again.

---

## 2. Verify `dailyBookingReminders` fires
**Effort:** 5 minutes, one-time check
**Why:** The cron was scheduled through the Base44 builder alongside `autoCancelExpiredBookings`. The 5-minute expiry sweep is **verified live** (a stale canary booking got auto-cancelled on the first run), but the daily reminder job hasn't had an observable run yet — it only does anything when a paid booking checks in or out that day.
**How:** On a day with a real check-in, confirm the guest got the "🏠 Check-in today" push, or query the Booking row for a populated `checkin_reminder_pushed_at`.

---

## 3. Nova lead-reply push trigger (deferred)
**Effort:** blocked on a missing feature, not on push infra
**Why:** All other push triggers are wired. This one has nothing to hook into: there is no admin-replies-to-lead flow in the codebase (LeadsAdmin only edits `Lead.status`). When a lead-messaging feature is built, add a `tryPush` call in its send path — the pattern is in any of the wired functions (e.g. `telegramWebhook`'s `postAdminReply`).

---

## 4. Rides — new architecture design (USER, blocks everything below)
**Effort:** design work, user is doing this themselves
**Why:** Stage 1 (Vehicle/Driver/RideBooking entities, /PlanTrip + /Vehicle pages, VehiclesAdmin) shipped, but the user wants to re-architect before Stages 2–3 are built. Do not build on the old flow until the new design lands.

## 5. Rides Stage 2 (blocked on #4)
- `/RideCheckout` page: service_date, start_time, duration_tier, pickup_location → compute `end_at` → create `RideBooking`.
- `checkRideAvailabilityWebhook` Deno function mirroring `checkAvailabilityWebhook` — overlap check per vehicle + Telegram admin approve/reject.
- Bookings page Rides sub-section (Pending / Upcoming / Active / Completed / Cancelled).

## 6. Rides Stage 3 (blocked on #5)
- Paystack ride payment (mirror PaymentPage for RideBooking).
- Admin driver-assignment UI (pick from approved Driver roster → stamp `driver_id` + `driver_assigned_at`).
- Driver contact reveal: only visible to guest when `status === confirmed && paid && driver_id != null`.
- Ride confirmation email; wire "Add a Ride" from property bookings via `linked_property_booking_id`.

## 7. Ride push triggers (blocked on #5/#6)
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
