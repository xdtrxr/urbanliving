import { base44 } from '@/api/base44Client';
import { fromResponse, fromThrown } from '@/lib/fnResult';

// invokeFn — call a backend function and get one result shape back, whether
// it succeeded, refused or never answered:
//
//   const r = await invokeFn('assignRideDriver', { ride_booking_id, driver_id });
//   if (r.ok) use(r.data); else toast({ description: r.error });   // r.code for branching
//
// It never throws. A bare base44.functions.invoke does: its error has the
// same sentence for a message (src/api/base44Client.js puts it there), but
// the code to branch on is still down in err.response.data. See
// src/lib/fnResult.js.
export async function invokeFn(name, body = {}) {
  try {
    return fromResponse(await base44.functions.invoke(name, body));
  } catch (err) {
    return fromThrown(err);
  }
}
