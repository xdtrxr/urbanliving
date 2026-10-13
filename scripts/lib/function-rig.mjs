// Runs a shipped Base44 function in node, start to finish, against an
// in-memory stand-in for the SDK. Used by the check-*-handler scripts.
//
// There is no Deno here and no sandbox for Base44 functions, so this is the
// only place a handler executes before it meets a guest. esbuild bundles the
// function's entry.ts as it is; its one import (npm:@base44/sdk) is pointed
// at the stand-in below, and Deno.serve hands the handler over instead of
// opening a port. Nothing leaves the machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { build } from 'esbuild';

// Deno has the Web Crypto API as a global (the Paystack webhook signs with
// it). Node only does from version 19.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const clone = (v) => JSON.parse(JSON.stringify(v));
const refuse = (status, message) => Object.assign(new Error(message), { status, response: { status, data: { message } } });
const matches = (row, query) => Object.entries(query || {}).every(([k, v]) => {
  if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(row[k]);
  if (v && typeof v === 'object' && typeof v.$regex === 'string') return new RegExp(v.$regex, v.$options || '').test(String(row[k] ?? ''));
  return row[k] === v;
});

// Tables in memory, with the two behaviours of the real platform a handler
// has to get right: get() REJECTS (404) for a row that is not there, and a
// row written as the caller is subject to the create rule while a row written
// with the service role is not. `serverOnlyCreate` names the entities whose
// create rule is "an admin, or the server". `userReads` maps an entity to its
// read rule, (row, user) => boolean, for reads made as the caller.
// Who is calling. Kept per call, not on the rig, so that two calls in flight
// at once (the payment page and Paystack's webhook) each keep their own
// session, and a function invoked by another sees its caller's.
const session = new AsyncLocalStorage();

