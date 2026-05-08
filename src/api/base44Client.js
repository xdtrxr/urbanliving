import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';

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
