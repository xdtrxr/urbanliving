# Entity rules waiting for the next Publish

These schema files are the **intended** access rules for the entities in the
table below. They are kept outside `base44/` entirely because a
Base44 checkpoint applies whatever is in that folder to the live database
within minutes to hours, while the client bundle and the functions only ship
when someone presses **Publish** in the Base44 dashboard. On 2026-09-09 the
admin-only Booking update rule went live under the old client and would have
blocked guests from cancelling a stay or uploading their ID after paying, so
it was reverted through the MCP and parked here.

What each one tightens, and which shipped code makes it safe:

| File | Rule | Needs (in the next publish) |
|---|---|---|
| `Booking.jsonc` | `update` admin-only | `cancelBooking`, `startStayPayment`, `submitBookingId` functions and the client that calls them (Bookings, PaymentPage, IdUploadGate) |
| `LoyaltyTransaction.jsonc` | `create` admin-only | `awardPoints` function and the client that calls it (loyaltyService, Dashboard, Quests, AIChatConcierge) |
| `User.jsonc` | field-level `write` admin-only on `loyalty_points` and `loyalty_tier` | same as above |
| `WithdrawalRequest.jsonc` | `create` admin-only | `createWithdrawalRequest` from the driver wallet work (2026-10), which creates the row under the service role. Until this rule is live a signed-in user can create a pending withdrawal row by hand; driver-wallet rows are re-checked against the ledger by `processWithdrawal`, referral rows are not |

| `RideBooking.jsonc` | `create` admin-only | `checkRideAvailability` from the review hardening (2026-10), which creates the row under the service role. Until this rule is live a signed-in user can create a ride row by hand with any status on it, including confirmed and paid: a free ride, and a job a driver would be paid for |

`scripts/check-entities.mjs` checks the "Needs" column for every file here
whose rule is `create` admin-only: it fails if any function creates that
entity as the caller, or if the browser code creates one at all.

`referral_balance_ngn` on User is already admin-write live; nothing in the
old client writes it, so that one did not have to wait.

## Publish-day runbook (planned 2026-09-20)

1. Press **Publish** in the Base44 dashboard. The latest checkpoint carries
   commit `ee0891b` or later, which includes all of the code above.
2. Wait for the live entry chunk to change, then run
   `scripts/check-deploy.sh`. Every marker must pass and none of the eleven
   functions may return 404.
3. Set `INTERNAL_FUNCTION_SECRET` in the Base44 environment
   (`openssl rand -hex 32`). Until it is set the three gated functions accept
   unauthenticated calls and log a warning.
4. Copy every `.jsonc` file here over the same name in `base44/entities/`, commit, and push each
   one through the MCP (`update_entity_schema`) so they take effect at once
   rather than on the next checkpoint. Base44 will commit its own copies
   back to GitHub; fetch and fast-forward.
5. Delete this folder in the same commit.
6. Smoke-test as a non-admin user: cancel an unpaid stay, upload an ID after
   a test payment, complete a social quest, and confirm
   `base44.auth.updateMe({ loyalty_points: 1 })` is refused from the console.
   Then request a ride through the app (it must still work) and confirm that
   `base44.entities.RideBooking.create({ ... })` and
   `base44.entities.WithdrawalRequest.create({ ... })` are both refused from
   the console.
