# Entity rules waiting for the owner's go-ahead

One rule change is ready and NOT applied. It closes a gap that is older than
the booking-options work, found while reviewing it (2026-10-11).

## What is open today

`Booking.rls.create` and `AvailabilityRequest.rls.create` let any signed-in
guest create a row that carries their own email. Nothing limits the other
fields, so a guest can write a Booking by hand with any `total_price`, or one
that is already `approved_at`, `confirmed` or `paid`. `startStayPayment` and
`verifyPaystackPayment` then work from that hand-written total.

## Why it can be closed now

`checkAvailabilityWebhook` writes both rows with the service role, and nothing
else creates either entity: `grep -rn "Booking\.create\|AvailabilityRequest\.create" src base44/functions`
lists only that function. Guests read their rows by email, not by who created
them. `scripts/check-stay-handler.mjs` runs the handler under the strict rule.

## Order

1. Publish first, so the live `checkAvailabilityWebhook` is the copy that uses
   the service role. Confirm it: `GET /api/apps/{app_id}/backend-functions`
   must show `asServiceRole.entities.Booking.create` in its code. An older
   copy creates the rows as the guest and would be refused.
2. With `update_entity_schema`, send each live schema back unchanged except
   for `rls.create`:

       "create": { "user_condition": { "role": "admin" } }

   on `Booking` and on `AvailabilityRequest`. `read`, `update` and `delete`
   stay as they are.
3. Pull the "External agent changes" commit Base44 writes, add both entities
   to the "only the server may create a row" checks in
   `scripts/check-entities.mjs`, and delete this folder.

## To undo

Send the schema again with the old rule: for `Booking`

    "create": { "$or": [ { "data.guest_email": "{{user.email}}" }, { "user_condition": { "role": "admin" } } ] }

and the same with `data.user_email` for `AvailabilityRequest`.
