#!/usr/bin/env bash
# Post-deploy smoke check for UrbanStays Drive.
#
# Answers one question fast: is the code that is actually serving traffic the
# code in this repo? The frontend is hash-named and lazy-chunked, so "it looks
# fine" tells you nothing — this greps the live chunks for strings that only
# exist in the current revision.
#
# Usage: scripts/check-deploy.sh
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

SITE="https://urbanstays.io"
API="$VITE_BASE44_BACKEND_URL/api/apps/$VITE_BASE44_APP_ID"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok(){ printf "  \033[32mok\033[0m    %s\n" "$1"; pass=$((pass+1)); }
no(){ printf "  \033[31mFAIL\033[0m  %s\n" "$1"; fail=$((fail+1)); }

echo; echo "── live bundle ──"
# Retry: a single transient curl failure should not read as "deploy broken".
for attempt in 1 2 3; do
  curl -sL --max-time 30 --retry 2 "$SITE" -o "$TMP/index.html" && [ -s "$TMP/index.html" ] && break
  [ "$attempt" = 3 ] && { no "site unreachable after 3 attempts"; exit 1; }
  sleep 3
done
entry=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$TMP/index.html" | head -1)
[ -n "$entry" ] && ok "entry chunk: $entry" || no "no entry chunk found"
curl -sL --max-time 45 "$SITE/$entry" -o "$TMP/all.js"

# Pull every lazily-imported chunk so page code is actually in scope. Fetched in
# parallel -- there are ~50 and serial curls take minutes.
grep -oE 'assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.js' "$TMP/all.js" | sort -u > "$TMP/chunks.txt"
printf "  fetching %s chunks\n" "$(wc -l < "$TMP/chunks.txt" | tr -d ' ')"
xargs -P 12 -I{} curl -sL --max-time 30 "$SITE/assets/{}" -o "$TMP/c_{}" < <(sed 's#assets/##' "$TMP/chunks.txt") 2>/dev/null || true
# A chunk URL that does not exist is answered with the site's index.html (the
# SPA fallback) and HTTP 200. Until 2026-10-10 the line above asked for every
# chunk WITHOUT its assets/ prefix, got fifty copies of the home page, and this
# script reported every page-level marker as missing on a build that was in
# fact live. So: if anything that should be JavaScript starts like an HTML
# document, say so and stop. Every result below would be meaningless.
html=$(grep -liE '^<!doctype html' "$TMP"/c_* 2>/dev/null | wc -l | tr -d ' ')
if [ "$html" != "0" ]; then
  no "$html chunk(s) came back as HTML, not JavaScript: this check cannot see the live code"
  exit 1
fi
ok "every chunk fetched is JavaScript"
cat "$TMP"/c_* >> "$TMP/all.js" 2>/dev/null
printf "  fetched %s bytes of live JS\n" "$(wc -c < "$TMP/all.js" | tr -d ' ')"

echo; echo "── revision markers (must all be present) ──"
# Every marker is text a person reads or a field name sent over the wire. A
# function or variable name is no good: the minifier renames it, and the
# marker then reads as missing on a build that has the feature.
while IFS='|' read -r label marker; do
  grep -qF -- "$marker" "$TMP/all.js" && ok "$label" || no "$label  (missing: $marker)"
done <<'MARKERS'
hourly pricing|price_per_hour_ngn
per-vehicle turnaround|turnaround_hours
city-first browse|Where do you need a ride
Port Harcourt|Port Harcourt
category taxonomy|Air-conditioned saloon cars
booking reference|booking_reference
estimated vs final price|estimated_price
price adjustment reason|price_adjustment_reason
registration number|registration_number
proceed-to-payment CTA|Proceed to payment
request-availability CTA|Request availability
extra-hour rate|price_extra_hour_ngn
extra-hour snapshot|extra_hour_rate_ngn
admin-only costing|VehicleCosting
nav leads with the two things the app does|Cars & Chauffeurs
nav: Find a Stay|Browse & book apartments
stay cancel via function|cancelBooking
stay payment via function|startStayPayment
driver pages|getDriverRides
driver wallet|getDriverWallet
readable function refusals|Could not reach the server. Check your connection and try again.
ride report dialog|Report a problem with this driver
payout retry (hardening)|Paystack never confirmed this one
record driver pay (hardening)|No pay recorded
driver told when no pay is on record (hardening)|Confirm it with the team before you set off
ride payment refusals shown (hardening)|This ride has already been paid for.
report photos from the file store only (hardening)|[a-f0-9]{24}\/files\/
id upload via function|submitBookingId
stay booking options|How many bedrooms do you want?
seasonal rates in the admin form|Add seasonal rate
search lands on an option|bedroom option available
stay refusals shown to the guest|OPTION_UNAVAILABLE
assistant told about options|BOOKING OPTIONS AND SEASONAL RATES
vehicle powertrain in the admin form|Electric cars get an Electric badge
payments on hold (admin)|Payments on hold
payment on hold (guest)|Payment received, awaiting confirmation
admin confirms a held payment|confirm_held
admin records a refund|markHeldPaymentRefunded
ride pay asks the server again|We could not check this ride just now
no-price listings|Price on request
vehicle form asks for a category|Choose a category
platform block worded for a guest|This part of the site is not available right now.
Nova reads booked dates from the server|getBookedRanges
stale assign-driver window refused|expected_driver_id
reports inbox follows the pay ledger|May be holding the driver
points via function|awardPoints
MARKERS

