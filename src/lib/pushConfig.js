// VAPID public key used by the browser when subscribing to web push.
//
// This is the *public* half of an asymmetric keypair — it's safe to commit
// and ship to the client. The matching *private* key lives only in the
// Base44 environment (env var VAPID_PRIVATE_KEY) and is used server-side
// by sendPushNotification to sign the push request.
//
// To rotate: generate a new pair with
//   npx web-push generate-vapid-keys --json
// then update this constant AND the Base44 env var in the same deploy.
// Every existing browser subscription is invalidated by a rotation — users
// will be re-prompted to enable notifications the next time the toggle
// runs through subscribe().
export const VAPID_PUBLIC_KEY =
  'BL6XOrXiOQdDgsyO2rkWgoz0DdYzpsOhmu4fFfU-CuH-0D-lNVqCCinVLQNcjXrHDQjz8w4boeuMO04a9HRTVoI';

// Convert the base64url-encoded public key into a Uint8Array, which is the
// format the PushManager.subscribe() applicationServerKey field demands.
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}
