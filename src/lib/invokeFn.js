import { base44 } from '@/api/base44Client';
import { fromResponse, fromThrown } from '@/lib/fnResult';

// invokeFn — call a backend function and get one result shape back, whether
// it succeeded, refused or never answered:
//
//   const r = await invokeFn('assignRideDriver', { ride_booking_id, driver_id });
//   if (r.ok) use(r.data); else toast({ description: r.error });   // r.code for branching
//
// It never throws. See src/lib/fnResult.js for why a bare
// base44.functions.invoke hides the server's reason for a refusal.
export async function invokeFn(name, body = {}) {
  try {
    return fromResponse(await base44.functions.invoke(name, body));
  } catch (err) {
    return fromThrown(err);
  }
}
