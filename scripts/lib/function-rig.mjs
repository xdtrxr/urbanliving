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
import { build } from 'esbuild';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const clone = (v) => JSON.parse(JSON.stringify(v));
const refuse = (status, message) => Object.assign(new Error(message), { status, response: { status, data: { message } } });
const matches = (row, query) => Object.entries(query || {}).every(([k, v]) => (
  v && typeof v === 'object' && Array.isArray(v.$in) ? v.$in.includes(row[k]) : row[k] === v
));

// Tables in memory, with the two behaviours of the real platform a handler
// has to get right: get() REJECTS (404) for a row that is not there, and a
// row written as the caller is subject to the create rule while a row written
// with the service role is not. `serverOnlyCreate` names the entities whose
// create rule is "an admin, or the server". `userReads` maps an entity to its
// read rule, (row, user) => boolean, for reads made as the caller.
export function createRig({ serverOnlyCreate = [], userReads = {} } = {}) {
  // rig.failOn(entity, op, id) may return true to make that one write fail
  // before it lands, and rig.failAfter(...) to make it fail after it has
  // landed (a timeout on the way back): the two "second write" cases a
  // handler without transactions has to survive.
  const rig = { db: {}, env: {}, user: null, seq: 0, sent: [], handlers: {}, failOn: null, failAfter: null };
  const maybeFail = (name, op, id) => {
    if (rig.failOn && rig.failOn(name, op, id)) throw refuse(500, `${name}.${op} failed (injected)`);
  };
  const maybeFailAfter = (name, op, id) => {
    if (rig.failAfter && rig.failAfter(name, op, id)) throw refuse(500, `${name}.${op} landed, then failed (injected)`);
  };
  // A read made as the caller sees only the rows the entity's read rule
  // lets that caller see. Service-role reads see everything.
  const visible = (name, as) => (row) => as === 'service' || !userReads[name] || !!(rig.user && userReads[name](row, rig.user));
  const table = (name, as) => {
    const rows = () => (rig.db[name] = rig.db[name] || []);
    return {
      async get(id) {
        const row = rows().find((r) => r.id === id && visible(name, as)(r));
        if (!row) throw refuse(404, `Entity ${name} with ID ${id} not found`);
        return clone(row);
      },
      async filter(query, sort, limit) {
        return clone(rows().filter((r) => matches(r, query) && visible(name, as)(r)).slice(0, limit || 50));
      },
      async create(data) {
        maybeFail(name, 'create');
        if (as !== 'service' && serverOnlyCreate.includes(name) && !(rig.user && rig.user.role === 'admin')) {
          throw refuse(403, `Permission denied: only the server may create ${name}`);
        }
        rig.seq += 1;
        // The platform stamps created_date; handlers that settle a race by
        // "the oldest claim wins" sort on it. One millisecond apart, in order.
        const row = {
          ...clone(data),
          id: `${name.toLowerCase()}-${rig.seq}`,
          created_date: new Date(Date.UTC(2026, 9, 12, 12, 0, 0, rig.seq)).toISOString(),
          created_by: as === 'service' ? 'service' : rig.user && rig.user.email,
        };
        rows().push(row);
        return clone(row);
      },
      async update(id, patch) {
        maybeFail(name, 'update', id);
        const row = rows().find((r) => r.id === id);
        if (!row) throw refuse(404, `Entity ${name} with ID ${id} not found`);
        Object.assign(row, clone(patch));
        maybeFailAfter(name, 'update', id);
        return clone(row);
      },
      async delete(id) {
        maybeFail(name, 'delete', id);
        const at = rows().findIndex((r) => r.id === id);
        if (at < 0) throw refuse(404, `Entity ${name} with ID ${id} not found`);
        rows().splice(at, 1);
        return { success: true };
      },
    };
  };
  const tables = (as) => new Proxy({}, { get: (_, name) => table(name, as) });
  rig.client = () => ({ auth: { me: async () => rig.user }, entities: tables('user'), asServiceRole: { entities: tables('service') } });
  return rig;
}

// Telegram: record the message, answer as the Bot API would.
export function stubTelegram(rig) {
  rig.env.TELEGRAM_BOT_TOKEN = 'check-token';
  rig.env.TELEGRAM_ADMIN_CHAT_ID = '1';
  globalThis.fetch = async (url, init) => {
    let payload = {};
    try { payload = JSON.parse(init.body); } catch { /* not JSON */ }
    rig.sent.push(payload.caption || payload.text || '');
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
export async function call(rig, handler, body, user, method = 'POST') {
  rig.user = user;
  if (muted === 0) {
    realConsole = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
  }
  muted += 1;
  let res;
  try {
    res = await handler(new Request('http://check.local/function', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }));
  } finally {
    muted -= 1;
    if (muted === 0) Object.assign(console, realConsole);
  }
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, code: json && json.code, error: json && json.error, data: json && json.data };
}
