// What to do with a referral code from a ?ref= link, and what to say after.
//
// Referral codes are for new accounts (todo.md, "Decision 3", 2026-10-23).
// The server refuses an account that has already booked; this decides when
// the browser may send a code without asking. A visitor who opens a link
// while signed out and then signs up or signs in has the code applied for
// them, as always. A visitor who was already signed in when they opened the
// link is asked first: a link sent round to existing customers must not
// quietly enter its sender as their referrer.
//
// Used by src/components/utils/ReferralTracker.jsx and, for what a refusal
// means, src/components/dashboard/ReferralCodePrompt.jsx. No imports on purpose:
// scripts/check-referral-attribution.mjs runs this file as it is.

export const REFERRAL_KEY = 'urbanstays_referral_code';

// The server refuses a code longer than this as "not found". A longer one is
// not a code anybody holds, and is not worth asking about or keeping.
const LONGEST = 64;

// The code as it is worth keeping or sending, or '' when it is not one.
export const usableCode = (code) => {
  const text = typeof code === 'string' ? code.trim() : '';
  return text.length > LONGEST ? '' : text;
};
const same = (a, b) => a.toUpperCase() === b.toUpperCase();

// urlCode: the ?ref= of the page just opened. storedCode: what was kept
// before this page was opened. user: the account signed in now, or null.
//
// Answers { action, code }, the action being one of:
//   none   nothing to do
//   keep   signed out: keep the link's code for when they sign up or sign in
//   apply  send the kept code now, without asking (the visit began signed out)
//   ask    they were already signed in when they opened this link: ask first
//   drop   nothing to ask: forget the kept code
export function referralStep({ urlCode, storedCode, user }) {
  const fromLink = usableCode(urlCode);
  const kept = usableCode(storedCode);
  if (!user) return fromLink ? { action: 'keep', code: fromLink } : { action: 'none', code: null };
  if (!fromLink && !kept) return { action: 'none', code: null };
  // Already referred: the server would only say so.
  if (user.referred_by_code) return { action: 'drop', code: null };
  // A code kept while signed out is applied as it always was. That includes
  // arriving back on the link itself: signing in returns a visitor to the
  // page they came from, ?ref= and all, and the code was kept on the way out.
  if (kept && (!fromLink || same(fromLink, kept))) return { action: 'apply', code: kept };
  // Opened while signed in. Their own link (opened to see that it works) is
  // not a question worth asking.
  if (user.referral_code && same(fromLink, String(user.referral_code))) return { action: 'drop', code: null };
  return { action: 'ask', code: fromLink.toUpperCase() };
}

// The server's refusals that no other code would change: the account has
// booked with us already, or has a referrer already. Facts about the
// account, not mistakes, so they are said calmly and never as an error.
export const FINAL_REFUSALS = ['EXISTING_CUSTOMER', 'ALREADY_ATTRIBUTED'];
export const isFinalRefusal = (code) => FINAL_REFUSALS.includes(code);

// What to show after the person pressed Apply, from the result invokeFn
// returns ({ ok, error, code }). A quiet note, never an error screen, in the
// server's own words when it refused.
export function referralNote(result) {
  if (result && result.ok) {
    return { title: 'Referral code applied', description: 'Your friend earns their reward when you make your first booking.' };
  }
  const sentence = (result && result.error) || 'Something went wrong. Please try again.';
  if (isFinalRefusal(result && result.code)) return { title: null, description: sentence };
  return { title: 'Referral code not applied', description: sentence };
}

// One page load inside the Layout, start to finish, with the browser handed
// in so that a check can run it in node:
//   storage   { read(), keep(code), forget() }: the kept code
//   me()      the account signed in now, or null (never throws)
//   send(code)  attributeReferral, answering invokeFn's { ok, error, code }
//   ask(code, { apply, decline })  put the question to the person
//   tell(note)  show what referralNote says
// Answers the step it took.
export async function trackReferral({ urlCode, storage, me, send, ask, tell }) {
  const fromLink = usableCode(urlCode);
  const storedCode = storage.read();
  // Kept at once, before anything is awaited, as it always was: a
  // members-only page can send a signed-out visitor to the sign-in page
  // before me() answers, and the code must survive the trip.
  if (fromLink) storage.keep(fromLink);
  const user = await me();
  const step = referralStep({ urlCode: fromLink, storedCode, user });
  // Once a code has been sent it is forgotten, whatever the server said:
  // one try per code, as before.
  const decide = async (code) => {
    const result = await send(code);
    storage.forget();
    return result;
  };
  if (step.action === 'apply') {
    // Silent, as it always was: this visit began signed out.
    await decide(step.code);
  } else if (step.action === 'ask') {
    // Not kept while the question is open. A page opened later, with no
    // ?ref=, would find it kept and send it without asking.
    storage.forget();
    ask(step.code, {
      apply: async () => tell(referralNote(await decide(step.code))),
      // Nothing is kept by now. Forgotten again all the same, in case
      // another tab kept a code meanwhile: "Not now" leaves nothing behind.
      decline: () => storage.forget(),
    });
  } else if (step.action === 'drop') {
    storage.forget();
  }
  return step;
}
