// What a failed function call says — run with: node scripts/check-invoke-errors.mjs
//
// A function that refuses answers with a 4xx and a sentence written for the
// person ("That vehicle is already booked for those hours."). The SDK throws
// on a 4xx, and the message on what it throws is axios's own: "Request failed
// with status code 409". Most screens catch the error and show err.message,
// so that line is what people were shown.
//
// src/api/base44Client.js now passes every thrown call through withSentence
// (src/lib/fnResult.js), which makes the server's sentence the message and
// leaves the rest of the error alone. The live backend answers 402 to every
// function, so none of this can be tried there. This script builds the errors
// axios really throws and reads what each ends up saying, then bundles the
// client module as shipped, over a stand-in SDK, to see that
// base44.functions.invoke is the wrapped one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AxiosError } from 'axios';
import { build } from 'esbuild';
import { fromThrown, withSentence } from '../src/lib/fnResult.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const CALM = 'Something went wrong. Please try again.';
const OFFLINE = 'Could not reach the server. Check your connection and try again.';

// The error axios throws for an answer outside 2xx, made the way its own
// settle() makes it. The real class, so the check also covers what a plain
// object cannot: that its message can be replaced at all.
const answered = (status, data) => new AxiosError(
  `Request failed with status code ${status}`,
  status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
  {}, {}, { status, data, headers: {} },
);
// ...and for a request nothing answered.
const unanswered = () => new AxiosError('Network Error', AxiosError.ERR_NETWORK, {}, {});

// ── The four kinds of failure ──────────────────────────────────────────────
console.log('\n— what each failure says —');
{
  const err = answered(409, { success: false, error: 'Those dates are already booked.', code: 'DATES_TAKEN' });
  const response = err.response;
  const out = withSentence(err);
  check('a 409 says what the server said', out.message, 'Those dates are already booked.');
  check('it is the same error object, not a copy', out === err, true);
  check('with its response, status and code as axios set them',
    [out.response === response, out.status, out.code, out.response.data.code], [true, 409, 'ERR_BAD_REQUEST', 'DATES_TAKEN']);
  check('and still an axios error to anything that asks', [out instanceof AxiosError, out.name, out.isAxiosError], [true, 'AxiosError', true]);
}
{
  // What the platform itself answers while the workspace plan blocks functions.
  const out = withSentence(answered(402, { message: 'Functions are blocked - app owner lacks backend functions capability' }));
  check('a 402 from the platform is shown as it was sent',
    [out.message, out.status], ['Functions are blocked - app owner lacks backend functions capability', 402]);
}
{
  const out = withSentence(answered(500, '<!DOCTYPE html><html><body><h1>500 Internal Server Error</h1></body></html>'));
  check('a 500 that is an error page gets the calm line: not the page, not the status line', out.message, CALM);
  check('its status is still there for code to read', [out.status, out.response.status, out.code], [500, 500, 'ERR_BAD_RESPONSE']);
}
{
  const out = withSentence(unanswered());
  check('no answer at all reads as a connection problem', out.message, OFFLINE);
  check('and keeps the code axios gave it', [out.code, out.response === undefined], ['ERR_NETWORK', true]);
}

// ── Nothing brings the old line back ───────────────────────────────────────
console.log('\n— the old line is gone —');
{
  const bodies = [undefined, null, '', '<html>Bad gateway</html>', {}, { success: false }, { error: '' }, { error: { message: 'nested' } }, []];
  const said = [];
  for (const status of [400, 401, 403, 404, 409, 429, 500, 502, 503]) {
    for (const body of bodies) said.push(withSentence(answered(status, body)).message);
  }
  check('an answer with no sentence in it never says "status code"', said.filter((m) => /status code|<html/i.test(m)), []);
  check('it says the calm line every time', [...new Set(said)], [CALM]);
}
{
  const once = withSentence(answered(409, { error: 'Already decided' }));
  check('passing an error through twice changes nothing', withSentence(once).message, 'Already decided');
  check('nor for an error page', withSentence(withSentence(answered(502, '<html></html>'))).message, CALM);
}
{
  // invokeFn catches the same error after the client has been at it. Both
  // ways of calling a function have to end up with one sentence.
  const cases = [
    answered(409, { success: false, error: 'No driver cost is set for this vehicle.', code: 'PAYOUT_REQUIRED' }),
    answered(402, { message: 'Functions are blocked' }),
    answered(500, '<html>Server error</html>'),
    unanswered(),
  ];
  check('invokeFn reads the same sentence off it as a screen that shows err.message',
    cases.map((e) => fromThrown(withSentence(e)).error === e.message), [true, true, true, true]);
  check('and still finds the code to branch on', fromThrown(cases[0]).code, 'PAYOUT_REQUIRED');
}
{
  const frozen = Object.freeze(answered(409, { error: 'Already decided' }));
  let out = null;
  let threw = false;
  try { out = withSentence(frozen); } catch { threw = true; }
  check('an error that cannot be changed is handed back as it came', [threw, out === frozen], [false, true]);
  check('something thrown that is not an error passes straight through', [withSentence('boom'), withSentence(undefined), withSentence(null)], ['boom', undefined, null]);
}

