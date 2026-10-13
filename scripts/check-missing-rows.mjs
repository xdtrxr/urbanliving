// A row that is not there, and an id that is not an id — run with:
//   node scripts/check-missing-rows.mjs
//
// Two facts about the platform that most functions were written without:
//   - entity.get(id) REJECTS for a row that does not exist. "const row = await
//     X.get(id); if (!row) return 404" never reaches its 404: the caller gets
//     HTTP 500 for a stale or mistyped id.
//   - the id goes into the URL of the row it fetches, so "../Booking/abc" sent
//     to a function that reads RideBooking fetches a STAY. The guest owns that
//     stay, so every check after the fetch passes, and a function that then
//     writes by the same id writes to the stay: cancelRideBooking would have
//     cancelled a stay past the stay's own rules (a paid one, or one holding a
//     payment), and cancelBooking a ride past the ride's.
//
// This runs the shipped functions (scripts/lib/function-rig.mjs) with both
// kinds of id and wants the refusal each one intended, never a 500.

import { createRig, loadFunction, call, stubNetwork } from './lib/function-rig.mjs';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const rig = createRig();
stubNetwork(rig);
const guest = { id: 'gina', email: 'gina@example.com', role: 'user', full_name: 'Gina Guest' };
const admin = { id: 'root', email: 'root@example.com', role: 'admin' };
rig.db.User = [guest, admin].map((u) => ({ ...u }));
// A stay of the guest's that nobody has approved, and a paid one with an ID on file.
rig.db.Booking = [
  { id: 'stay1', guest_email: guest.email, property_id: 'p1', check_in: '2026-12-13', check_out: '2026-12-17', total_price: 120000, status: 'pending', payment_status: 'unpaid' },
  { id: 'stay2', guest_email: guest.email, property_id: 'p1', check_in: '2026-11-01', check_out: '2026-11-03', total_price: 80000, status: 'confirmed', payment_status: 'paid' },
];
rig.db.RideBooking = [];
rig.db.Property = [{ id: 'p1', title: 'Maitama Duplex' }];
const stay = () => rig.db.Booking.find((b) => b.id === 'stay1');
const untouched = () => [stay().status, stay().payment_status, stay().transaction_hash || null];

// A path dressed as an id. The rig resolves it as the platform's URL would,
// to row stay1 of Booking, so a function that does not refuse it really does
// fetch the stay, and one that writes by it really does change it.
const PATH = '../Booking/stay1';
rig.paystack['ref-path'] = { status: 'success', amount: 120000 * 100, currency: 'NGN', metadata: { ride_booking_id: PATH } };

// name, who asks, the body for an id, what "not found" looks like for a
// missing row and for a path.
const CASES = [
  ['startRidePayment', guest, (id) => ({ ride_booking_id: id }), 404, 400],
  ['verifyRidePayment', guest, (id) => ({ ride_booking_id: id, reference: 'ref-path' }), 404, 404],
  ['cancelRideBooking', guest, (id) => ({ ride_booking_id: id }), 404, 404],
  ['getRideDriverContact', guest, (id) => ({ ride_booking_id: id }), 404, 404],
  ['submitBookingId', guest, (id) => ({ booking_id: id }), 404, 404],
  ['awardPoints', guest, (id) => ({ kind: 'booking_milestones', booking_id: id }), 404, 404],
  ['decideRideBooking', admin, (id) => ({ ride_booking_id: id, action: 'approve' }), 404, 404],
  ['requestHostDetails', admin, (id) => ({ booking_id: id }), 404, 404],
  ['completeRide', admin, (id) => ({ ride_booking_id: id }), 404, 400],
  ['resolveRideReport', admin, (id) => ({ report_id: id, status: 'resolved', action_taken: 'none' }), 404, 400],
  ['draftSupportReply', guest, (id) => ({ message_id: id }), 404, 404],
  ['notifyLead', admin, (id) => ({ lead_id: id }), 404, 404],
];

console.log('\n— a row that is not there, and an id that is really a path —');
for (const [name, who, body, missing, path] of CASES) {
  const handler = await loadFunction(rig, name);
  let r = await call(rig, handler, body('no-such-row'), who);
  check(`${name}: a row that does not exist is a plain "not found", not a crash`, r.status, missing);
  r = await call(rig, handler, body(PATH), who);
  check(`${name}: an id that is a path to another table is refused`, r.status, path);
  check(`${name}: and the stay it pointed at is untouched`, untouched(), ['pending', 'unpaid', null]);
}

console.log('\n— rows named by other rows —');
{
  const handler = await loadFunction(rig, 'submitBookingId');
  let r = await call(rig, handler, { booking_id: 'stay2', reuse_from_booking_id: 'no-such-row' }, guest);
  check('reusing the ID from a booking that does not exist says so', [r.status, r.code], [404, 'NO_PRIOR_ID']);
  r = await call(rig, handler, { booking_id: 'stay2', reuse_from_booking_id: PATH }, guest);
  check('and from a path', [r.status, r.code], [404, 'NO_PRIOR_ID']);
}
{
  // A paid, confirmed ride whose driver row has since been deleted.
  rig.db.RideBooking.push({ id: 'ride1', guest_email: guest.email, status: 'confirmed', payment_status: 'paid', driver_id: 'driver-gone', vehicle_id: 'v1', start_at: '2026-12-01T09:00:00.000Z', end_at: '2026-12-01T12:00:00.000Z' });
  const handler = await loadFunction(rig, 'getRideDriverContact');
  const r = await call(rig, handler, { ride_booking_id: 'ride1' }, guest);
  check('a ride whose driver was deleted answers calmly, not with a crash', r.status !== 500 && !!r.error, true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