echo; echo "── stale markers (must all be GONE) ──"
# Only strings the new source genuinely no longer contains. A marker that was
# never there would report "gone" and read as a false pass. "Check availability"
# (lower-case a) was the ride CTA; the stays flow uses "Check Availability" and
# grep -F is case-sensitive, so the stays string does not trip this.
for m in "Plan a Trip" "Check availability" "/ full day" "Book a Ride"; do
  grep -qF -- "$m" "$TMP/all.js" && no "stale string still live: $m" || ok "gone: $m"
done

echo; echo "── entities reachable (200/401/403=exists, 404=schema NOT DEPLOYED) ──"
# These three are admin-only in every direction. An unauthenticated read of
# one that exists is answered with HTTP 200 and an empty list (the access rule
# filters every row out), or refused. Either proves the schema is deployed;
# only 404 means it is not.
for e in VehicleCosting DriverEarning RideReport WithdrawalLedger; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 "$API/entities/$e?limit=1")
  [ "$code" = "404" ] && no "$e schema NOT DEPLOYED" || ok "$e (HTTP $code)"
done

echo; echo "── functions reachable (500=exists+needs auth, 404=NOT DEPLOYED) ──"
for f in checkRideAvailability decideRideBooking assignRideDriver getRideDriverContact \
         startRidePayment verifyRidePayment cancelRideBooking getRideBookings \
         cancelBooking startStayPayment submitBookingId awardPoints checkAvailabilityWebhook \
         getDriverProfile getDriverRides getDriverWallet getDriverEarningsAdmin \
         settleDriverEarning completeRide createRideReport resolveRideReport \
         createWithdrawalRequest processWithdrawal \
         verifyPaystackPayment markHeldPaymentRefunded getBookedRanges; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 -X POST \
         -H 'Content-Type: application/json' -d '{}' "$API/functions/$f")
  # 402 is the platform refusing to run ANY function for this workspace (the
  # plan has no backend functions). It is not "deployed and fine".
  if [ "$code" = "404" ]; then no "$f NOT DEPLOYED"
  elif [ "$code" = "402" ]; then no "$f BLOCKED BY THE PLATFORM (HTTP 402: the workspace plan cannot run backend functions)"
  else ok "$f (HTTP $code)"; fi
done

echo; echo "── vehicle data migration ──"
curl -s --max-time 30 "$API/entities/Vehicle?limit=200" -o "$TMP/v.json"
node -e '
const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
let need=0;
for(const v of rows){
  const flags=[];
  if(!v.category) flags.push("no category (still on legacy fallback)");
  if(Number(v.min_hours_per_booking)>8) flags.push(`min_hours=${v.min_hours_per_booking} blocks all hourly`);
  if(!v.price_per_hour_ngn) flags.push("no hourly rate (day hire only)");
  if(!v.registration_number) flags.push("no plate (guest cannot identify the car)");
  if(flags.length){need++;console.log(`  needs attention: ${v.name} [${v.id}]`);flags.forEach(f=>console.log(`      - ${f}`));}
  else console.log(`  migrated: ${v.name}`);
}
console.log(need?`\n  ${need} vehicle(s) still need admin attention`:"\n  all vehicles migrated");
' "$TMP/v.json"

echo; echo "── result ──"
printf "  %s passed, %s failed\n\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
