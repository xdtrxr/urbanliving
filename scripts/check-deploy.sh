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
xargs -P 12 -I{} curl -sL --max-time 30 "$SITE/{}" -o "$TMP/c_{}" < <(sed 's#assets/##' "$TMP/chunks.txt") 2>/dev/null || true
cat "$TMP"/c_* >> "$TMP/all.js" 2>/dev/null
printf "  fetched %s bytes of live JS\n" "$(wc -c < "$TMP/all.js" | tr -d ' ')"

echo; echo "── revision markers (must all be present) ──"
while IFS='|' read -r label marker; do
  grep -qF -- "$marker" "$TMP/all.js" && ok "$label" || no "$label  (missing: $marker)"
done <<'MARKERS'
hourly pricing|price_per_hour_ngn
per-vehicle turnaround|turnaround_hours
city-first browse|Where do you need a ride
Port Harcourt|Port Harcourt
category taxonomy|effectiveCategory
booking reference|booking_reference
estimated vs final price|estimated_price
price adjustment reason|price_adjustment_reason
registration number|registration_number
proceed-to-payment CTA|Proceed to payment
request-availability CTA|Request availability
extra-hour rate|price_extra_hour_ngn
extra-hour snapshot|extra_hour_rate_ngn
admin-only costing|VehicleCosting
nav says Book a Ride|Book a Ride
MARKERS

echo; echo "── stale markers (must all be GONE) ──"
# Only strings the new source genuinely no longer contains. A marker that was
# never there would report "gone" and read as a false pass. "Check availability"
# (lower-case a) was the ride CTA; the stays flow uses "Check Availability" and
# grep -F is case-sensitive, so the stays string does not trip this.
for m in "Plan a Trip" "Check availability" "/ full day"; do
  grep -qF -- "$m" "$TMP/all.js" && no "stale string still live: $m" || ok "gone: $m"
done

echo; echo "── entities reachable (401/403=exists, 404=schema NOT DEPLOYED) ──"
# VehicleCosting is admin-only in every direction, so an unauthenticated read
# is refused — but refused is not the same as missing.
for e in VehicleCosting; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 "$API/entities/$e?limit=1")
  [ "$code" = "404" ] && no "$e schema NOT DEPLOYED" || ok "$e (HTTP $code)"
done

echo; echo "── functions reachable (500=exists+needs auth, 404=NOT DEPLOYED) ──"
for f in checkRideAvailability decideRideBooking assignRideDriver getRideDriverContact \
         startRidePayment verifyRidePayment cancelRideBooking getRideBookings; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 -X POST \
         -H 'Content-Type: application/json' -d '{}' "$API/functions/$f")
  [ "$code" = "404" ] && no "$f NOT DEPLOYED" || ok "$f (HTTP $code)"
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