export function createRig({ serverOnlyCreate = [], userReads = {} } = {}) {
  // rig.failOn(entity, op, id) may return true to make that one write fail
  // before it lands, and rig.failAfter(...) to make it fail after it has
  // landed (a timeout on the way back): the two "second write" cases a
  // handler without transactions has to survive.
  const rig = { db: {}, env: {}, user: null, seq: 0, sent: [], telegram: [], emails: [], invoked: [], paystack: {}, paystackGate: null, handlers: {}, failOn: null, failAfter: null };
  const maybeFail = (name, op, id) => {
    if (rig.failOn && rig.failOn(name, op, id)) throw refuse(500, `${name}.${op} failed (injected)`);
  };
  const maybeFailAfter = (name, op, id) => {
    if (rig.failAfter && rig.failAfter(name, op, id)) throw refuse(500, `${name}.${op} landed, then failed (injected)`);
  };
  // A read made as the caller sees only the rows the entity's read rule
  // lets that caller see. Service-role reads see everything.
  const caller = () => { const held = session.getStore(); return held ? held.user : rig.user; };
  const visible = (name, as) => (row) => as === 'service' || !userReads[name] || !!(caller() && userReads[name](row, caller()));
  // On the platform an id is a piece of the URL that fetches the row, so
  // "../Booking/x" asked of RideBooking names row x of Booking. The stand-in
  // does the same for get, update and delete: without it a check cannot tell
  // a function that refuses such an id from one that never looked.
  const named = (name, id) => {
    const path = /^\.\.\/(\w+)\/([^/?#]+)$/.exec(String(id));
    return path ? { table: path[1], id: path[2] } : { table: name, id };
  };
  const table = (name, as) => {
    const rows = () => (rig.db[name] = rig.db[name] || []);
    const rowsOf = (other) => (rig.db[other] = rig.db[other] || []);
    return {
      async get(id) {
        const at = named(name, id);
        const row = rowsOf(at.table).find((r) => r.id === at.id && visible(at.table, as)(r));
        if (!row) throw refuse(404, `Entity ${name} with ID ${id} not found`);
        return clone(row);
      },
      async filter(query, sort, limit, skip) {
        const from = skip || 0;
        const found = rows().filter((r) => matches(r, query) && visible(name, as)(r));
        // "field" ascending, "-field" descending; rows without the field
        // first. A stable sort, so rows that tie keep the order they were made.
        if (typeof sort === 'string' && sort) {
          const down = sort.startsWith('-');
          const field = sort.replace(/^[-+]/, '');
          const key = (r) => (r[field] === undefined || r[field] === null ? '' : String(r[field]));
          found.sort((a, b) => key(a).localeCompare(key(b)) * (down ? -1 : 1));
        }
        return clone(found.slice(from, from + (limit || 50)));
      },
      async create(data) {
        maybeFail(name, 'create');
        if (as !== 'service' && serverOnlyCreate.includes(name) && !(caller() && caller().role === 'admin')) {
          throw refuse(403, `Permission denied: only the server may create ${name}`);
        }
        rig.seq += 1;
        // The platform stamps created_date; handlers that settle a race by
        // "the oldest claim wins" sort on it. One millisecond apart, in order.
        const row = {
          ...clone(data),
          id: `${name.toLowerCase()}-${rig.seq}`,
          created_date: new Date(Date.UTC(2026, 9, 12, 12, 0, 0, rig.seq)).toISOString(),
          created_by: as === 'service' ? 'service' : caller() && caller().email,
        };
        rows().push(row);
        return clone(row);
      },
      async update(id, patch) {
        maybeFail(name, 'update', id);
        const at = named(name, id);
        const row = rowsOf(at.table).find((r) => r.id === at.id);
        if (!row) throw refuse(404, `Entity ${name} with ID ${id} not found`);
        Object.assign(row, clone(patch));
        maybeFailAfter(name, 'update', id);
        return clone(row);
      },
      async delete(id) {
        maybeFail(name, 'delete', id);
        const at = named(name, id);
        const index = rowsOf(at.table).findIndex((r) => r.id === at.id);
        if (index < 0) throw refuse(404, `Entity ${name} with ID ${id} not found`);
        rowsOf(at.table).splice(index, 1);
        return { success: true };
      },
    };
  };
  const tables = (as) => new Proxy({}, { get: (_, name) => table(name, as) });
  // One function calling another. A function loaded into this rig runs for
  // real, seeing the same session as its caller (the SDK forwards the token),
  // and a refusal throws as base44.functions.invoke does. A function that is
  // not loaded is only recorded. Every call is kept in rig.invoked.
  const functions = {
    async invoke(name, body) {
      rig.invoked.push({ name, body: clone(body ?? {}) });
      const handler = rig.handlers[name];
      if (!handler) return { status: 200, data: { success: true } };
      const res = await handler(new Request('http://check.local/function', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }));
      let data = null;
      try { data = await res.json(); } catch { /* no body */ }
      if (res.status >= 400) {
        throw Object.assign(new Error(`Request failed with status code ${res.status}`), { status: res.status, response: { status: res.status, data } });
      }
      return { status: res.status, data };
    },
  };
  // Email leaves through the Core integration; here it is kept in rig.emails.
  const integrations = { Core: { SendEmail: async (mail) => { rig.emails.push(clone(mail)); return { success: true }; } } };
  rig.client = () => ({
    auth: { me: async () => caller() },
    entities: tables('user'),
    functions,
    integrations,
    asServiceRole: { entities: tables('service'), functions, integrations },
  });
  return rig;
}

// Telegram: record the message, answer as the Bot API would. rig.sent keeps
// the text of each message, rig.telegram the whole payload (buttons too).
export function stubTelegram(rig) {
  rig.env.TELEGRAM_BOT_TOKEN = 'check-token';
  rig.env.TELEGRAM_ADMIN_CHAT_ID = '1';
  globalThis.fetch = async (url, init) => {
    let payload = {};
    try { payload = JSON.parse(init.body); } catch { /* not JSON */ }
    rig.sent.push(payload.caption || payload.text || '');
    rig.telegram.push({ url: String(url), ...payload });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

// Paystack and Telegram together. A transaction is whatever the check put in
// rig.paystack[reference] ({ status, amount, currency, metadata }); a
// reference that is not there is answered as Paystack answers an unknown one.
// Anything else a handler tries to reach fails loudly: nothing leaves the
// machine.
export function stubNetwork(rig) {
  stubTelegram(rig);
  const telegram = globalThis.fetch;
  rig.env.PAYSTACK_SECRET_KEY = 'sk_check';
  globalThis.fetch = async (url, init) => {
    const to = String(url);
    if (to.startsWith('https://api.telegram.org/')) return telegram(url, init);
    if (to.startsWith('https://api.paystack.co/transaction/verify/')) {
      // rig.paystackGate, when set, is a promise Paystack's answer waits on:
      // the way to hold one caller mid-flight while another runs.
      if (rig.paystackGate) await rig.paystackGate;
      const reference = decodeURIComponent(to.split('/').pop());
      const found = rig.paystack[reference];
      const answer = found
        ? { status: true, message: 'Verification successful', data: { reference, ...found } }
        : { status: false, message: 'Transaction reference not found' };
      return new Response(JSON.stringify(answer), { status: found ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`a handler tried to reach ${to}`);
  };
}

// Bundles base44/functions/<name>/entry.ts as shipped and returns its handler.
let loaded = 0;
export async function loadFunction(rig, name) {
  loaded += 1;
  const key = `${name}#${loaded}`;
  globalThis.__functionRigs = globalThis.__functionRigs || {};
  globalThis.__functionRigs[key] = rig;
  const at = `globalThis.__functionRigs[${JSON.stringify(key)}]`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-rig-'));
  const outFile = path.join(outDir, 'handler.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'base44/functions', name, 'entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: outFile,
    logLevel: 'silent',
    banner: { js: `const Deno = { serve: (h) => { ${at}.handlers[${JSON.stringify(name)}] = h; }, env: { get: (k) => ${at}.env[k] } };` },
    plugins: [{
      name: 'base44-sdk-stand-in',
      setup(b) {
        b.onResolve({ filter: /^npm:@base44\/sdk/ }, () => ({ path: 'sdk', namespace: 'stand-in' }));
        b.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({ contents: `export const createClientFromRequest = () => ${at}.client();` }));
      },
    }],
  });
  await import(pathToFileURL(outFile).href);
  fs.rmSync(outDir, { recursive: true, force: true });
  return rig.handlers[name];
}

// One request to a handler as `user` (null = signed out). The handler logs as
// it goes; its console output is muted so a check prints only its own lines.
// Calls may overlap (two writers racing), so the mute is counted: the real
// console comes back when the last call in flight has finished.
let muted = 0;
let realConsole = null;
export async function call(rig, handler, body, user, method = 'POST', { headers = {}, rawBody } = {}) {
  rig.user = user;
  if (muted === 0) {
    realConsole = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
  }
  muted += 1;
  let res;
  try {
    res = await session.run({ user }, () => handler(new Request('http://check.local/function', {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'POST' ? (rawBody ?? JSON.stringify(body)) : undefined,
    })));
  } finally {
    muted -= 1;
    if (muted === 0) Object.assign(console, realConsole);
  }
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, code: json && json.code, error: json && json.error, data: json && json.data, json };
}