// ── The client the app imports ─────────────────────────────────────────────
// src/api/base44Client.js as shipped. Its SDK is replaced by a stand-in whose
// invoke answers or throws to order, and its app params (which read
// import.meta.env and window as they load) by an empty object. Nothing leaves
// the machine.
console.log('\n— base44.functions.invoke —');
const sdk = {
  functions: {
    calls: [],
    answers: {},
    // A method that needs its `this`, as the SDK's own is free to.
    async invoke(name, body) {
      this.calls.push([name, body]);
      const answer = this.answers[name];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
};
globalThis.__invokeCheck = sdk;
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoke-check-'));
const outFile = path.join(outDir, 'client.mjs');
await build({
  entryPoints: [path.join(ROOT, 'src/api/base44Client.js')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: outFile,
  logLevel: 'silent',
  plugins: [{
    name: 'stand-ins',
    setup(b) {
      b.onResolve({ filter: /^@base44\/sdk$/ }, () => ({ path: 'sdk', namespace: 'stand-in' }));
      b.onResolve({ filter: /^@\/lib\/app-params$/ }, () => ({ path: 'app-params', namespace: 'stand-in' }));
      b.onResolve({ filter: /^@\// }, (a) => ({ path: path.join(ROOT, 'src', `${a.path.slice(2)}.js`) }));
      b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (a) => ({
        contents: a.path === 'sdk' ? 'export const createClient = () => globalThis.__invokeCheck;' : 'export const appParams = {};',
      }));
    },
  }],
});
const { base44 } = await import(pathToFileURL(outFile).href);
fs.rmSync(outDir, { recursive: true, force: true });

check('the app gets the client the SDK made', base44 === sdk, true);
{
  const answer = { status: 200, data: { success: true, data: { rides: [] } } };
  sdk.functions.answers.getRideBookings = answer;
  check('a call that succeeds comes back untouched', (await base44.functions.invoke('getRideBookings', { scope: 'mine' })) === answer, true);
  check('having gone out with the name and body it was given', sdk.functions.calls, [['getRideBookings', { scope: 'mine' }]]);
}
{
  const refusal = answered(409, { success: false, error: 'That vehicle is already booked for those hours.', code: 'VEHICLE_TAKEN' });
  sdk.functions.answers.checkRideAvailability = refusal;
  let caught = null;
  try { await base44.functions.invoke('checkRideAvailability', {}); } catch (err) { caught = err; }
  check('a refusal is still thrown, and it is the error the SDK threw', caught === refusal, true);
  check('saying what the server said', caught && caught.message, 'That vehicle is already booked for those hours.');
  check('with the status and the server code where callers read them',
    caught && [caught.response.status, caught.response.data.code], [409, 'VEHICLE_TAKEN']);
}
{
  sdk.functions.answers.getBookings = unanswered();
  let caught = null;
  try { await base44.functions.invoke('getBookings', { scope: 'mine' }); } catch (err) { caught = err; }
  check('a call nothing answered says so calmly', caught && caught.message, OFFLINE);
}

// ── No way round it ────────────────────────────────────────────────────────
// The wrapper is on one client. A second createClient, or a function imported
// the legacy way ("@/functions/..." resolves, inside the vite plugin, to a
// client of its own), would throw the old line again.
console.log('\n— every call goes through that client —');
{
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (/\.jsx?$/.test(entry.name)) sources.push([path.relative(ROOT, at), fs.readFileSync(at, 'utf8')]);
    }
  };
  walk(path.join(ROOT, 'src'));
  const having = (re) => sources.filter(([, text]) => re.test(text)).map(([file]) => file).sort();
  check('the app makes one client', having(/\bcreateClient\(/), ['src/api/base44Client.js']);
  check('no function is imported the legacy way', having(/from\s+['"][^'"]*\/functions(\/[^'"]*)?['"]/), []);
  check('nothing else swaps invoke for something of its own', having(/functions\.invoke\s*=[^=]/), ['src/api/base44Client.js']);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
