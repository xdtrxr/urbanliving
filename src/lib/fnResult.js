// Reading what a backend function said.
//
// Every function in this app answers { success: true, data } on a 2xx, and
// { success: false, error, code } with a 4xx or 5xx when it refuses. The SDK
// call is plain axios, which RESOLVES the first and THROWS the second, so the
// sentence a person is meant to read ("No driver cost is set for this
// vehicle…") arrives inside the thrown error, not in a response.
//
// fromResponse and fromThrown turn both outcomes into one shape:
//   { ok, data, error, code, status, body }
// withSentence is for the screens that catch the error themselves.
// No imports on purpose: the check scripts load this file as it is, and
// src/api/base44Client.js imports it, so it must not import the client back.

const FALLBACK = 'Something went wrong. Please try again.';
const OFFLINE = 'Could not reach the server. Check your connection and try again.';

// The sentence in a response body, wherever this function put it. Older
// functions use `error` alone; the platform itself uses `message` or `detail`.
const sentenceIn = (body) => {
  if (!body || typeof body !== 'object') return null;
  for (const key of ['error', 'message', 'detail']) {
    if (typeof body[key] === 'string' && body[key].trim()) return body[key];
  }
  return null;
};

// The call resolved: a 2xx.
export function fromResponse(res) {
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : null;
  const status = (res && res.status) || null;
  if (body && body.success === true) {
    return { ok: true, data: body.data === undefined ? null : body.data, error: null, code: null, status, body };
  }
  return { ok: false, data: null, error: sentenceIn(body) || FALLBACK, code: (body && body.code) || null, status, body };
}

// The call threw: a refusal (4xx), a failure (5xx), or no answer at all.
export function fromThrown(err) {
  const response = (err && err.response) || null;
  const raw = (response && response.data) || (err && err.data) || null;
  const body = raw && typeof raw === 'object' ? raw : null;
  const status = (response && response.status) || (err && err.status) || null;
  const transport = err && typeof err.message === 'string' && err.message ? err.message : null;
  // No response and no body means the request never got an answer.
  const error = sentenceIn(body) || (!response && !raw ? OFFLINE : (transport || FALLBACK));
  return { ok: false, data: null, error, code: (body && body.code) || null, status, body };
}

// The thrown error itself, with that sentence as its message. Most screens
// call base44.functions.invoke themselves and show err.message, which from
// axios is "Request failed with status code 409". src/api/base44Client.js
// passes every thrown call through here, so those screens show the reason
// without being rewritten. Only the message changes: .response, .status and
// .code are still there for the callers that read them.
export function withSentence(err) {
  if (!err || typeof err !== 'object') return err;
  const { error, body } = fromThrown(err);
  // An answer with no sentence in it (a gateway's error page, say) leaves
  // fromThrown only axios's own line to hand back. Nobody is shown that one.
  const sentence = (sentenceIn(body) || error === OFFLINE) ? error : FALLBACK;
  // A frozen error keeps the text it came with: better that than a TypeError
  // thrown over the real one.
  try { err.message = sentence; } catch { /* left as it was */ }
  return err;
}
