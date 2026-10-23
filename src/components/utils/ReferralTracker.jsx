import { useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { invokeFn } from '@/lib/invokeFn';
import { toast } from '@/components/ui/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { REFERRAL_KEY, trackReferral } from '@/lib/referralLink';

// The kept code lives in localStorage, which can throw (a private window,
// blocked site data). Without it a link still works, for this visit only.
const storage = {
  read: () => { try { return localStorage.getItem(REFERRAL_KEY); } catch { return null; } },
  keep: (code) => { try { localStorage.setItem(REFERRAL_KEY, code); } catch { /* this visit only */ } },
  forget: () => { try { localStorage.removeItem(REFERRAL_KEY); } catch { /* nothing kept */ } },
};

async function send(code) {
  const result = await invokeFn('attributeReferral', { ref_code: code });
  if (result.ok) console.log('Referral attributed:', result.data);
  else console.warn('Referral not attributed:', result.code || result.error);
  return result;
}

// Asked of a visitor who was already signed in when they opened the link.
// A toast, not a dialog: the page they came for stays usable, and closing
// the toast leaves nothing kept, the same as "Not now".
function ask(code, { apply, decline }) {
  toast({
    title: `Apply referral code ${code}?`,
    description: 'Referral codes are for new accounts. Your friend earns a reward when you make your first booking.',
    // Radix closes a toast after five seconds; a question waits for its answer.
    duration: Infinity,
    action: (
      <div className="flex shrink-0 flex-col gap-2">
        <ToastAction altText={`Apply referral code ${code}`} onClick={() => { apply(); }}>Apply</ToastAction>
        <ToastAction altText="Not now" onClick={() => decline()}>Not now</ToastAction>
      </div>
    ),
  });
}

const tell = (note) => toast({ title: note.title, description: note.description });

/**
 * ReferralTracker: picks up ?ref=CODE on any page inside the Layout.
 *
 * Signed out, the code is kept until they sign up or sign in, and is then
 * sent for them. Already signed in when they opened the link, they are asked
 * first. The rules are in src/lib/referralLink.js; the server has the last
 * word, and a code is for a new account only.
 */
export default function ReferralTracker() {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let urlCode = null;
    try {
      urlCode = new URLSearchParams(window.location.search).get('ref');
    } catch { /* no query string to read */ }
    trackReferral({
      urlCode,
      storage,
      // auth.me() throws for a signed-out visitor.
      me: () => base44.auth.me().catch(() => null),
      send,
      ask,
      tell,
    }).catch((err) => console.error('Referral tracking failed:', err));
  }, []);

  return null;
}
