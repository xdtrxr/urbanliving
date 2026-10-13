import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';
import { withSentence } from '@/lib/fnResult';

const { appId, serverUrl, token, functionsVersion } = appParams;

// appBaseUrl is required for the OAuth provider redirect URLs
// (loginWithProvider builds `${appBaseUrl}/api/apps/auth/login?...`).
// Without it the button silently navigates to a relative 404.
export const base44 = createClient({
  appId,
  serverUrl,
  appBaseUrl: serverUrl,
  token,
  functionsVersion,
  requiresAuth: false
});

// A function that refuses answers with a 4xx, and the SDK throws that as
// "Request failed with status code 409". The reason the server gave is in the
// error's response body, where most screens never look: they show
// err.message. So the sentence is put there, here, for every call at once.
// What is thrown is still the SDK's own error object.
const { functions } = base44;
const invoke = functions.invoke.bind(functions);
functions.invoke = async (...args) => {
  try {
    return await invoke(...args);
  } catch (err) {
    throw withSentence(err);
  }
};
