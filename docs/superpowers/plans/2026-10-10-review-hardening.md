# Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seventeen defects three independent reviewers found in the driver wallet and ride reports work, before any of it is published.

**Architecture:** Five tasks, one per kind of failure: a payout that could be sent twice or left stuck; an assignment that could leave the driver with no pay row; a release that could overwrite a reversal; ride rows a browser could write for itself; and reports that could be stacked, pinned on the wrong driver or carry a link to anywhere. Every fix that is a decision is a pure function the check scripts run; every helper copied between functions is compared character for character, as before.

**Tech Stack:** As the two plans this follows: Base44 Deno functions and entity schemas, React 18 + Vite + Tailwind + shadcn/ui, Paystack transfers. Checks: eslint, the node check scripts, esbuild parse, vite build.

**Spec:** `docs/superpowers/specs/2026-10-07-driver-wallet-and-reports-design.md`.

**Prerequisite:** every task of `2026-10-10-driver-wallet.md` and `2026-10-10-ride-reports.md`. The find-blocks below are written against the code as those two plans leave it.

## Global Constraints

- Everything in the Global Constraints of the two earlier plans still holds: whole naira, WAT instants, lockstep helper copies with a plain JavaScript body, the `{ success, data | error, code }` envelope, dark-mode twins, no new dependencies.
- An id that arrives in a request body, or sits on a row a browser could have written, is used only after `isId` accepts it: letters, digits, `_` and `-`, at most 64 characters. `entity.get(id)` is a GET on `…/<id>`, so `abc#x` fetches row `abc` while every equality check sees a different string.
- A Paystack transfer for a withdrawal always uses the reference `wd-<row id>`, and the function asks Paystack what it already holds for that reference before it sends and again after any refusal. Nothing on this platform can lock a row, so that reference is the only real guarantee that one withdrawal is sent once.
- A withdrawal is marked failed, and a referral refunded, only when Paystack refused it for a stated reason and holds no transfer for it. No answer, a timeout, a rate limit or a fault on Paystack's side means "ask again", never "refund".
- A row that has ever been reversed stays reversed. `reversed_at` is never cleared, and the wallet arithmetic counts no row that carries it.
- One commit per task, prefix `fix(rides):`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to read the steps

As in the earlier plans: **Create `path`:**, **Replace `path` with:** and **Edit `path`** — find: … replace with: …, each followed by exact content; a find-block occurs exactly once in its file.

## Review Focus

The five failures below are the ones a person is most likely to cause without meaning to. Each is pinned by a check in the task named.

1. **Admin presses Process twice, or two admins press it at once.** One bank transfer leaves, not two. Pinned in Task R01: the shipped `sendWithdrawal` is run twice at once against a stand-in for Paystack, in every order the two calls' requests could arrive, and exactly one transfer exists afterwards.
2. **Paystack does not answer after the row was marked processing.** The withdrawal is not stuck: it can be retried, cannot be sent twice, and the settlement webhook can still find it. Pinned in Task R01 (`canSend`, the lost-answer and no-answer runs of `sendWithdrawal`, `withdrawalIdFromReference`).
3. **Admin mis-clicks driver A and then clicks driver B.** The driver who ends up on the ride has a pay row; the other does not. Pinned in Task R02: two `writeAssignment` calls are run against each other in every order with up to four changes of turn, and in random orders beyond that.
4. **Admin reverses a driver's pay at the same moment the sweep releases it.** The reversal wins. Pinned in Task R03 (`walletTotals` ignores a row with `reversed_at`; `settleDueEarning` puts the status back).
5. **A guest complains about driver A, then the ride is handed to driver B.** B is paid on time; the complaint holds only A's pay. Pinned in Task R05 (`hasOpenGuestReport` cases with two drivers).

---

### Task R01: A payout is sent once, is never left stuck, and is always on the ledger

**Findings closed:** two overlapping `processWithdrawal` calls sent two transfers (high); a driver-wallet row whose `driver_id` was the real id plus `#` skipped the ledger check (high); a throw after the row was marked processing left it there for good; a transfer reversed after it had succeeded was ignored; a hand-made row could name someone else's bank account, or claim another withdrawal's transfer in the webhook.

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (the withdrawal helper is built with `isId`; new payout section above `// ---- result ----`)
- Modify: `scripts/check-entities.mjs` (one assertion)
- Modify: `base44/entities/WithdrawalRequest.jsonc`, `docs/entity-rules-pending-publish/WithdrawalRequest.jsonc` (`transfer_reference`)
- Replace: `base44/functions/processWithdrawal/entry.ts`
- Modify: `base44/functions/paystackTransferWebhook/entry.ts` (the row is found from the reference; a reversal after success)
- Modify: `base44/functions/createWithdrawalRequest/entry.ts` (`isId` on the bank account id)
- Modify: `src/components/admin/WithdrawalsAdmin.jsx` (Retry for a stuck row; the new answers)

**Interfaces:**
- Produces, in `processWithdrawal/entry.ts`:
  - `isId(value) → boolean`. Copied into every function that takes an id from a request; Tasks R02, R03 and R05 add the other copies.
  - `transferReferenceFor(withdrawalId) → 'wd-<id>'`.
  - `canSend(withdrawal) → boolean`: pending, or processing with no `transfer_code`.
  - `bankBelongsTo(bankAccount, withdrawal) → boolean`.
  - `lookupFromResponse(httpStatus, body) → transfer | null | undefined`: what Paystack holds for a reference. `null` is a definite "nothing"; `undefined` is "could not tell".
  - `refusalMessage(httpStatus, body, fallback) → string | null`: Paystack's stated reason, or `null` when it gave no usable answer.
  - `transferOutcome(accepted, message, lookup) → 'sent' | 'already_sent' | 'unconfirmed' | 'failed'`.
  - `rowStatusFor(transferStatus) → 'completed' | 'failed' | 'reversed' | ''`.
  - `sendWithdrawal(sr, paystack, withdrawal, nowIso) → { status, body }`, where `paystack` is `{ find(reference), createRecipient(bankAccount), send(payload) }` as built by `paystackClient(secretKey)`.
  - New answers: `{ success: true, already_sent: true, status, message }`; refusals `UNCONFIRMED` (502), `BANK_MISMATCH` (409), `NO_BANK` (404). `NOT_COVERED` (409) is unchanged.
- Produces, in `paystackTransferWebhook/entry.ts`: `withdrawalIdFromReference(reference) → id | null`; `webhookShouldAct(eventName, status) → boolean`.
- Produces: `WithdrawalRequest.transfer_reference` (string).

**Why a fixed reference, and why ask first.** There is no lock and no compare-and-swap on this platform, so two calls can both read a row as pending. The old code built the reference from the row id and `Date.now()`, so every call was unique and Paystack accepted both. With `wd-<row id>` Paystack holds at most one transfer per withdrawal, and the function can ask it. It asks before sending (which catches a second press, a stale tab, and a retry of an attempt whose answer was lost) and again after any refusal (which catches two calls at the very same moment: the second is refused over the reference, asks, and finds the first one's transfer).

**Why the whole send is one function.** `sendWithdrawal` takes Paystack as an argument, so the check script runs the shipped code against a stand-in that keeps one promise: no two transfers with one reference. That is the only way to check "pressed twice, sent once" without a bank. The script does not stop at one overlap: each database or Paystack request is a step, and it walks every order in which two calls' steps can interleave. Task R02 reuses the same walker for assignments.

- [ ] **Step 1: Write the failing checks**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  constLine('processWithdrawal', 'WITHDRAWAL_THRESHOLD_NGN'), FETCH_ALL,
  liftSrc('processWithdrawal', 'driverEmails', 'driver'),
```

replace with:

```js
  constLine('processWithdrawal', 'WITHDRAWAL_THRESHOLD_NGN'), FETCH_ALL,
  liftSrc('processWithdrawal', 'isId', 'value'),
  liftSrc('processWithdrawal', 'driverEmails', 'driver'),
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Payouts: sent once, never stuck, always on the ledger ──────────────────
console.log('\n— payout safety —');
const PW = 'processWithdrawal';
const pw = (name, signature) => liftSrc(PW, name, signature);
const isId = make('isId', pw('isId', 'value'));
check('a row id is an id', isId('6a431f7ed4c9964e10f5a1b3'), true);
// entity.get(id) is a GET on …/<id>. Each of these would fetch a row other
// than the one every equality check in the function is looking at.
for (const bad of ['6a431f7ed4c9964e10f5a1b3#', '6a431f7ed4c9964e10f5a1b3?x=1', '../User/6a431f7ed4c9964e10f5a1b3', 'a/b', 'a b', '', 'x'.repeat(65), 42, null, undefined, { $ne: '' }]) {
  check(`${JSON.stringify(bad) ?? String(bad)} is not an id`, isId(bad), false);
}
identical('isId', 'value', [PW, 'createWithdrawalRequest']);

// A real driver forges a row for far more than they earned and appends "#"
// to their own id. get() drops the "#" and returns their driver row; before
// this fix the request then went missing from its own ledger check.
{
  const sr = bank([request({ amount: 2000000, driver_id: 'drvA#' })], [releasedRow('e1', 20000)]);
  const realGet = sr.Driver.get;
  sr.Driver.get = (id) => realGet(String(id).split('#')[0].split('?')[0]);
  check('a driver id with "#" on the end is refused',
    await driverWithdrawalProblem(sr, request({ amount: 2000000, driver_id: 'drvA#' })), 'This request names no driver.');
}
{
  // Whatever get() returns, it must be the row the request names.
  const sr = bank([request({ driver_id: 'drvZ' })], [releasedRow('e1', 20000)]);
  sr.Driver.get = async () => ({ id: 'drvA', user_email: 'emeka@work.ng' });
  check('a lookup that answers with a different driver is refused',
    await driverWithdrawalProblem(sr, request({ driver_id: 'drvZ' })), 'This request names no driver.');
}
{
  // The request must be one of the rows the arithmetic counts.
  const sr = bank([], [releasedRow('e1', 20000)]);
  check('a request that is not on the driver\'s ledger is refused',
    await driverWithdrawalProblem(sr, request()), 'This request is not on the driver\'s ledger.');
}

const transferReferenceFor = make('transferReferenceFor', pw('transferReferenceFor', 'withdrawalId'));
const ROW_ID = '6a431f7ed4c9964e10f5a1b3';
const REF = transferReferenceFor(ROW_ID);
check('one withdrawal, one reference, every time', REF, transferReferenceFor(ROW_ID.toUpperCase()));
check('…in the form Paystack accepts', /^[a-z0-9_-]{16,50}$/.test(REF), true);
check('…and never shared between withdrawals', REF === transferReferenceFor('6a431f7ed4c9964e10f5a1b4'), false);
const withdrawalIdFromReference = make('withdrawalIdFromReference',
  liftSrc('paystackTransferWebhook', 'withdrawalIdFromReference', 'reference'));
check('the webhook can get the row id back out of it', withdrawalIdFromReference(REF), ROW_ID);
check('an old-style reference names no row', withdrawalIdFromReference('WD-6a431f7e-1760000000000'), null);
check('no reference names no row', withdrawalIdFromReference(undefined), null);

const canSend = make('canSend', pw('canSend', 'withdrawal'));
check('a pending row can be sent', canSend({ status: 'pending' }), true);
check('a row marked processing that never got a transfer code can be retried', canSend({ status: 'processing' }), true);
check('a row Paystack has acknowledged cannot be sent again', canSend({ status: 'processing', transfer_code: 'TRF_1' }), false);
for (const status of ['completed', 'failed', 'reversed']) {
  check(`a ${status} row cannot be sent`, canSend({ status }), false);
}
check('no row cannot be sent', canSend(null), false);

const bankBelongsTo = make('bankBelongsTo', pw('bankBelongsTo', 'bankAccount, withdrawal'));
check('the requester\'s own account', bankBelongsTo({ user_email: 'ada@mail.ng' }, { user_email: 'Ada@Mail.ng ' }), true);
check('someone else\'s account', bankBelongsTo({ user_email: 'ada@mail.ng' }, { user_email: 'mallory@evil.ng' }), false);
check('an account with no owner belongs to nobody', bankBelongsTo({}, { user_email: '' }), false);

// What Paystack holds for a reference. A transfer, null for a definite
// "nothing", undefined for "could not tell". Only null may lead to a refund.
const lookupFromResponse = make('lookupFromResponse', pw('lookupFromResponse', 'httpStatus, body'));
check('a transfer that exists',
  lookupFromResponse(200, { status: true, data: { transfer_code: 'TRF_1', status: 'success' } })?.transfer_code, 'TRF_1');
check('"Transfer not found" is a definite nothing', lookupFromResponse(404, { status: false, message: 'Transfer not found' }), null);
check('…whichever 4xx carries it', lookupFromResponse(400, { status: false, message: 'Transfer not found' }), null);
for (const http of [0, 401, 403, 408, 429, 500, 502, 503]) {
  check(`HTTP ${http} says nothing about whether the transfer exists`, lookupFromResponse(http, { status: false }), undefined);
}
check('a 200 with no transfer in it says nothing either', lookupFromResponse(200, { status: true, data: {} }), undefined);
check('…nor does a 200 that was not JSON', lookupFromResponse(200, null), undefined);

const refusalMessage = make('refusalMessage', pw('refusalMessage', 'httpStatus, body, fallback'));
check('a refusal carries Paystack\'s reason',
  refusalMessage(400, { status: false, message: 'Your balance is not enough to fulfil this request' }, 'x'),
  'Your balance is not enough to fulfil this request');
check('…or the fallback when it gave none', refusalMessage(400, { status: false }, 'Transfer initiation failed'), 'Transfer initiation failed');
for (const http of [0, 200, 408, 429, 500, 503]) {
  check(`HTTP ${http} is no answer, not a refusal`, refusalMessage(http, { message: 'x' }, 'y'), null);
}
check('a 400 that was not JSON is no answer', refusalMessage(400, null, 'y'), null);

// What to do after asking Paystack to send.
const transferOutcome = make('transferOutcome', pw('transferOutcome', 'accepted, message, lookup'));
check('accepted: sent', transferOutcome(true, '', null), 'sent');
check('refused, but Paystack already holds this transfer: someone else sent it first',
  transferOutcome(false, 'Please provide a unique reference. Reference already exists on a transfer', { transfer_code: 'TRF_1' }), 'already_sent');
check('refused for a stated reason and nothing is held: failed, so a referral is refunded',
  transferOutcome(false, 'Your balance is not enough to fulfil this request', null), 'failed');
// The cases where refunding would be a guess. A wrong guess pays twice.
check('refused, and Paystack could not be asked: do not refund', transferOutcome(false, 'Invalid key', undefined), 'unconfirmed');
check('no answer, and nothing held yet: do not refund', transferOutcome(false, null, null), 'unconfirmed');
check('refused over the reference but nothing found: do not refund',
  transferOutcome(false, 'Please provide a unique reference. Reference already exists on a transfer', null), 'unconfirmed');

const rowStatusFor = make('rowStatusFor', pw('rowStatusFor', 'transferStatus'));
check('a transfer the bank paid', rowStatusFor('success'), 'completed');
check('a transfer the bank refused', rowStatusFor('failed'), 'failed');
check('a transfer the bank sent back', rowStatusFor('reversed'), 'reversed');
for (const status of ['pending', 'processing', 'queued', 'otp', 'received', '', undefined]) {
  check(`a transfer that is ${JSON.stringify(status)} is not settled`, rowStatusFor(status), '');
}

// A stand-in for Paystack that keeps the one promise the fix relies on: it
// never holds two transfers with the same reference.
function fakePaystack(opts = {}) {
  const transfers = new Map();
  const calls = { find: 0, recipient: 0, send: 0 };
  return {
    transfers,
    calls,
    async find(reference) {
      calls.find += 1;
      if (opts.cannotAsk) return undefined;
      // The other call's transfer landed just after this look.
      if (opts.staleFirstFind && calls.find === 1) return null;
      return transfers.get(reference) || null;
    },
    async createRecipient() {
      calls.recipient += 1;
      if (opts.recipientRefusal !== undefined) return { ok: false, message: opts.recipientRefusal, details: null };
      return { ok: true, code: 'RCP_1' };
    },
    async send(payload) {
      calls.send += 1;
      if (transfers.has(payload.reference)) {
        return { ok: false, message: 'Please provide a unique reference. Reference already exists on a transfer', details: null };
      }
      // refusal: a string is Paystack's stated reason; null is no answer at all.
      if (opts.refusal !== undefined) return { ok: false, message: opts.refusal, details: { message: opts.refusal } };
      const transfer = {
        id: 900 + transfers.size, transfer_code: `TRF_${transfers.size + 1}`, status: 'pending',
        amount: payload.amount, reference: payload.reference, recipient: payload.recipient,
      };
      transfers.set(payload.reference, transfer);
      // Paystack took the transfer, and its answer was lost on the way back.
      if (opts.answerLost) return { ok: false, message: null, details: null };
      return { ok: true, transfer };
    },
  };
}
const PAYOUT = [
  constLine(PW, 'WITHDRAWAL_THRESHOLD_NGN'), FETCH_ALL,
  pw('isId', 'value'), pw('driverEmails', 'driver'), pw('driverWithdrawals', 'driver, rows'),
  pw('walletTotals', 'earnings, withdrawals'), pw('refundsToBalance', 'withdrawal'),
  pw('transferReferenceFor', 'withdrawalId'), pw('bankBelongsTo', 'bankAccount, withdrawal'),
  pw('transferOutcome', 'accepted, message, lookup'), pw('rowStatusFor', 'transferStatus'),
  pw('driverWithdrawalProblem', 'sr, w'), pw('refundReferralOnce', 'sr, withdrawal, nowIso'),
  pw('sendWithdrawal', 'sr, paystack, withdrawal, nowIso'),
];
const sendWithdrawal = make('sendWithdrawal', ...PAYOUT);
const refundReferralOnce = make('refundReferralOnce', ...PAYOUT);
const SENT_AT = '2026-08-10T12:00:00.000Z';
const referralRow = (extra = {}) => ({
  id: ROW_ID, wallet: 'referral', user_email: 'ada@mail.ng', amount: 15000, status: 'pending', bank_account_id: 'bank1', ...extra,
});
const driverRow = (extra = {}) => request({ bank_account_id: 'bank1', ...extra });
// Everything a payout reads and writes. The person asking starts with ₦5,000
// of referral balance, so a refund shows as 5,000 + the amount.
const payWorld = (row, extra = {}) => ({
  WithdrawalRequest: fakeEntity([row]),
  UserBankAccount: fakeEntity([{
    id: 'bank1', user_email: row.user_email, account_name: 'Ada Obi', account_number: '0123456789', bank_code: '058',
    recipient_code: 'RCP_0', ...(extra.bank || {}),
  }]),
  User: fakeEntity([{ id: 'u1', email: row.user_email, referral_balance_ngn: 5000 }]),
  Driver: fakeEntity([{ id: 'drvA', user_email: 'emeka@work.ng', previous_user_emails: [] }]),
  DriverEarning: fakeEntity(extra.earnings || []),
});
const rowOf = (sr) => sr.WithdrawalRequest.rows[0];
const balanceOf = (sr) => sr.User.rows[0].referral_balance_ngn;

{
  const sr = payWorld(referralRow());
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a pending withdrawal is sent', r.status === 200 && r.body.success === true && !r.body.already_sent, true);
  check('…as one transfer', ps.transfers.size, 1);
  check('…for the amount in kobo', ps.transfers.get(REF)?.amount, 1500000);
  check('…to the account\'s recipient', ps.transfers.get(REF)?.recipient, 'RCP_0');
  check('…and the row is processing', rowOf(sr).status, 'processing');
  check('…carrying its reference', rowOf(sr).transfer_reference, REF);
  check('…and Paystack\'s transfer code', rowOf(sr).transfer_code, 'TRF_1');
}
{
  // The finding. Both calls read the row while it was still pending.
  const sr = payWorld(referralRow());
  const ps = fakePaystack();
  const [a, b] = await Promise.all([
    sendWithdrawal(sr, ps, referralRow(), SENT_AT),
    sendWithdrawal(sr, ps, referralRow(), SENT_AT),
  ]);
  check('two calls at the same moment: one transfer', ps.transfers.size, 1);
  check('…both asked Paystack to send, and the reference stopped the second', ps.calls.send, 2);
  check('…one is told it had already been sent', [a, b].filter((r) => r.body.already_sent).length, 1);
  check('…neither is told it failed', [a, b].every((r) => r.status === 200 && r.body.success === true), true);
  check('…the row is processing with the transfer code', `${rowOf(sr).status}/${rowOf(sr).transfer_code}`, 'processing/TRF_1');
  check('…and nobody was refunded', balanceOf(sr), 5000);
}
{
  const sr = payWorld(referralRow());
  const ps = fakePaystack();
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  // A second tab that loaded the list before the first press.
  const again = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a second press from a stale tab asks first, and sends nothing', ps.calls.send, 1);
  check('…and says so', again.body.already_sent, true);
}
{
  const sr = payWorld(referralRow());
  const ps = fakePaystack({ answerLost: true });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('Paystack took the transfer but its answer was lost: found by reference', r.body.already_sent, true);
  check('…the row has the transfer code', rowOf(sr).transfer_code, 'TRF_1');
  check('…and nobody was refunded', balanceOf(sr), 5000);
}
{
  const sr = payWorld(referralRow());
  const r = await sendWithdrawal(sr, fakePaystack({ refusal: null }), referralRow(), SENT_AT);
  check('no answer from Paystack: not confirmed', `${r.status}/${r.body.code}`, '502/UNCONFIRMED');
  check('…the row waits as processing, with its reference and no transfer code',
    `${rowOf(sr).status}/${rowOf(sr).transfer_reference}/${rowOf(sr).transfer_code || ''}`, `processing/${REF}/`);
  check('…which is the state admin can retry', canSend(rowOf(sr)), true);
  check('…and nobody was refunded', balanceOf(sr), 5000);
  const ps = fakePaystack();
  const retry = await sendWithdrawal(sr, ps, { ...rowOf(sr) }, SENT_AT);
  check('the retry sends it, once', `${retry.body.success}/${ps.transfers.size}`, 'true/1');
}
{
  const sr = payWorld(referralRow());
  const ps = fakePaystack({ cannotAsk: true });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('Paystack cannot be asked what it holds: nothing is sent', `${r.body.code}/${ps.calls.send}`, 'UNCONFIRMED/0');
  check('…and the row is left as it was', rowOf(sr).status, 'pending');
}
{
  const sr = payWorld(referralRow());
  const r = await sendWithdrawal(sr, fakePaystack({ refusal: 'Your balance is not enough to fulfil this request' }), referralRow(), SENT_AT);
  check('refused by Paystack for a stated reason: failed', `${r.status}/${rowOf(sr).status}`, '400/failed');
  check('…with the reason on the row', rowOf(sr).error_message, 'Your balance is not enough to fulfil this request');
  check('…and in the answer admin sees', `${r.body.error}: ${r.body.details?.message}`, 'Transfer failed: Your balance is not enough to fulfil this request');
  check('…a referral withdrawal is credited back', balanceOf(sr), 20000);
  check('…and stamped', rowOf(sr).refunded_at, SENT_AT);
  check('a second refund attempt credits nothing',
    `${await refundReferralOnce(sr, { ...rowOf(sr) }, SENT_AT)}/${balanceOf(sr)}`, 'false/20000');
}
{
  const sr = payWorld(driverRow(), { earnings: [releasedRow('e1', 20000)] });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, driverRow(), SENT_AT);
  check('a driver-wallet request the ledger covers is sent', `${r.body.success}/${ps.transfers.size}`, 'true/1');
}
{
  const sr = payWorld(driverRow(), { earnings: [releasedRow('e1', 20000)] });
  await sendWithdrawal(sr, fakePaystack({ refusal: 'Your balance is not enough to fulfil this request' }), driverRow(), SENT_AT);
  check('a refused driver-wallet payout is failed', rowOf(sr).status, 'failed');
  check('…and credits no referral cash: failing the row is its refund', balanceOf(sr), 5000);
}
{
  const sr = payWorld(driverRow({ amount: 500000 }), { earnings: [releasedRow('e1', 20000)] });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, driverRow({ amount: 500000 }), SENT_AT);
  check('a driver-wallet request the ledger does not cover is closed', `${r.status}/${r.body.code}/${rowOf(sr).status}`, '409/NOT_COVERED/failed');
  check('…and nothing is sent', ps.calls.send, 0);
}
{
  // Stuck as processing, the pay behind it reversed since, and the first
  // attempt DID reach the bank. Failing the row here would free the money
  // to be withdrawn a second time.
  const stuck = driverRow({ status: 'processing' });
  const sr = payWorld(stuck, { earnings: [] });
  const ps = fakePaystack();
  ps.transfers.set(transferReferenceFor(stuck.id), { id: 8, transfer_code: 'TRF_8', status: 'pending' });
  await sendWithdrawal(sr, ps, stuck, SENT_AT);
  check('a payout that already went out is never failed, whatever the ledger says now',
    `${rowOf(sr).status}/${rowOf(sr).transfer_code}`, 'processing/TRF_8');
}
{
  const sr = payWorld(referralRow({ status: 'processing' }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  const r = await sendWithdrawal(sr, ps, referralRow({ status: 'processing' }), SENT_AT);
  check('a stuck row whose transfer the bank has paid is completed by Retry',
    `${rowOf(sr).status}/${rowOf(sr).transfer_code}/${r.body.status}`, 'completed/TRF_7/completed');
  check('…and nothing is sent', ps.calls.send, 0);
}
{
  const sr = payWorld(referralRow({ status: 'processing' }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'failed' });
  await sendWithdrawal(sr, ps, referralRow({ status: 'processing' }), SENT_AT);
  check('a stuck row whose transfer the bank refused is failed and credited back',
    `${rowOf(sr).status}/${balanceOf(sr)}`, 'failed/20000');
}
{
  const sr = payWorld(referralRow(), { bank: { user_email: 'someone@else.ng' } });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a request naming someone else\'s bank account is not sent', `${r.status}/${r.body.code}/${ps.calls.send}`, '409/BANK_MISMATCH/0');
  check('…and is left exactly as it was, for a person to look at', `${rowOf(sr).status}/${balanceOf(sr)}`, 'pending/5000');
}
{
  const sr = payWorld(referralRow({ bank_account_id: 'bank1#' }));
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow({ bank_account_id: 'bank1#' }), SENT_AT);
  check('a bank account id that is not a plain id is never looked up', `${r.status}/${r.body.code}/${ps.calls.send}`, '404/NO_BANK/0');
}
{
  const sr = payWorld(referralRow(), { bank: { recipient_code: '' } });
  const ps = fakePaystack();
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a first payout to an account creates its Paystack recipient', sr.UserBankAccount.rows[0].recipient_code, 'RCP_1');
  check('…and sends to it', ps.transfers.get(REF)?.recipient, 'RCP_1');
}
{
  const sr = payWorld(referralRow(), { bank: { recipient_code: '' } });
  const ps = fakePaystack({ recipientRefusal: 'Account number is invalid' });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('an account Paystack will not accept: failed and credited back',
    `${r.body.error}/${rowOf(sr).status}/${balanceOf(sr)}/${ps.calls.send}`, 'Failed to create transfer recipient/failed/20000/0');
}
{
  const sr = payWorld(referralRow(), { bank: { recipient_code: '' } });
  const r = await sendWithdrawal(sr, fakePaystack({ recipientRefusal: null }), referralRow(), SENT_AT);
  check('no answer while creating the recipient: not confirmed, not refunded',
    `${r.body.code}/${rowOf(sr).status}/${balanceOf(sr)}`, 'UNCONFIRMED/processing/5000');
}

{
  // The settlement webhook was quicker than this call: the row is already
  // completed, but the copy this call read, and its look at Paystack, are older.
  const sr = payWorld(referralRow({ status: 'completed', transfer_code: 'TRF_7' }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'pending' });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a row the webhook already completed is not put back to processing', `${rowOf(sr).status}/${r.body.status}`, 'completed/completed');
}
{
  const sr = payWorld(referralRow({ status: 'reversed', transfer_code: 'TRF_7', refunded_at: SENT_AT }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('…and a row the bank reversed is not put back to completed', `${rowOf(sr).status}/${balanceOf(sr)}`, 'reversed/5000');
}
{
  // The other call's transfer landed just after this call looked, settled,
  // and the webhook completed the row before this call marked it processing.
  // The duplicate is refused, and the second look puts the row right.
  const sr = payWorld(referralRow({ status: 'completed', transfer_code: 'TRF_7' }));
  const ps = fakePaystack({ staleFirstFind: true });
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a completed row marked processing by a late call is completed again by that same call',
    `${rowOf(sr).status}/${ps.transfers.size}/${r.body.already_sent}`, 'completed/1/true');
}

// ── Every order two calls could run in ─────────────────────────────────────
// Nothing on the platform locks a row, so two calls interleave at every
// database or Paystack request. Each request is one step here, and a schedule
// says whose step runs next. everySchedule walks all of them, each against a
// fresh world. Task R02 uses the same walker for assignments.
const viaGate = (target, gate, ops) => {
  const view = { ...target };
  for (const op of ops) view[op] = async (...args) => { await gate(); return target[op](...args); };
  return view;
};
const gatedWorld = (world, gate) => Object.fromEntries(Object.entries(world)
  .map(([name, entity]) => [name, viaGate(entity, gate, ['filter', 'create', 'update', 'get'])]));

// Run the actors to the end, with `choose` picking whose step goes next.
async function interleave(actors, choose) {
  const pending = actors.map(() => null);
  const done = actors.map(() => false);
  const results = actors.map(() => undefined);
  let wake = () => {};
  const parked = () => pending.every((p, i) => p || done[i]);
  const sleep = () => new Promise((r) => { wake = r; });
  actors.forEach((run, i) => {
    const gate = () => new Promise((go) => { pending[i] = go; wake(); });
    Promise.resolve().then(() => run(gate)).then(
      (r) => { results[i] = r; },
      (e) => { results[i] = { threw: String((e && e.message) || e) }; },
    ).then(() => { done[i] = true; wake(); });
  });
  for (;;) {
    // Wait until every actor is parked at a step or has finished.
    while (!parked()) await sleep();
    const ready = pending.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    if (ready.length === 0) return results;
    const pick = choose(ready);
    const go = pending[pick];
    pending[pick] = null;
    go();
  }
}

// Depth-first over schedules. `maxSwitches` bounds how often the turn may pass
// to another actor while the current one could still go on; Infinity walks
// every schedule there is. setup() answers { world, actors }, where an actor
// is (gate) => promise. Answers { runs, problem, schedule }.
async function everySchedule(setup, verdict, maxSwitches = Infinity) {
  const stack = [[]];
  let runs = 0;
  while (stack.length > 0) {
    const prefix = stack.pop();
    const decisions = [];
    let last = -1;
    let switches = 0;
    const { world, actors } = setup();
    const results = await interleave(actors, (ready) => {
      if (ready.length === 1) { [last] = ready; return last; }
      const stay = ready.includes(last) ? last : -1;
      const i = decisions.length;
      const pick = i < prefix.length ? prefix[i] : (stay >= 0 ? stay : ready[0]);
      decisions.push({ ready, stay, pick, switches });
      if (stay >= 0 && pick !== stay) switches += 1;
      last = pick;
      return pick;
    });
    // Every decision made past the prefix has siblings nobody has tried yet.
    for (let i = prefix.length; i < decisions.length; i += 1) {
      const d = decisions[i];
      for (const alt of d.ready) {
        if (alt === d.pick) continue;
        const cost = d.stay >= 0 && alt !== d.stay ? 1 : 0;
        if (d.switches + cost <= maxSwitches) stack.push([...decisions.slice(0, i).map((x) => x.pick), alt]);
      }
    }
    runs += 1;
    const problem = verdict(world, results);
    if (problem) return { runs, problem, schedule: decisions.map((d) => d.pick).join('') };
  }
  return { runs, problem: '', schedule: '' };
}

// Two presses on one withdrawal, in every order their requests could arrive.
const twoPresses = (row, extra) => () => {
  const sr = payWorld(row, extra);
  const ps = fakePaystack();
  const press = (gate) => sendWithdrawal(
    gatedWorld(sr, gate), viaGate(ps, gate, ['find', 'createRecipient', 'send']), { ...row }, SENT_AT);
  return { world: { sr, ps }, actors: [press, press] };
};
const oneTransfer = ({ sr, ps }, results) => {
  if (ps.transfers.size !== 1) return `${ps.transfers.size} transfers left the account`;
  if (results.some((r) => !r || r.status !== 200 || r.body.success !== true)) {
    return `a press was told ${JSON.stringify(results.map((r) => (r && r.body ? r.body.code || r.status : r)))}`;
  }
  if (rowOf(sr).status !== 'processing' || rowOf(sr).transfer_code !== 'TRF_1') {
    return `the row ended ${rowOf(sr).status}/${rowOf(sr).transfer_code}`;
  }
  if (balanceOf(sr) !== 5000) return `the referral balance ended at ${balanceOf(sr)}`;
  return '';
};
{
  const out = await everySchedule(twoPresses(referralRow()), oneTransfer);
  check(`two presses at once, every order (${out.runs}): one transfer, both told the truth, no refund`, `${out.problem}${out.schedule}`, '');
  check('…and that was more than one order', out.runs > 100, true);
}
{
  const out = await everySchedule(twoPresses(referralRow(), { bank: { recipient_code: '' } }), oneTransfer);
  check(`…the same when the account has no Paystack recipient yet (${out.runs})`, `${out.problem}${out.schedule}`, '');
}
{
  // A driver-wallet payout reads the ledger first, so each press has more
  // steps. Every order in which the turn changes hands at most four times.
  const out = await everySchedule(twoPresses(driverRow(), { earnings: [releasedRow('e1', 20000)] }), oneTransfer, 4);
  check(`…and for a driver-wallet payout (${out.runs})`, `${out.problem}${out.schedule}`, '');
}

const webhookShouldAct = make('webhookShouldAct', liftSrc('paystackTransferWebhook', 'webhookShouldAct', 'eventName, status'));
check('success on a processing row', webhookShouldAct('transfer.success', 'processing'), true);
check('failure on a processing row', webhookShouldAct('transfer.failed', 'processing'), true);
check('a second success on a completed row is ignored', webhookShouldAct('transfer.success', 'completed'), false);
check('a second failure on a failed row is ignored', webhookShouldAct('transfer.failed', 'failed'), false);
// The bank sent the money back after the transfer had succeeded.
check('a reversal after success is acted on', webhookShouldAct('transfer.reversed', 'completed'), true);
check('a second reversal is ignored', webhookShouldAct('transfer.reversed', 'reversed'), false);
check('nothing acts on a pending row', webhookShouldAct('transfer.success', 'pending'), false);

// ---- result ----
```

**Edit `scripts/check-entities.mjs`** — find:

```js
check('WithdrawalRequest.driver_id', prop('WithdrawalRequest', 'driver_id')?.type === 'string');
```

replace with:

```js
check('WithdrawalRequest.driver_id', prop('WithdrawalRequest', 'driver_id')?.type === 'string');
check('WithdrawalRequest.transfer_reference', prop('WithdrawalRequest', 'transfer_reference')?.type === 'string');
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: could not find isId in base44/functions/processWithdrawal/entry.ts`.

Run: `node scripts/check-entities.mjs`

Expected: ` FAIL  WithdrawalRequest.transfer_reference`.

- [ ] **Step 3: Record the reference on the row**

The same field goes into the staged copy, or copying that file over the live one on publish day would delete it (the entity check fails if the two differ).

**Edit `base44/entities/WithdrawalRequest.jsonc`** — find:

```json
    "transfer_id": {
      "type": "string",
      "description": "Paystack transfer ID"
    },
```

replace with:

```json
    "transfer_id": {
      "type": "string",
      "description": "Paystack transfer ID"
    },
    "transfer_reference": {
      "type": "string",
      "description": "The reference sent to Paystack for this withdrawal: wd-<row id>, fixed per row, so Paystack never holds two transfers for one withdrawal. Written before the transfer is requested, so the settlement webhook can find the row even if Paystack's answer never arrived."
    },
```

**Edit `docs/entity-rules-pending-publish/WithdrawalRequest.jsonc`** — find:

```json
    "transfer_id": {
      "type": "string",
      "description": "Paystack transfer ID"
    },
```

replace with:

```json
    "transfer_id": {
      "type": "string",
      "description": "Paystack transfer ID"
    },
    "transfer_reference": {
      "type": "string",
      "description": "The reference sent to Paystack for this withdrawal: wd-<row id>, fixed per row, so Paystack never holds two transfers for one withdrawal. Written before the transfer is requested, so the settlement webhook can find the row even if Paystack's answer never arrived."
    },
```

- [ ] **Step 4: Rewrite `processWithdrawal`**

`fetchAll` and the three wallet arithmetic helpers are unchanged, character for character. Everything from `isId` down is new or restructured: the handler now only authenticates, reads the row, and hands it to `sendWithdrawal`.

**Replace `base44/functions/processWithdrawal/entry.ts` with:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// processWithdrawal
// ----------------------------------------------------------------------------
// Admin sends a withdrawal to Paystack.
//
// SENT ONCE. Nothing on this platform can lock a row, so two calls for the
// same withdrawal (a double press, two tabs, two admins) can both read it as
// pending. Two things stand between that and two bank transfers:
//   1. the Paystack reference is fixed per row, wd-<row id>, and Paystack
//      does not hold two transfers with one reference;
//   2. before sending, and again after any refusal, this function asks
//      Paystack what it already holds for that reference.
// A withdrawal is marked failed, and a referral refunded, only when Paystack
// refused it for a stated reason AND holds no transfer for it. Refunding on a
// guess would pay twice: once by transfer and once by refund.
//
// NEVER STUCK. The reference is written on the row before Paystack is asked
// to send. If the answer never arrives, the row stays processing with no
// transfer code, which is exactly the state canSend() lets admin retry, and
// paystackTransferWebhook can still find the row from the reference alone.
//
// ON THE LEDGER. A referral withdrawal was debited from
// User.referral_balance_ngn when it was requested. A driver-wallet withdrawal
// was not debited from anywhere: the row is the reservation against the
// driver's released earnings. So a driver-wallet request is checked against
// the ledger again here, and the request itself must be one of the rows that
// check counts. Nothing on the row is trusted: a browser can create a
// WithdrawalRequest row directly until the stricter create rule staged in
// docs/entity-rules-pending-publish is live.

const WITHDRAWAL_THRESHOLD_NGN = 10000;

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, undefined, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copies in every function that takes an id.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// ── Wallet arithmetic — lockstep copies, see getDriverWallet ────────────────

// Every login this driver is, or was, linked to. Lower-cased, once each.
function driverEmails(driver: any) {
    const all = [driver && driver.user_email].concat((driver && driver.previous_user_emails) || []);
    const out = [];
    for (const raw of all) {
        const email = String(raw || '').trim().toLowerCase();
        if (email && !out.includes(email)) out.push(email);
    }
    return out;
}

// The withdrawal rows that count against this driver's balance: driver-wallet
// rows carrying this driver's id AND made by a login that is, or was, linked
// to this driver. The second condition is not decoration. Until the staged
// rule that stops browsers creating WithdrawalRequest rows is live, any
// signed-in user can create one for their own email with any driver_id on it;
// the email is the one field the access rule pins to the creator.
function driverWithdrawals(driver: any, rows: any[]) {
    if (!driver) return [];
    const emails = driverEmails(driver);
    return (rows || []).filter((w) => !!w
        && w.wallet === 'driver'
        && w.driver_id === driver.id
        && emails.includes(String(w.user_email || '').trim().toLowerCase()));
}

// The driver's position in whole naira. Pass withdrawals through
// driverWithdrawals first. A failed or reversed transfer counts nowhere, so it
// needs no refund. If pay is reversed after it was withdrawn, available stops
// at zero and the difference is carried as shortfall until later pay covers it.
function walletTotals(earnings: any[], withdrawals: any[]) {
    const naira = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    let held = 0;
    let released = 0;
    for (const e of earnings || []) {
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
        else if (e.status === 'released') released += naira(e.amount_ngn);
    }
    let paidOut = 0;
    let reserved = 0;
    for (const w of withdrawals || []) {
        if (!w) continue;
        if (w.status === 'completed') paidOut += naira(w.amount);
        else if (w.status === 'pending' || w.status === 'processing') reserved += naira(w.amount);
    }
    const net = released - paidOut - reserved;
    return {
        held,
        released,
        paid_out: paidOut,
        reserved,
        available: Math.max(0, net),
        shortfall: Math.max(0, -net),
    };
}

// Only a withdrawal that debited a stored balance is refunded to one. A row
// written before wallets existed is a referral withdrawal. Lockstep copy in
// paystackTransferWebhook.
function refundsToBalance(withdrawal: any) {
    return !!withdrawal && withdrawal.wallet !== 'driver';
}

// ── Sending ─────────────────────────────────────────────────────────────────

// The Paystack reference for a withdrawal. Fixed per row, in the form
// Paystack requires (lowercase letters, digits, - and _, 16 to 50 characters),
// so Paystack never holds two transfers for one withdrawal.
// paystackTransferWebhook reads the row id back out of it.
function transferReferenceFor(withdrawalId: string) {
    return `wd-${String(withdrawalId).toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
}

// Whether this row may be sent now: a pending one, or one an earlier attempt
// marked processing without ever getting a transfer code back. Sending the
// second kind again is safe because its reference is the same.
function canSend(withdrawal: any) {
    if (!withdrawal) return false;
    if (withdrawal.status === 'pending') return true;
    return withdrawal.status === 'processing' && !withdrawal.transfer_code;
}

// Whether the bank account on a request is the requester's own.
function bankBelongsTo(bankAccount: any, withdrawal: any) {
    const owner = String((bankAccount && bankAccount.user_email) || '').trim().toLowerCase();
    const asker = String((withdrawal && withdrawal.user_email) || '').trim().toLowerCase();
    return !!owner && owner === asker;
}

// What Paystack's answer to "what do you hold for this reference?" means:
// the transfer; null for a definite "nothing"; undefined for "could not
// tell". When a transfer exists the answer is a 2xx carrying it, so any
// ordinary refusal means there is none. A bad key, a timeout, a rate limit
// or a fault on Paystack's side says nothing either way.
function lookupFromResponse(httpStatus: number, body: any) {
    if (httpStatus >= 200 && httpStatus < 300) {
        return body && body.status && body.data && body.data.transfer_code ? body.data : undefined;
    }
    if (httpStatus < 400 || httpStatus === 401 || httpStatus === 403) return undefined;
    if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return undefined;
    return null;
}

// Paystack's stated reason for refusing a request, or null when it gave no
// usable answer: no response at all (0), a timeout, a rate limit, a fault on
// its side, a body that was not JSON, or a 2xx without what was asked for.
// null never leads to a refund. It means "ask again", not "no".
function refusalMessage(httpStatus: number, body: any, fallback: string) {
    if (httpStatus < 400 || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return null;
    if (!body || typeof body !== 'object') return null;
    return String(body.message || fallback);
}

// What happened to a transfer request. `message` is refusalMessage's answer;
// `lookup` is lookupFromResponse's.
//   sent          Paystack accepted it
//   already_sent  not accepted, but the transfer exists: another call, or an
//                 earlier attempt, got there first
//   failed        refused for a stated reason and nothing exists: the only
//                 case in which a referral is refunded
//   unconfirmed   anything else. The row stays processing and nobody is
//                 refunded, because refunding a transfer that did go out
//                 would pay twice.
function transferOutcome(accepted: boolean, message: string | null, lookup: any) {
    if (accepted) return 'sent';
    if (lookup && lookup.transfer_code) return 'already_sent';
    if (lookup === undefined) return 'unconfirmed';
    if (message === null || message === undefined) return 'unconfirmed';
    if (/reference/i.test(String(message))) return 'unconfirmed';
    return 'failed';
}

// Where a withdrawal row should stand given the status Paystack reports for
// its transfer. '' means not settled yet: the row stays processing and the
// settlement webhook finishes it.
function rowStatusFor(transferStatus: string) {
    if (transferStatus === 'success') return 'completed';
    if (transferStatus === 'failed') return 'failed';
    if (transferStatus === 'reversed') return 'reversed';
    return '';
}

// Why a driver-wallet withdrawal must not be paid, or '' when it may be.
// The request itself has to be one of the rows walletTotals counts, so "the
// ledger covers it" is the same as "there is no shortfall".
async function driverWithdrawalProblem(sr: any, w: any) {
    const amount = Number(w.amount);
    if (typeof w.amount !== 'number' || !Number.isInteger(amount) || amount < WITHDRAWAL_THRESHOLD_NGN) {
        return 'The amount on this request is not a valid withdrawal.';
    }
    if (!isId(w.driver_id)) return 'This request names no driver.';
    const driver = await sr.Driver.get(w.driver_id);
    if (!driver) return 'The driver profile for this request no longer exists.';
    // Whatever the lookup answered with, it must be the row the request names.
    if (driver.id !== w.driver_id) return 'This request names no driver.';
    // Only the login linked to the driver right now may start a withdrawal.
    const requester = String(w.user_email || '').trim().toLowerCase();
    if (!requester || requester !== String(driver.user_email || '').trim().toLowerCase()) {
        return 'This login is not the one linked to the driver profile.';
    }
    const earnings = await fetchAll(sr.DriverEarning, { driver_id: driver.id });
    const rows = await fetchAll(sr.WithdrawalRequest, { driver_id: driver.id });
    const counted = driverWithdrawals(driver, rows);
    // If the request is not among the counted rows, the arithmetic below says
    // nothing about it, and "no shortfall" would be meaningless.
    if (!counted.some((r) => r.id === w.id)) return 'This request is not on the driver\'s ledger.';
    const totals = walletTotals(earnings, counted);
    if (totals.shortfall > 0) {
        return `The driver's released earnings do not cover this request (short by ₦${totals.shortfall.toLocaleString()}).`;
    }
    return '';
}

// Credit a failed referral withdrawal back to the stored balance, once: the
// row's refunded_at stamp is the guard, and it is the same stamp
// paystackTransferWebhook uses. A driver-wallet request debited nothing, so
// marking it failed is its refund. Says whether anything was credited.
async function refundReferralOnce(sr: any, withdrawal: any, nowIso: string) {
    if (!refundsToBalance(withdrawal)) return false;
    const fresh = await sr.WithdrawalRequest.get(withdrawal.id);
    if (!fresh || fresh.refunded_at) return false;
    const users = await sr.User.filter({ email: withdrawal.user_email });
    if (!Array.isArray(users) || users.length === 0) return false;
    await sr.User.update(users[0].id, {
        referral_balance_ngn: (Number(users[0].referral_balance_ngn) || 0) + (Number(withdrawal.amount) || 0),
    });
    await sr.WithdrawalRequest.update(withdrawal.id, { refunded_at: nowIso });
    return true;
}

// Send one withdrawal and say what the response should be: { status, body }.
// Everything that touches Paystack goes through `paystack` (see
// paystackClient), so this exact code runs in scripts/check-driver-wallet.mjs
// against a stand-in, including two calls overlapping on one row.
async function sendWithdrawal(sr: any, paystack: any, withdrawal: any, nowIso: string) {
    const reference = transferReferenceFor(withdrawal.id);
    const refuse = (status, error, code) => ({ status, body: { success: false, error, code } });

    // The transfer exists at Paystack. Record its codes. The row's status is
    // only ever moved forward: to its settled state if the bank has settled
    // and the row is not final yet, or from pending to processing. It is
    // never written over a state the settlement webhook may have set a
    // moment ago, which is why the row is read again here.
    const alreadySent = async (transfer) => {
        const settled = rowStatusFor(transfer.status);
        const fresh = await sr.WithdrawalRequest.get(withdrawal.id);
        const open = !!fresh && (fresh.status === 'pending' || fresh.status === 'processing');
        const patch = {
            transfer_reference: reference,
            transfer_code: transfer.transfer_code,
            transfer_id: String(transfer.id || ''),
        };
        if (settled && open) {
            patch.status = settled;
            patch.processed_at = nowIso;
        } else if (!settled && fresh && fresh.status === 'pending') {
            patch.status = 'processing';
        }
        await sr.WithdrawalRequest.update(withdrawal.id, patch);
        if (open && (settled === 'failed' || settled === 'reversed')) await refundReferralOnce(sr, withdrawal, nowIso);
        const status = patch.status || (fresh && fresh.status) || 'processing';
        const what = {
            completed: 'This withdrawal had already been sent, and the bank has paid it.',
            failed: 'This withdrawal had already been sent, and the bank refused it. It is marked failed.',
            reversed: 'This withdrawal had already been sent, and the bank sent the money back. It is marked reversed.',
        }[status] || 'This withdrawal had already been sent to Paystack. Its status will update when the bank settles.';
        return {
            status: 200,
            body: {
                success: true,
                already_sent: true,
                status,
                message: `${what} Nothing was sent a second time.`,
            },
        };
    };

    // What it means that Paystack did not accept a request. `message` is its
    // stated reason, or null when it gave no usable answer.
    const notAccepted = async (label, message, details) => {
        const lookup = await paystack.find(reference);
        const outcome = transferOutcome(false, message, lookup);
        if (outcome === 'already_sent') return alreadySent(lookup);
        if (outcome === 'unconfirmed') {
            return refuse(502, `Paystack did not confirm the transfer. The withdrawal is left as processing and cannot be sent twice. Press Retry in a minute. If it keeps happening, look up the reference ${reference} in Paystack.`, 'UNCONFIRMED');
        }
        await sr.WithdrawalRequest.update(withdrawal.id, {
            status: 'failed',
            error_message: message || label,
            processed_at: nowIso,
        });
        await refundReferralOnce(sr, withdrawal, nowIso);
        return { status: 400, body: { success: false, error: label, details } };
    };

    // Ask before sending. A transfer for this withdrawal may already exist:
    // an earlier attempt whose answer was lost, or a press a moment ago.
    const before = await paystack.find(reference);
    if (before === undefined) {
        return refuse(502, 'Paystack could not be asked whether this withdrawal has already been sent, so nothing was sent. Try again in a minute.', 'UNCONFIRMED');
    }
    if (before) return alreadySent(before);

    // Nothing has been sent, so a request that should not be paid can still
    // be turned away. A driver-wallet request is only as good as the ledger
    // behind it; one that fails is closed, so it cannot be retried into a
    // payout later. Nothing was debited for it, so nothing is refunded.
    if (withdrawal.wallet === 'driver') {
        const problem = await driverWithdrawalProblem(sr, withdrawal);
        if (problem) {
            await sr.WithdrawalRequest.update(withdrawal.id, {
                status: 'failed',
                error_message: problem,
                processed_at: nowIso,
            });
            return refuse(409, problem, 'NOT_COVERED');
        }
    }

    let bankAccount = null;
    if (isId(withdrawal.bank_account_id)) {
        try {
            bankAccount = await sr.UserBankAccount.get(withdrawal.bank_account_id);
        } catch (_err) {
            bankAccount = null;
        }
    }
    if (!bankAccount) return refuse(404, 'Bank account not found', 'NO_BANK');
    // createWithdrawalRequest only accepts the requester's own account, so a
    // row naming someone else's was not made by it. Left exactly as it is,
    // for a person to look at: failing it would refund a referral balance
    // that may never have been debited.
    if (!bankBelongsTo(bankAccount, withdrawal)) {
        return refuse(409, 'The bank account on this request does not belong to the person who asked. Nothing was sent.', 'BANK_MISMATCH');
    }

    // The reference goes on the row before Paystack is asked to send.
    await sr.WithdrawalRequest.update(withdrawal.id, { status: 'processing', transfer_reference: reference });

    // Create the transfer recipient the first time this account is paid.
    let recipientCode = bankAccount.recipient_code;
    if (!recipientCode) {
        const made = await paystack.createRecipient(bankAccount);
        if (!made.ok) return notAccepted('Failed to create transfer recipient', made.message, made.details);
        recipientCode = made.code;
        await sr.UserBankAccount.update(bankAccount.id, { recipient_code: recipientCode });
    }

    const sent = await paystack.send({
        source: 'balance',
        reason: `UrbanStays withdrawal - ${String(withdrawal.id).substring(0, 8)}`,
        amount: Math.round(Number(withdrawal.amount) * 100), // kobo
        recipient: recipientCode,
        reference,
    });
    if (!sent.ok) return notAccepted('Transfer failed', sent.message, sent.details);

    // Paystack accepted the transfer for processing. It is NOT marked
    // completed here: settlement is asynchronous and can still fail.
    // paystackTransferWebhook hears transfer.success / transfer.failed /
    // transfer.reversed and moves the row to its final state.
    await sr.WithdrawalRequest.update(withdrawal.id, {
        transfer_code: sent.transfer.transfer_code,
        transfer_id: String(sent.transfer.id || ''),
    });
    return {
        status: 200,
        body: {
            success: true,
            message: 'Transfer initiated — Paystack will confirm settlement asynchronously.',
            transfer_data: sent.transfer,
        },
    };
}

// The three Paystack calls a payout needs, in the shape sendWithdrawal reads.
function paystackClient(secretKey: string) {
    const headers = { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    // { http, body }. http is 0 when there was no response at all.
    const call = async (method: string, path: string, payload?: unknown) => {
        try {
            const res = await fetch(`https://api.paystack.co${path}`, {
                method,
                headers,
                ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
            });
            const body = await res.json().catch(() => null);
            return { http: res.status, body };
        } catch (err) {
            console.error(`Paystack ${method} ${path} gave no answer:`, err);
            return { http: 0, body: null };
        }
    };
    const accepted = (http: number, body: any) => http >= 200 && http < 300 && !!body && !!body.status && !!body.data;
    return {
        // The transfer Paystack holds for a reference: see lookupFromResponse.
        async find(reference: string) {
            const { http, body } = await call('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
            return lookupFromResponse(http, body);
        },
        async createRecipient(bankAccount: any) {
            const { http, body } = await call('POST', '/transferrecipient', {
                type: 'nuban',
                name: bankAccount.account_name,
                account_number: bankAccount.account_number,
                bank_code: bankAccount.bank_code,
                currency: 'NGN',
            });
            if (accepted(http, body) && body.data.recipient_code) return { ok: true, code: body.data.recipient_code };
            return { ok: false, message: refusalMessage(http, body, 'Failed to create transfer recipient'), details: body };
        },
        async send(payload: unknown) {
            const { http, body } = await call('POST', '/transfer', payload);
            if (accepted(http, body) && body.data.transfer_code) return { ok: true, transfer: body.data };
            return { ok: false, message: refusalMessage(http, body, 'Transfer initiation failed'), details: body };
        },
    };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);

        const user = await base44.auth.me();
        if (!user || user.role !== 'admin') {
            return Response.json({ success: false, error: 'Unauthorized. Admin access required.' }, { status: 403 });
        }

        const body = await req.json().catch(() => null);
        const withdrawal_request_id = body?.withdrawal_request_id;
        if (!isId(withdrawal_request_id)) {
            return Response.json({ success: false, error: 'Missing withdrawal_request_id' }, { status: 400 });
        }

        const sr = base44.asServiceRole.entities;
        const withdrawalRequest = await sr.WithdrawalRequest.get(withdrawal_request_id);
        if (!withdrawalRequest || withdrawalRequest.id !== withdrawal_request_id) {
            return Response.json({ success: false, error: 'Withdrawal request not found' }, { status: 404 });
        }
        if (!canSend(withdrawalRequest)) {
            return Response.json({
                success: false,
                error: `Withdrawal is already ${withdrawalRequest.status}`,
            }, { status: 400 });
        }

        const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        if (!paystackSecretKey) {
            return Response.json({ success: false, error: 'Payment service not configured' }, { status: 500 });
        }

        const result = await sendWithdrawal(sr, paystackClient(paystackSecretKey), withdrawalRequest, new Date().toISOString());
        if (result.status >= 500) console.warn(`processWithdrawal ${withdrawal_request_id}:`, result.body.error);
        return Response.json(result.body, { status: result.status });
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
});
```

- [ ] **Step 5: The webhook finds the row from the reference and acts on a reversal after success**

A reference of the form `wd-<row id>` names the row by an id only the platform assigns, so a row somebody made by hand cannot claim another withdrawal's transfer by copying its transfer code. The old lookups stay for transfers sent before references had that form.

**Edit `base44/functions/paystackTransferWebhook/entry.ts`** — find:

```ts
// Idempotency: lookup is by transfer_code (preferred, set by processWithdrawal)
// or the transfer reference fallback. We refuse to act on rows that aren't in
// `processing` state, so a re-delivered webhook is a no-op.
```

replace with:

```ts
// Finding the row: processWithdrawal sends the reference wd-<row id>, so the
// row is read by that id and by nothing else. Transfers sent before
// references had that form are matched on transfer_code, then transfer_id.
//
// Idempotency: a row is settled once. A re-delivered success or failure finds
// it already final and is a no-op. The one event that acts on a final row is
// transfer.reversed on a completed one (see webhookShouldAct).
```

**Edit `base44/functions/paystackTransferWebhook/entry.ts`** — find:

```ts
// Refunds the user's referral_balance_ngn for a failed/reversed transfer.
```

replace with:

```ts
// The row id inside a reference built by processWithdrawal (wd-<row id>), or
// null for anything else.
function withdrawalIdFromReference(reference: string) {
    const m = /^wd-([a-z0-9_-]{1,64})$/.exec(String(reference || ''));
    return m ? m[1] : null;
}

// Whether an event should change a row in this state. A row is settled once:
// a re-delivered success or failure finds it already final and is ignored.
// The one event that acts on a final row is a reversal after success, when
// the bank sends the money back: the payout must stop counting as paid.
function webhookShouldAct(eventName: string, status: string) {
    if (status === 'processing') return true;
    return eventName === 'transfer.reversed' && status === 'completed';
}

// Refunds the user's referral_balance_ngn for a failed/reversed transfer.
```

**Edit `base44/functions/paystackTransferWebhook/entry.ts`** — find:

```ts
        // Prefer lookup by transfer_code (we stamped it on the row at initiation).
        // Fall back to transfer_id if Paystack only sends id for this event type.
        let withdrawals: any[] = [];
        if (transferCode) {
            withdrawals = await sdk.asServiceRole.entities.WithdrawalRequest.filter({
                transfer_code: transferCode,
            });
        }
        if (withdrawals.length === 0 && event?.data?.id) {
            withdrawals = await sdk.asServiceRole.entities.WithdrawalRequest.filter({
                transfer_id: String(event.data.id),
            });
        }
```

replace with:

```ts
        let withdrawals: any[] = [];
        const rowId = withdrawalIdFromReference(reference || '');
        if (rowId) {
            // The reference names the row. Nothing else is tried: a row that
            // merely carries the same transfer code is not this withdrawal.
            // This also finds a row whose transfer code was never written
            // because Paystack's answer to processWithdrawal was lost.
            try {
                const row = await sdk.asServiceRole.entities.WithdrawalRequest.get(rowId);
                if (row && row.id === rowId) withdrawals = [row];
            } catch (_err) {
                // No such row.
            }
        } else {
            // A transfer sent before references carried the row id.
            if (transferCode) {
                withdrawals = await sdk.asServiceRole.entities.WithdrawalRequest.filter({
                    transfer_code: transferCode,
                });
            }
            if (withdrawals.length === 0 && event?.data?.id) {
                withdrawals = await sdk.asServiceRole.entities.WithdrawalRequest.filter({
                    transfer_id: String(event.data.id),
                });
            }
        }
```

**Edit `base44/functions/paystackTransferWebhook/entry.ts`** — find:

```ts
        // Idempotency: we only act on rows still in `processing`. A re-delivered
        // success would have already flipped to `completed`; a re-delivered
        // failure would already be `failed` and refunded.
        if (withdrawal.status !== 'processing') {
```

replace with:

```ts
        // Idempotency: a re-delivered success would have already flipped to
        // `completed`; a re-delivered failure would already be `failed` and
        // refunded. A reversal of a completed transfer is the exception.
        if (!webhookShouldAct(eventName, withdrawal.status)) {
```

**Edit `base44/functions/paystackTransferWebhook/entry.ts`** — find:

```ts
            await sdk.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, {
                status: 'completed',
                processed_at: nowIso,
            });
```

replace with:

```ts
            await sdk.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, {
                status: 'completed',
                processed_at: nowIso,
                // A row found by its reference may never have had its code written.
                ...(transferCode && !withdrawal.transfer_code ? { transfer_code: transferCode } : {}),
            });
```

**Edit `base44/functions/paystackTransferWebhook/entry.ts`** — find:

```ts
        await sdk.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, {
            status: newStatus,
            error_message: reason || `Transfer ${newStatus}`,
            processed_at: nowIso,
        });
```

replace with:

```ts
        await sdk.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, {
            status: newStatus,
            error_message: reason || `Transfer ${newStatus}`,
            processed_at: nowIso,
            ...(transferCode && !withdrawal.transfer_code ? { transfer_code: transferCode } : {}),
        });
```

- [ ] **Step 6: `createWithdrawalRequest` only looks up a plain id**

**Edit `base44/functions/createWithdrawalRequest/entry.ts`** — find:

```ts
// The amount asked for: a positive whole number of naira, or null. Kobo are
```

replace with:

```ts
// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// The amount asked for: a positive whole number of naira, or null. Kobo are
```

**Edit `base44/functions/createWithdrawalRequest/entry.ts`** — find:

```ts
        if (body?.amount === undefined || body?.amount === null || !bank_account_id) {
            return refuse(400, 'Missing required fields: amount and bank_account_id');
        }
```

replace with:

```ts
        if (body?.amount === undefined || body?.amount === null || !bank_account_id) {
            return refuse(400, 'Missing required fields: amount and bank_account_id');
        }
        if (!isId(bank_account_id)) {
            return refuse(400, 'Invalid bank account');
        }
```

- [ ] **Step 7: Admin can retry a stuck payout, and is told what happened**

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
    const r = await invokeFn('processWithdrawal', { withdrawal_request_id: target.id });
    if (r.ok) {
      toast({
        title: 'Transfer initiated',
        description: 'Paystack accepted the transfer. Status will flip to Completed when the bank settles.',
      });
    } else {
      toast({
        title: r.code === 'NOT_COVERED' ? 'Not paid: the earnings do not cover it' : 'Transfer rejected',
```

replace with:

```jsx
    const r = await invokeFn('processWithdrawal', { withdrawal_request_id: target.id });
    if (r.ok) {
      toast(r.body?.already_sent
        ? {
          title: 'Already sent',
          description: r.body.message || 'This withdrawal had already gone to Paystack. Nothing was sent a second time.',
        }
        : {
          title: 'Transfer initiated',
          description: 'Paystack accepted the transfer. Status will flip to Completed when the bank settles.',
        });
    } else {
      toast({
        title: r.code === 'NOT_COVERED' ? 'Not paid: the earnings do not cover it'
          : r.code === 'UNCONFIRMED' ? 'Not confirmed yet'
            : r.code === 'BANK_MISMATCH' ? 'Not sent: check this request'
              : 'Transfer rejected',
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
              const isPending = r.status === 'pending';
```

replace with:

```jsx
              const isPending = r.status === 'pending';
              // Marked processing, but Paystack never answered with a transfer
              // code. Retrying is safe: the function asks Paystack what it
              // already holds for this withdrawal before it sends anything.
              const isStuck = isProcessing && !r.transfer_code;
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
                    {isPending && (
```

replace with:

```jsx
                    {(isPending || isStuck) && (
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
                              <Send className="w-4 h-4 mr-2" />
                              Process now
```

replace with:

```jsx
                              <Send className="w-4 h-4 mr-2" />
                              {isStuck ? 'Retry' : 'Process now'}
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
                        {bank && !bank.is_verified && (
                          <p className="text-[11px] text-rose-600 dark:text-rose-400 sm:text-right">Bank account not verified</p>
                        )}
```

replace with:

```jsx
                        {bank && !bank.is_verified && (
                          <p className="text-[11px] text-rose-600 dark:text-rose-400 sm:text-right">Bank account not verified</p>
                        )}
                        {isStuck && (
                          <p className="text-[11px] text-amber-700 dark:text-amber-300 sm:text-right sm:max-w-[220px]">
                            Paystack never confirmed this one. Retrying cannot send it twice.
                          </p>
                        )}
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
            <AlertDialogTitle>Process withdrawal?</AlertDialogTitle>
```

replace with:

```jsx
            <AlertDialogTitle>
              {confirmTarget?.status === 'processing' ? 'Retry this withdrawal?' : 'Process withdrawal?'}
            </AlertDialogTitle>
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
                    Paystack will accept the transfer and settle async. The status will flip to Completed when the bank confirms; if it fails, the user's balance is refunded automatically.
                  </span>
```

replace with:

```jsx
                    Paystack will accept the transfer and settle async. The status will flip to Completed when the bank confirms; if it fails, the user's balance is refunded automatically.
                  </span>
                  {confirmTarget.status === 'processing' && (
                    <span className="block text-xs text-amber-700 dark:text-amber-300">
                      Paystack never confirmed the first attempt. It is asked what it already holds for this withdrawal before anything is sent, so the money cannot go out twice.
                    </span>
                  )}
```

- [ ] **Step 8: Run the checks**

Run: `npm run check`

Expected: five `PASS` lines, with every line under `— payout safety —` ok.

Run: `for f in processWithdrawal paystackTransferWebhook createWithdrawalRequest; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done; npm run lint`

Expected: no `PARSE FAIL` line, no lint output.

- [ ] **Step 9: Sandbox checklist (after the next publish, Paystack test keys)**

Step 1 is the one that cannot be checked without Paystack: it proves Paystack refuses a second transfer with the same reference. If two transfers appear, stop, and do not process payouts until it is understood.

1. Open Admin → Withdrawals in two tabs. Press Process now on the same pending row in both within a second. Expected: one says "Transfer initiated", the other "Already sent"; Paystack's dashboard shows one transfer with reference `wd-<row id>`.
2. As a linked driver, create a row by hand with `driver_id: '<own id>#'` and `amount: 2000000`, then process it as admin. Expected: "Not paid: the earnings do not cover it" with "This request names no driver."; the row is `failed`.
3. Set a wrong `PAYSTACK_SECRET_KEY`, press Process now on a pending referral row, then restore the key. Expected: "Not confirmed yet"; the row is still `pending`; the user's referral balance is unchanged. With the key restored, Process now sends it.
4. In the data editor, set a pending row's status to `processing` by hand. Expected: the row shows Retry and the amber line under it; Retry sends it, and Paystack shows one transfer.
5. In Paystack's dashboard, find a settled test transfer made by step 1 and note that the row is `completed`. (A `transfer.reversed` event cannot be forced in test mode; the rule is pinned by the `webhookShouldAct` checks.)

- [ ] **Step 10: Commit**

```bash
git add scripts/check-driver-wallet.mjs scripts/check-entities.mjs base44/entities/WithdrawalRequest.jsonc docs/entity-rules-pending-publish/WithdrawalRequest.jsonc base44/functions/processWithdrawal/entry.ts base44/functions/paystackTransferWebhook/entry.ts base44/functions/createWithdrawalRequest/entry.ts src/components/admin/WithdrawalsAdmin.jsx
git commit -m "fix(rides): a payout is sent once, can be retried, and must be on the driver's ledger" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task R02: The driver on the ride always has their pay row, whoever else was assigning

**Findings closed:** two overlapping assignments each reversed the other's pay row, leaving the driver who ended up on the ride with none; there was no way to record pay for a driver already on a ride, which is every ride assigned before the driver was given a login; an assignment for a driver with no login answered 500 if the ledger could not be read, after the ride row had already been written; a ride the sweep had completed dropped out of the overlap checks, so the turnaround after it protected neither its driver nor its car; a completed ride with no driver lost its Assign button and left the needs-a-driver queue; a driver profile with earnings could be deleted; a guest blocked from rides could still be sent a driver.

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (three expectations; new section above `// ---- result ----`)
- Replace: `base44/functions/assignRideDriver/entry.ts`
- Modify: `base44/functions/cancelRideBooking/entry.ts` (lockstep copy of `reverseHeldEarnings`)
- Modify: `base44/functions/checkRideAvailability/entry.ts` (`busyWindow`; completed rides in the vehicle conflict check)
- Modify: `base44/functions/getRideBookings/entry.ts` (two admin-only flags per ride)
- Modify: `src/config/rides.js` (`payMissing`, `needsDriver`, `mayDeleteDriver`)
- Modify: `src/components/admin/RidesAdmin.jsx`, `src/components/admin/DriversAdmin.jsx`

**Interfaces:**
- Changes: `reverseHeldEarnings(...)` also returns `rows`, the rows it reversed as they were read. Both copies.
- Produces, in `assignRideDriver/entry.ts`:
  - `isId`, `isRideBlocked` (lockstep copies); `guestIsBlocked(accounts, email) → boolean`.
  - `busyWindow(ride, w) → { startMs, endMs } | null`, lockstep in `checkRideAvailability`.
  - `payoutOf(earning) → { amount, basis, rate, units }`.
  - `realignLedger(sr, ride, driverId, payout, endAtIso, note, nowIso, heldBefore) → { settled, superseded, current_driver_id, earning, reversed_ngn, released_ngn }`.
  - `writeAssignment(sr, ride, driverId, payout, endAtIso, patch, note, nowIso)` → the same, plus `ledger_error` (`''` when all is well).
  - `assignmentNotices(sameDriver, rideOver, payIsNew) → { guest: boolean, driver: 'assigned' | 'pay' | '' }`.
  - New refusals: `SUPERSEDED` (409), `GUEST_BLOCKED` (409). New fields on success: `already_assigned`, `pay_recorded`, `guest_notified`, `ledger_warning`.
- Produces, in `getRideBookings/entry.ts`: `livePayKeys(earnings) → string[]`; per ride, for admin only, `driver_linked` and `driver_pay_recorded` (`null` when the ledger could not be read).
- Produces, in `src/config/rides.js`: `PAY_NUDGE_DAYS`, `payMissing(ride, nowMs)`, `needsDriver(ride)`, `mayDeleteDriver(earnings, withdrawals)`.

**How two assignments are kept straight.** The old order was: hold my driver's pay, write the ride row, reverse everyone else's held pay. Two calls doing that at once each reverse the other's row. No amount of reordering fixes it, because every write is made on a reading that may be stale by the time it lands, and nothing on this platform can lock the ride. So `realignLedger` does not trust any single reading. After the ride row is written it loops: read who the ride says is driving, reverse pay held for anyone else, make sure that driver has a standing row, and go round again if it wrote anything. A call that reversed a row for a driver who turns out to be on the ride after all holds the same figures for them again. The loop ends on a pass with nothing to fix. The check script runs two of these against each other in every order their requests could arrive.

**The same driver again.** Submitting the driver who is already on the ride changes nothing about the ride. It exists so pay can be recorded for a ride assigned before the driver had a login: the checks on whether this driver should be sent are skipped, the guest is not told a second time, and a standing pay row is never repriced.

- [ ] **Step 1: Write the failing checks**

`reverseHeldEarnings` is about to hand back the rows it reversed, so the three places that compare its whole answer now compare the rows by id.

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  same('…and reports what moved', out, { reversed_ngn: 15000, released_ngn: 0, driver_ids: ['drvA'] });
```

replace with:

```js
  same('…and reports what moved', { ...out, rows: out.rows.map((r) => r.id) },
    { reversed_ngn: 15000, released_ngn: 0, driver_ids: ['drvA'], rows: ['a1'] });
  check('…handing back the row as it was read, pay figure included', `${out.rows[0].status}/${out.rows[0].amount_ngn}`, 'held/15000');
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  same('…and reported', out, { reversed_ngn: 0, released_ngn: 15000, driver_ids: [] });
```

replace with:

```js
  same('…and reported', out, { reversed_ngn: 0, released_ngn: 15000, driver_ids: [], rows: [] });
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  same('…and totals it', out, { reversed_ngn: 35000, released_ngn: 0, driver_ids: ['drvA', 'drvB'] });
```

replace with:

```js
  same('…and totals it', { ...out, rows: out.rows.map((r) => r.id) },
    { reversed_ngn: 35000, released_ngn: 0, driver_ids: ['drvA', 'drvB'], rows: ['a1', 'b1'] });
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Assignment: two at once, the same driver again, and at rollout ─────────
console.log('\n— assignment under concurrency —');
const AR = 'assignRideDriver';
const ar = (name, signature) => liftSrc(AR, name, signature);
identical('isId', 'value', [PW, AR]);
identical('isRideBlocked', 'account', ['checkRideAvailability', AR]);
identical('busyWindow', 'ride, w', [AR, 'checkRideAvailability']);

const guestIsBlocked = make('guestIsBlocked', ar('isRideBlocked', 'account'), ar('guestIsBlocked', 'accounts, email'));
check('a blocked guest is blocked', guestIsBlocked([{ email: 'tunde@mail.ng', ride_blocked: true }], 'Tunde@Mail.ng'), true);
check('a guest who is not blocked is not', guestIsBlocked([{ email: 'tunde@mail.ng', ride_blocked: false }], 'tunde@mail.ng'), false);
check('the word "true" does not block', guestIsBlocked([{ email: 'tunde@mail.ng', ride_blocked: 'true' }], 'tunde@mail.ng'), false);
// A ride row with no guest email makes the lookup answer with whoever comes first.
check('a ride with no guest email matches nobody', guestIsBlocked([{ email: 'someone@else.ng', ride_blocked: true }], ''), false);
check('…and another account that happens to be blocked is not this guest',
  guestIsBlocked([{ email: 'someone@else.ng', ride_blocked: true }], 'tunde@mail.ng'), false);

// A ride keeps its driver and its car busy for its booked window. One that
// was completed early frees them from that moment.
const busyWindow = make('busyWindow', ar('busyWindow', 'ride, w'));
const windowsOverlap = make('windowsOverlap', ar('windowsOverlap', 'aStart, aEnd, bStart, bEnd, buffer'));
const W = { startMs: at('2026-08-10T08:00:00.000Z'), endMs: at('2026-08-10T16:00:00.000Z') };
same('a confirmed ride is busy for its whole booked window', busyWindow({ status: 'confirmed' }, W), W);
same('a ride the sweep completed at its end: the whole window',
  busyWindow({ status: 'completed', completed_at: '2026-08-10T16:05:00.000Z' }, W), W);
same('a ride admin completed early: until that moment',
  busyWindow({ status: 'completed', completed_at: '2026-08-10T11:00:00.000Z' }, W), { startMs: W.startMs, endMs: at('2026-08-10T11:00:00.000Z') });
same('a completed ride with no completion time keeps its whole window', busyWindow({ status: 'completed' }, W), W);
same('a completion stamped before the start cannot make a window run backwards',
  busyWindow({ status: 'completed', completed_at: '2026-08-10T07:00:00.000Z' }, W), { startMs: W.startMs, endMs: W.startMs });
check('a ride with no readable time has no window', busyWindow({ status: 'completed' }, null), null);
// The same thing as the functions use it, with the default one-hour turnaround.
const clashes = (ride, startIso, endIso) => {
  const b = busyWindow(ride, W);
  return windowsOverlap(at(startIso), at(endIso), b.startMs, b.endMs, 3600000);
};
const sweptAtEnd = { status: 'completed', completed_at: '2026-08-10T16:00:30.000Z' };
check('closed by the sweep at 16:00: a 16:30 pickup is still inside the turnaround',
  clashes(sweptAtEnd, '2026-08-10T16:30:00.000Z', '2026-08-10T18:30:00.000Z'), true);
check('…and a 17:00 pickup is clear', clashes(sweptAtEnd, '2026-08-10T17:00:00.000Z', '2026-08-10T19:00:00.000Z'), false);
const doneEarly = { status: 'completed', completed_at: '2026-08-10T11:00:00.000Z' };
check('completed early at 11:00: free for a 12:30 pickup',
  clashes(doneEarly, '2026-08-10T12:30:00.000Z', '2026-08-10T14:30:00.000Z'), false);
check('…which the booked window alone would have refused',
  clashes({ status: 'confirmed' }, '2026-08-10T12:30:00.000Z', '2026-08-10T14:30:00.000Z'), true);

const assignmentNotices = make('assignmentNotices', ar('assignmentNotices', 'sameDriver, rideOver, payIsNew'));
same('a new driver for a ride still to come: guest and driver are told',
  assignmentNotices(false, false, true), { guest: true, driver: 'assigned' });
same('the same driver again: the guest is not told twice, the driver hears about the pay',
  assignmentNotices(true, false, true), { guest: false, driver: 'pay' });
same('the same driver again with nothing new: nobody is told', assignmentNotices(true, false, false), { guest: false, driver: '' });
same('a driver attached after the ride is over: the guest is not told someone is coming',
  assignmentNotices(false, true, true), { guest: false, driver: 'pay' });
same('…and with no pay recorded, nobody is told', assignmentNotices(false, true, false), { guest: false, driver: '' });

const ASSIGN = [
  PAY, FETCH_ALL, constLine(AR, 'MAX_REALIGN_PASSES'),
  ar('releaseAtFor', 'endAtIso'),
  ar('holdEarning', 'sr, ride, driverId, payout, endAtIso, nowIso'),
  ar('reverseHeldEarnings', 'sr, rideId, keepDriverId, note, nowIso'),
  ar('payoutOf', 'earning'),
  ar('realignLedger', 'sr, ride, driverId, payout, endAtIso, note, nowIso, heldBefore'),
  ar('writeAssignment', 'sr, ride, driverId, payout, endAtIso, patch, note, nowIso'),
];
const writeAssignment = make('writeAssignment', ...ASSIGN);
const ASSIGNED_EARLIER = '2026-08-01T00:00:00.000Z';
const rideWorld = (driverId = '', earnings = []) => ({
  RideBooking: fakeEntity([{
    ...rideA, status: 'confirmed', payment_status: 'paid', driver_id: driverId,
    driver_assigned_at: driverId ? ASSIGNED_EARLIER : '',
  }]),
  DriverEarning: fakeEntity(earnings),
});
const assignTo = (sr, driver, payout = dayPay) => writeAssignment(
  sr, rideA, driver, payout, END, { driver_id: driver, driver_assigned_at: NOW }, `Reassigned to ${driver}`, NOW);
const heldBy = (sr) => sr.DriverEarning.rows.filter((e) => e.status === 'held').map((e) => e.driver_id).join(',');
const onRide = (sr) => sr.RideBooking.rows[0].driver_id;

{
  const sr = rideWorld();
  const r = await assignTo(sr, 'drvA');
  check('a first assignment: the driver is on the ride with one held row', `${onRide(sr)}/${heldBy(sr)}`, 'drvA/drvA');
  check('…and the call is told so', `${r.superseded}/${r.ledger_error}/${r.earning.status}/${r.earning.amount_ngn}`, 'false//held/15000');
}
{
  const sr = rideWorld('drvA', [heldRow('a1', 'drvA')]);
  const r = await assignTo(sr, 'drvB');
  check('a change of driver: the new one holds, the old one does not', `${onRide(sr)}/${heldBy(sr)}`, 'drvB/drvB');
  check('…the old row is reversed, not deleted', sr.DriverEarning.rows.find((e) => e.id === 'a1').status, 'reversed');
  check('…and nothing had been released', r.released_ngn, 0);
}
{
  const sr = rideWorld('drvA', [heldRow('a1', 'drvA', { status: 'released' })]);
  const r = await assignTo(sr, 'drvB');
  check('a change of driver after the old one was paid: reported, not clawed back',
    `${r.released_ngn}/${sr.DriverEarning.rows[0].status}`, '15000/released');
}
{
  // Rollout: the driver was put on this ride before pay was tracked. The same
  // driver is submitted again, with nothing to change on the ride itself.
  const sr = rideWorld('drvA');
  const r = await writeAssignment(sr, rideA, 'drvA', dayPay, END, {}, 'Reassigned to drvA', NOW);
  check('the same driver again records their pay', `${heldBy(sr)}/${r.earning.amount_ngn}/${r.earning.held_at}`, `drvA/15000/${NOW}`);
  check('…without rewriting the ride', sr.RideBooking.rows[0].driver_assigned_at, ASSIGNED_EARLIER);
  const again = await writeAssignment(sr, rideA, 'drvA', { ...dayPay, amount: 99999 }, END, {}, 'Reassigned to drvA', '2026-08-09T10:00:00.000Z');
  check('…and a second time changes nothing: the first figure stands',
    `${sr.DriverEarning.rows.length}/${again.earning.amount_ngn}/${again.earning.held_at}`, `1/15000/${NOW}`);
}
{
  // A driver with no login: nothing is recorded, as before.
  const sr = rideWorld('drvA', [heldRow('a1', 'drvA')]);
  const r = await assignTo(sr, 'drvU', null);
  check('a driver with no login is assigned with no pay row', `${onRide(sr)}/${heldBy(sr)}/${r.earning}`, 'drvU//null');
}
{
  // The ledger cannot be read. A driver with no login has nothing to record,
  // so the assignment still goes through and says what it could not do.
  const sr = rideWorld();
  sr.DriverEarning.filter = async () => { throw new Error('ledger unavailable'); };
  const r = await assignTo(sr, 'drvU', null);
  check('ledger down, driver with no login: assigned, and admin is warned', `${onRide(sr)}/${r.ledger_error}`, 'drvU/ledger unavailable');
}
{
  // The same failure for a driver whose pay must be recorded: nothing happens.
  const sr = rideWorld();
  sr.DriverEarning.filter = async () => { throw new Error('ledger unavailable'); };
  let threw = '';
  try { await assignTo(sr, 'drvA'); } catch (err) { threw = err.message; }
  check('ledger down, driver with a login: refused before the ride is touched', `${threw}/${onRide(sr)}`, 'ledger unavailable/');
}
{
  // Another assignment lands just after this call writes the ride row.
  const sr = rideWorld();
  const realUpdate = sr.RideBooking.update;
  sr.RideBooking.update = async (id, patch) => { await realUpdate(id, patch); return realUpdate(id, { driver_id: 'drvB' }); };
  const r = await assignTo(sr, 'drvA');
  check('overtaken by another assignment: this call is told it lost', `${r.superseded}/${r.current_driver_id}/${r.earning}`, 'true/drvB/null');
  check('…and leaves no pay held for its driver', heldBy(sr), '');
}

// Two assignments for one ride at the same moment. Each actor is the shipped
// writeAssignment; the walker from the payout section tries the orders their
// database requests could arrive in. Whoever the ride ends with must hold
// exactly one row, nobody else may hold any, and the call whose driver is on
// the ride must not have been told it lost.
//
// An assignment makes more requests than a payout, so walking every order
// would take minutes. Each race below walks every order in which the turn
// changes hands at most a set number of times, which is where two real calls
// overlap, and a random sample with no such limit covers the long tail.
const assignActors = (sr, calls) => calls.map(([driver, payout]) => (gate) => writeAssignment(
  gatedWorld(sr, gate), rideA, driver, payout, END, { driver_id: driver, driver_assigned_at: NOW }, `Reassigned to ${driver}`, NOW));
const assignRace = (calls, driverId = '', earnings = []) => () => {
  const sr = rideWorld(driverId, earnings);
  return { world: { sr, calls }, actors: assignActors(sr, calls) };
};
const ledgerAgrees = ({ sr, calls }, results) => {
  const final = onRide(sr);
  const winners = calls.map(([driver], i) => (driver === final ? i : -1)).filter((i) => i >= 0);
  if (winners.length === 0) return `the ride ended with "${final}"`;
  const tracked = !!calls[winners[0]][1];
  const held = sr.DriverEarning.rows.filter((e) => e.status === 'held');
  const theirs = held.filter((e) => e.driver_id === final);
  if (theirs.length !== (tracked ? 1 : 0)) return `${final} is on the ride with ${theirs.length} held rows`;
  if (held.length !== theirs.length) return `pay is still held for a driver who is not on the ride (${heldBy(sr)})`;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (!r || r.threw) return `a call threw: ${r && r.threw}`;
    if (r.ledger_error) return `a call could not settle the ledger: ${r.ledger_error}`;
    if (winners.includes(i) && r.superseded) return 'the call whose driver is on the ride was told it lost';
    if (winners.includes(i) && tracked && !(r.earning && r.earning.status === 'held')) return 'the winning call was handed no held row';
  }
  return '';
};
// A fixed pseudo-random sequence, so a failing schedule can be run again.
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
async function randomSchedules(setup, verdict, count, seed) {
  const rand = seeded(seed);
  for (let n = 1; n <= count; n += 1) {
    const { world, actors } = setup();
    const trace = [];
    const results = await interleave(actors, (ready) => {
      const pick = ready[Math.floor(rand() * ready.length)];
      trace.push(pick);
      return pick;
    });
    const problem = verdict(world, results);
    if (problem) return { runs: n, problem, schedule: trace.join('') };
  }
  return { runs: count, problem: '', schedule: '' };
}
const A_PAY = ['drvA', dayPay];
const B_PAY = ['drvB', { ...dayPay, amount: 20000, rate: 20000 }];
{
  const out = await everySchedule(assignRace([A_PAY, B_PAY]), ledgerAgrees, 4);
  check(`two drivers assigned at once (${out.runs} orders): whoever is on the ride holds one row, the other none`, `${out.problem}${out.schedule}`, '');
  check('…and that was more than a handful of orders', out.runs > 500, true);
}
{
  const out = await everySchedule(assignRace([A_PAY, B_PAY], 'drvC', [heldRow('c1', 'drvC')]), ledgerAgrees, 4);
  check(`…the same when a third driver was on the ride before (${out.runs})`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await everySchedule(assignRace([A_PAY, A_PAY]), ledgerAgrees, 6);
  check(`the same driver submitted twice at once (${out.runs}): one row, not two`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await everySchedule(assignRace([A_PAY, ['drvU', null]]), ledgerAgrees, 5);
  check(`a driver with a login against one without (${out.runs}): pay is held only if the first is on the ride`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await randomSchedules(assignRace([A_PAY, B_PAY], 'drvC', [heldRow('c1', 'drvC')]), ledgerAgrees, 1500, 7);
  check(`two drivers at once, ${out.runs} random orders with no limit on changes of turn`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await randomSchedules(assignRace([A_PAY, B_PAY, ['drvC', dayPay]]), ledgerAgrees, 500, 20261010);
  check(`three drivers assigned at once, ${out.runs} random orders`, `${out.problem}${out.schedule}`, '');
}

// ── What the rides list tells admin ────────────────────────────────────────
console.log('\n— rides list flags —');
const livePayKeys = make('livePayKeys', liftSrc('getRideBookings', 'livePayKeys', 'earnings'));
same('pay that still stands is keyed by ride and driver', livePayKeys([
  { ride_booking_id: 'r1', driver_id: 'drvA', status: 'held' },
  { ride_booking_id: 'r2', driver_id: 'drvB', status: 'released' },
  { ride_booking_id: 'r3', driver_id: 'drvA', status: 'reversed' },
  null,
]), ['r1:drvA', 'r2:drvB']);
same('no ledger, no keys', livePayKeys(undefined), []);

const T0 = at('2026-08-10T12:00:00.000Z');
const unpaidDriver = {
  payment_status: 'paid', status: 'confirmed', driver_assigned: true, driver_linked: true, driver_pay_recorded: false,
  end_at: '2026-08-10T10:00:00.000Z',
};
check('a driver with a login and no pay on record: flagged', rides.payMissing(unpaidDriver, T0), true);
check('…not once pay is recorded', rides.payMissing({ ...unpaidDriver, driver_pay_recorded: true }, T0), false);
check('…not when the ledger could not be read: no claim is made', rides.payMissing({ ...unpaidDriver, driver_pay_recorded: null }, T0), false);
check('…not for a driver with no login', rides.payMissing({ ...unpaidDriver, driver_linked: false }, T0), false);
check('…not for a ride with no driver', rides.payMissing({ ...unpaidDriver, driver_assigned: false }, T0), false);
check('…not for an unpaid ride', rides.payMissing({ ...unpaidDriver, payment_status: 'unpaid' }, T0), false);
check('…not for a cancelled ride', rides.payMissing({ ...unpaidDriver, status: 'cancelled' }, T0), false);
check('a completed ride is flagged the same way', rides.payMissing({ ...unpaidDriver, status: 'completed' }, T0), true);
check('still flagged a week after the ride ended', rides.payMissing(unpaidDriver, at('2026-08-17T10:00:00.000Z')), true);
check('…but not older history, which was settled outside the app', rides.payMissing(unpaidDriver, at('2026-08-17T10:00:01.000Z')), false);
check('the week is the shipped constant', rides.PAY_NUDGE_DAYS, 7);

const driverless = { payment_status: 'paid', status: 'confirmed', driver_assigned: false };
check('a paid, confirmed ride with no driver needs one', rides.needsDriver(driverless), true);
check('…and still does after the sweep completed it', rides.needsDriver({ ...driverless, status: 'completed' }), true);
check('…not once it has one', rides.needsDriver({ ...driverless, driver_assigned: true }), false);
check('an unpaid ride does not', rides.needsDriver({ ...driverless, payment_status: 'unpaid' }), false);
check('a cancelled ride does not', rides.needsDriver({ ...driverless, status: 'cancelled' }), false);

check('a driver with nothing on record may be deleted', rides.mayDeleteDriver([], []), true);
check('a driver with an earning may not', rides.mayDeleteDriver([{ id: 'e1' }], []), false);
check('a driver with a withdrawal may not', rides.mayDeleteDriver([], [{ id: 'w1' }]), false);
check('a lookup that did not answer is not "nothing on record"', rides.mayDeleteDriver(undefined, []), false);

// ---- result ----
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: the script stops with `TypeError: Cannot read properties of undefined (reading 'map')`, because `reverseHeldEarnings` does not hand back rows yet.

- [ ] **Step 3: `reverseHeldEarnings` hands back the rows it reversed (the cancellation copy)**

The copy in `assignRideDriver` changes the same way in Step 4. The check script fails if the two differ.

**Edit `base44/functions/cancelRideBooking/entry.ts`** — find:

```ts
// they are totalled so the caller can tell admin. Lockstep copy, see
// assignRideDriver; scripts/check-driver-wallet.mjs fails if the two differ.
```

replace with:

```ts
// they are totalled so the caller can tell admin. The rows that were reversed
// are handed back as they were read, pay figures included. Lockstep copy, see
// assignRideDriver; scripts/check-driver-wallet.mjs fails if the two differ.
```

**Edit `base44/functions/cancelRideBooking/entry.ts`** — find:

```ts
    const out = { reversed_ngn: 0, released_ngn: 0, driver_ids: [] };
```

replace with:

```ts
    const out = { reversed_ngn: 0, released_ngn: 0, driver_ids: [], rows: [] };
```

**Edit `base44/functions/cancelRideBooking/entry.ts`** — find:

```ts
            if (!out.driver_ids.includes(e.driver_id)) out.driver_ids.push(e.driver_id);
```

replace with:

```ts
            if (!out.driver_ids.includes(e.driver_id)) out.driver_ids.push(e.driver_id);
            out.rows.push(e);
```

- [ ] **Step 4: Rewrite `assignRideDriver`**

Unchanged, character for character: the ride time model, the pay model (`driverPayoutFor`, `releaseAtFor`, `parsePayoutOverride`), `fetchAll`, `safeIso`, `holdEarning` and `tryPush`. New: `isId`, `isRideBlocked`, `guestIsBlocked`, `busyWindow`, `payoutOf`, `realignLedger`, `writeAssignment`, `assignmentNotices`. Changed: `reverseHeldEarnings` hands back `rows`, and the handler.

**Replace `base44/functions/assignRideDriver/entry.ts` with:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// assignRideDriver
// ----------------------------------------------------------------------------
// Admin attaches a driver to a paid ride. Assignment happens after payment by
// design: approval commits the vehicle, and holding a driver against a booking
// that may still expire would take them out of circulation for nothing.
//
// Enforces driver availability with the same overlap rule used for vehicles,
// filtered on driver_id — a driver cannot be in two cars at once any more than
// a car can be in two places.
//
// Also the moment the driver's pay is HELD. For a driver who has a login
// (Driver.user_email), a DriverEarning row is written for the pay figure —
// what admin typed, or the vehicle's driver cost for the booked duration.
// The sweep releases it two hours after the booked end. A driver without a
// login is assigned exactly as before and nothing is recorded.
//
// TWO ASSIGNMENTS AT ONCE. Nothing here can lock the ride, so a second
// assignment can land a moment before or after this one. writeAssignment
// writes the ride row and then makes the ledger agree with whoever the ride
// row says is driving, however the two calls interleave: that driver ends
// with one held row and nobody else with any. The call that lost is told so
// (SUPERSEDED) and its guest is not notified.
//
// THE SAME DRIVER AGAIN is not a new assignment. It is how pay is recorded
// for a ride that was assigned before the driver had a login, or before pay
// was tracked: the checks on whether this driver should be sent are skipped,
// the guest is not told a second time, and a standing pay row is never
// repriced.

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// Admin blocked this account from rides when resolving a report against it
// (resolveRideReport). Only the boolean true blocks. Lockstep copy, see
// checkRideAvailability.
function isRideBlocked(account: any) {
    return !!account && account.ride_blocked === true;
}

// Whether the account a ride was booked under is blocked from rides. Looks
// only at an account that really has that address: a ride row with no guest
// email must not match whichever account the lookup happened to return.
function guestIsBlocked(accounts: any[], email: string) {
    const wanted = String(email || '').trim().toLowerCase();
    if (!wanted) return false;
    return (accounts || []).some((a) => !!a && String(a.email || '').trim().toLowerCase() === wanted && isRideBlocked(a));
}

// ── Ride time model — lockstep copy, see checkRideAvailability ──────────────
const WAT_OFFSET = '+01:00';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_HOURLY = 8;

// Per-vehicle turnaround — lockstep copy, see checkRideAvailability. A driver
// needs the same clearance between jobs that a car does.
const DEFAULT_TURNAROUND_MS = 1 * HOUR_MS;
function turnaroundMsFor(vehicle: any): number {
    const h = Number(vehicle?.turnaround_hours);
    return Number.isFinite(h) && h >= 0 ? h * HOUR_MS : DEFAULT_TURNAROUND_MS;
}

function rideDurationMs(tier: string, days?: number, hours?: number): number {
    switch (tier) {
        case 'hourly': return Math.min(MAX_HOURLY, Math.max(1, Number(hours) || 1)) * HOUR_MS;
        case '12hr': return 12 * HOUR_MS;
        case '24hr': return DAY_MS;
        case 'multi_day': return Math.max(1, Number(days) || 1) * DAY_MS;
        case 'weekly': return 7 * DAY_MS;
        case 'monthly': return 30 * DAY_MS;
        default: return NaN;
    }
}

function windowOf(r: any): { startMs: number; endMs: number } | null {
    let startMs = Date.parse(r.start_at || '');
    if (Number.isNaN(startMs)) startMs = Date.parse(`${r.service_date}T${r.start_time}:00${WAT_OFFSET}`);
    if (Number.isNaN(startMs)) return null;
    let endMs = Date.parse(r.end_at || '');
    if (Number.isNaN(endMs)) {
        const dur = rideDurationMs(r.duration_tier, r.duration_days, r.duration_hours);
        if (Number.isNaN(dur)) return null;
        endMs = startMs + dur;
    }
    return { startMs, endMs };
}

function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number, buffer: number): boolean {
    return aStart < bEnd + buffer && aEnd + buffer > bStart;
}

// The stretch a ride keeps its driver, or its car, busy, given its booked
// window `w`. A ride still to run, or running, holds them for all of it. A
// completed ride held them until it was completed: at its booked end if the
// sweep closed it, earlier if admin marked it done because the guest finished
// early. The caller adds the turnaround. Lockstep copy in
// checkRideAvailability.
function busyWindow(ride: any, w: any) {
    if (!w) return null;
    if (ride.status !== 'completed') return w;
    const doneMs = Date.parse(ride.completed_at || '');
    if (Number.isNaN(doneMs)) return w;
    return { startMs: w.startMs, endMs: Math.max(w.startMs, Math.min(w.endMs, doneMs)) };
}

// ── Driver pay model ────────────────────────────────────────────────────────
// What a driver is paid for a ride, read off the vehicle's VehicleCosting row.
// MIRRORED client-side by driverPayoutFor in src/config/rides.js, which draws
// the figure in the Assign driver dialog before anything is submitted. This
// copy is the one that reaches the ledger; scripts/check-driver-wallet.mjs
// executes both and fails if they disagree for any duration tier.
//
// Held pay becomes releasable two hours after the booked end, so an
// extra-hour settlement or a complaint from either side can land first.
const RELEASE_BUFFER_MS = 2 * HOUR_MS;
const MAX_PAYOUT_NGN = 50000000;

function driverPayoutFor(costing: any, tier: string, hours?: number, days?: number) {
    if (!costing) return null;
    const perHour = Math.round(Number(costing.driver_cost_per_hour_ngn) || 0);
    const perDay = Math.round(Number(costing.driver_cost_per_day_ngn) || 0);
    let basis = 'daily';
    let rate = perDay;
    let units = 1;
    switch (tier) {
        case 'hourly':
            basis = 'hourly';
            rate = perHour;
            units = Math.min(MAX_HOURLY, Math.max(1, Math.round(Number(hours) || 1)));
            break;
        case '12hr':
        case '24hr':
            break;
        case 'multi_day':
            units = Math.max(1, Math.round(Number(days) || 1));
            break;
        case 'weekly':
            units = 7;
            break;
        case 'monthly':
            units = 30;
            break;
        default:
            return null;
    }
    // Zero means "nobody entered a driver cost", never "this driver is free".
    if (rate <= 0) return null;
    // The booked duration is whatever the guest typed at request time and the
    // rate is whatever admin typed. A product that is not a finite amount
    // under the ceiling is not a pay figure: return nothing, so the dialog
    // asks admin to type one.
    const amount = rate * units;
    if (!Number.isFinite(amount) || amount > MAX_PAYOUT_NGN) return null;
    return { amount, basis, rate, units };
}

function releaseAtFor(endAtIso: string) {
    const endMs = Date.parse(endAtIso || '');
    if (Number.isNaN(endMs)) return null;
    // An end at the very edge of the representable range parses, but two
    // hours later does not exist and toISOString would throw on it.
    const release = new Date(endMs + RELEASE_BUFFER_MS);
    if (Number.isNaN(release.getTime())) return null;
    return release.toISOString();
}

// The pay figure admin typed, if any. { ok: true, value: null } means nothing
// was typed and the costing row decides. Anything that is not a whole-naira
// amount between 0 and the ceiling is refused rather than coerced, so NaN or
// "25,000" read as 25 can never reach the ledger.
function parsePayoutOverride(raw: unknown) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null };
    // Plain digits only. Number() would also swallow "1e3", "0x10" and "+5".
    if (typeof raw === 'string' && !/^\d{1,9}(\.\d+)?$/.test(raw.trim())) return { ok: false, value: null };
    const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PAYOUT_NGN) {
        return { ok: false, value: null };
    }
    return { ok: true, value: Math.round(n) };
}

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, undefined, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

// ── Driver earnings ledger ──────────────────────────────────────────────────
// Bodies are plain JavaScript on purpose: scripts/check-driver-wallet.mjs
// lifts these two off disk and runs them against an in-memory ledger.

// ISO string for an instant, or null when it is not a representable date. A
// ride's end is derived from the duration the guest booked, so it is checked
// before anything calls toISOString on it.
function safeIso(ms: number) {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Hold the new driver's pay. Returns the earning that now stands for this
// driver on this ride, or null when there is nothing to hold. Safe to call
// twice: a standing row is returned as it is, never duplicated or repriced.
async function holdEarning(sr: any, ride: any, driverId: string, payout: any, endAtIso: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: ride.id });
    const standing = ledger.find((e) => e.driver_id === driverId && e.status !== 'reversed');
    if (standing) return standing;
    if (!payout || !(payout.amount > 0)) return null;
    // No readable end means no moment to release at. Refuse loudly rather
    // than write a row that could never be paid out.
    const releaseAt = releaseAtFor(endAtIso);
    if (!releaseAt) throw new Error('holdEarning: this ride has no readable end time');
    await sr.DriverEarning.create({
        driver_id: driverId,
        ride_booking_id: ride.id,
        booking_reference: ride.booking_reference || '',
        vehicle_name: ride.vehicle_name || '',
        service_date: ride.service_date,
        end_at: endAtIso,
        amount_ngn: payout.amount,
        basis: payout.basis,
        rate_ngn: payout.rate,
        units: payout.units,
        status: 'held',
        on_hold: false,
        release_at: releaseAt,
        held_at: nowIso,
    });
    // Two admins assigning in the same second would both reach this line. The
    // oldest held row for this driver and ride stands; any twin is reversed.
    const twins = await fetchAll(sr.DriverEarning, { ride_booking_id: ride.id, driver_id: driverId, status: 'held' });
    twins.sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
        || String(a.id).localeCompare(String(b.id)));
    for (const extra of twins.slice(1)) {
        await sr.DriverEarning.update(extra.id, {
            status: 'reversed', reversed_at: nowIso, admin_notes: `Duplicate of ${twins[0].id}`,
        });
    }
    return twins[0] || null;
}

// Reverse the pay still HELD on a ride for every driver except keepDriverId
// (pass '' to reverse all of it). Released rows are never clawed back here;
// they are totalled so the caller can tell admin. The rows that were reversed
// are handed back as they were read, pay figures included. Lockstep copy in
// cancelRideBooking.
async function reverseHeldEarnings(sr: any, rideId: string, keepDriverId: string, note: string, nowIso: string) {
    const ledger = await fetchAll(sr.DriverEarning, { ride_booking_id: rideId });
    const out = { reversed_ngn: 0, released_ngn: 0, driver_ids: [], rows: [] };
    for (const e of ledger) {
        if (keepDriverId && e.driver_id === keepDriverId) continue;
        const amount = Math.max(0, Math.round(Number(e.amount_ngn) || 0));
        if (e.status === 'held') {
            await sr.DriverEarning.update(e.id, {
                status: 'reversed',
                reversed_at: nowIso,
                on_hold: false,
                admin_notes: e.admin_notes ? `${e.admin_notes} | ${note}` : note,
            });
            out.reversed_ngn += amount;
            if (!out.driver_ids.includes(e.driver_id)) out.driver_ids.push(e.driver_id);
            out.rows.push(e);
        } else if (e.status === 'released') {
            out.released_ngn += amount;
        }
    }
    return out;
}

// The pay figures on a ledger row, in the shape holdEarning takes.
function payoutOf(earning: any) {
    return {
        amount: Math.max(0, Math.round(Number(earning.amount_ngn) || 0)),
        basis: earning.basis || 'manual',
        rate: Math.max(0, Math.round(Number(earning.rate_ngn) || 0)),
        units: Number(earning.units) || 1,
    };
}

// How many times realignLedger looks again before it gives up and says so.
const MAX_REALIGN_PASSES = 6;

// Make the ledger agree with whoever the ride row says is driving NOW. That
// is not always the driver this call just wrote: another assignment for the
// same ride can land a moment before or after this one, and nothing here can
// lock the ride.
//
// Each pass reads the ride, reverses pay still held for anyone else, and
// makes sure the driver on the ride has a standing row. Every write is made
// on a reading of the ride that may be stale by the time it lands, so every
// write is followed by another pass, and the loop ends on a pass that found
// nothing to fix. If this call reversed a row for a driver who turns out to
// be on the ride after all, it holds the same figures for them again, as a
// new row: a reversed row is never revived.
//
// scripts/check-driver-wallet.mjs runs two of these against each other in
// every order their requests could arrive.
async function realignLedger(sr: any, ride: any, driverId: string, payout: any, endAtIso: string, note: string, nowIso: string, heldBefore: any) {
    const out = { settled: false, superseded: false, current_driver_id: '', earning: null, reversed_ngn: 0, released_ngn: 0 };
    // Rows this call reversed, and the ids of rows it created.
    const taken = [];
    const made = heldBefore ? [heldBefore.id] : [];
    for (let pass = 0; pass < MAX_REALIGN_PASSES && !out.settled; pass += 1) {
        const now = await sr.RideBooking.get(ride.id);
        const currentId = (now && now.driver_id) || '';
        const others = await reverseHeldEarnings(sr, ride.id, currentId, note, nowIso);
        taken.push(...others.rows);
        let wrote = others.rows.length > 0;
        // What the driver on the ride should be holding: this call's figure
        // if it is this call's driver, otherwise what this call took off
        // them on an earlier pass, when the ride row still named someone else.
        const theirs = taken.filter((e) => e.driver_id === currentId);
        const figures = currentId === driverId ? payout : (theirs.length > 0 ? payoutOf(theirs[theirs.length - 1]) : null);
        let standing = null;
        if (currentId && figures) {
            standing = await holdEarning(sr, ride, currentId, figures, endAtIso, nowIso);
            if (standing && standing.held_at === nowIso && !made.includes(standing.id)) {
                made.push(standing.id);
                wrote = true;
            }
            // Held, and gone again before this call could look: another call
            // reversed it on a stale reading of the ride. Look again.
            if (!standing && figures.amount > 0) wrote = true;
        }
        out.superseded = currentId !== driverId;
        out.current_driver_id = currentId;
        out.earning = out.superseded ? null : standing;
        out.reversed_ngn += others.reversed_ngn;
        out.released_ngn = others.released_ngn;
        out.settled = !wrote;
    }
    return out;
}

// Everything an assignment writes, in the one order that is safe.
//   1. The pay row. If the ledger cannot be written this throws, and the ride
//      is not handed to a driver whose pay could not be recorded.
//   2. The ride row. `patch` is empty when the same driver is submitted again.
//   3. The ledger is made to agree with the ride row. A failure here is
//      reported in ledger_error, not thrown: the driver IS on the ride by
//      then, and answering "it failed" would be a lie admin might act on.
// `payout` is null for a driver with no login: nothing is recorded for them.
async function writeAssignment(sr: any, ride: any, driverId: string, payout: any, endAtIso: string, patch: any, note: string, nowIso: string) {
    const first = payout ? await holdEarning(sr, ride, driverId, payout, endAtIso, nowIso) : null;
    if (Object.keys(patch || {}).length > 0) await sr.RideBooking.update(ride.id, patch);
    try {
        const out = await realignLedger(sr, ride, driverId, payout, endAtIso, note, nowIso, first);
        return { ...out, ledger_error: out.settled ? '' : 'the ledger did not settle' };
    } catch (err) {
        return {
            settled: false,
            superseded: false,
            current_driver_id: driverId,
            earning: first,
            reversed_ngn: 0,
            released_ngn: 0,
            ledger_error: String((err && err.message) || err),
        };
    }
}

// Who is told about an assignment. The guest hears when a driver is being
// sent to them: not when the same driver is submitted again to record pay,
// and not when a driver is attached to a ride that is already over. The
// driver hears about a new job or, when there is no new job, about pay that
// was recorded just now.
function assignmentNotices(sameDriver: boolean, rideOver: boolean, payIsNew: boolean) {
    const newJob = !sameDriver && !rideOver;
    return { guest: newJob, driver: newJob ? 'assigned' : (payIsNew ? 'pay' : '') };
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

Deno.serve(async (req) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return json({ success: false, error: 'Unauthorized' }, 401);
        if (user.role !== 'admin') return json({ success: false, error: 'Admin access required' }, 403);

        const body = await req.json().catch(() => null);
        const { ride_booking_id, driver_id, pickup_instructions, driver_payout_ngn } = body || {};
        if (!isId(ride_booking_id) || !isId(driver_id)) {
            return json({ success: false, error: 'ride_booking_id and driver_id are required' }, 400);
        }

        const sr = base44.asServiceRole.entities;
        const ride = await sr.RideBooking.get(ride_booking_id);
        if (!ride || ride.id !== ride_booking_id) return json({ success: false, error: 'Ride booking not found' }, 404);
        if (ride.status === 'cancelled') {
            return json({ success: false, error: 'This ride was cancelled', code: 'CANCELLED' }, 409);
        }
        if (ride.payment_status !== 'paid') {
            return json({
                success: false,
                error: 'Assign a driver only after the ride is paid.',
                code: 'NOT_PAID',
            }, 409);
        }

        const driver = await sr.Driver.get(driver_id);
        if (!driver || driver.id !== driver_id) return json({ success: false, error: 'Driver not found' }, 404);

        const win = windowOf(ride);
        if (!win) return json({ success: false, error: 'This ride has an unreadable time window' }, 409);

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        // The same driver again is not a new assignment: see the header.
        const sameDriver = ride.driver_id === driver_id;
        const reassigning = !!ride.driver_id && !sameDriver;
        // Over: the sweep or admin completed it, or its booked window has passed.
        const rideOver = ride.status === 'completed' || nowMs > win.endMs;

        // ── Should this driver be sent? ─────────────────────────────────
        // None of it is asked about the driver who is already on the ride.
        if (!sameDriver) {
            if (driver.active === false || driver.admin_approved === false) {
                return json({
                    success: false,
                    error: 'That driver is inactive or not approved.',
                    code: 'DRIVER_UNAVAILABLE',
                }, 409);
            }

            // A guest admin has blocked from rides is not sent a driver. Not
            // asked about a ride that is already over: recording who drove it
            // sends nobody anywhere.
            if (!rideOver && typeof ride.guest_email === 'string' && ride.guest_email.trim()) {
                const accounts = await sr.User.filter({ email: ride.guest_email });
                if (guestIsBlocked(accounts, ride.guest_email)) {
                    return json({
                        success: false,
                        error: 'This guest is blocked from ride bookings. Cancel this ride, or lift the block under Rides → Reports, before sending a driver.',
                        code: 'GUEST_BLOCKED',
                    }, 409);
                }
            }

            // City mismatch is almost always a mis-click rather than an intent to
            // send a driver between Abuja and Lagos, so it is worth blocking.
            const vehicle = isId(ride.vehicle_id) ? await sr.Vehicle.get(ride.vehicle_id) : null;
            if (vehicle?.city && driver.city && vehicle.city !== driver.city) {
                return json({
                    success: false,
                    error: `${driver.full_name} is based in ${driver.city} but this vehicle is in ${vehicle.city}.`,
                    code: 'CITY_MISMATCH',
                }, 409);
            }

            // Driver double-booking check, same overlap rule as vehicles. A
            // completed ride still counts: it kept its driver until it was
            // completed, and the turnaround after it still applies.
            const theirRides = await fetchAll(sr.RideBooking, {
                driver_id, status: { $in: ['pending', 'confirmed', 'completed'] },
            });
            for (const other of theirRides) {
                if (other.id === ride.id) continue;
                const ow = busyWindow(other, windowOf(other));
                if (!ow) continue;
                if (windowsOverlap(win.startMs, win.endMs, ow.startMs, ow.endMs, turnaroundMsFor(vehicle))) {
                    return json({
                        success: false,
                        error: `${driver.full_name} is already driving another booking in that window.`,
                        code: 'DRIVER_DOUBLE_BOOKED',
                        conflict: {
                            ride_booking_id: other.id,
                            start_at: safeIso(ow.startMs),
                            end_at: safeIso(ow.endMs),
                        },
                    }, 409);
                }
            }
        }

        // ── Driver pay ──────────────────────────────────────────────────
        // Tracked only for a driver who has a login to see it with. ₦0 is a
        // real answer ("paid inside the partner's rate") and holds nothing;
        // no figure at all is refused so nobody drives for an unknown amount.
        const linkedEmail = typeof driver.user_email === 'string' ? driver.user_email.trim().toLowerCase() : '';
        let payout: any = null;
        if (linkedEmail) {
            const typed = parsePayoutOverride(driver_payout_ngn);
            if (!typed.ok) {
                return json({
                    success: false,
                    error: 'Driver pay must be a whole naira amount between 0 and 50,000,000.',
                    code: 'INVALID_PAYOUT',
                }, 400);
            }
            if (typed.value !== null) {
                payout = { amount: typed.value, basis: 'manual', rate: typed.value, units: 1 };
            } else {
                const costings = await sr.VehicleCosting.filter({ vehicle_id: ride.vehicle_id });
                payout = driverPayoutFor(costings?.[0] || null, ride.duration_tier, ride.duration_hours, ride.duration_days);
                if (!payout) {
                    return json({
                        success: false,
                        error: 'No driver cost is set for this vehicle. Enter the pay for this ride, or set it under Vehicles → Internal costing.',
                        code: 'PAYOUT_REQUIRED',
                    }, 409);
                }
            }
        }

        // The ride's end comes from what the guest booked. One that is not a
        // real date cannot be released against, so stop here with a message
        // rather than let toISOString throw further down.
        const endAtIso = safeIso(win.endMs);
        if (linkedEmail && (!endAtIso || !releaseAtFor(endAtIso))) {
            return json({ success: false, error: 'This ride has an unreadable time window', code: 'BAD_WINDOW' }, 409);
        }

        // ── Write ───────────────────────────────────────────────────────
        const instructions = typeof pickup_instructions === 'string' ? pickup_instructions.trim() : '';
        const patch = {
            // The same driver again changes nothing about who is driving.
            ...(sameDriver ? {} : { driver_id, driver_assigned_at: nowIso }),
            // Only overwrite when something was actually typed — a reassignment
            // that leaves the box blank must not wipe instructions already
            // written for this pickup.
            ...(instructions ? { pickup_instructions: instructions } : {}),
        };
        const written = await writeAssignment(
            sr, ride, driver_id, payout, endAtIso, patch, `Reassigned to ${driver.full_name}`, nowIso,
        );
        if (written.ledger_error) {
            console.error(`assignRideDriver: ledger not settled for ride ${ride_booking_id}:`, written.ledger_error);
        }
        if (written.superseded) {
            return json({
                success: false,
                error: `Another assignment for this ride was saved at the same moment, so ${driver.full_name} is not on it. The list shows who is.`,
                code: 'SUPERSEDED',
            }, 409);
        }
        const earning = written.earning;
        // Held by this call, as opposed to a row that was already standing.
        const payIsNew = !!earning && earning.held_at === nowIso;
        const notices = assignmentNotices(sameDriver, rideOver, payIsNew);

        // Guest email with the driver's details — this is the moment the
        // contact becomes visible, so it goes out by email as well as push
        // rather than relying on the guest opening the app.
        if (notices.guest) {
            try {
                const when = new Date(win.startMs).toLocaleString('en-GB', {
                    timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short',
                });
                await base44.integrations.Core.SendEmail({
                    to: ride.guest_email,
                    subject: reassigning
                        ? `Driver update for your ${ride.vehicle_name}`
                        : `Your driver for the ${ride.vehicle_name}`,
                    body: `Hi ${ride.guest_name || 'there'},\n\n` +
                        `${reassigning ? 'Your driver has been changed.' : 'Your driver is confirmed.'}\n\n` +
                        `👤 Driver: ${driver.full_name}\n` +
                        `📞 Phone: ${driver.phone}\n` +
                        (driver.years_experience ? `⭐ Experience: ${driver.years_experience} years\n` : '') +
                        `🚗 Vehicle: ${ride.vehicle_name}\n` +
                        `🕒 Pickup: ${when}\n\n` +
                        `They'll be in touch closer to the time. Safe travels.\n\n` +
                        `— Urban Stays`,
                    from_name: 'Urban Stays',
                });
            } catch (err) {
                console.warn('Driver assignment email failed (non-fatal):', err);
            }

            await tryPush(base44, {
                user_email: ride.guest_email,
                title: reassigning ? '🔄 Driver updated' : '👤 Driver assigned',
                body: `${driver.full_name} will be driving your ${ride.vehicle_name}. Tap for their details.`,
                url: `/Bookings#ride-${ride.id}`,
                tag: `ride-driver-${ride.id}`,
            });
        }

        // The driver hears about it too, now that they have somewhere to look.
        const whenShort = new Date(win.startMs).toLocaleString('en-GB', {
            timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
        });
        if (linkedEmail && notices.driver === 'assigned') {
            await tryPush(base44, {
                user_email: linkedEmail,
                title: '🚗 New ride assigned',
                body: earning && earning.status === 'held'
                    ? `${ride.vehicle_name} on ${whenShort} · ₦${(Number(earning.amount_ngn) || 0).toLocaleString()} held until the trip ends`
                    : `${ride.vehicle_name} on ${whenShort}. Tap for the pickup details.`,
                url: `/DriverRides#ride-${ride.id}`,
                tag: `driver-assigned-${ride.id}`,
            });
        } else if (linkedEmail && notices.driver === 'pay') {
            await tryPush(base44, {
                user_email: linkedEmail,
                title: '💰 Pay recorded',
                body: `₦${(Number(earning.amount_ngn) || 0).toLocaleString()} for the ${ride.vehicle_name} on ${whenShort} is in your wallet, held until it is released.`,
                url: '/DriverWallet',
                tag: `driver-pay-${ride.id}`,
            });
        }
        if (reassigning) {
            try {
                const previous = isId(ride.driver_id) ? await sr.Driver.get(ride.driver_id) : null;
                const previousEmail = typeof previous?.user_email === 'string' ? previous.user_email.trim().toLowerCase() : '';
                if (previousEmail) {
                    await tryPush(base44, {
                        user_email: previousEmail,
                        title: '🔄 Ride reassigned',
                        body: `You are no longer driving the ${ride.vehicle_name} on ${whenShort}.`,
                        url: '/DriverRides',
                        tag: `driver-removed-${ride.id}`,
                    });
                }
            } catch (err) {
                console.warn('Previous driver push failed (non-fatal):', err);
            }
        }

        return json({
            success: true,
            data: {
                ride_booking_id,
                driver_id,
                driver_name: driver.full_name,
                reassigned: reassigning,
                // true when this driver was already on the ride: nothing about
                // the assignment changed, and the guest was not told again.
                already_assigned: sameDriver,
                // false means this driver has no login, so nothing was recorded.
                pay_tracked: !!linkedEmail,
                // true when this call is the one that held the pay.
                pay_recorded: payIsNew,
                driver_payout_ngn: earning ? Number(earning.amount_ngn) || 0 : (payout ? payout.amount : null),
                payout_basis: earning ? earning.basis || null : (payout ? payout.basis : null),
                earning_id: earning ? earning.id : null,
                guest_notified: notices.guest,
                // The previous driver's pay was already released and has NOT
                // been taken back. Admin decides in Rides → Earnings.
                previous_earning_released: written.released_ngn > 0,
                // The driver is on the ride, but the pay records could not be
                // brought fully up to date. Admin is told to look.
                ledger_warning: !!written.ledger_error,
            },
        });
    } catch (error) {
        console.error('assignRideDriver error:', error);
        return json({ success: false, error: 'Internal server error', details: (error as Error).message }, 500);
    }
});
```

- [ ] **Step 5: A completed ride still holds its car until it was completed**

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
    buffer: number,
): boolean {
    return aStart < bEnd + buffer && aEnd + buffer > bStart;
}
```

replace with:

```ts
    buffer: number,
): boolean {
    return aStart < bEnd + buffer && aEnd + buffer > bStart;
}

// The stretch a ride keeps its driver, or its car, busy, given its booked
// window `w`. A ride still to run, or running, holds them for all of it. A
// completed ride held them until it was completed: at its booked end if the
// sweep closed it, earlier if admin marked it done because the guest finished
// early. The caller adds the turnaround. Lockstep copy, see assignRideDriver.
function busyWindow(ride: any, w: any) {
    if (!w) return null;
    if (ride.status !== 'completed') return w;
    const doneMs = Date.parse(ride.completed_at || '');
    if (Number.isNaN(doneMs)) return w;
    return { startMs: w.startMs, endMs: Math.max(w.startMs, Math.min(w.endMs, doneMs)) };
}
```

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
        const held = await fetchAll(base44.asServiceRole.entities.RideBooking, {
            vehicle_id, status: { $in: ['pending', 'confirmed'] },
        });
        for (const other of held) {
            const ow = rideWindow(other);
```

replace with:

```ts
        // A completed ride still counts. The sweep completes a ride the
        // moment its window ends, and leaving it out would let the next
        // booking start inside the turnaround that follows it.
        const held = await fetchAll(base44.asServiceRole.entities.RideBooking, {
            vehicle_id, status: { $in: ['pending', 'confirmed', 'completed'] },
        });
        for (const other of held) {
            const ow = busyWindow(other, rideWindow(other));
```

- [ ] **Step 6: The rides list says which drivers are owed a pay row**

**Edit `base44/functions/getRideBookings/entry.ts`** — find:

```ts
const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, '-created_date', PAGE, skip);
```

replace with:

```ts
// "<ride id>:<driver id>" for every pay row that still stands. Admin only.
function livePayKeys(earnings: any[]) {
    const keys = [];
    for (const e of earnings || []) {
        if (!e || e.status === 'reversed') continue;
        keys.push(`${e.ride_booking_id}:${e.driver_id}`);
    }
    return keys;
}

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, '-created_date', PAGE, skip);
```

**Edit `base44/functions/getRideBookings/entry.ts`** — find:

```ts
        const driverNames = new Map<string, string>();
        if (scope === 'all') {
            const ids = new Set(rides.map((r) => r.driver_id).filter(Boolean));
            if (ids.size > 0) {
                const roster = await fetchAll(base44.asServiceRole.entities.Driver, {});
                for (const d of roster) {
                    if (ids.has(d.id)) driverNames.set(d.id, d.full_name || '');
                }
            }
        }
```

replace with:

```ts
        const driverNames = new Map<string, string>();
        // Admin only: which assigned drivers have a login, and which rides
        // already have pay standing for their driver. Together they let the
        // list point at a ride whose driver should be paid through the app
        // and is not, which is every ride assigned before the driver was
        // given a login. `paid` stays null if the ledger cannot be read, and
        // the client then makes no claim either way.
        const linkedDrivers = new Set<string>();
        let paid: Set<string> | null = null;
        if (scope === 'all') {
            const ids = new Set(rides.map((r) => r.driver_id).filter(Boolean));
            if (ids.size > 0) {
                const roster = await fetchAll(base44.asServiceRole.entities.Driver, {});
                for (const d of roster) {
                    if (!ids.has(d.id)) continue;
                    driverNames.set(d.id, d.full_name || '');
                    if (String(d.user_email || '').trim()) linkedDrivers.add(d.id);
                }
                try {
                    const standing = await fetchAll(base44.asServiceRole.entities.DriverEarning, {
                        status: { $in: ['held', 'released'] },
                    });
                    paid = new Set(livePayKeys(standing));
                } catch (err) {
                    console.warn('Could not read driver earnings (the ride list is unaffected):', err);
                }
            }
        }
```

**Edit `base44/functions/getRideBookings/entry.ts`** — find:

```ts
                driver_assigned: !!r.driver_id,
```

replace with:

```ts
                driver_assigned: !!r.driver_id,
                // Admin only. driver_pay_recorded is null when the ledger
                // could not be read.
                driver_linked: scope === 'all' ? linkedDrivers.has(r.driver_id) : undefined,
                driver_pay_recorded: scope === 'all' ? (paid ? paid.has(`${r.id}:${r.driver_id}`) : null) : undefined,
```

- [ ] **Step 7: The three decisions the admin screens make**

**Edit `src/config/rides.js`** — find:

```js
  return { ok: true, value };
}

// ── Ride reports ────────────────────────────────────────────────────────────
```

replace with:

```js
  return { ok: true, value };
}

// ── What the admin rides list points at ─────────────────────────────────────
// Days after a ride's end during which admin is still nudged to record pay
// for a driver who had none. Older rides were settled outside the app.
export const PAY_NUDGE_DAYS = 7;

// Whether this ride's driver has a login but no pay on record for it: a ride
// assigned before the driver was given a login, or before pay was tracked.
// Reads the two flags getRideBookings sends to admin. driver_pay_recorded is
// null when the ledger could not be read, and then no claim is made.
export function payMissing(ride, nowMs) {
  if (!ride || ride.payment_status !== 'paid' || ride.status === 'cancelled') return false;
  if (!ride.driver_assigned || !ride.driver_linked || ride.driver_pay_recorded !== false) return false;
  const endMs = Date.parse(ride.end_at || '');
  if (Number.isNaN(endMs)) return true;
  return nowMs <= endMs + PAY_NUDGE_DAYS * 24 * 60 * 60 * 1000;
}

// A paid ride nobody has been assigned to. A ride the sweep has already
// completed still counts: who drove it, and their pay, can be recorded after
// the fact.
export const needsDriver = (ride) => !!ride
  && ride.payment_status === 'paid'
  && (ride.status === 'confirmed' || ride.status === 'completed')
  && !ride.driver_assigned;

// Whether a driver profile may be deleted: only when both lookups answered
// and found nothing. Earnings and withdrawals hang off the profile's id, so a
// driver with either is switched to inactive instead.
export const mayDeleteDriver = (earnings, withdrawals) => Array.isArray(earnings)
  && Array.isArray(withdrawals)
  && earnings.length === 0
  && withdrawals.length === 0;

// ── Ride reports ────────────────────────────────────────────────────────────
```

- [ ] **Step 8: The Assign dialog and the rides list**

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
import {
  categoryLabel, ADJUSTMENT_REASONS, driverPayoutFor, typedDriverPay, RELEASE_BUFFER_HOURS,
} from '@/config/rides';
```

replace with:

```jsx
import {
  categoryLabel, ADJUSTMENT_REASONS, driverPayoutFor, typedDriverPay, RELEASE_BUFFER_HOURS,
  payMissing, needsDriver,
} from '@/config/rides';
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
  const [pay, setPay] = useState('');
  const [suggested, setSuggested] = useState(null);
```

replace with:

```jsx
  const [pay, setPay] = useState('');
  const [suggested, setSuggested] = useState(null);
  // Whether the driver already on this ride has pay recorded for it. null
  // until the ledger has been read; "Record pay" is only offered on false.
  const [currentPaid, setCurrentPaid] = useState(null);
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
    setPay('');
    setSuggested(null);
    if (!ride) return undefined;
```

replace with:

```jsx
    setPay('');
    setSuggested(null);
    setCurrentPaid(null);
    if (!ride) return undefined;
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
        const [costings, held] = await Promise.all([
          base44.entities.VehicleCosting.filter({ vehicle_id: ride.vehicle_id }),
          base44.entities.DriverEarning.filter({ ride_booking_id: ride.id, status: 'held' }),
        ]);
        if (cancelled) return;
        setSuggested(driverPayoutFor(costings?.[0] || null, ride.duration_tier, {
          hours: ride.duration_hours, days: ride.duration_days,
        }));
        // Changing the driver: start from the figure the outgoing driver was promised.
        const current = Array.isArray(held) && held.length > 0 ? held[0] : null;
        if (current) setPay(String(Math.round(Number(current.amount_ngn) || 0)));
```

replace with:

```jsx
        const [costings, ledger] = await Promise.all([
          base44.entities.VehicleCosting.filter({ vehicle_id: ride.vehicle_id }),
          base44.entities.DriverEarning.filter({ ride_booking_id: ride.id }),
        ]);
        if (cancelled) return;
        setSuggested(driverPayoutFor(costings?.[0] || null, ride.duration_tier, {
          hours: ride.duration_hours, days: ride.duration_days,
        }));
        const standing = (Array.isArray(ledger) ? ledger : []).filter((e) => e.status !== 'reversed');
        setCurrentPaid(!!ride.driver_id && standing.some((e) => e.driver_id === ride.driver_id));
        // Changing the driver: start from the figure the outgoing driver was promised.
        const current = standing.find((e) => e.status === 'held') || null;
        if (current) setPay(String(Math.round(Number(current.amount_ngn) || 0)));
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
    setSaving(null);
    if (!r.ok) {
      toast({ title: 'Could not assign', description: r.error, variant: 'destructive' });
      return;
    }
```

replace with:

```jsx
    setSaving(null);
    if (!r.ok) {
      toast({
        title: r.code === 'SUPERSEDED' ? 'Someone else just assigned this ride' : 'Could not assign',
        description: r.error,
        variant: 'destructive',
      });
      // The list on screen is out of date: close and reload it.
      if (r.code === 'SUPERSEDED') onAssigned();
      return;
    }
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
    toast({
      title: ride?.driver_id ? 'Driver changed' : 'Driver assigned',
      description: `${driver.full_name} is on this ride. The guest has been emailed and notified. ${payNote}`,
    });
```

replace with:

```jsx
    if (d.already_assigned) {
      // The same driver again: nothing about the ride changed, only the ledger.
      toast({
        title: d.pay_recorded ? 'Pay recorded' : 'Nothing changed',
        description: d.pay_recorded
          ? `${ngn(d.driver_payout_ngn)} is now held for ${driver.full_name} on this ride. The guest was not contacted again.`
          : `${driver.full_name} was already on this ride. ${payNote}`,
      });
    } else {
      toast({
        title: ride?.driver_id ? 'Driver changed' : 'Driver assigned',
        description: `${driver.full_name} is on this ride. ${d.guest_notified ? 'The guest has been emailed and notified. ' : ''}${payNote}`,
      });
    }
    if (d.ledger_warning) {
      toast({
        title: 'Check this ride under Earnings',
        description: 'The driver is on the ride, but the pay records could not be brought fully up to date. Open Rides → Earnings and look at the rows for this ride.',
        variant: 'destructive',
      });
    }
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
                <Button
                  size="sm"
                  variant={d.id === ride?.driver_id ? 'outline' : 'default'}
                  disabled={saving === d.id || d.id === ride?.driver_id}
                  onClick={() => assign(d)}
                  className="rounded-xl flex-shrink-0"
                >
                  {saving === d.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : d.id === ride?.driver_id ? 'Assigned' : 'Assign'}
                </Button>
```

replace with:

```jsx
                {/* One save at a time: every button waits while any is in
                    flight, so a slip onto the wrong driver cannot be followed
                    by a second click that races it. The driver already on the
                    ride gets "Record pay" when they have a login and nothing
                    on the ledger for this ride, which is how pay is added for
                    a ride assigned before pay was tracked. */}
                <Button
                  size="sm"
                  variant={d.id === ride?.driver_id ? 'outline' : 'default'}
                  disabled={!!saving || (d.id === ride?.driver_id && !(d.user_email && currentPaid === false))}
                  onClick={() => assign(d)}
                  className="rounded-xl flex-shrink-0"
                >
                  {saving === d.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : d.id !== ride?.driver_id ? 'Assign'
                      : d.user_email && currentPaid === false ? 'Record pay' : 'Assigned'}
                </Button>
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
      ? rides.filter((r) => r.payment_status === 'paid' && r.status === 'confirmed' && !r.driver_assigned)
      : rides.filter((r) => r.bucket === filter);
  const needsDriverCount = rides.filter(
    (r) => r.payment_status === 'paid' && r.status === 'confirmed' && !r.driver_assigned,
  ).length;
```

replace with:

```jsx
      ? rides.filter(needsDriver)
      : rides.filter((r) => r.bucket === filter);
  const needsDriverCount = rides.filter(needsDriver).length;
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
                        {r.driver_assigned && (
                          <Badge variant="outline" className="text-xs">
                            {r.driver_name ? `Driver: ${r.driver_name}` : 'Driver assigned'}
                          </Badge>
                        )}
```

replace with:

```jsx
                        {r.driver_assigned && (
                          <Badge variant="outline" className="text-xs">
                            {r.driver_name ? `Driver: ${r.driver_name}` : 'Driver assigned'}
                          </Badge>
                        )}
                        {payMissing(r, Date.now()) && (
                          <Badge className="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-0 text-xs">
                            No pay recorded
                          </Badge>
                        )}
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
                    {r.payment_status === 'paid' && r.status === 'confirmed'
                      && (!r.driver_assigned || r.bucket === 'upcoming' || r.bucket === 'current') && (
```

replace with:

```jsx
                    {/* A ride the sweep has completed keeps this button while
                        it has no driver, or its driver has no pay recorded. */}
                    {r.payment_status === 'paid' && (r.status === 'confirmed' || r.status === 'completed')
                      && (!r.driver_assigned || r.bucket === 'upcoming' || r.bucket === 'current' || payMissing(r, Date.now())) && (
```

**Edit `src/components/admin/RidesAdmin.jsx`** — find:

```jsx
                          {r.driver_assigned ? 'Change driver' : 'Assign driver'}
```

replace with:

```jsx
                          {!r.driver_assigned ? 'Assign driver' : payMissing(r, Date.now()) ? 'Record pay' : 'Change driver'}
```

- [ ] **Step 9: A driver with pay on record is deactivated, not deleted**

**Edit `src/components/admin/DriversAdmin.jsx`** — find:

```jsx
import { CITIES, normaliseEmail, looksLikeEmail, driverLoginPatch } from '@/config/rides';
```

replace with:

```jsx
import { CITIES, normaliseEmail, looksLikeEmail, driverLoginPatch, mayDeleteDriver } from '@/config/rides';
```

**Edit `src/components/admin/DriversAdmin.jsx`** — find:

```jsx
    setDeletingId(toDelete.id);
    try {
      await base44.entities.Driver.delete(toDelete.id);
      toast({ title: 'Driver removed' });
```

replace with:

```jsx
    setDeletingId(toDelete.id);
    try {
      // Earnings and withdrawals hang off the profile's id. Delete the profile
      // and the driver's wallet, and any payout waiting on it, are orphaned.
      // Both entities are admin-only at the API, like Driver itself. If either
      // lookup fails this throws, and nothing is deleted.
      const [earnings, withdrawals] = await Promise.all([
        base44.entities.DriverEarning.filter({ driver_id: toDelete.id }, undefined, 1),
        base44.entities.WithdrawalRequest.filter({ driver_id: toDelete.id }, undefined, 1),
      ]);
      if (!mayDeleteDriver(earnings, withdrawals)) {
        toast({
          title: 'This driver has pay on record',
          description: `${toDelete.full_name} has earnings or withdrawals in the app, so the profile cannot be removed. Switch them to inactive instead: they are no longer offered rides and keep access to their wallet.`,
          variant: 'destructive',
        });
        return;
      }
      await base44.entities.Driver.delete(toDelete.id);
      toast({ title: 'Driver removed' });
```

**Edit `src/components/admin/DriversAdmin.jsx`** — find:

```jsx
              resolving — deactivate instead if they might return.
```

replace with:

```jsx
              resolving — deactivate instead if they might return. A driver
              with earnings or withdrawals on record cannot be removed at all.
```

- [ ] **Step 10: Run the checks**

Run: `npm run check`

Expected: five `PASS` lines, with every line under `— assignment under concurrency —` and `— rides list flags —` ok.

The walker's bounds are chosen so the whole script stays under five seconds. A one-off run at wider bounds on 2026-10-10 also passed: 165,084 orders for two drivers (up to six changes of turn), 65,996 with a third driver already on the ride (up to five), 37,097 for a driver with a login against one without (up to seven), and 20,000 random orders of three assignments at once. The same wider run is what found the last defect in this task before it was fixed: a call that held a pay row, had it reversed by the other call on a stale reading, and finished without looking again.

Run: `for f in assignRideDriver cancelRideBooking checkRideAvailability getRideBookings; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done; npm run lint`

Expected: no `PARSE FAIL` line, no lint output.

- [ ] **Step 11: Sandbox checklist (after the next publish)**

1. Open the Assign dialog for a paid ride in two tabs. Assign driver A in one and driver B in the other as close together as you can. Expected: the ride shows one of them; Rides → Earnings has exactly one held row for this ride, for that driver; if one tab was overtaken it says "Someone else just assigned this ride".
2. In one tab, press Assign for a driver. Expected: every Assign button in the dialog is disabled until the answer arrives.
3. Assign a driver who has no login. Then give them a login on the Drivers tab. Expected: the ride shows the amber "No pay recorded" badge and a "Record pay" button; the dialog shows "Record pay" beside that driver; pressing it holds the pay, the driver gets a push, and the guest gets no second email.
4. Let the sweep complete a paid ride that has no driver. Expected: it is still listed under "Needs a driver" and still has "Assign driver". Assigning one after the fact sends the guest nothing.
5. Mark a running ride completed at its midpoint. Expected: the same driver can be assigned to another ride starting more than the vehicle's turnaround later, and the same vehicle can be requested for that slot. A ride the sweep completed at its end still blocks a pickup inside the turnaround.
6. Block a guest from a ride report, then try to assign a driver to another upcoming paid ride of theirs. Expected: "This guest is blocked from ride bookings…" and no assignment.
7. Try to remove a driver who has an earning. Expected: "This driver has pay on record"; the profile is still there.

- [ ] **Step 12: Commit**

```bash
git add scripts/check-driver-wallet.mjs base44/functions/assignRideDriver/entry.ts base44/functions/cancelRideBooking/entry.ts base44/functions/checkRideAvailability/entry.ts base44/functions/getRideBookings/entry.ts src/config/rides.js src/components/admin/RidesAdmin.jsx src/components/admin/DriversAdmin.jsx
git commit -m "fix(rides): the driver on the ride always has their pay row, whoever else was assigning" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task R03: A reversal always wins

**Findings closed:** admin reversing a driver's pay at the same moment the sweep (or another admin) released it could leave the row saying released, with the money available to withdraw; the same for a reassignment or a cancellation that reversed a held row while the sweep was releasing it. Also: `settleDriverEarning` and `completeRide` looked up whatever id the request carried.

**Files:**
- Modify: `scripts/check-driver-wallet.mjs` (one helper list; new section above `// ---- result ----`)
- Modify: `scripts/check-ride-reports.mjs` (one helper list)
- Modify: `base44/functions/getDriverWallet/entry.ts`, `createWithdrawalRequest/entry.ts`, `processWithdrawal/entry.ts`, `getDriverEarningsAdmin/entry.ts`, `getDashboardStats/entry.ts` (`walletTotals`, all five copies)
- Modify: `base44/functions/autoCancelExpiredBookings/entry.ts` (`isReleasable`, `keepReversed`, `settleDueEarning`)
- Modify: `base44/functions/settleDriverEarning/entry.ts` (`isId`, `nextEarningState`, `keepReversed`, `writeEarningChange`, the handler)
- Modify: `base44/functions/completeRide/entry.ts` (`isId`)

**Interfaces:**
- Changes: `walletTotals(earnings, withdrawals)` counts no earning that carries `reversed_at`. Same signature and result shape.
- Changes: `isReleasable(earning, nowMs)` is false for a row that carries `reversed_at`. `nextEarningState(...)` answers `ALREADY_REVERSED` for any action but `reverse` on such a row.
- Produces: `keepReversed(sr, earningId) → the row as it now stands`, lockstep in `autoCancelExpiredBookings` and `settleDriverEarning`.
- Produces, in `settleDriverEarning/entry.ts`: `writeEarningChange(sr, earning, patch) → the row as it now stands`; refusal `REVERSED_MEANWHILE` (409).
- `settleDueEarning` now answers `'reversed'` when a release it wrote was put back.

**Why two layers.** Nothing on this platform can lock a row. A release reads the row as held, decides, and writes `status: 'released'`; a reversal made in between is overwritten. `reversed_at` is the one mark that survives, because nothing ever clears it. So:

1. The arithmetic does not depend on who won: `walletTotals` counts no row that carries `reversed_at`, whatever its status says. This is what protects the money, in every one of the five functions that compute a balance.
2. The row is put right: every write that sets a status other than reversed is followed by `keepReversed`, which reads the row again and restores `reversed` if it carries a reversal time. This is what makes the screens agree with the arithmetic.

- [ ] **Step 1: Write the failing checks**

`settleDueEarning` is about to call `keepReversed`, so both scripts that lift it need that helper beside it.

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  sweepSrc('hasOpenGuestReport', 'sr, rideBookingId'), sweepSrc('settleDueEarning', 'sr, earningId, nowMs'));
```

replace with:

```js
  sweepSrc('hasOpenGuestReport', 'sr, rideBookingId'), sweepSrc('keepReversed', 'sr, earningId'),
  sweepSrc('settleDueEarning', 'sr, earningId, nowMs'));
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
  liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId'), liftSrc(SWEEP, 'settleDueEarning', 'sr, earningId, nowMs'));
```

replace with:

```js
  liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId'), liftSrc(SWEEP, 'keepReversed', 'sr, earningId'),
  liftSrc(SWEEP, 'settleDueEarning', 'sr, earningId, nowMs'));
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── A reversal always wins ─────────────────────────────────────────────────
console.log('\n— a reversal always wins —');
const SE = 'settleDriverEarning';
identical('isId', 'value', [PW, SE]);
identical('isId', 'value', [PW, 'completeRide']);
identical('keepReversed', 'sr, earningId', ['autoCancelExpiredBookings', SE]);

// The arithmetic first: it is what stands between a lost race and money. A
// release that landed on top of a reversal leaves this row behind.
const overwritten = { id: 'e1', status: 'released', amount_ngn: 20000, released_at: AT, reversed_at: AT };
same('a released row that carries a reversal time counts nowhere', walletTotals([overwritten], []), ZERO);
same('…nor a held one', walletTotals([{ ...overwritten, status: 'held' }], []), ZERO);
same('…and it covers nothing already paid out: that is a shortfall',
  walletTotals([overwritten], [wd('a', { amount: 20000 })]), { ...ZERO, paid_out: 20000, shortfall: 20000 });
same('a row that was never reversed counts as before',
  walletTotals([{ ...overwritten, reversed_at: undefined }], []), { ...ZERO, released: 20000, available: 20000 });

check('a row that carries a reversal time is never releasable', isReleasable(due({ reversed_at: AT }), DUE), false);
same('a release on a row that carries a reversal time is refused',
  nextEarningState('release', { ...heldE, reversed_at: AT }, {}, AT), refusal('ALREADY_REVERSED'));
same('…and so is an adjustment',
  nextEarningState('adjust', { ...heldE, reversed_at: AT }, { reason: 'extra hour', amount_ngn: 18000 }, AT), refusal('ALREADY_REVERSED'));
check('…but reversing it again is allowed, which puts its status right',
  nextEarningState('reverse', overwritten, { reason: 'guest never showed' }, AT).patch.status, 'reversed');

const keepReversed = make('keepReversed', liftSrc(SE, 'keepReversed', 'sr, earningId'));
{
  const sr = { DriverEarning: fakeEntity([overwritten]) };
  const row = await keepReversed(sr, 'e1');
  check('a release that landed on a reversal is put back', `${sr.DriverEarning.rows[0].status}/${row.status}`, 'reversed/reversed');
  check('…keeping the time it was reversed', sr.DriverEarning.rows[0].reversed_at, AT);
}
{
  const sr = { DriverEarning: fakeEntity([{ ...overwritten, reversed_at: undefined }]) };
  let writes = 0;
  const realUpdate = sr.DriverEarning.update;
  sr.DriverEarning.update = async (...args) => { writes += 1; return realUpdate(...args); };
  const row = await keepReversed(sr, 'e1');
  check('an ordinary released row is left alone', `${row.status}/${writes}`, 'released/0');
}
{
  const sr = { DriverEarning: fakeEntity([]) };
  check('a row that no longer exists is not an error', await keepReversed(sr, 'gone'), null);
}

// The race itself, in every order. Each actor is shipped code: the sweep's
// settleDueEarning, and what settleDriverEarning does for one action (read
// the row, decide with nextEarningState, write with writeEarningChange).
const writeEarningChange = make('writeEarningChange',
  liftSrc(SE, 'keepReversed', 'sr, earningId'), liftSrc(SE, 'writeEarningChange', 'sr, earning, patch'));
const adminMove = (w, action, input = {}) => async (gate) => {
  const sr = gatedWorld(w, gate);
  const e = await sr.DriverEarning.get('e1');
  const next = nextEarningState(action, e, input, AT);
  if (!next.ok) return next.code;
  const row = await writeEarningChange(sr, e, next.patch);
  return row.status;
};
const sweepRelease = (w) => (gate) => settleDueEarning(gatedWorld(w, gate), 'e1', DUE);
const reversalStands = (w) => {
  const row = w.DriverEarning.rows[0];
  if (row.status !== 'reversed' || !row.reversed_at) return `the row ended ${row.status}`;
  if (walletTotals([row], []).available !== 0) return 'reversed pay is still available';
  return '';
};
const WHY = { reason: 'guest never showed' };
{
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    return { world: w, actors: [sweepRelease(w), adminMove(w, 'reverse', WHY)] };
  }, reversalStands);
  check(`the sweep releases while admin reverses, every order (${out.runs}): the pay ends reversed`, `${out.problem}${out.schedule}`, '');
  check('…and that was more than one order', out.runs > 10, true);
}
{
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    return { world: w, actors: [adminMove(w, 'release'), adminMove(w, 'reverse', WHY)] };
  }, reversalStands);
  check(`one admin releases while another reverses, every order (${out.runs})`, `${out.problem}${out.schedule}`, '');
}
{
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    return { world: w, actors: [sweepRelease(w), adminMove(w, 'release'), adminMove(w, 'reverse', WHY)] };
  }, reversalStands, 4);
  check(`the sweep and an admin both release while another admin reverses (${out.runs})`, `${out.problem}${out.schedule}`, '');
}
{
  // A release that was told the truth: when the sweep says "released", the
  // row was not reversed underneath it at that moment, and when a reversal
  // did get in first the sweep says so and sends the driver no "available" push.
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    return { world: w, actors: [sweepRelease(w), adminMove(w, 'reverse', WHY)] };
  }, (w, results) => (['released', 'reversed', 'skipped'].includes(results[0]) ? '' : `the sweep answered ${results[0]}`));
  check('…and the sweep only ever answers released, reversed or skipped', `${out.problem}${out.schedule}`, '');
}
{
  // The ride is handed to another driver while the sweep is releasing the
  // first driver's pay. Either the reassignment reversed the row and it stays
  // reversed, or the release got there first and the reassignment reports
  // pay that was already released. Never both.
  const out = await everySchedule(() => {
    const w = world(due(), drivenRide());
    const reassign = async (gate) => {
      const sr = gatedWorld(w, gate);
      await sr.RideBooking.update('ride1', { driver_id: 'drvB' });
      return reverseHeldEarnings(sr, 'ride1', 'drvB', 'Reassigned to drvB', AT);
    };
    return { world: w, actors: [sweepRelease(w), reassign] };
  }, (w, results) => {
    const row = w.DriverEarning.rows[0];
    const moved = results[1];
    if (row.reversed_at && row.status !== 'reversed') return `reversed, then overwritten as ${row.status}`;
    if (row.status === 'released' && moved.reversed_ngn > 0) return 'the reassignment believes it reversed pay that ended released';
    if (row.status === 'held') return 'the pay was neither released nor reversed';
    return '';
  });
  check(`the sweep releases while the ride is reassigned, every order (${out.runs})`, `${out.problem}${out.schedule}`, '');
}

// ---- result ----
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: could not find keepReversed in base44/functions/autoCancelExpiredBookings/entry.ts`.

Run: `node scripts/check-ride-reports.mjs`

Expected: the same error.

- [ ] **Step 3: The arithmetic counts no row that was ever reversed**

The same change in all five copies. The check script fails if any copy differs from the one in `getDriverWallet`.

**Edit `base44/functions/getDriverWallet/entry.ts`** — find:

```ts
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

replace with:

```ts
        // A row that has ever been reversed counts nowhere, whatever its
        // status says. Nothing here can lock a row, so a release can land on
        // top of a reversal made a moment earlier; reversed_at is never
        // cleared, which makes it the one mark that cannot be lost that way.
        if (!e || e.reversed_at) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

**Edit `base44/functions/createWithdrawalRequest/entry.ts`** — find:

```ts
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

replace with:

```ts
        // A row that has ever been reversed counts nowhere, whatever its
        // status says. Nothing here can lock a row, so a release can land on
        // top of a reversal made a moment earlier; reversed_at is never
        // cleared, which makes it the one mark that cannot be lost that way.
        if (!e || e.reversed_at) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

**Edit `base44/functions/processWithdrawal/entry.ts`** — find:

```ts
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

replace with:

```ts
        // A row that has ever been reversed counts nowhere, whatever its
        // status says. Nothing here can lock a row, so a release can land on
        // top of a reversal made a moment earlier; reversed_at is never
        // cleared, which makes it the one mark that cannot be lost that way.
        if (!e || e.reversed_at) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

**Edit `base44/functions/getDriverEarningsAdmin/entry.ts`** — find:

```ts
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

replace with:

```ts
        // A row that has ever been reversed counts nowhere, whatever its
        // status says. Nothing here can lock a row, so a release can land on
        // top of a reversal made a moment earlier; reversed_at is never
        // cleared, which makes it the one mark that cannot be lost that way.
        if (!e || e.reversed_at) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

**Edit `base44/functions/getDashboardStats/entry.ts`** — find:

```ts
        if (!e) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

replace with:

```ts
        // A row that has ever been reversed counts nowhere, whatever its
        // status says. Nothing here can lock a row, so a release can land on
        // top of a reversal made a moment earlier; reversed_at is never
        // cleared, which makes it the one mark that cannot be lost that way.
        if (!e || e.reversed_at) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
```

- [ ] **Step 4: The sweep puts a reversal back if its release landed on one**

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
    if (!earning || earning.status !== 'held' || earning.on_hold) return false;
```

replace with:

```ts
    if (!earning || earning.status !== 'held' || earning.on_hold || earning.reversed_at) return false;
```

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
// Settle one due earning: 'released' | 'reversed' | 'held' | 'skipped'.
```

replace with:

```ts
// A reversal always wins. Nothing here can lock a row, so a release can land
// on top of a reversal made a moment earlier and leave the row saying
// "released". reversed_at is never cleared, so after any write that sets a
// status other than reversed the row is read again, and put back if it
// carries one. Returns the row as it now stands. Lockstep copy in
// settleDriverEarning.
async function keepReversed(sr: any, earningId: string) {
    const fresh = await sr.DriverEarning.get(earningId);
    if (!fresh || !fresh.reversed_at || fresh.status === 'reversed') return fresh;
    await sr.DriverEarning.update(earningId, { status: 'reversed', on_hold: false });
    return { ...fresh, status: 'reversed', on_hold: false };
}

// Settle one due earning: 'released' | 'reversed' | 'held' | 'skipped'.
```

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
    await sr.DriverEarning.update(e.id, {
        status: 'released', released_at: nowIso, on_hold: false, hold_reason: '',
    });
    return 'released';
}
```

replace with:

```ts
    await sr.DriverEarning.update(e.id, {
        status: 'released', released_at: nowIso, on_hold: false, hold_reason: '',
    });
    // Admin, a reassignment or a cancellation may have reversed this row
    // while the ride was being read. If so it stays reversed, and the caller
    // does not tell the driver it was released.
    const after = await keepReversed(sr, e.id);
    return after && after.status === 'reversed' ? 'reversed' : 'released';
}
```

- [ ] **Step 5: Admin's moves do the same, and only look up a plain id**

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
    ALREADY_REVERSED: { status: 409, error: 'This pay has already been reversed.' },
};
```

replace with:

```ts
    ALREADY_REVERSED: { status: 409, error: 'This pay has already been reversed.' },
    REVERSED_MEANWHILE: { status: 409, error: 'This pay was reversed while that change was being saved. It stays reversed.' },
};

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
```

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
    if (status === 'reversed') return { ok: false, code: 'ALREADY_REVERSED' };
```

replace with:

```ts
    if (status === 'reversed') return { ok: false, code: 'ALREADY_REVERSED' };
    // A row that carries a reversal time is reversed, even if a release that
    // landed at the same moment left its status saying otherwise. The one
    // move still allowed is to reverse it again, which puts the status right.
    if (earning && earning.reversed_at && action !== 'reverse') return { ok: false, code: 'ALREADY_REVERSED' };
```

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
async function tryPush(sdk: any, opts: Record<string, unknown>) {
```

replace with:

```ts
// A reversal always wins. Nothing here can lock a row, so a release can land
// on top of a reversal made a moment earlier and leave the row saying
// "released". reversed_at is never cleared, so after any write that sets a
// status other than reversed the row is read again, and put back if it
// carries one. Returns the row as it now stands. Lockstep copy, see
// autoCancelExpiredBookings.
async function keepReversed(sr: any, earningId: string) {
    const fresh = await sr.DriverEarning.get(earningId);
    if (!fresh || !fresh.reversed_at || fresh.status === 'reversed') return fresh;
    await sr.DriverEarning.update(earningId, { status: 'reversed', on_hold: false });
    return { ...fresh, status: 'reversed', on_hold: false };
}

// Write a decided change and hand back the row as it now stands. A change
// that is not itself a reversal is followed by keepReversed, so a reversal
// made while this one was being decided is not overwritten.
async function writeEarningChange(sr: any, earning: any, patch: any) {
    await sr.DriverEarning.update(earning.id, patch);
    if (patch && patch.status === 'reversed') return sr.DriverEarning.get(earning.id);
    return keepReversed(sr, earning.id);
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
```

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
        const { earning_id, action, reason, amount_ngn } = await req.json().catch(() => ({}));
        if (!earning_id || typeof action !== 'string') {
            return json({ success: false, error: 'earning_id and action are required' }, 400);
        }

        const sr = base44.asServiceRole.entities;
        const earning = await sr.DriverEarning.get(earning_id);
        if (!earning) return json({ success: false, error: 'That pay record no longer exists.', code: 'NOT_FOUND' }, 404);
```

replace with:

```ts
        const body = await req.json().catch(() => null);
        const { earning_id, action, reason, amount_ngn } = body || {};
        if (!isId(earning_id) || typeof action !== 'string') {
            return json({ success: false, error: 'earning_id and action are required' }, 400);
        }

        const sr = base44.asServiceRole.entities;
        const earning = await sr.DriverEarning.get(earning_id);
        if (!earning || earning.id !== earning_id) {
            return json({ success: false, error: 'That pay record no longer exists.', code: 'NOT_FOUND' }, 404);
        }
```

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
            const ride = await sr.RideBooking.get(earning.ride_booking_id);
            const verdict = releaseDecision(earning, ride);
```

replace with:

```ts
            const ride = isId(earning.ride_booking_id) ? await sr.RideBooking.get(earning.ride_booking_id) : null;
            const verdict = releaseDecision(earning, ride);
```

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
        await sr.DriverEarning.update(earning.id, next.patch);
        const updated = await sr.DriverEarning.get(earning.id);

        if (action === 'release') {
```

replace with:

```ts
        const updated = await writeEarningChange(sr, earning, next.patch);
        // Somebody reversed this pay while the change above was being decided.
        // The reversal stands, and admin is told that, not that the change
        // was saved. No "your pay is available" push goes out either.
        if (action !== 'reverse' && updated && updated.status === 'reversed') {
            const refusal = REFUSALS.REVERSED_MEANWHILE;
            return json({ success: false, error: refusal.error, code: 'REVERSED_MEANWHILE' }, refusal.status);
        }

        if (action === 'release') {
```

- [ ] **Step 6: `completeRide` only looks up a plain id**

**Edit `base44/functions/completeRide/entry.ts`** — find:

```ts
Deno.serve(async (req) => {
```

replace with:

```ts
// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

Deno.serve(async (req) => {
```

**Edit `base44/functions/completeRide/entry.ts`** — find:

```ts
        const { ride_booking_id } = await req.json().catch(() => ({}));
        if (!ride_booking_id) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const sr = base44.asServiceRole.entities;
        const ride = await sr.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found', code: 'NOT_FOUND' }, 404);
```

replace with:

```ts
        const body = await req.json().catch(() => null);
        const ride_booking_id = body?.ride_booking_id;
        if (!isId(ride_booking_id)) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const sr = base44.asServiceRole.entities;
        const ride = await sr.RideBooking.get(ride_booking_id);
        if (!ride || ride.id !== ride_booking_id) {
            return json({ success: false, error: 'Ride booking not found', code: 'NOT_FOUND' }, 404);
        }
```

- [ ] **Step 7: Run the checks**

Run: `npm run check`

Expected: five `PASS` lines, with every line under `— a reversal always wins —` ok.

Run: `for f in getDriverWallet createWithdrawalRequest processWithdrawal getDriverEarningsAdmin getDashboardStats autoCancelExpiredBookings settleDriverEarning completeRide; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done; npm run lint`

Expected: no `PARSE FAIL` line, no lint output.

- [ ] **Step 8: Sandbox checklist (after the next publish)**

A real race cannot be forced by hand, so the sandbox step checks the two layers separately.

1. In the data editor, take a released `DriverEarning` row and set `reversed_at` to now, leaving `status` as `released`. Expected: the driver's wallet no longer counts it as available; Admin → Overview "Driver pay owed" drops by the same amount; a withdrawal for that money is refused.
2. In Rides → Earnings, press Release on a held row whose `reversed_at` you have set by hand. Expected: "This pay has already been reversed."
3. Reverse a released row from Rides → Earnings. Expected: unchanged from before this task. The row shows Reversed, and the driver's available balance drops.

- [ ] **Step 9: Commit**

```bash
git add scripts/check-driver-wallet.mjs scripts/check-ride-reports.mjs base44/functions/getDriverWallet/entry.ts base44/functions/createWithdrawalRequest/entry.ts base44/functions/processWithdrawal/entry.ts base44/functions/getDriverEarningsAdmin/entry.ts base44/functions/getDashboardStats/entry.ts base44/functions/autoCancelExpiredBookings/entry.ts base44/functions/settleDriverEarning/entry.ts base44/functions/completeRide/entry.ts
git commit -m "fix(rides): a reversal of a driver's pay always wins over a release" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task R04: Ride rows are written by the server

**Findings closed:** `checkRideAvailability` created the ride row as the signed-in guest, which is why the `RideBooking` create rule has to let any signed-in user create one, and that rule only pins the guest's email: a row can be made by hand already marked confirmed and paid, a free ride for the guest and a job for a driver whose pay the app would then hold and release. A guest blocked from rides after requesting one could still pay for it. Also: the payment page showed "Could not load payment information" for every refusal from `startRidePayment`, and a driver looking at a ride with no pay on record was told it was "arranged with the team".

**Files:**
- Modify: `scripts/check-entities.mjs` (staged `RideBooking` rule; nothing creates a staged entity as the caller)
- Modify: `scripts/check-driver-wallet.mjs` (new section above `// ---- result ----`)
- Create: `docs/entity-rules-pending-publish/RideBooking.jsonc`
- Modify: `docs/entity-rules-pending-publish/README.md`
- Modify: `base44/functions/checkRideAvailability/entry.ts` (`isId`; the row is created under the service role)
- Modify: `base44/functions/startRidePayment/entry.ts` (`isId`; a blocked guest cannot start a payment)
- Modify: `src/pages/PaymentPage.jsx` (the server's sentence is shown)
- Modify: `src/config/rides.js` (`noPayLine`), `src/components/driver/DriverRideCard.jsx`

**Interfaces:**
- Produces: the staged rule `RideBooking.create` admin-only. It goes live with the others, right after the next Publish (see the README in that folder). Until then the hole it closes is still open.
- Produces, in `startRidePayment/entry.ts`: lockstep copies of `isId`, `isRideBlocked` and `guestIsBlocked`; refusal `RIDE_BLOCKED` (403), same sentence as `checkRideAvailability`.
- Produces, in `src/config/rides.js`: `noPayLine(bucket) → { tone, text }`.
- Changes: `payLine(earning, bucket)` in `DriverRideCard.jsx` takes the ride's bucket.

**What this does and does not close today.** Creating the row under the service role changes nothing a guest can do until the staged rule is applied: the live rule still lets a browser create a ride row. What this task does is make the strict rule safe to apply, and pin that in a check, so that on publish day it is one copy and one push. The check added to `scripts/check-entities.mjs` fails if any function creates a staged entity as the caller, or if the browser code creates one at all.

- [ ] **Step 1: Write the failing checks**

**Edit `scripts/check-entities.mjs`** — find:

```js
check('staged WithdrawalRequest: reading is unchanged',
  JSON.stringify(stagedWithdrawal?.rls?.read) === JSON.stringify(entities.WithdrawalRequest?.rls?.read));
```

replace with:

```js
check('staged WithdrawalRequest: reading is unchanged',
  JSON.stringify(stagedWithdrawal?.rls?.read) === JSON.stringify(entities.WithdrawalRequest?.rls?.read));

const stagedRide = stagedFiles.includes('RideBooking.jsonc')
  ? JSON.parse(stripComments(fs.readFileSync(path.join(STAGED, 'RideBooking.jsonc'), 'utf8')))
  : null;
// Until this is live, a signed-in user can create a ride row by hand with any
// status on it, including confirmed and paid. checkRideAvailability creates
// under the service role, so the strict rule breaks nothing once published.
check('staged RideBooking: only the server may create a row', adminOnly(stagedRide?.rls?.create));
for (const op of ['read', 'update', 'delete']) {
  check(`staged RideBooking: ${op} is unchanged`,
    !!stagedRide && JSON.stringify(stagedRide.rls?.[op]) === JSON.stringify(entities.RideBooking?.rls?.[op]));
}

// A staged "only the server may create" rule is safe to apply only if nothing
// creates that row as the signed-in user: no function (it must go through
// asServiceRole) and nothing in the browser. This is the README's "Needs"
// column, checked.
const filesUnder = (dir, exts) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const full = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'node_modules' ? [] : filesUnder(full, exts);
  return exts.some((e) => d.name.endsWith(e)) ? [full] : [];
});
const functionFiles = filesUnder(path.join(ROOT, 'base44/functions'), ['.ts']);
const browserFiles = filesUnder(path.join(ROOT, 'src'), ['.js', '.jsx']);
const rel = (file) => path.relative(ROOT, file);
for (const file of stagedFiles) {
  const stem = file.replace(/\.jsonc$/, '');
  const staged = JSON.parse(stripComments(fs.readFileSync(path.join(STAGED, file), 'utf8')));
  if (!adminOnly(staged.rls?.create)) continue;
  const asCaller = new RegExp(`(?<!asServiceRole)\\.entities\\.${stem}\\.(create|bulkCreate)\\(`);
  const inBrowser = new RegExp(`\\b${stem}\\.(create|bulkCreate)\\(`);
  const offenders = [
    ...functionFiles.filter((f) => asCaller.test(fs.readFileSync(f, 'utf8'))),
    ...browserFiles.filter((f) => inBrowser.test(fs.readFileSync(f, 'utf8'))),
  ].map(rel);
  check(`nothing creates a ${stem} as the signed-in user`, offenders.length === 0, offenders.join(', '));
}
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Ride rows are written by the server ────────────────────────────────────
console.log('\n— ride rows —');
identical('isId', 'value', [PW, 'checkRideAvailability']);
identical('isId', 'value', [PW, 'startRidePayment']);
identical('isRideBlocked', 'account', ['checkRideAvailability', 'startRidePayment']);
identical('guestIsBlocked', 'accounts, email', [AR, 'startRidePayment']);

// What a driver is told about a ride with no pay on record. It is the only
// warning they get that the app is not holding anything for them.
check('before the ride: confirm with the team first', rides.noPayLine('upcoming').text.includes('before you set off'), true);
check('…and it stands out', rides.noPayLine('upcoming').tone, 'warn');
check('…the same while the ride is running', rides.noPayLine('current').tone, 'warn');
check('after the ride: ask if some was expected', rides.noPayLine('past').text.includes('Ask the team'), true);
check('…quietly', rides.noPayLine('past').tone, 'muted');
check('a cancelled ride promises nothing either way', rides.noPayLine('cancelled').text, 'No pay is recorded in the app for this ride.');
check('no sentence claims pay has been arranged',
  ['upcoming', 'current', 'past', 'cancelled'].some((b) => /arranged/i.test(rides.noPayLine(b).text)), false);

// ---- result ----
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node scripts/check-entities.mjs`

Expected: ` FAIL  staged RideBooking: only the server may create a row`, and the three lines after it.

Run: `node scripts/check-driver-wallet.mjs`

Expected: `Error: could not find isId in base44/functions/checkRideAvailability/entry.ts`.

- [ ] **Step 3: Stage the strict rule**

A copy of `base44/entities/RideBooking.jsonc` as it stands, with one change: `rls.create` is admin-only. `scripts/check-entities.mjs` fails if the two ever list different fields.

**Create `docs/entity-rules-pending-publish/RideBooking.jsonc`:**

```json
{
  "name": "RideBooking",
  "type": "object",
  "description": "A booking for a Vehicle (chauffeur-driven hire). Mirrors the Booking entity's lifecycle so the Bookings page can show rides in the same Pending/Upcoming/Active/Completed/Cancelled tabs.",
  "properties": {
    "vehicle_id": {
      "type": "string",
      "description": "FK to Vehicle"
    },
    "vehicle_name": {
      "type": "string",
      "description": "Snapshotted at booking time so the row keeps a readable label even if the Vehicle row is later deleted"
    },
    "vehicle_image": {
      "type": "string",
      "description": "Snapshot of the primary vehicle image at booking time"
    },
    "guest_name": {
      "type": "string"
    },
    "guest_email": {
      "type": "string"
    },
    "guest_phone": {
      "type": "string",
      "description": "Required at booking time \u2014 admin uses this to coordinate pickup"
    },
    "service_date": {
      "type": "string",
      "format": "date",
      "description": "The pickup date (YYYY-MM-DD). For multi-day bookings this is day 1."
    },
    "start_time": {
      "type": "string",
      "description": "Pickup time in HH:MM (24h)"
    },
    "booking_reference": {
      "type": "string",
      "description": "Human-quotable reference (UD-XXXXXX) generated at request time. For the guest to cite in messages and for admin to search on \u2014 the row id stays the actual key."
    },
    "duration_tier": {
      "type": "string",
      "enum": [
        "hourly",
        "12hr",
        "24hr",
        "multi_day",
        "weekly",
        "monthly"
      ],
      "description": "Which pricing tier was selected at checkout. '12hr' is presented to guests as 'Full day (12 hours)' \u2014 the value was deliberately not renamed, since renaming would orphan every existing row for the sake of a label."
    },
    "duration_hours": {
      "type": "number",
      "description": "For hourly bookings, how many hours (1-8). Ignored for every other tier."
    },
    "duration_days": {
      "type": "number",
      "description": "For multi_day bookings, the total number of days. Always 1 for hourly/12hr/24hr."
    },
    "start_at": {
      "type": "string",
      "format": "date-time",
      "description": "Computed pickup datetime, derived from service_date + start_time pinned to WAT (UTC+1). Stored rather than re-derived so overlap queries and bucketing are cheap and every consumer agrees on the same instant."
    },
    "end_at": {
      "type": "string",
      "format": "date-time",
      "description": "Computed end datetime in ISO format. start_at + the duration implied by duration_tier. Drives conflict detection."
    },
    "pickup_location": {
      "type": "object",
      "properties": {
        "address": {
          "type": "string"
        },
        "area": {
          "type": "string",
          "description": "Neighborhood / district (Maitama, Lekki, etc.)"
        },
        "city": {
          "type": "string",
          "description": "Always inherited from the vehicle, never entered by the guest, so pickup can't drift to a city the car isn't in. Not an enum \u2014 see Vehicle.city."
        },
        "coordinates": {
          "type": "object",
          "properties": {
            "lat": {
              "type": "number"
            },
            "lng": {
              "type": "number"
            }
          }
        }
      }
    },
    "dropoff_location": {
      "type": "object",
      "description": "Optional. For known one-way trips. Otherwise the driver follows the guest's plan throughout the booking window.",
      "properties": {
        "address": {
          "type": "string"
        },
        "area": {
          "type": "string"
        },
        "city": {
          "type": "string"
        }
      }
    },
    "passengers": {
      "type": "number",
      "default": 1
    },
    "special_requests": {
      "type": "string"
    },
    "estimated_price": {
      "type": "number",
      "description": "What the guest was quoted when they submitted the request, computed server-side from the Vehicle. Frozen \u2014 never rewritten. total_price may diverge from it once admin confirms, and the guest is shown both."
    },
    "total_price": {
      "type": "number",
      "description": "The NGN amount actually charged. Starts equal to estimated_price and is the only figure payment ever reads, so admin adjusting it at approval needs no change to the payment path."
    },
    "price_adjustment_reason": {
      "type": "string",
      "description": "Why total_price differs from estimated_price (airport surcharge, extra waiting time, fuel). Mandatory whenever admin changes the figure \u2014 a silent price rise between quote and payment must be impossible."
    },
    "extra_hour_rate_ngn": {
      "type": "number",
      "description": "The per-hour overage rate the guest agreed to when they requested, snapshotted from the Vehicle (like vehicle_name) so a later price edit on the car cannot change what this booking's extra time costs. Shown in the confirmation email and on the booking card; admin applies it when settling extra time after the trip."
    },
    "suggested_vehicle_ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Set when admin rejects because the chosen vehicle is unavailable but similar cars in the same city are free. The guest sees these as alternatives instead of a dead end."
    },
    "pickup_instructions": {
      "type": "string",
      "description": "Free-text note from admin for the pickup itself ('driver waits at the Zone 4 gate, call on arrival'). Written at driver assignment and shown alongside the driver's contact details."
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "confirmed",
        "completed",
        "cancelled"
      ],
      "default": "pending"
    },
    "payment_status": {
      "type": "string",
      "enum": [
        "unpaid",
        "paid",
        "refunded"
      ],
      "default": "unpaid"
    },
    "approved_at": {
      "type": "string",
      "format": "date-time",
      "description": "When admin approved the request \u2014 same role as Booking.approved_at. Also the decision idempotency guard: a row with approved_at set has already been decided."
    },
    "admin_response": {
      "type": "string",
      "description": "Decision message shown to the guest. Lives here rather than on a separate request entity \u2014 Rides deliberately uses one row per request, unlike the apartment flow's AvailabilityRequest + Booking split."
    },
    "telegram_message_id": {
      "type": "string",
      "description": "Id of the admin Telegram message, so it can be edited in place when the decision is made."
    },
    "payment_deadline": {
      "type": "string",
      "format": "date-time",
      "description": "Auto-cancel timer \u2014 same role as Booking.payment_deadline"
    },
    "payment_started_at": {
      "type": "string",
      "format": "date-time",
      "description": "Stamped server-side by startRidePayment on first open of the payment page. Never written by the client."
    },
    "paid_at": {
      "type": "string",
      "format": "date-time",
      "description": "When payment cleared. Revenue reporting keys off this."
    },
    "payment_method": {
      "type": "string",
      "enum": [
        "paystack",
        "other"
      ],
      "default": "paystack"
    },
    "cancel_reason": {
      "type": "string",
      "enum": [
        "admin_rejected",
        "payment_expired",
        "user_cancelled",
        "other"
      ],
      "description": "Why the booking ended. Matches the Booking enum so the UI can reuse the same status badge component."
    },
    "transaction_hash": {
      "type": "string",
      "description": "Paystack transaction reference for idempotency"
    },
    "driver_id": {
      "type": "string",
      "description": "FK to Driver. Assigned by admin when confirming the booking \u2014 null until then. RLS hides this field from guests until the booking is confirmed AND paid."
    },
    "driver_assigned_at": {
      "type": "string",
      "format": "date-time",
      "description": "When admin assigned a driver. Used by the UI to know when to surface the driver contact card."
    },
    "payment_warning_pushed_at": {
      "type": "string",
      "format": "date-time",
      "description": "Idempotency stamp for the 5-minute payment warning push, so a re-run of the sweep cannot double-notify."
    },
    "driver_arrival_push_sent_at": {
      "type": "string",
      "format": "date-time",
      "description": "Idempotency stamp for the driver-arriving-soon push (~30 min before start_at)."
    },
    "linked_property_booking_id": {
      "type": "string",
      "description": "Optional FK to a Booking row when the ride was added from an existing property stay (Phase 3 hook)"
    },
    "completed_at": {
      "type": "string",
      "format": "date-time",
      "description": "When the ride was marked completed. Set by the sweep once the booked window is over, or by admin through completeRide."
    },
    "completed_by": {
      "type": "string",
      "enum": [
        "system",
        "admin"
      ],
      "description": "Who completed it. The driver's pay is deliberately NOT stored on this row: a guest can read their own RideBooking, and the pay lives on DriverEarning."
    }
  },
  "required": [
    "vehicle_id",
    "guest_email",
    "guest_phone",
    "service_date",
    "start_time",
    "duration_tier"
  ],
  "rls": {
    "create": {
      "user_condition": {
        "role": "admin"
      }
    },
    "read": {
      "$or": [
        {
          "user_condition": {
            "role": "admin"
          }
        },
        {
          "data.guest_email": "{{user.email}}"
        }
      ]
    },
    "update": {
      "user_condition": {
        "role": "admin"
      }
    },
    "delete": {
      "user_condition": {
        "role": "admin"
      }
    }
  }
}
```

**Edit `docs/entity-rules-pending-publish/README.md`** — find:

```md
These three schema files are the **intended** access rules for Booking,
LoyaltyTransaction and User. They are kept outside `base44/` entirely because a
```

replace with:

```md
These schema files are the **intended** access rules for the entities in the
table below. They are kept outside `base44/` entirely because a
```

**Edit `docs/entity-rules-pending-publish/README.md`** — find:

```md
`referral_balance_ngn` on User is already admin-write live; nothing in the
```

replace with:

```md
| `RideBooking.jsonc` | `create` admin-only | `checkRideAvailability` from the review hardening (2026-10), which creates the row under the service role. Until this rule is live a signed-in user can create a ride row by hand with any status on it, including confirmed and paid: a free ride, and a job a driver would be paid for |

`scripts/check-entities.mjs` checks the "Needs" column for every file here
whose rule is `create` admin-only: it fails if any function creates that
entity as the caller, or if the browser code creates one at all.

`referral_balance_ngn` on User is already admin-write live; nothing in the
```

**Edit `docs/entity-rules-pending-publish/README.md`** — find:

```md
   a test payment, complete a social quest, and confirm
   `base44.auth.updateMe({ loyalty_points: 1 })` is refused from the console.
```

replace with:

```md
   a test payment, complete a social quest, and confirm
   `base44.auth.updateMe({ loyalty_points: 1 })` is refused from the console.
   Then request a ride through the app (it must still work) and confirm that
   `base44.entities.RideBooking.create({ ... })` and
   `base44.entities.WithdrawalRequest.create({ ... })` are both refused from
   the console.
```

- [ ] **Step 4: `checkRideAvailability` creates the row itself**

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
// Admin blocked this account from rides when resolving a report against it
// (resolveRideReport). Only the boolean true blocks.
```

replace with:

```ts
// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// Admin blocked this account from rides when resolving a report against it
// (resolveRideReport). Only the boolean true blocks.
```

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
        const vehicle = await base44.asServiceRole.entities.Vehicle.get(vehicle_id);
        if (!vehicle) return json({ success: false, error: 'Vehicle not found' }, 404);
```

replace with:

```ts
        const vehicle = isId(vehicle_id) ? await base44.asServiceRole.entities.Vehicle.get(vehicle_id) : null;
        if (!vehicle || vehicle.id !== vehicle_id) return json({ success: false, error: 'Vehicle not found' }, 404);
```

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
            const stay = await base44.asServiceRole.entities.Booking.get(linked_property_booking_id);
            if (!stay || stay.guest_email !== user.email) {
```

replace with:

```ts
            const stay = isId(linked_property_booking_id)
                ? await base44.asServiceRole.entities.Booking.get(linked_property_booking_id)
                : null;
            if (!stay || stay.id !== linked_property_booking_id || stay.guest_email !== user.email) {
```

**Edit `base44/functions/checkRideAvailability/entry.ts`** — find:

```ts
        const ride = await base44.entities.RideBooking.create(payload);
```

replace with:

```ts
        // Created under the service role, never as the guest. Every figure on
        // this row was worked out above from the Vehicle and the clock. The
        // access rule staged in docs/entity-rules-pending-publish stops a
        // browser creating a ride row at all; once it is live, this line is
        // the only way a ride comes to exist. Until then a row can still be
        // made by hand with any status on it.
        const ride = await base44.asServiceRole.entities.RideBooking.create(payload);
```

- [ ] **Step 5: A guest blocked from rides cannot start a payment**

The block is checked when a ride is requested and (Task R02) when a driver is assigned. A guest blocked in between could still pay. The payment page is the last place to stop them before money moves.

**Edit `base44/functions/startRidePayment/entry.ts`** — find:

```ts
Deno.serve(async (req) => {
```

replace with:

```ts
// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// Admin blocked this account from rides when resolving a report against it
// (resolveRideReport). Only the boolean true blocks. Lockstep copy, see
// checkRideAvailability.
function isRideBlocked(account: any) {
    return !!account && account.ride_blocked === true;
}

// Whether the account a ride was booked under is blocked from rides. Looks
// only at an account that really has that address: a ride row with no guest
// email must not match whichever account the lookup happened to return.
// Lockstep copy, see assignRideDriver.
function guestIsBlocked(accounts: any[], email: string) {
    const wanted = String(email || '').trim().toLowerCase();
    if (!wanted) return false;
    return (accounts || []).some((a) => !!a && String(a.email || '').trim().toLowerCase() === wanted && isRideBlocked(a));
}

Deno.serve(async (req) => {
```

**Edit `base44/functions/startRidePayment/entry.ts`** — find:

```ts
        const { ride_booking_id } = await req.json().catch(() => ({}));
        if (!ride_booking_id) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const ride = await base44.asServiceRole.entities.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found' }, 404);
```

replace with:

```ts
        const body = await req.json().catch(() => null);
        const ride_booking_id = body?.ride_booking_id;
        if (!isId(ride_booking_id)) return json({ success: false, error: 'ride_booking_id is required' }, 400);

        const ride = await base44.asServiceRole.entities.RideBooking.get(ride_booking_id);
        if (!ride || ride.id !== ride_booking_id) return json({ success: false, error: 'Ride booking not found' }, 404);
```

**Edit `base44/functions/startRidePayment/entry.ts`** — find:

```ts
        if (ride.payment_status === 'paid') {
            return json({ success: true, data: { already_paid: true, ride_booking_id } });
        }
```

replace with:

```ts
        if (ride.payment_status === 'paid') {
            return json({ success: true, data: { already_paid: true, ride_booking_id } });
        }
        // Blocked since this ride was requested. Read fresh under the service
        // role, not from the session, so a block takes effect at once. Admin
        // opening the page on a guest's behalf is not stopped.
        if (user.role !== 'admin') {
            const accounts = await base44.asServiceRole.entities.User.filter({ email: user.email });
            if (guestIsBlocked(accounts, user.email)) {
                return json({
                    success: false,
                    error: 'Ride bookings are not available on this account. Please contact support.',
                    code: 'RIDE_BLOCKED',
                }, 403);
            }
        }
```

- [ ] **Step 6: The payment page shows what the server said**

`base44.functions.invoke` throws on any refusal, so every one of them (not approved, cancelled, window closed, and now blocked) fell into the page's catch and came out as "Could not load payment information. Please restart the booking process." A ride that was already paid came back as a success with no price and was drawn as a ₦0 payment.

**Edit `src/pages/PaymentPage.jsx`** — find:

```jsx
import { base44 } from '@/api/base44Client';
```

replace with:

```jsx
import { base44 } from '@/api/base44Client';
import { invokeFn } from '@/lib/invokeFn';
```

**Edit `src/pages/PaymentPage.jsx`** — find:

```jsx
        const startRes = await base44.functions.invoke('startRidePayment', {
          ride_booking_id: rideBookingId,
        });
        if (!startRes?.data?.success) {
          setError(startRes?.data?.error || 'This ride is not ready for payment.');
          setIsPageLoading(false);
          return;
        }
        const r = startRes.data.data;
```

replace with:

```jsx
        // invokeFn never throws, so a refusal arrives as the server's own
        // sentence ("The payment window for this ride has closed.") instead
        // of falling into the catch below as a generic failure.
        const start = await invokeFn('startRidePayment', { ride_booking_id: rideBookingId });
        if (!start.ok) {
          setError(start.error || 'This ride is not ready for payment.');
          setIsPageLoading(false);
          return;
        }
        const r = start.data || {};
        if (r.already_paid) {
          setError('This ride has already been paid for.');
          setIsPageLoading(false);
          return;
        }
```

- [ ] **Step 7: A driver is told when the app is holding nothing for a ride**

**Edit `src/config/rides.js`** — find:

```js
  && earnings.length === 0
  && withdrawals.length === 0;
```

replace with:

```js
  && earnings.length === 0
  && withdrawals.length === 0;

// ── What a driver is told about a ride with no pay on record ────────────────
// No earning row means the app is holding nothing for this ride: the driver
// had no login when it was assigned, or the figure was ₦0. Before the ride
// that is something to settle with the team first, so it is said plainly and
// in the warning colour. It never says pay has been arranged: the app does
// not know that.
export function noPayLine(bucket) {
  if (bucket === 'upcoming' || bucket === 'current') {
    return { tone: 'warn', text: 'No pay is recorded in the app for this ride. Confirm it with the team before you set off.' };
  }
  if (bucket === 'past') {
    return { tone: 'muted', text: 'No pay was recorded in the app for this ride. Ask the team if you were expecting some.' };
  }
  return { tone: 'muted', text: 'No pay is recorded in the app for this ride.' };
}
```

**Edit `src/components/driver/DriverRideCard.jsx`** — find:

```jsx
import { durationLabel } from '@/config/rides';
```

replace with:

```jsx
import { durationLabel, noPayLine } from '@/config/rides';
```

**Edit `src/components/driver/DriverRideCard.jsx`** — find:

```jsx
// The one sentence about money. A ride with no earning row predates pay
// tracking or was assigned at ₦0; either way the driver is told who to ask.
export function payLine(earning) {
  if (!earning) return { tone: 'muted', text: 'Pay for this ride is arranged with the team.' };
```

replace with:

```jsx
// The one sentence about money. A ride with no earning row predates pay
// tracking or was assigned at ₦0; either way the driver is told the app is
// holding nothing for it, and before the ride, to confirm with the team.
export function payLine(earning, bucket) {
  if (!earning) return noPayLine(bucket);
```

**Edit `src/components/driver/DriverRideCard.jsx`** — find:

```jsx
  const pay = payLine(ride.earning);
```

replace with:

```jsx
  const pay = payLine(ride.earning, ride.bucket);
```

- [ ] **Step 8: Run the checks**

Run: `npm run check`

Expected: five `PASS` lines. Under `— staged rules —`: `nothing creates a LoyaltyTransaction as the signed-in user`, the same for `RideBooking` and for `WithdrawalRequest`, all ok.

Run: `for f in checkRideAvailability startRidePayment; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done; npm run lint`

Expected: no `PARSE FAIL` line, no lint output.

- [ ] **Step 9: Sandbox checklist (after the next publish)**

1. Before the staged rules are applied, request a ride through the app. Expected: it works as before, and the new row's `created_by` is the app's service account, not the guest.
2. Apply the staged rules (README, step 4). From the browser console as a signed-in guest run `base44.entities.RideBooking.create({ vehicle_id: '<a real id>', guest_email: '<own email>', guest_phone: '0800', service_date: '2026-12-01', start_time: '10:00', duration_tier: '24hr', status: 'confirmed', payment_status: 'paid' })`. Expected: refused. Then request a ride through the app. Expected: it still works.
3. Block a guest from a ride report while they have an approved, unpaid ride. Open its payment page as that guest. Expected: "Ride bookings are not available on this account. Please contact support.", and no Paystack button.
4. Open the payment page for a ride whose window has closed. Expected: "The payment window for this ride has closed.", not "Could not load payment information".
5. As a driver, open My rides with an upcoming ride that has no pay recorded. Expected: the orange line "No pay is recorded in the app for this ride. Confirm it with the team before you set off."

- [ ] **Step 10: Commit**

```bash
git add scripts/check-entities.mjs scripts/check-driver-wallet.mjs docs/entity-rules-pending-publish/RideBooking.jsonc docs/entity-rules-pending-publish/README.md base44/functions/checkRideAvailability/entry.ts base44/functions/startRidePayment/entry.ts src/pages/PaymentPage.jsx src/config/rides.js src/components/driver/DriverRideCard.jsx
git commit -m "fix(rides): the server writes ride rows, and a blocked guest cannot pay for one" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task R05: A report is filed once, holds only the driver it is about, and carries only real uploads

**Findings closed:** `createRideReport` looked the ride up by the id in the request but used that same string for its "already reported" check and stored it on the row, so `<id>#1`, `<id>#2`, … each fetched the same ride and each passed as a first report: one person could stack reports on one ride without limit. A guest's open complaint held the pay of whoever was on the ride, so a complaint about driver A held driver B's pay after the ride was handed over, and B's wallet said "under review". A report "photo" could be any https link, which admin's browser then fetched: the reporter chose the server that learned when admin opened the report, and what admin was shown. `resolveRideReport` looked up whatever id the request carried.

**Files:**
- Modify: `scripts/check-ride-reports.mjs`, `scripts/check-driver-wallet.mjs` (one helper signature)
- Modify: `base44/functions/createRideReport/entry.ts` (`isId`, `UPLOAD_URL`, `isUploadUrl`, `fileRideReport`, the handler)
- Modify: `base44/functions/autoCancelExpiredBookings/entry.ts`, `base44/functions/settleDriverEarning/entry.ts` (`hasOpenGuestReport` takes the driver)
- Modify: `base44/functions/getDriverWallet/entry.ts`, `base44/functions/getDriverRides/entry.ts` (`ridesUnderReviewFor`)
- Modify: `base44/functions/resolveRideReport/entry.ts` (`isId`)
- Modify: `src/config/rides.js` (`UPLOAD_URL`, `safePhotoUrl`), `src/components/rides/RideReportDialog.jsx`

**Interfaces:**
- Changes: `hasOpenGuestReport(sr, rideBookingId, driverId)`. Both copies. True only for an open or reviewing report filed by the guest that names that driver.
- Produces, in `createRideReport/entry.ts`: `isId` (lockstep); `UPLOAD_URL`; `isUploadUrl(url) → boolean`; `fileRideReport(sr, ride, reporter, input) → { ok: true, id, row } | { ok: false, code: 'ALREADY_REPORTED' }`, where `reporter` is `{ email, role, name, reported_name }`.
- Produces: `ridesUnderReviewFor(reports, driverId) → ride ids`, lockstep in `getDriverWallet` and `getDriverRides`.
- Changes, in `src/config/rides.js`: `safePhotoUrl(url)` accepts only what `isUploadUrl` accepts; exports `UPLOAD_URL`.

**Where uploads live.** Every file this app has uploaded is at `https://base44.app/api/apps/<24 hex>/files/…`: all 148 file links on the live listings, checked on 2026-10-10, with no query string on any of them. The rule accepts exactly that shape. If the platform ever moves its file store, report photos will be refused at the upload step with a message that says so, and the two copies of `UPLOAD_URL` are the one thing to change.

- [ ] **Step 1: Write the failing checks**

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  sweepSrc('hasOpenGuestReport', 'sr, rideBookingId'), sweepSrc('keepReversed', 'sr, earningId'),
```

replace with:

```js
  sweepSrc('hasOpenGuestReport', 'sr, rideBookingId, driverId'), sweepSrc('keepReversed', 'sr, earningId'),
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
identical('notifyAdminLine', 'text', ['autoCancelExpiredBookings', 'createRideReport']);
```

replace with:

```js
identical('notifyAdminLine', 'text', ['autoCancelExpiredBookings', 'createRideReport']);
identical('isId', 'value', ['processWithdrawal', 'createRideReport']);
identical('isId', 'value', ['processWithdrawal', 'resolveRideReport']);
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
const LIMITS = consts(HOME, ['CATEGORIES', 'MIN_DESCRIPTION', 'MAX_DESCRIPTION', 'MAX_EVIDENCE', 'MAX_URL_LENGTH', 'CARD_EXCERPT']);
```

replace with:

```js
const LIMITS = consts(HOME, ['CATEGORIES', 'MIN_DESCRIPTION', 'MAX_DESCRIPTION', 'MAX_EVIDENCE', 'MAX_URL_LENGTH', 'UPLOAD_URL', 'CARD_EXCERPT']);
// A link shaped like the ones this platform's file store hands back.
const uploaded = (name) => `https://base44.app/api/apps/69f75159e3beeee0837b5b60/files/mp/public/69f75159e3beeee0837b5b60/${name}`;
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
const validateReportInput = make('validateReportInput', LIMITS, src('validateReportInput', 'body'));
```

replace with:

```js
const validateReportInput = make('validateReportInput', LIMITS, src('isUploadUrl', 'url'), src('validateReportInput', 'body'));
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
same('uploaded photos are kept, once each',
  validateReportInput({ ...good, evidence_urls: ['https://base44.app/files/a.jpg', 'https://base44.app/files/a.jpg', 'https://base44.app/files/b.jpg'] }).value.evidence_urls,
  ['https://base44.app/files/a.jpg', 'https://base44.app/files/b.jpg']);
check('a fourth photo is refused',
  validateReportInput({ ...good, evidence_urls: [1, 2, 3, 4].map((n) => `https://base44.app/files/${n}.jpg`) }).code, 'TOO_MANY_FILES');
```

replace with:

```js
same('uploaded photos are kept, once each',
  validateReportInput({ ...good, evidence_urls: [uploaded('a.jpg'), uploaded('a.jpg'), uploaded('b.jpg')] }).value.evidence_urls,
  [uploaded('a.jpg'), uploaded('b.jpg')]);
check('a fourth photo is refused',
  validateReportInput({ ...good, evidence_urls: [1, 2, 3, 4].map((n) => uploaded(`${n}.jpg`)) }).code, 'TOO_MANY_FILES');
// Admin's browser fetches every photo on a report. Each of these would let
// the reporter pick the server it is fetched from, or what comes back.
for (const [why, bad] of [
  ['another site', 'https://example.com/a.jpg'],
  ['a tracking pixel', 'https://evil.example/pixel.gif?report=1'],
  ['a host that only starts like ours', 'https://base44.app.evil.example/api/apps/69f75159e3beeee0837b5b60/files/a.jpg'],
  ['our host as a username', 'https://base44.app@evil.example/api/apps/69f75159e3beeee0837b5b60/files/a.jpg'],
  ['our host, but not the file store', 'https://base44.app/api/apps/69f75159e3beeee0837b5b60/entities/User'],
  ['our host, some other page', 'https://base44.app/files/a.jpg'],
  ['a query string on a real upload', `${uploaded('a.jpg')}?x=1`],
  ['a fragment on a real upload', `${uploaded('a.jpg')}#x`],
  ['a path that climbs out of the file store', uploaded('../../../entities/User')],
  ['plain http', uploaded('a.jpg').replace('https:', 'http:')],
]) {
  check(`a "photo" from ${why} is refused`, validateReportInput({ ...good, evidence_urls: [bad] }).code, 'BAD_URL');
}
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
check('photos that are not a list are refused', validateReportInput({ ...good, evidence_urls: 'https://base44.app/files/a.jpg' }).code, 'BAD_URL');
```

replace with:

```js
check('photos that are not a list are refused', validateReportInput({ ...good, evidence_urls: uploaded('a.jpg') }).code, 'BAD_URL');

// Filing: once per reporter per ride, always under the ride's own id.
console.log('\n— filing once —');
const isId = make('isId', src('isId', 'value'));
// Each of these fetched the same ride as "ride1" and, before this fix, each
// counted as a ride nobody had reported yet.
for (const stacked of ['ride1#1', 'ride1#2', 'ride1?again=1', 'ride1/', ' ride1']) {
  check(`${JSON.stringify(stacked)} is not accepted as a ride id`, isId(stacked), false);
}
const fileRideReport = make('fileRideReport', src('fileRideReport', 'sr, ride, reporter, input'));
const reportedRide = {
  id: 'ride1', booking_reference: 'UD-AAA111', vehicle_name: 'Prado', service_date: '2026-08-10',
  guest_email: 'ada@example.com', guest_name: 'Ada Obi', driver_id: 'drvA',
};
const asGuest = { email: 'ada@example.com', role: 'guest', name: 'Ada Obi', reported_name: 'Emeka Okafor' };
const asDriver = { email: 'emeka@work.ng', role: 'driver', name: 'Emeka Okafor', reported_name: 'Ada Obi' };
const said = { category: 'rude', description: 'He shouted at me the whole trip.', evidence_urls: [] };
{
  const sr = { RideReport: fakeEntity([]) };
  const first = await fileRideReport(sr, reportedRide, asGuest, said);
  check('a first report is filed', `${first.ok}/${sr.RideReport.rows.length}`, 'true/1');
  check('…under the ride\'s own id', sr.RideReport.rows[0].ride_booking_id, 'ride1');
  check('…open, with nothing decided', `${first.row.status}/${first.row.action_taken}`, 'open/none');
  check('…a guest\'s report names the driver, not an email', `${first.row.reported_driver_id}/${first.row.reported_email}`, 'drvA/');
  const second = await fileRideReport(sr, reportedRide, asGuest, { ...said, description: 'And another thing entirely.' });
  check('the same person cannot report the same ride twice', `${second.ok}/${second.code}/${sr.RideReport.rows.length}`, 'false/ALREADY_REPORTED/1');
  const other = await fileRideReport(sr, reportedRide, asDriver, said);
  check('the other side of the ride still can', `${other.ok}/${sr.RideReport.rows.length}`, 'true/2');
  check('…a driver\'s report names the guest, not a driver', `${other.row.reported_email}/${other.row.reported_driver_id}`, 'ada@example.com/');
}
{
  // Two taps on Submit both pass the "already" check. The second to write
  // sees the first one's row, removes its own, and answers as a duplicate.
  const sr = { RideReport: fakeEntity([]) };
  const realCreate = sr.RideReport.create;
  let twin = true;
  sr.RideReport.create = async (data) => {
    if (twin) { twin = false; await realCreate({ ...data, description: 'the other tap' }); }
    return realCreate(data);
  };
  const late = await fileRideReport(sr, reportedRide, asGuest, said);
  check('two taps on Submit leave one report', `${late.ok}/${late.code}/${sr.RideReport.rows.length}`, 'false/ALREADY_REPORTED/1');
  check('…the first one', sr.RideReport.rows[0].description, 'the other tap');
}
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
identical('hasOpenGuestReport', 'sr, rideBookingId', ['autoCancelExpiredBookings', 'settleDriverEarning']);
```

replace with:

```js
identical('hasOpenGuestReport', 'sr, rideBookingId, driverId', ['autoCancelExpiredBookings', 'settleDriverEarning']);
identical('ridesUnderReviewFor', 'reports, driverId', ['getDriverWallet', 'getDriverRides']);
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
const hasOpenGuestReport = make('hasOpenGuestReport', liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId'));
const reportsOf = (rows) => ({ RideReport: fakeEntity(rows) });
const filed = (reporter_role, status, ride_booking_id = 'ride1') => ({ id: 'r1', ride_booking_id, reporter_role, status });
check('an open complaint from the guest holds the ride', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1'), true);
check('so does one being reviewed', await hasOpenGuestReport(reportsOf([filed('guest', 'reviewing')]), 'ride1'), true);
check('a resolved one does not', await hasOpenGuestReport(reportsOf([filed('guest', 'resolved')]), 'ride1'), false);
check('a dismissed one does not', await hasOpenGuestReport(reportsOf([filed('guest', 'dismissed')]), 'ride1'), false);
check('a complaint about another ride does not', await hasOpenGuestReport(reportsOf([filed('guest', 'open', 'other')]), 'ride1'), false);
// The driver reporting an abusive customer must never delay the driver's own pay.
check('a report the DRIVER filed never holds the driver\'s pay', await hasOpenGuestReport(reportsOf([filed('driver', 'open')]), 'ride1'), false);
check('no reports at all', await hasOpenGuestReport(reportsOf([]), 'ride1'), false);
```

replace with:

```js
const hasOpenGuestReport = make('hasOpenGuestReport', liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId, driverId'));
const reportsOf = (rows) => ({ RideReport: fakeEntity(rows) });
// A guest's report names the driver it is about; a driver's report names nobody's pay.
const filed = (reporter_role, status, ride_booking_id = 'ride1', reported_driver_id = reporter_role === 'guest' ? 'drvA' : '') => ({
  id: 'r1', ride_booking_id, reporter_role, status, reported_driver_id,
});
check('an open complaint from the guest holds the ride', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1', 'drvA'), true);
check('so does one being reviewed', await hasOpenGuestReport(reportsOf([filed('guest', 'reviewing')]), 'ride1', 'drvA'), true);
check('a resolved one does not', await hasOpenGuestReport(reportsOf([filed('guest', 'resolved')]), 'ride1', 'drvA'), false);
check('a dismissed one does not', await hasOpenGuestReport(reportsOf([filed('guest', 'dismissed')]), 'ride1', 'drvA'), false);
check('a complaint about another ride does not', await hasOpenGuestReport(reportsOf([filed('guest', 'open', 'other')]), 'ride1', 'drvA'), false);
// The driver reporting an abusive customer must never delay the driver's own pay.
check('a report the DRIVER filed never holds the driver\'s pay', await hasOpenGuestReport(reportsOf([filed('driver', 'open')]), 'ride1', 'drvA'), false);
check('no reports at all', await hasOpenGuestReport(reportsOf([]), 'ride1', 'drvA'), false);
// Review focus 5: the complaint is about one driver, and the ride was then
// handed to another.
check('a complaint about driver A does not hold driver B\'s pay', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1', 'drvB'), false);
check('…it still holds driver A\'s', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1', 'drvA'), true);
check('an earning with no driver on it is held by nothing', await hasOpenGuestReport(reportsOf([filed('guest', 'open')]), 'ride1', ''), false);
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
  liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId'), liftSrc(SWEEP, 'keepReversed', 'sr, earningId'),
```

replace with:

```js
  liftSrc(SWEEP, 'hasOpenGuestReport', 'sr, rideBookingId, driverId'), liftSrc(SWEEP, 'keepReversed', 'sr, earningId'),
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
{
  const sr = worldWith([filed('guest', 'open', 'someone-elses-ride')]);
  check('a complaint about a different ride holds nothing here', await settleDueEarning(sr, 'e1', DUE), 'released');
}
```

replace with:

```js
{
  const sr = worldWith([filed('guest', 'open', 'someone-elses-ride')]);
  check('a complaint about a different ride holds nothing here', await settleDueEarning(sr, 'e1', DUE), 'released');
}
{
  // The guest complained about the driver who was on the ride first (drvZ).
  // The ride was then handed to drvA, whose pay this is.
  const sr = worldWith([filed('guest', 'open', 'ride1', 'drvZ')]);
  check('a complaint about the driver before them does not delay the driver who took over', await settleDueEarning(sr, 'e1', DUE), 'released');
}

const ridesUnderReviewFor = make('ridesUnderReviewFor', liftSrc('getDriverWallet', 'ridesUnderReviewFor', 'reports, driverId'));
same('"under review" is shown for rides where the guest complained about this driver',
  ridesUnderReviewFor([
    filed('guest', 'open', 'ride1', 'drvA'),
    filed('guest', 'reviewing', 'ride2', 'drvA'),
    filed('guest', 'open', 'ride2', 'drvA'),
    filed('guest', 'open', 'ride3', 'drvB'),
    filed('guest', 'resolved', 'ride4', 'drvA'),
    filed('driver', 'open', 'ride5'),
    null,
  ], 'drvA'),
  ['ride1', 'ride2']);
same('…and for nobody when there are no reports', ridesUnderReviewFor(undefined, 'drvA'), []);
```

**Edit `scripts/check-ride-reports.mjs`** — find:

```js
check('an uploaded photo is shown', rides.safePhotoUrl('https://base44.app/files/a.jpg'), 'https://base44.app/files/a.jpg');
```

replace with:

```js
check('an uploaded photo is shown', rides.safePhotoUrl(uploaded('a.jpg')), uploaded('a.jpg'));
check('the inbox and the server use one rule for where uploads live', String(rides.UPLOAD_URL), String(make('UPLOAD_URL', LIMITS)));
const isUploadUrl = make('isUploadUrl', LIMITS, src('isUploadUrl', 'url'));
// Whatever the server would store, the inbox shows; whatever it would refuse,
// the inbox will not draw even if the row was typed into the data browser.
for (const link of [
  uploaded('a.jpg'), uploaded('IMG_8199.jpeg'), uploaded('05221f132_IMG%209029.jpeg'),
  'https://example.com/a.jpg', 'https://base44.app/files/a.jpg', `${uploaded('a.jpg')}?x=1`, `${uploaded('a.jpg')}#x`,
  uploaded('../../../entities/User'), 'https://base44.app.evil.example/api/apps/69f75159e3beeee0837b5b60/files/a.jpg',
  uploaded(`${'a'.repeat(600)}.jpg`),
]) {
  check(`server and inbox agree on ${link.slice(0, 60)}${link.length > 60 ? '…' : ''}`, !!rides.safePhotoUrl(link), isUploadUrl(link));
}
check('…and a real upload is one they both accept', isUploadUrl(uploaded('05221f132_IMG_9029.jpeg')), true);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node scripts/check-ride-reports.mjs`

Expected: `Error: could not find isId in base44/functions/createRideReport/entry.ts`.

- [ ] **Step 3: `createRideReport` files under the ride's own id and stores only real uploads**

**Edit `base44/functions/createRideReport/entry.ts`** — find:

```ts
//   - WHAT  a category from a fixed list, 10 to 2000 characters of text, and
//           at most three https photo links
//
// While a report is open the driver's pay for that ride stays held (the sweep
// and settleDriverEarning both check). Nothing is done to either party until
// admin decides, in resolveRideReport.
```

replace with:

```ts
//   - WHAT  a category from a fixed list, 10 to 2000 characters of text, and
//           at most three photos, each a link to a file uploaded through
//           this platform
//
// While a guest's report about a driver is open, that driver's pay for the
// ride stays held (the sweep and settleDriverEarning both check). A report a
// driver files about a guest holds nobody's pay. Nothing is done to either
// party until admin decides, in resolveRideReport.

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
```

**Edit `base44/functions/createRideReport/entry.ts`** — find:

```ts
const MAX_URL_LENGTH = 600;
```

replace with:

```ts
const MAX_URL_LENGTH = 600;
// Where an uploaded file lives: this platform's file store, under an app id.
// MIRRORED client-side by UPLOAD_URL in src/config/rides.js.
const UPLOAD_URL = /^https:\/\/base44\.app\/api\/apps\/[a-f0-9]{24}\/files\/[A-Za-z0-9._~%\/-]+$/;
```

**Edit `base44/functions/createRideReport/entry.ts`** — find:

```ts
// The reporter's input, checked. Photos must be plain https links with no
// spaces, quotes or angle brackets: they are later used as <img src>, and a
// "photo" of javascript:… or a URL that closes an attribute must never be
// stored in the first place.
```

replace with:

```ts
// Whether a link is a file uploaded through this platform. A report photo is
// later drawn as <img src> on admin's screen. Any other https link would let
// whoever filed the report choose the server that learns when, and from
// where, admin opened it, and choose what admin is shown. So nothing else is
// ever stored: not another host, not a query string, not a path that climbs.
function isUploadUrl(url: unknown) {
    return typeof url === 'string' && url.length <= MAX_URL_LENGTH && UPLOAD_URL.test(url) && !url.includes('..');
}

// The reporter's input, checked. A photo must be a link isUploadUrl accepts.
```

**Edit `base44/functions/createRideReport/entry.ts`** — find:

```ts
        if (typeof item !== 'string' || item.length > MAX_URL_LENGTH || !/^https:\/\/[^\s"'<>]+$/.test(item)) {
```

replace with:

```ts
        if (!isUploadUrl(item)) {
```

**Edit `base44/functions/createRideReport/entry.ts`** — find:

```ts
// The Driver row this login belongs to, or null. Lockstep copy, see
// getDriverProfile.
```

replace with:

```ts
// File one report, once per reporter per ride. Takes the ride ROW, not the id
// that arrived in the request, so the "already reported" lookup and the
// stored row both use the ride's own id. reporter is { email, role, name,
// reported_name }; input is validateReportInput's value.
//
// Two taps on Submit can both pass the "already" check. The oldest report
// stands; a later twin is removed and answered as a duplicate.
async function fileRideReport(sr: any, ride: any, reporter: any, input: any) {
    const mine = { ride_booking_id: ride.id, reporter_email: reporter.email };
    const already = await sr.RideReport.filter(mine);
    if (Array.isArray(already) && already.length > 0) return { ok: false, code: 'ALREADY_REPORTED' };
    const row = {
        ride_booking_id: ride.id,
        booking_reference: ride.booking_reference || '',
        vehicle_name: ride.vehicle_name || '',
        service_date: ride.service_date,
        reporter_email: reporter.email,
        reporter_role: reporter.role,
        reporter_name: reporter.name || '',
        // Who the report is about: a guest by email, a driver by id. The
        // driver's id is what decides whose pay an open report holds.
        reported_email: reporter.role === 'driver' ? (ride.guest_email || '') : '',
        reported_driver_id: reporter.role === 'guest' ? (ride.driver_id || '') : '',
        reported_name: reporter.reported_name || '',
        category: input.category,
        description: input.description,
        evidence_urls: input.evidence_urls,
        status: 'open',
        action_taken: 'none',
    };
    const created = await sr.RideReport.create(row);
    const twins = (await sr.RideReport.filter(mine))
        .sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
            || String(a.id).localeCompare(String(b.id)));
    if (twins.length > 1 && twins[0].id !== created.id) {
        await sr.RideReport.delete(created.id);
        return { ok: false, code: 'ALREADY_REPORTED' };
    }
    return { ok: true, id: created.id, row };
}

// The Driver row this login belongs to, or null. Lockstep copy, see
// getDriverProfile.
```

**Edit `base44/functions/createRideReport/entry.ts`** — find:

```ts
        const body = await req.json().catch(() => ({}));
        const ride_booking_id = body?.ride_booking_id;
        if (!ride_booking_id || typeof ride_booking_id !== 'string') {
            return json({ success: false, error: 'ride_booking_id is required' }, 400);
        }
        const input = validateReportInput(body);
        if (!input.ok) return json({ success: false, error: input.error, code: input.code }, 400);

        const sr = base44.asServiceRole.entities;
        const ride = await sr.RideBooking.get(ride_booking_id);
        if (!ride) return json({ success: false, error: 'Ride booking not found', code: 'NOT_FOUND' }, 404);

        // Who is asking, decided from the session. Nothing in the request
        // body says which side they were on.
        const driver = await findDriverForUser(sr, user.email);
        const role = reporterRoleFor(ride, user.email, driver);
        if (!role) {
            return json({
                success: false,
                error: 'Only the guest or the driver of this ride can report it.',
                code: 'NOT_PARTY',
            }, 403);
        }
        if (ride.payment_status !== 'paid') {
            return json({ success: false, error: 'Only a paid ride can be reported.', code: 'NOT_PAID' }, 409);
        }
        if (!ride.driver_id) {
            return json({ success: false, error: 'This ride has no driver assigned yet.', code: 'NO_DRIVER' }, 409);
        }
        if (!reportWindowOpen(ride, Date.now())) {
            return json({
                success: false,
                error: 'A ride can be reported from when it starts until 7 days after it ends.',
                code: 'OUTSIDE_WINDOW',
            }, 409);
        }

        const already = await sr.RideReport.filter({ ride_booking_id, reporter_email: user.email });
        if (already.length > 0) {
            return json({
                success: false,
                error: 'You have already reported this ride. The team has it.',
                code: 'ALREADY_REPORTED',
            }, 409);
        }

        // Who the report is about, snapshotted so the inbox reads on its own.
        let reportedName = ride.guest_name || '';
        if (role === 'guest') {
            const theirDriver = await sr.Driver.get(ride.driver_id);
            reportedName = theirDriver?.full_name || 'Driver';
        }

        const row = {
            ride_booking_id,
            booking_reference: ride.booking_reference || '',
            vehicle_name: ride.vehicle_name || '',
            service_date: ride.service_date,
            reporter_email: user.email,
            reporter_role: role,
            reporter_name: role === 'driver' ? (driver?.full_name || '') : (ride.guest_name || user.full_name || ''),
            reported_email: role === 'driver' ? (ride.guest_email || '') : '',
            reported_driver_id: role === 'guest' ? ride.driver_id : '',
            reported_name: reportedName,
            category: input.value.category,
            description: input.value.description,
            evidence_urls: input.value.evidence_urls,
            status: 'open',
            action_taken: 'none',
        };
        const created = await sr.RideReport.create(row);

        // Two taps on Submit can both pass the "already" check. The oldest
        // report stands; a later twin is removed and answered as a duplicate.
        const twins = (await sr.RideReport.filter({ ride_booking_id, reporter_email: user.email }))
            .sort((a: any, b: any) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
                || String(a.id).localeCompare(String(b.id)));
        if (twins.length > 1 && twins[0].id !== created.id) {
            await sr.RideReport.delete(created.id);
            return json({
                success: false,
                error: 'You have already reported this ride. The team has it.',
                code: 'ALREADY_REPORTED',
            }, 409);
        }

        await notifyAdminLine(reportCardText(row));

        return json({ success: true, data: { report_id: created.id, reporter_role: role } });
```

replace with:

```ts
        const body = await req.json().catch(() => null);
        const ride_booking_id = body?.ride_booking_id;
        if (!isId(ride_booking_id)) {
            return json({ success: false, error: 'ride_booking_id is required' }, 400);
        }
        const input = validateReportInput(body);
        if (!input.ok) return json({ success: false, error: input.error, code: input.code }, 400);

        const sr = base44.asServiceRole.entities;
        const ride = await sr.RideBooking.get(ride_booking_id);
        if (!ride || ride.id !== ride_booking_id) {
            return json({ success: false, error: 'Ride booking not found', code: 'NOT_FOUND' }, 404);
        }

        // Who is asking, decided from the session. Nothing in the request
        // body says which side they were on.
        const driver = await findDriverForUser(sr, user.email);
        const role = reporterRoleFor(ride, user.email, driver);
        if (!role) {
            return json({
                success: false,
                error: 'Only the guest or the driver of this ride can report it.',
                code: 'NOT_PARTY',
            }, 403);
        }
        if (ride.payment_status !== 'paid') {
            return json({ success: false, error: 'Only a paid ride can be reported.', code: 'NOT_PAID' }, 409);
        }
        if (!ride.driver_id) {
            return json({ success: false, error: 'This ride has no driver assigned yet.', code: 'NO_DRIVER' }, 409);
        }
        if (!reportWindowOpen(ride, Date.now())) {
            return json({
                success: false,
                error: 'A ride can be reported from when it starts until 7 days after it ends.',
                code: 'OUTSIDE_WINDOW',
            }, 409);
        }

        // Who the report is about, snapshotted so the inbox reads on its own.
        let reportedName = ride.guest_name || '';
        if (role === 'guest') {
            const theirDriver = isId(ride.driver_id) ? await sr.Driver.get(ride.driver_id) : null;
            reportedName = theirDriver?.full_name || 'Driver';
        }

        const filed = await fileRideReport(sr, ride, {
            email: user.email,
            role,
            name: role === 'driver' ? (driver?.full_name || '') : (ride.guest_name || user.full_name || ''),
            reported_name: reportedName,
        }, input.value);
        if (!filed.ok) {
            return json({
                success: false,
                error: 'You have already reported this ride. The team has it.',
                code: 'ALREADY_REPORTED',
            }, 409);
        }

        await notifyAdminLine(reportCardText(filed.row));

        return json({ success: true, data: { report_id: filed.id, reporter_role: role } });
```

- [ ] **Step 4: An open complaint holds the pay of the driver it is about, and nobody else's**

The same change in both copies of `hasOpenGuestReport`. The check script fails if they differ.

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
// True while admin has not closed a complaint the GUEST made about this ride.
// That is a dispute about the service the driver is being paid for, so the
// pay waits. A report the DRIVER filed about the guest never holds the
// driver's own pay: that would punish them for speaking up. Lockstep copy in
// settleDriverEarning.
async function hasOpenGuestReport(sr: any, rideBookingId: string) {
    const open = await sr.RideReport.filter({
        ride_booking_id: rideBookingId, reporter_role: 'guest', status: { $in: ['open', 'reviewing'] },
    });
    return Array.isArray(open) && open.length > 0;
}
```

replace with:

```ts
// True while admin has not closed a complaint the GUEST made about THIS
// DRIVER on this ride. That is a dispute about the service the driver is
// being paid for, so the pay waits. It is matched on the driver the report
// names: if the ride was handed to someone else after the complaint, the
// complaint is about the first driver, and the second is paid on time. A
// report the DRIVER filed about the guest never holds the driver's own pay:
// that would punish them for speaking up. Lockstep copy in
// settleDriverEarning.
async function hasOpenGuestReport(sr: any, rideBookingId: string, driverId: string) {
    if (!driverId) return false;
    const open = await sr.RideReport.filter({
        ride_booking_id: rideBookingId,
        reporter_role: 'guest',
        reported_driver_id: driverId,
        status: { $in: ['open', 'reviewing'] },
    });
    return Array.isArray(open) && open.length > 0;
}
```

**Edit `base44/functions/autoCancelExpiredBookings/entry.ts`** — find:

```ts
    if (await hasOpenGuestReport(sr, e.ride_booking_id)) return 'skipped';
```

replace with:

```ts
    if (await hasOpenGuestReport(sr, e.ride_booking_id, e.driver_id)) return 'skipped';
```

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
// True while admin has not closed a complaint the GUEST made about this ride.
// That is a dispute about the service the driver is being paid for, so the
// pay waits. A report the DRIVER filed about the guest never holds the
// driver's own pay: that would punish them for speaking up. Lockstep copy,
// see autoCancelExpiredBookings.
async function hasOpenGuestReport(sr: any, rideBookingId: string) {
    const open = await sr.RideReport.filter({
        ride_booking_id: rideBookingId, reporter_role: 'guest', status: { $in: ['open', 'reviewing'] },
    });
    return Array.isArray(open) && open.length > 0;
}
```

replace with:

```ts
// True while admin has not closed a complaint the GUEST made about THIS
// DRIVER on this ride. That is a dispute about the service the driver is
// being paid for, so the pay waits. It is matched on the driver the report
// names: if the ride was handed to someone else after the complaint, the
// complaint is about the first driver, and the second is paid on time. A
// report the DRIVER filed about the guest never holds the driver's own pay:
// that would punish them for speaking up. Lockstep copy, see
// autoCancelExpiredBookings.
async function hasOpenGuestReport(sr: any, rideBookingId: string, driverId: string) {
    if (!driverId) return false;
    const open = await sr.RideReport.filter({
        ride_booking_id: rideBookingId,
        reporter_role: 'guest',
        reported_driver_id: driverId,
        status: { $in: ['open', 'reviewing'] },
    });
    return Array.isArray(open) && open.length > 0;
}
```

**Edit `base44/functions/settleDriverEarning/entry.ts`** — find:

```ts
            if (await hasOpenGuestReport(sr, earning.ride_booking_id)) {
                return json({
                    success: false,
                    error: 'The guest has an open report on this ride. Resolve or dismiss it under Rides → Reports first.',
```

replace with:

```ts
            if (await hasOpenGuestReport(sr, earning.ride_booking_id, earning.driver_id)) {
                return json({
                    success: false,
                    error: 'The guest has an open report about this driver on this ride. Resolve or dismiss it under Rides → Reports first.',
```

- [ ] **Step 5: "Under review" is shown to the driver the complaint is about**

**Edit `base44/functions/getDriverWallet/entry.ts`** — find:

```ts
// One ledger row as the driver sees it. An allow-list: hold reasons, admin
```

replace with:

```ts
// The rides on which a guest's complaint about THIS driver is still open.
// Their pay for those rides shows as "under review". A complaint about a
// driver who was on the ride before them is not theirs. Lockstep copy in
// getDriverRides; the sweep applies the same rule in hasOpenGuestReport.
function ridesUnderReviewFor(reports: any[], driverId: string) {
    const out = [];
    for (const r of reports || []) {
        if (!r || r.reporter_role !== 'guest' || r.reported_driver_id !== driverId) continue;
        if (r.status !== 'open' && r.status !== 'reviewing') continue;
        if (!out.includes(r.ride_booking_id)) out.push(r.ride_booking_id);
    }
    return out;
}

// One ledger row as the driver sees it. An allow-list: hold reasons, admin
```

**Edit `base44/functions/getDriverWallet/entry.ts`** — find:

```ts
            fetchAll(sr.RideReport, { reporter_role: 'guest', status: { $in: ['open', 'reviewing'] } }),
        ]);
        const ridesUnderReview = new Set(openReports.map((r: any) => r.ride_booking_id));
```

replace with:

```ts
            fetchAll(sr.RideReport, {
                reporter_role: 'guest', reported_driver_id: driver.id, status: { $in: ['open', 'reviewing'] },
            }),
        ]);
        const ridesUnderReview = new Set(ridesUnderReviewFor(openReports, driver.id));
```

**Edit `base44/functions/getDriverRides/entry.ts`** — find:

```ts
    return w.startMs <= nowMs && nowMs <= w.endMs + REPORT_WINDOW_AFTER_END_MS;
}

const PAGE = 500;
```

replace with:

```ts
    return w.startMs <= nowMs && nowMs <= w.endMs + REPORT_WINDOW_AFTER_END_MS;
}

// The rides on which a guest's complaint about THIS driver is still open.
// Their pay for those rides shows as "under review". A complaint about a
// driver who was on the ride before them is not theirs. Lockstep copy, see
// getDriverWallet.
function ridesUnderReviewFor(reports: any[], driverId: string) {
    const out = [];
    for (const r of reports || []) {
        if (!r || r.reporter_role !== 'guest' || r.reported_driver_id !== driverId) continue;
        if (r.status !== 'open' && r.status !== 'reviewing') continue;
        if (!out.includes(r.ride_booking_id)) out.push(r.ride_booking_id);
    }
    return out;
}

const PAGE = 500;
```

**Edit `base44/functions/getDriverRides/entry.ts`** — find:

```ts
            fetchAll(sr.RideReport, { reporter_role: 'guest', status: { $in: ['open', 'reviewing'] } }),
        ]);
        const reportedRides = new Set(myReports.map((r: any) => r.ride_booking_id));
        const ridesUnderReview = new Set(openReports.map((r: any) => r.ride_booking_id));
```

replace with:

```ts
            fetchAll(sr.RideReport, {
                reporter_role: 'guest', reported_driver_id: driver.id, status: { $in: ['open', 'reviewing'] },
            }),
        ]);
        const reportedRides = new Set(myReports.map((r: any) => r.ride_booking_id));
        const ridesUnderReview = new Set(ridesUnderReviewFor(openReports, driver.id));
```

- [ ] **Step 6: `resolveRideReport` only looks up a plain id**

**Edit `base44/functions/resolveRideReport/entry.ts`** — find:

```ts
async function tryPush(sdk: any, opts: Record<string, unknown>) {
```

replace with:

```ts
// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copy, see processWithdrawal.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

async function tryPush(sdk: any, opts: Record<string, unknown>) {
```

**Edit `base44/functions/resolveRideReport/entry.ts`** — find:

```ts
        const { report_id, status, action_taken, admin_notes } = await req.json().catch(() => ({}));
        if (!report_id || typeof report_id !== 'string') {
            return json({ success: false, error: 'report_id is required' }, 400);
        }
```

replace with:

```ts
        const body = await req.json().catch(() => null);
        const { report_id, status, action_taken, admin_notes } = body || {};
        if (!isId(report_id)) {
            return json({ success: false, error: 'report_id is required' }, 400);
        }
```

**Edit `base44/functions/resolveRideReport/entry.ts`** — find:

```ts
        const report = await sr.RideReport.get(report_id);
        if (!report) return json({ success: false, error: 'That report no longer exists.', code: 'NOT_FOUND' }, 404);
```

replace with:

```ts
        const report = await sr.RideReport.get(report_id);
        if (!report || report.id !== report_id) {
            return json({ success: false, error: 'That report no longer exists.', code: 'NOT_FOUND' }, 404);
        }
```

**Edit `base44/functions/resolveRideReport/entry.ts`** — find:

```ts
            const driver = await sr.Driver.get(report.reported_driver_id);
```

replace with:

```ts
            const driver = isId(report.reported_driver_id) ? await sr.Driver.get(report.reported_driver_id) : null;
```

- [ ] **Step 7: The inbox and the dialog use the same rule**

**Edit `src/config/rides.js`** — find:

```js
// A stored report photo, if it is safe to use as an <img src>: a plain https
// link with no spaces, quotes or angle brackets. Same rule the server applies
// when a report is filed; applied again here because a row can also be typed
// into the data browser. Anything else is simply not shown.
export const safePhotoUrl = (url) =>
  (typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null);
```

replace with:

```js
// Where an uploaded file lives: this platform's file store, under an app id.
// MIRROR of UPLOAD_URL in base44/functions/createRideReport/entry.ts;
// scripts/check-ride-reports.mjs fails if the two differ.
export const UPLOAD_URL = /^https:\/\/base44\.app\/api\/apps\/[a-f0-9]{24}\/files\/[A-Za-z0-9._~%\/-]+$/;

// A stored report photo, if it may be used as an <img src>: a link to a file
// uploaded through this platform, and nothing else. Admin's browser fetches
// whatever this returns, so any other link would let the person who filed
// the report choose the server that learns admin opened it. The server
// applies the same rule when a report is filed; it is applied again here
// because a row can also be typed into the data browser. Anything else is
// simply not shown.
export const safePhotoUrl = (url) =>
  (typeof url === 'string' && url.length <= 600 && UPLOAD_URL.test(url) && !url.includes('..') ? url : null);
```

**Edit `src/components/rides/RideReportDialog.jsx`** — find:

```jsx
import { REPORT_CATEGORIES, REPORT_LIMITS } from '@/config/rides';
```

replace with:

```jsx
import { REPORT_CATEGORIES, REPORT_LIMITS, safePhotoUrl } from '@/config/rides';
```

**Edit `src/components/rides/RideReportDialog.jsx`** — find:

```jsx
      if (!file_url) throw new Error('The upload did not return a link.');
```

replace with:

```jsx
      if (!file_url) throw new Error('The upload did not return a link.');
      // The server stores only links to this platform's own file store. Say
      // so here, rather than refuse the whole report when it is sent.
      if (!safePhotoUrl(file_url)) {
        throw new Error('The upload returned a link this form cannot attach. Send the report without the photo and tell the team.');
      }
```

- [ ] **Step 8: Run the checks**

Run: `npm run check`

Expected: five `PASS` lines.

Run: `for f in createRideReport resolveRideReport autoCancelExpiredBookings settleDriverEarning getDriverWallet getDriverRides; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done; npm run lint`

Expected: no `PARSE FAIL` line, no lint output.

- [ ] **Step 9: Sandbox checklist (after the next publish)**

1. As a guest, report a ride with a photo. Expected: accepted; the photo shows in Admin → Rides → Reports. Report the same ride again. Expected: "You have already reported this ride."
2. From the browser console as that guest, call the function with `ride_booking_id: '<the ride id>#2'`. Expected: "ride_booking_id is required", and no second row in the inbox.
3. From the console, call it for another reportable ride with `evidence_urls: ['https://example.com/a.jpg']`. Expected: "One of the photos is not a valid upload."
4. As a guest, report driver A on a running ride. Reassign the ride to driver B. Expected: A's pay row is reversed; B's wallet shows the pay as held with its release time, not "under review"; two hours after the end B's pay releases while the report is still open.
5. With that report still open, try Release on A's row for a ride that was not reassigned. Expected: "The guest has an open report about this driver on this ride."

- [ ] **Step 10: Commit**

```bash
git add scripts/check-ride-reports.mjs scripts/check-driver-wallet.mjs base44/functions/createRideReport/entry.ts base44/functions/autoCancelExpiredBookings/entry.ts base44/functions/settleDriverEarning/entry.ts base44/functions/getDriverWallet/entry.ts base44/functions/getDriverRides/entry.ts base44/functions/resolveRideReport/entry.ts src/config/rides.js src/components/rides/RideReportDialog.jsx
git commit -m "fix(rides): a report is filed once, holds only the driver it is about, and carries only real uploads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Second review

Four more reviewers were asked to break Tasks R01 to R05 once they were committed: one each for payouts, for assignment and reversal, for ride rows and reports, and one for the check scripts themselves. They reported 33 findings, 27 once duplicates are merged. Tasks R06 to R08 close them. The fourth reviewer also tested the schedule walker on races whose answers are known (it visits exactly the right number of orders and finds the lost update) and re-ran the assignment races under stricter verdicts than the ones shipped; those held.

### Task R06: Payouts, second review

**Findings closed:**
- (high) Two calls for a driver-wallet request the earnings did not cover: the first marked it failed, and the second, still holding the copy it read while the row was pending, found the row "on the ledger" by id, found no shortfall because a failed row reserves nothing, wrote processing over failed, and sent it. The same stale copy let a referral row that had just been failed and credited back be sent.
- Two overlapping calls that were both refused each credited the referral balance: "has this been refunded?" was read, then acted on. A Retry racing the bank's failure event did the same through the other refund path.
- A referral row typed into the database by hand was credited an amount that was never taken, whenever its payout was refused or failed. That credit outlives the staged create rule.
- A row with a transfer code whose settlement event never arrived, or whose transfer ended as abandoned, blocked or rejected, stayed processing for good, and blocked that person's next withdrawal.
- After an unconfirmed send the row left the default Pending view, and the toast pointed at a Retry button that was not on screen.
- Smaller: a duplicate answered with a 2xx carrying a settled transfer left the row processing; a reference made by the old code could be read as a row id if it came back in lower case; a missing driver profile crashed the ledger check instead of closing the request, because the platform rejects a read of a missing row and does not answer null.

**Files:**
- Create: `base44/entities/WithdrawalLedger.jsonc`, `src/lib/withdrawalRow.js`
- Replace: `base44/functions/processWithdrawal/entry.ts`, `base44/functions/paystackTransferWebhook/entry.ts`
- Modify: `base44/functions/createWithdrawalRequest/entry.ts` (records the debit)
- Modify: `src/components/admin/WithdrawalsAdmin.jsx`
- Modify: `scripts/check-entities.mjs`, `scripts/check-driver-wallet.mjs`

**Interfaces:**
- Produces: entity `WithdrawalLedger` (`withdrawal_request_id`, `user_email`, `kind: debit | attempt | refund`, `state`, `amount_ngn`), admin-only for all four operations.
- Changes: `sendWithdrawal(sr, paystack, withdrawalId, allowUnrecorded, nowIso)`. It reads the row itself.
- Changes: `refundReferralOnce(sr, withdrawal, nowIso, unsent) → 'refunded' | 'already' | 'no_debit' | 'held_back' | 'interrupted' | 'no_user' | 'not_stored'`. Lockstep in both functions.
- Changes: `webhookShouldAct(eventName, row)`; `withdrawalIdFromReference` accepts only `wd-` plus 24 hex.
- Produces, lockstep in both functions: `debitOnRecord(entries, withdrawal)`, `madeRecently(entry, nowIso)`, `attemptBlocksRefund(entry, nowIso)`, `claimIsLive(entry, nowIso)`, `STALE_ATTEMPT_MS`.
- Produces, in `processWithdrawal/entry.ts`: `getOrNull(entity, id)`, `canRecheck(withdrawal)`, `canCredit(withdrawal)`. New refusals `UNRECORDED` (409), `NOT_SENDABLE` (409), `NO_TRANSFER` (409), `NOT_FOUND` (404). New request field `allow_unrecorded`. New answer fields `refund`, `credited`, `warning: 'NEEDS_OTP'`.
- Produces, in `src/lib/withdrawalRow.js`: `withdrawalActions(row) → { send, retry, recheck, credit }`, `showsUnderPending(row)`.

**How a refund is made exactly once, with nothing to lock.** "Has this been refunded?" cannot be read and then acted on: two calls both read "no". So each call first writes a claim (a `WithdrawalLedger` row of kind `refund`), then reads all the claims for that withdrawal, and only the oldest one that still stands credits. A call that finds an older claim marks its own a duplicate and credits nothing.

**How a withdrawal is never both sent and credited back.** The same idea, from both sides. A call about to send writes an `attempt` row and then looks for a claim on the refund; if it sees one it stands down. A call about to credit back a refusal writes its claim and then looks for an attempt that has sent, or still could; if it sees one it stands down. Each writes before it looks, so at least one of the two always sees the other. When both stand down, the row is failed and not credited, says so, and one press of **Credit back** afterwards asks Paystack and credits it.

**Why a debit has to be on record.** A `WithdrawalRequest` row can be typed in from a browser until the staged rule is live, and such a row is indistinguishable from one made before this version. `WithdrawalLedger` is a new entity and admin-only from its first day, so a `debit` row in it is proof that `createWithdrawalRequest` took the money. No debit on record: not sent without a second confirmation, never credited back automatically.

- [ ] **Step 1: Write the failing checks**

**Edit `scripts/check-entities.mjs`** — find:

```js
check('WithdrawalRequest update is admin-only', adminOnly(entities.WithdrawalRequest?.rls?.update));
```

replace with:

```js
check('WithdrawalRequest update is admin-only', adminOnly(entities.WithdrawalRequest?.rls?.update));

// The referral balance's paper trail. Admin-only in every direction: it is
// the one record of a withdrawal that cannot be typed in from a browser.
check('WithdrawalLedger exists', !!entities.WithdrawalLedger);
for (const f of ['withdrawal_request_id', 'user_email', 'kind', 'state', 'amount_ngn']) {
  check(`WithdrawalLedger.${f}`, !!prop('WithdrawalLedger', f));
}
check('WithdrawalLedger.kind is debit | attempt | refund',
  sameList(prop('WithdrawalLedger', 'kind')?.enum, ['debit', 'attempt', 'refund']));
for (const op of OPS) {
  check(`WithdrawalLedger ${op} is admin-only`, adminOnly(entities.WithdrawalLedger?.rls?.[op]));
}
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
import { fromResponse, fromThrown } from '../src/lib/fnResult.js';
```

replace with:

```js
import { fromResponse, fromThrown } from '../src/lib/fnResult.js';
import { withdrawalActions, showsUnderPending } from '../src/lib/withdrawalRow.js';
```

The ledger rows carry the time they were made, and two of the new rules read it, so the stand-in entity can be told when its clock starts.

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
function fakeEntity(seed = []) {
```

replace with:

```js
function fakeEntity(seed = [], startMs = Date.UTC(2026, 0, 1)) {
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
      const row = { id: `new${n}`, created_date: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), ...data };
```

replace with:

```js
      // Stamped one second apart from startMs, in the order they were made.
      const row = { id: `new${n}`, created_date: new Date(startMs + n * 1000).toISOString(), ...data };
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  constLine('processWithdrawal', 'WITHDRAWAL_THRESHOLD_NGN'), FETCH_ALL,
  liftSrc('processWithdrawal', 'isId', 'value'),
```

replace with:

```js
  constLine('processWithdrawal', 'WITHDRAWAL_THRESHOLD_NGN'), FETCH_ALL,
  liftSrc('processWithdrawal', 'isId', 'value'),
  liftSrc('processWithdrawal', 'getOrNull', 'entity, id'),
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
check('an old-style reference names no row', withdrawalIdFromReference('WD-6a431f7e-1760000000000'), null);
```

replace with:

```js
check('an old-style reference names no row', withdrawalIdFromReference('WD-6a431f7e-1760000000000'), null);
check('…nor does it if it comes back in lower case', withdrawalIdFromReference('wd-6a431f7e-1760000000000'), null);
check('…and nothing but a row id after wd- does', withdrawalIdFromReference('wd-../User/6a431f7ed4c9964e10f5a1b3'), null);
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
    async send(payload) {
      calls.send += 1;
      if (transfers.has(payload.reference)) {
        return { ok: false, message: 'Please provide a unique reference. Reference already exists on a transfer', details: null };
      }
      // refusal: a string is Paystack's stated reason; null is no answer at all.
      if (opts.refusal !== undefined) return { ok: false, message: opts.refusal, details: { message: opts.refusal } };
      const transfer = {
        id: 900 + transfers.size, transfer_code: `TRF_${transfers.size + 1}`, status: 'pending',
```

replace with:

```js
    async send(payload) {
      calls.send += 1;
      if (transfers.has(payload.reference)) {
        // Paystack's documented answer to a repeated reference is a refusal.
        // duplicateAnswers2xx is the other possibility: a 2xx carrying the
        // transfer it already holds.
        if (opts.duplicateAnswers2xx) return { ok: true, transfer: transfers.get(payload.reference) };
        return { ok: false, message: 'Please provide a unique reference. Reference already exists on a transfer', details: null };
      }
      // refusal: a string is Paystack's stated reason; null is no answer at all.
      // refuseFirst: the same, for the first send it is asked for and no other.
      if (opts.refusal !== undefined) return { ok: false, message: opts.refusal, details: { message: opts.refusal } };
      if (opts.refuseFirst !== undefined && calls.send === 1) {
        return { ok: false, message: opts.refuseFirst, details: { message: opts.refuseFirst } };
      }
      const transfer = {
        id: 900 + transfers.size, transfer_code: `TRF_${transfers.size + 1}`, status: opts.sendStatus || 'pending',
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
const PAYOUT = [
  constLine(PW, 'WITHDRAWAL_THRESHOLD_NGN'), FETCH_ALL,
  pw('isId', 'value'), pw('driverEmails', 'driver'), pw('driverWithdrawals', 'driver, rows'),
  pw('walletTotals', 'earnings, withdrawals'), pw('refundsToBalance', 'withdrawal'),
  pw('transferReferenceFor', 'withdrawalId'), pw('bankBelongsTo', 'bankAccount, withdrawal'),
  pw('transferOutcome', 'accepted, message, lookup'), pw('rowStatusFor', 'transferStatus'),
  pw('driverWithdrawalProblem', 'sr, w'), pw('refundReferralOnce', 'sr, withdrawal, nowIso'),
  pw('sendWithdrawal', 'sr, paystack, withdrawal, nowIso'),
];
const sendWithdrawal = make('sendWithdrawal', ...PAYOUT);
const refundReferralOnce = make('refundReferralOnce', ...PAYOUT);
const SENT_AT = '2026-08-10T12:00:00.000Z';
const referralRow = (extra = {}) => ({
  id: ROW_ID, wallet: 'referral', user_email: 'ada@mail.ng', amount: 15000, status: 'pending', bank_account_id: 'bank1', ...extra,
});
const driverRow = (extra = {}) => request({ bank_account_id: 'bank1', ...extra });
// Everything a payout reads and writes. The person asking starts with ₦5,000
// of referral balance, so a refund shows as 5,000 + the amount.
const payWorld = (row, extra = {}) => ({
  WithdrawalRequest: fakeEntity([row]),
  UserBankAccount: fakeEntity([{
    id: 'bank1', user_email: row.user_email, account_name: 'Ada Obi', account_number: '0123456789', bank_code: '058',
    recipient_code: 'RCP_0', ...(extra.bank || {}),
  }]),
  User: fakeEntity([{ id: 'u1', email: row.user_email, referral_balance_ngn: 5000 }]),
  Driver: fakeEntity([{ id: 'drvA', user_email: 'emeka@work.ng', previous_user_emails: [] }]),
  DriverEarning: fakeEntity(extra.earnings || []),
});
const rowOf = (sr) => sr.WithdrawalRequest.rows[0];
```

replace with:

```js
const PAYOUT = [
  constLine(PW, 'WITHDRAWAL_THRESHOLD_NGN'), constLine(PW, 'STALE_ATTEMPT_MS'), FETCH_ALL,
  pw('isId', 'value'), pw('getOrNull', 'entity, id'), pw('driverEmails', 'driver'), pw('driverWithdrawals', 'driver, rows'),
  pw('walletTotals', 'earnings, withdrawals'), pw('refundsToBalance', 'withdrawal'),
  pw('debitOnRecord', 'entries, withdrawal'), pw('madeRecently', 'entry, nowIso'),
  pw('attemptBlocksRefund', 'entry, nowIso'), pw('claimIsLive', 'entry, nowIso'),
  pw('transferReferenceFor', 'withdrawalId'), pw('canSend', 'withdrawal'), pw('canRecheck', 'withdrawal'),
  pw('canCredit', 'withdrawal'), pw('bankBelongsTo', 'bankAccount, withdrawal'),
  pw('transferOutcome', 'accepted, message, lookup'), pw('rowStatusFor', 'transferStatus'),
  pw('driverWithdrawalProblem', 'sr, w'), pw('refundReferralOnce', 'sr, withdrawal, nowIso, unsent'),
  pw('sendWithdrawal', 'sr, paystack, withdrawalId, allowUnrecorded, nowIso'),
];
// The shipped function is handed an id and reads the row itself. The checks
// below were written around a row object, so this passes its id along.
const sendWithdrawalById = make('sendWithdrawal', ...PAYOUT);
const sendWithdrawal = (sr, paystack, row, nowIso, allowUnrecorded = false) =>
  sendWithdrawalById(sr, paystack, row.id, allowUnrecorded, nowIso);
const refundReferralOnce = make('refundReferralOnce', ...PAYOUT);
const SENT_AT = '2026-08-10T12:00:00.000Z';
const minutesBefore = (m) => new Date(Date.parse(SENT_AT) - m * 60000).toISOString();
const referralRow = (extra = {}) => ({
  id: ROW_ID, wallet: 'referral', user_email: 'ada@mail.ng', amount: 15000, status: 'pending', bank_account_id: 'bank1', ...extra,
});
const driverRow = (extra = {}) => request({ bank_account_id: 'bank1', ...extra });
// What createWithdrawalRequest writes when it takes a referral amount off the balance.
const debitFor = (row) => ({
  id: 'debit1', created_date: minutesBefore(60), kind: 'debit', state: 'recorded',
  withdrawal_request_id: row.id, user_email: row.user_email, amount_ngn: row.amount,
});
// Everything a payout reads and writes. The person asking starts with ₦5,000
// of referral balance, so a credit back shows as 5,000 + the amount. A
// referral request made through the app has its debit on record; pass
// ledger: [] for one that has not. Ledger rows made during a check are
// stamped in the two minutes before SENT_AT, so they count as recent.
const payWorld = (row, extra = {}) => ({
  WithdrawalRequest: fakeEntity([row]),
  UserBankAccount: fakeEntity([{
    id: 'bank1', user_email: row.user_email, account_name: 'Ada Obi', account_number: '0123456789', bank_code: '058',
    recipient_code: 'RCP_0', ...(extra.bank || {}),
  }]),
  User: fakeEntity([{ id: 'u1', email: row.user_email, referral_balance_ngn: 5000 }]),
  Driver: fakeEntity([{ id: 'drvA', user_email: 'emeka@work.ng', previous_user_emails: [] }]),
  DriverEarning: fakeEntity(extra.earnings || []),
  WithdrawalLedger: fakeEntity(extra.ledger || (row.wallet === 'driver' ? [] : [debitFor(row)]), Date.parse(SENT_AT) - 120000),
});
const rowOf = (sr) => sr.WithdrawalRequest.rows[0];
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
    `${await refundReferralOnce(sr, { ...rowOf(sr) }, SENT_AT)}/${balanceOf(sr)}`, 'false/20000');
```

replace with:

```js
    `${await refundReferralOnce(sr, { ...rowOf(sr) }, SENT_AT, true)}/${balanceOf(sr)}`, 'already/20000');
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
{
  // The settlement webhook was quicker than this call: the row is already
  // completed, but the copy this call read, and its look at Paystack, are older.
  const sr = payWorld(referralRow({ status: 'completed', transfer_code: 'TRF_7' }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'pending' });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a row the webhook already completed is not put back to processing', `${rowOf(sr).status}/${r.body.status}`, 'completed/completed');
}
{
  const sr = payWorld(referralRow({ status: 'reversed', transfer_code: 'TRF_7', refunded_at: SENT_AT }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('…and a row the bank reversed is not put back to completed', `${rowOf(sr).status}/${balanceOf(sr)}`, 'reversed/5000');
}
{
  // The other call's transfer landed just after this call looked, settled,
  // and the webhook completed the row before this call marked it processing.
  // The duplicate is refused, and the second look puts the row right.
  const sr = payWorld(referralRow({ status: 'completed', transfer_code: 'TRF_7' }));
  const ps = fakePaystack({ staleFirstFind: true });
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a completed row marked processing by a late call is completed again by that same call',
    `${rowOf(sr).status}/${ps.transfers.size}/${r.body.already_sent}`, 'completed/1/true');
}
```

replace with:

```js
{
  // The settlement webhook got there first: the row is already completed.
  const sr = payWorld(referralRow({ status: 'completed', transfer_code: 'TRF_7', transfer_reference: REF }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a completed row is not touched and nothing is sent',
    `${rowOf(sr).status}/${r.body.code}/${ps.calls.send}`, 'completed/NOT_SENDABLE/0');
}
{
  const sr = payWorld(referralRow({ status: 'reversed', transfer_code: 'TRF_7', refunded_at: SENT_AT }));
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('…nor is a row the bank reversed', `${rowOf(sr).status}/${balanceOf(sr)}`, 'reversed/5000');
}
```

The two walks that follow have more steps per press now (each press reads the row itself, and a referral press writes and reads the ledger), so the one with a recipient to create is bounded like the driver-wallet one.

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  const out = await everySchedule(twoPresses(referralRow(), { bank: { recipient_code: '' } }), oneTransfer);
```

replace with:

```js
  const out = await everySchedule(twoPresses(referralRow(), { bank: { recipient_code: '' } }), oneTransfer, 3);
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
  const out = await everySchedule(twoPresses(referralRow()), oneTransfer);
  check(`two presses at once, every order (${out.runs}): one transfer, both told the truth, no refund`, `${out.problem}${out.schedule}`, '');
```

replace with:

```js
  const out = await everySchedule(twoPresses(referralRow()), oneTransfer, 3);
  check(`two presses at once (${out.runs} orders): one transfer, both told the truth, no refund`, `${out.problem}${out.schedule}`, '');
  const more = await randomSchedules(twoPresses(referralRow()), oneTransfer, 1000, 10);
  check(`…and in ${more.runs} random orders with no limit on changes of turn`, `${more.problem}${more.schedule}`, '');
```

A verdict may now look again after the race (press a button, read the result), so the walker waits for it.

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
    runs += 1;
    const problem = verdict(world, results);
```

replace with:

```js
    runs += 1;
    const problem = await verdict(world, results);
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
    const problem = verdict(world, results);
    if (problem) return { runs: n, problem, schedule: trace.join('') };
```

replace with:

```js
    const problem = await verdict(world, results);
    if (problem) return { runs: n, problem, schedule: trace.join('') };
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
const webhookShouldAct = make('webhookShouldAct', liftSrc('paystackTransferWebhook', 'webhookShouldAct', 'eventName, status'));
check('success on a processing row', webhookShouldAct('transfer.success', 'processing'), true);
check('failure on a processing row', webhookShouldAct('transfer.failed', 'processing'), true);
check('a second success on a completed row is ignored', webhookShouldAct('transfer.success', 'completed'), false);
check('a second failure on a failed row is ignored', webhookShouldAct('transfer.failed', 'failed'), false);
// The bank sent the money back after the transfer had succeeded.
check('a reversal after success is acted on', webhookShouldAct('transfer.reversed', 'completed'), true);
check('a second reversal is ignored', webhookShouldAct('transfer.reversed', 'reversed'), false);
check('nothing acts on a pending row', webhookShouldAct('transfer.success', 'pending'), false);
```

replace with:

```js
const webhookShouldAct = make('webhookShouldAct', liftSrc('paystackTransferWebhook', 'webhookShouldAct', 'eventName, row'));
const inState = (status) => ({ id: ROW_ID, status });
check('success on a processing row', webhookShouldAct('transfer.success', inState('processing')), true);
check('failure on a processing row', webhookShouldAct('transfer.failed', inState('processing')), true);
check('a second success on a completed row is ignored', webhookShouldAct('transfer.success', inState('completed')), false);
check('a second failure on a failed row is ignored', webhookShouldAct('transfer.failed', inState('failed')), false);
// The bank sent the money back after the transfer had succeeded.
check('a reversal after success is acted on', webhookShouldAct('transfer.reversed', inState('completed')), true);
check('a second reversal is ignored', webhookShouldAct('transfer.reversed', inState('reversed')), false);
check('nothing acts on a pending row', webhookShouldAct('transfer.success', inState('pending')), false);
// A second press that lost a race wrote "failed" on a stale reading, and the
// transfer it lost to went out.
check('a success for a row marked failed is acted on: the money left', webhookShouldAct('transfer.success', inState('failed')), true);
check('a failure for a completed row is not', webhookShouldAct('transfer.failed', inState('completed')), false);
check('no row, nothing to do', webhookShouldAct('transfer.success', null), false);
```

**Edit `scripts/check-driver-wallet.mjs`** — find:

```js
// ---- result ----
```

replace with:

```js
// ── Payouts, second review ─────────────────────────────────────────────────
console.log('\n— payouts: credited back once, never sent stale, never left unsettled —');
const WH = 'paystackTransferWebhook';
const LEDGER_FNS = [
  ['refundsToBalance', 'withdrawal'], ['debitOnRecord', 'entries, withdrawal'], ['madeRecently', 'entry, nowIso'],
  ['attemptBlocksRefund', 'entry, nowIso'], ['claimIsLive', 'entry, nowIso'],
  ['refundReferralOnce', 'sr, withdrawal, nowIso, unsent'],
];
for (const [name, signature] of LEDGER_FNS) identical(name, signature, [PW, WH]);
check('one staleness window in both functions', constLine(PW, 'STALE_ATTEMPT_MS'), constLine(WH, 'STALE_ATTEMPT_MS'));

// The platform rejects a read of a row that is not there. It does not answer null.
const getOrNull = make('getOrNull', pw('getOrNull', 'entity, id'));
const answering = (status) => ({ get: async () => { throw Object.assign(new Error('Entity Driver with ID x not found'), { status }); } });
check('a row that is not there is null, not an error', await getOrNull(answering(404), 'x'), null);
{
  let threw = '';
  try { await getOrNull(answering(500), 'x'); } catch (err) { threw = String(err.status); }
  check('any other failure is still a failure', threw, '500');
}
check('a row that is there comes back', (await getOrNull({ get: async (id) => ({ id }) }, 'x')).id, 'x');
check('an answer of nothing is passed on', await getOrNull({ get: async () => null }, 'x'), null);
{
  // The driver's profile was deleted, and the read is rejected the way the real platform rejects it.
  const sr = bank([request()], [releasedRow('e1', 20000)]);
  sr.Driver.get = answering(404).get;
  check('a driver profile that no longer exists is a reason, not a crash',
    await driverWithdrawalProblem(sr, request()), 'The driver profile for this request no longer exists.');
}
check('a request another call has just closed reserves nothing, and is refused for that',
  await problemFor(request({ status: 'failed' }), [releasedRow('e1', 20000)]), 'This request is no longer waiting to be paid.');

const debitOnRecord = make('debitOnRecord', pw('debitOnRecord', 'entries, withdrawal'));
const asked = referralRow();
const debit = (extra = {}) => ({ ...debitFor(asked), ...extra });
check('a request the app debited has its debit on record', debitOnRecord([debit()], asked), true);
check('…whatever case the address was typed in', debitOnRecord([debit({ user_email: 'Ada@Mail.NG' })], asked), true);
check('a debit for another request is not this one\'s', debitOnRecord([debit({ withdrawal_request_id: 'other' })], asked), false);
check('a debit for another amount is not', debitOnRecord([debit({ amount_ngn: 10000 })], asked), false);
check('a debit for another person is not', debitOnRecord([debit({ user_email: 'mallory@evil.ng' })], asked), false);
check('a claim on the refund is not a debit', debitOnRecord([debit({ kind: 'refund' })], asked), false);
check('no entries, no debit', debitOnRecord([], asked), false);
check('nothing at all, no debit', debitOnRecord(undefined, asked), false);

const RECENT = [constLine(PW, 'STALE_ATTEMPT_MS'), pw('madeRecently', 'entry, nowIso')];
const attemptBlocksRefund = make('attemptBlocksRefund', ...RECENT, pw('attemptBlocksRefund', 'entry, nowIso'));
const claimIsLive = make('claimIsLive', ...RECENT, pw('claimIsLive', 'entry, nowIso'));
const attemptRow = (state, minutes = 1) => ({ kind: 'attempt', state, created_date: minutesBefore(minutes) });
check('an attempt that sent blocks a refusal being credited back, however old', attemptBlocksRefund(attemptRow('sent', 600), SENT_AT), true);
check('an attempt still open a minute ago blocks it', attemptBlocksRefund(attemptRow('open'), SENT_AT), true);
check('an attempt left unconfirmed a minute ago blocks it', attemptBlocksRefund(attemptRow('unconfirmed'), SENT_AT), true);
check('an attempt left open eleven minutes ago died with its function', attemptBlocksRefund(attemptRow('open', 11), SENT_AT), false);
check('a refused attempt blocks nothing', attemptBlocksRefund(attemptRow('refused'), SENT_AT), false);
check('an abandoned attempt blocks nothing', attemptBlocksRefund(attemptRow('abandoned'), SENT_AT), false);
check('a row with no readable time counts as recent', attemptBlocksRefund({ kind: 'attempt', state: 'open' }, SENT_AT), true);
check('a claim is not an attempt', attemptBlocksRefund({ kind: 'refund', state: 'claimed', created_date: minutesBefore(1) }, SENT_AT), false);
const claimRow = (state, minutes = 1) => ({ kind: 'refund', state, created_date: minutesBefore(minutes) });
check('a claim that credited stands for good', claimIsLive(claimRow('credited', 600), SENT_AT), true);
check('a claim in the middle of crediting stands', claimIsLive(claimRow('crediting', 600), SENT_AT), true);
check('a claim made a minute ago stands', claimIsLive(claimRow('claimed'), SENT_AT), true);
check('a claim made eleven minutes ago and never decided does not', claimIsLive(claimRow('claimed', 11), SENT_AT), false);
for (const state of ['duplicate', 'held_back', 'no_user']) {
  check(`a ${state} claim does not stand`, claimIsLive(claimRow(state), SENT_AT), false);
}

const canRecheck = make('canRecheck', pw('canRecheck', 'withdrawal'));
const canCredit = make('canCredit', pw('refundsToBalance', 'withdrawal'), pw('canCredit', 'withdrawal'));
for (const status of ['abandoned', 'blocked', 'rejected']) {
  check(`a transfer Paystack reports as ${status} never left: failed`, rowStatusFor(status), 'failed');
}
// The screen offers exactly what the server would do.
for (const row of [
  { status: 'pending' }, { status: 'processing' }, { status: 'processing', transfer_code: 'TRF_1' },
  { status: 'processing', transfer_code: 'TRF_1', transfer_reference: REF },
  { status: 'completed', transfer_code: 'TRF_1', transfer_reference: REF },
  { status: 'failed' }, { status: 'failed', refunded_at: SENT_AT }, { status: 'failed', wallet: 'driver' },
  { status: 'reversed' }, { status: 'reversed', wallet: 'driver' },
]) {
  const offered = withdrawalActions(row);
  const label = JSON.stringify(row);
  check(`Process or Retry is offered for ${label} exactly when the server would send`, offered.send || offered.retry, canSend(row));
  check('…Check with Paystack exactly when the server would ask', offered.recheck, canRecheck(row));
  check('…Credit back exactly when the server would look', offered.credit, canCredit(row));
}
check('a stuck row is listed with the pending ones', showsUnderPending({ status: 'processing' }), true);
check('a row that was sent is not', showsUnderPending({ status: 'processing', transfer_code: 'TRF_1' }), false);
check('a first send is not a retry', `${withdrawalActions({ status: 'pending' }).send}/${withdrawalActions({ status: 'pending' }).retry}`, 'true/false');

const REFUSAL = 'Your balance is not enough to fulfil this request';
{
  // A referral request with no debit on record: made before the ledger
  // existed, or typed into the database by hand.
  const sr = payWorld(referralRow(), { ledger: [] });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a referral request with no debit on record is not sent on the first press',
    `${r.status}/${r.body.code}/${ps.calls.send}/${rowOf(sr).status}`, '409/UNRECORDED/0/pending');
  const again = await sendWithdrawal(sr, ps, referralRow(), SENT_AT, true);
  check('…it is sent when admin says so a second time', `${again.body.success}/${ps.transfers.size}`, 'true/1');
}
{
  const sr = payWorld(referralRow(), { ledger: [] });
  const r = await sendWithdrawal(sr, fakePaystack({ refusal: REFUSAL }), referralRow(), SENT_AT, true);
  check('…and if Paystack refuses it, it is failed but never credited back',
    `${rowOf(sr).status}/${balanceOf(sr)}/${r.body.refund}`, 'failed/5000/no_debit');
  check('…and the row says why', rowOf(sr).error_message.includes('no record of taking this amount'), true);
}
{
  // Typed in to look half-processed, so that the screen shows Retry.
  const sr = payWorld(referralRow({ status: 'processing' }), { ledger: [] });
  const ps = fakePaystack();
  const r = await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a hand-made "processing" row is not sent by Retry either', `${r.body.code}/${ps.calls.send}`, 'UNRECORDED/0');
}
{
  // Sent and acknowledged, and then the settlement event never arrived.
  const sent = referralRow({ status: 'processing', transfer_code: 'TRF_7', transfer_reference: REF });
  const settle = async (transferStatus) => {
    const sr = payWorld(sent);
    const ps = fakePaystack();
    ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: transferStatus });
    const r = await sendWithdrawal(sr, ps, sent, SENT_AT);
    return `${rowOf(sr).status}/${balanceOf(sr)}/${ps.calls.send}/${r.body.status}`;
  };
  check('asking Paystack about a sent row the bank paid completes it', await settle('success'), 'completed/5000/0/completed');
  check('…one the bank did not pay is failed and credited back', await settle('failed'), 'failed/20000/0/failed');
  check('…one Paystack abandoned is failed and credited back', await settle('abandoned'), 'failed/20000/0/failed');
  check('…one the bank sent back is reversed and credited back', await settle('reversed'), 'reversed/20000/0/reversed');
  check('…one still with the bank is left as it is', await settle('pending'), 'processing/5000/0/processing');
}
{
  const sent = referralRow({ status: 'processing', transfer_code: 'TRF_7', transfer_reference: REF });
  const sr = payWorld(sent);
  const none = await sendWithdrawal(sr, fakePaystack(), sent, SENT_AT);
  check('Paystack holds nothing for a row that says it was sent: nothing changes, and admin is told',
    `${none.body.code}/${rowOf(sr).status}`, 'NO_TRANSFER/processing');
  const deaf = await sendWithdrawal(sr, fakePaystack({ cannotAsk: true }), sent, SENT_AT);
  check('…and if Paystack cannot be asked, nothing changes either', `${deaf.body.code}/${rowOf(sr).status}`, 'UNCONFIRMED/processing');
}
{
  // Refused, while another attempt to send it was still in flight.
  const inFlight = { id: 'att0', kind: 'attempt', state: 'open', withdrawal_request_id: ROW_ID, created_date: minutesBefore(1) };
  const sr = payWorld(referralRow(), { ledger: [debitFor(referralRow()), inFlight] });
  const r = await sendWithdrawal(sr, fakePaystack({ refusal: REFUSAL }), referralRow(), SENT_AT);
  check('refused while another attempt is in flight: failed, and not credited back yet',
    `${rowOf(sr).status}/${balanceOf(sr)}/${r.body.refund}`, 'failed/5000/held_back');
  check('…the row says what to press', rowOf(sr).error_message.includes('Press Credit back'), true);
  // The other attempt ended in a refusal too. Admin presses Credit back.
  sr.WithdrawalLedger.rows.find((e) => e.id === 'att0').state = 'refused';
  const later = await sendWithdrawal(sr, fakePaystack(), { ...rowOf(sr) }, SENT_AT);
  check('Credit back then credits it', `${later.body.credited}/${balanceOf(sr)}/${rowOf(sr).refunded_at}`, `true/20000/${SENT_AT}`);
  const again = await sendWithdrawal(sr, fakePaystack(), { ...rowOf(sr) }, SENT_AT);
  check('…and a second press finds nothing to do', `${again.body.code}/${balanceOf(sr)}`, 'NOT_SENDABLE/20000');
}
{
  // Marked failed on a stale reading while the transfer it lost to went out.
  const failed = referralRow({ status: 'failed' });
  const sr = payWorld(failed);
  const ps = fakePaystack();
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'success' });
  const r = await sendWithdrawal(sr, ps, failed, SENT_AT);
  check('Credit back on a row whose transfer in fact went out credits nothing and corrects the row',
    `${rowOf(sr).status}/${balanceOf(sr)}/${r.body.already_sent}`, 'completed/5000/true');
}
{
  const failed = referralRow({ status: 'failed' });
  const halfDone = { id: 'c0', kind: 'refund', state: 'crediting', withdrawal_request_id: ROW_ID, created_date: minutesBefore(30) };
  const sr = payWorld(failed, { ledger: [debitFor(failed), halfDone] });
  const r = await sendWithdrawal(sr, fakePaystack(), failed, SENT_AT);
  check('a credit that was interrupted is never repeated blindly', `${r.body.refund}/${balanceOf(sr)}`, 'interrupted/5000');
}
{
  const failed = referralRow({ status: 'failed' });
  const sr = payWorld(failed, { ledger: [] });
  const r = await sendWithdrawal(sr, fakePaystack(), failed, SENT_AT);
  check('Credit back on a row with no debit on record credits nothing', `${r.body.refund}/${balanceOf(sr)}`, 'no_debit/5000');
}
{
  const failed = driverRow({ status: 'failed' });
  const sr = payWorld(failed, { earnings: [releasedRow('e1', 20000)] });
  const r = await sendWithdrawal(sr, fakePaystack(), failed, SENT_AT);
  check('a failed driver-wallet row has nothing to credit: failing it was its refund', `${r.body.code}/${balanceOf(sr)}`, 'NOT_SENDABLE/5000');
}
{
  // Paystack answers a repeat of a reference with a 2xx carrying the transfer
  // it already holds, and that transfer has already failed at the bank.
  const sr = payWorld(referralRow());
  const ps = fakePaystack({ staleFirstFind: true, duplicateAnswers2xx: true });
  ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'failed' });
  await sendWithdrawal(sr, ps, referralRow(), SENT_AT);
  check('a repeat answered with a transfer that already failed settles the row, it does not leave it processing',
    `${rowOf(sr).status}/${balanceOf(sr)}/${ps.transfers.size}`, 'failed/20000/1');
}
{
  const sr = payWorld(referralRow());
  const r = await sendWithdrawal(sr, fakePaystack({ sendStatus: 'otp' }), referralRow(), SENT_AT);
  check('a transfer Paystack is holding for a one-time code is not reported as on its way',
    `${r.body.warning}/${rowOf(sr).status}/${rowOf(sr).transfer_code}`, 'NEEDS_OTP/processing/TRF_1');
}

// The races. Each press is the shipped sendWithdrawal, handed an id the way
// the function is really called, so each one reads the row for itself.
const pressing = (row, extra, paystackOptions, count = 2) => () => {
  const sr = payWorld(row, extra);
  const ps = fakePaystack(paystackOptions);
  const press = (gate) => sendWithdrawalById(
    gatedWorld(sr, gate), viaGate(ps, gate, ['find', 'createRecipient', 'send']), row.id, false, SENT_AT);
  return { world: { sr, ps, row }, actors: Array.from({ length: count }, () => press) };
};
const creditedClaims = (sr) => sr.WithdrawalLedger.rows.filter((e) => e.kind === 'refund' && e.state === 'credited').length;
const wentOut = (ps) => [...ps.transfers.values()].filter((t) => rowStatusFor(t.status) !== 'failed' && rowStatusFor(t.status) !== 'reversed').length;
// What must be true of a referral withdrawal of ₦15,000 whatever happened.
const moneyIsRight = ({ sr, ps }, results) => {
  const broken = results.find((r) => !r || r.threw);
  if (broken !== undefined) return `a call threw: ${JSON.stringify(broken)}`;
  if (ps.transfers.size > 1) return `${ps.transfers.size} transfers left the account`;
  const credited = balanceOf(sr) - 5000;
  if (credited !== 0 && credited !== 15000) return `the balance moved by ${credited}`;
  if (creditedClaims(sr) !== (credited ? 1 : 0)) return `${creditedClaims(sr)} credited claim(s) for a balance that moved by ${credited}`;
  if (credited && wentOut(ps) > 0) return 'the withdrawal was both sent and credited back';
  if (credited && !rowOf(sr).refunded_at) return 'credited back, but the row does not say so';
  return '';
};
// One press of Credit back after the race, when nobody credited during it.
const creditBackAfterwards = async ({ sr }) => {
  const later = await sendWithdrawalById(sr, fakePaystack(), rowOf(sr).id, false, SENT_AT);
  if (!later.body.credited || balanceOf(sr) !== 20000 || creditedClaims(sr) !== 1) {
    return `Credit back afterwards did not credit once: ${JSON.stringify(later.body)}`;
  }
  return '';
};
{
  // The high finding. The earnings do not cover the request; the first call
  // closes it, and the second must not send it on the copy it read before.
  const uncovered = pressing(driverRow({ amount: 500000 }), { earnings: [releasedRow('e1', 20000)] });
  const out = await everySchedule(uncovered, ({ sr, ps }, results) => {
    if (results.some((r) => !r || r.threw)) return `a call threw: ${JSON.stringify(results)}`;
    if (ps.transfers.size !== 0) return `${ps.transfers.size} transfer(s) left for a request the earnings do not cover`;
    if (rowOf(sr).status !== 'failed') return `the row ended ${rowOf(sr).status}`;
    const told = results.map((r) => r.body.code);
    return told.every((c) => c === 'NOT_COVERED' || c === 'NOT_SENDABLE') ? '' : `the presses were told ${JSON.stringify(told)}`;
  }, Infinity);
  check(`two presses on a driver-wallet request the earnings do not cover (${out.runs} orders): nothing is sent`, `${out.problem}${out.schedule}`, '');
  check('…and that was more than a handful of orders', out.runs > 500, true);
}
{
  // Both presses are refused for a stated reason. Before, each credited the balance.
  const verdict = async (world, results) => {
    const wrong = moneyIsRight(world, results);
    if (wrong) return wrong;
    if (world.ps.transfers.size !== 0 || rowOf(world.sr).status !== 'failed') {
      return `a refused withdrawal ended ${rowOf(world.sr).status} with ${world.ps.transfers.size} transfer(s)`;
    }
    // Credited at once, or both stood down for each other and one more press does it.
    return balanceOf(world.sr) === 20000 ? '' : creditBackAfterwards(world);
  };
  const out = await everySchedule(pressing(referralRow(), undefined, { refusal: REFUSAL }), verdict, 3);
  check(`two presses both refused (${out.runs} orders): credited back exactly once`, `${out.problem}${out.schedule}`, '');
  const more = await randomSchedules(pressing(referralRow(), undefined, { refusal: REFUSAL }), verdict, 1000, 11);
  check(`…and in ${more.runs} random orders with no limit on changes of turn`, `${more.problem}${more.schedule}`, '');
  const three = await randomSchedules(pressing(referralRow(), undefined, { refusal: REFUSAL }, 3), verdict, 1000, 12);
  check(`…and with three presses, ${three.runs} random orders`, `${three.problem}${three.schedule}`, '');
}
{
  // The first send is refused for a stated reason and the next one, a moment
  // later, is accepted. Before, one call credited the balance and the other
  // sent the transfer.
  const verdict = async (world, results) => {
    const wrong = moneyIsRight(world, results);
    if (wrong) return wrong;
    if (wentOut(world.ps) > 0 || balanceOf(world.sr) === 20000) return '';
    return rowOf(world.sr).status === 'failed' ? creditBackAfterwards(world) : `nothing was sent or credited and the row ended ${rowOf(world.sr).status}`;
  };
  const out = await everySchedule(pressing(referralRow(), undefined, { refuseFirst: REFUSAL }), verdict, 3);
  check(`refused, then accepted a moment later (${out.runs} orders): sent or credited back, never both`, `${out.problem}${out.schedule}`, '');
  const more = await randomSchedules(pressing(referralRow(), undefined, { refuseFirst: REFUSAL }), verdict, 1000, 13);
  check(`…and in ${more.runs} random orders`, `${more.problem}${more.schedule}`, '');
}

// The bank's event arriving while a press is in flight. The actor is the
// webhook's own steps for one event: read the row, webhookShouldAct, write,
// and for a failure the webhook's copy of refundReferralOnce.
const webhookRefund = make('refundReferralOnce', constLine(WH, 'STALE_ATTEMPT_MS'), FETCH_ALL,
  ...LEDGER_FNS.map(([name, signature]) => liftSrc(WH, name, signature)));
const bankEvent = (world, eventName, transferStatus) => async (gate) => {
  const { sr, ps, row } = world;
  const w = gatedWorld(sr, gate);
  await gate(); // the moment the event arrives
  const transfer = ps.transfers.get(transferReferenceFor(row.id));
  if (!transfer) return 'no event'; // nothing was sent, so Paystack has nothing to report
  transfer.status = transferStatus; // the bank settled it
  const current = await w.WithdrawalRequest.get(row.id);
  if (!webhookShouldAct(eventName, current)) return 'skipped';
  if (eventName === 'transfer.success') {
    await w.WithdrawalRequest.update(row.id, { status: 'completed', processed_at: SENT_AT });
    return 'completed';
  }
  const status = eventName === 'transfer.reversed' ? 'reversed' : 'failed';
  await w.WithdrawalRequest.update(row.id, { status, processed_at: SENT_AT });
  return `${status}:${await webhookRefund(w, current, SENT_AT, false)}`;
};
const withEvent = (setup, eventName, transferStatus, prepare = () => {}) => () => {
  const made = setup();
  prepare(made.world);
  return { world: made.world, actors: [...made.actors, bankEvent(made.world, eventName, transferStatus)] };
};
{
  // Two presses and the bank's success. Before, a press holding a stale copy
  // could write "processing" over the webhook's "completed" and leave it there.
  const verdict = (world, results) => {
    const wrong = moneyIsRight(world, results.slice(0, 2));
    if (wrong) return wrong;
    const { sr, ps } = world;
    if (ps.transfers.size !== 1 || balanceOf(sr) !== 5000) return `${ps.transfers.size} transfer(s), balance ${balanceOf(sr)}`;
    if (results[2] === 'completed' && rowOf(sr).status !== 'completed') return `the webhook completed the row and it ended ${rowOf(sr).status}`;
    return ['completed', 'processing'].includes(rowOf(sr).status) ? '' : `the row ended ${rowOf(sr).status}`;
  };
  const out = await everySchedule(withEvent(pressing(referralRow()), 'transfer.success', 'success'), verdict, 3);
  check(`two presses while the bank's success arrives (${out.runs} orders): a completed row stays completed`, `${out.problem}${out.schedule}`, '');
  const more = await randomSchedules(withEvent(pressing(referralRow()), 'transfer.success', 'success'), verdict, 1000, 14);
  check(`…and in ${more.runs} random orders`, `${more.problem}${more.schedule}`, '');
}
{
  // Retry on a stuck row at the moment the bank's failure arrives: two
  // different pieces of code both want to credit it back.
  const stuck = referralRow({ status: 'processing', transfer_reference: REF });
  const failedAtBank = (world) => world.ps.transfers.set(REF, { id: 7, transfer_code: 'TRF_7', status: 'failed' });
  const verdict = (world, results) => moneyIsRight(world, results.slice(0, 1))
    || (rowOf(world.sr).status === 'failed' ? '' : `the row ended ${rowOf(world.sr).status}`)
    || (balanceOf(world.sr) === 20000 ? '' : `the balance ended at ${balanceOf(world.sr)}`);
  const out = await everySchedule(withEvent(pressing(stuck, undefined, undefined, 1), 'transfer.failed', 'failed', failedAtBank), verdict, 3);
  check(`Retry while the bank's failure arrives (${out.runs} orders): credited back exactly once`, `${out.problem}${out.schedule}`, '');
  check('…and that was more than a handful of orders', out.runs > 200, true);
  const more = await randomSchedules(withEvent(pressing(stuck, undefined, undefined, 1), 'transfer.failed', 'failed', failedAtBank), verdict, 1000, 15);
  check(`…and in ${more.runs} random orders`, `${more.problem}${more.schedule}`, '');
}

// ---- result ----
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node scripts/check-entities.mjs`

Expected: ` FAIL  WithdrawalLedger exists`, and the lines after it.

Run: `node scripts/check-driver-wallet.mjs`

Expected: the script stops with `Cannot find module` for `src/lib/withdrawalRow.js`.

- [ ] **Step 3: The ledger entity**

Admin-only for every operation from the day it is created, which is the whole point: a row in it cannot be typed in from a browser.

**Create `base44/entities/WithdrawalLedger.jsonc`:**

```json
{
  "name": "WithdrawalLedger",
  "type": "object",
  "properties": {
    "withdrawal_request_id": {
      "type": "string",
      "description": "The WithdrawalRequest this row is about"
    },
    "user_email": {
      "type": "string",
      "description": "Whose referral balance it concerns"
    },
    "kind": {
      "type": "string",
      "enum": [
        "debit",
        "attempt",
        "refund"
      ],
      "description": "debit: createWithdrawalRequest took the amount off the stored balance. attempt: a call is about to ask Paystack to send the withdrawal. refund: a call claims the right to credit it back."
    },
    "state": {
      "type": "string",
      "description": "debit: recorded. attempt: open, then sent | refused | unconfirmed | abandoned. refund: claimed, then crediting, then credited; or duplicate | held_back | no_user."
    },
    "amount_ngn": {
      "type": "number",
      "description": "Whole naira"
    }
  },
  "required": [
    "withdrawal_request_id",
    "user_email",
    "kind",
    "amount_ngn"
  ],
  "rls": {
    "create": {
      "user_condition": {
        "role": "admin"
      }
    },
    "read": {
      "user_condition": {
        "role": "admin"
      }
    },
    "update": {
      "user_condition": {
        "role": "admin"
      }
    },
    "delete": {
      "user_condition": {
        "role": "admin"
      }
    }
  }
}
```

- [ ] **Step 4: Rewrite `processWithdrawal`**

Unchanged, character for character: `fetchAll`, `isId`, the three wallet arithmetic helpers, `refundsToBalance`, `transferReferenceFor`, `canSend`, `bankBelongsTo`, `lookupFromResponse`, `refusalMessage`, `transferOutcome` and `paystackClient`. Everything else is new or changed.

**Replace `base44/functions/processWithdrawal/entry.ts` with:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// processWithdrawal
// ----------------------------------------------------------------------------
// Admin sends a withdrawal to Paystack, or asks Paystack about one it already
// has.
//
// SENT ONCE. Nothing on this platform can lock a row, so two calls for the
// same withdrawal (two tabs, two admins, a second press after a timeout) can
// both read it as pending. Three things stand between that and two bank
// transfers:
//   1. the Paystack reference is fixed per row, wd-<row id>, and Paystack
//      does not hold two transfers with one reference;
//   2. before sending, and again after any refusal, this function asks
//      Paystack what it already holds for that reference;
//   3. the row is read again immediately before it is marked processing, and
//      a row another call has just closed is left closed.
// A withdrawal is marked failed only when Paystack refused it for a stated
// reason AND holds no transfer for it.
//
// CREDITED BACK ONCE, AND ONLY WHAT WAS TAKEN. A referral withdrawal is paid
// out of a stored balance, which createWithdrawalRequest debits and records
// in WithdrawalLedger. A failed one is credited back only if that debit is on
// record, exactly once, and never while another attempt to send it could
// still succeed (refundReferralOnce). A referral request with no debit on
// record was made before the ledger existed or typed into the database by
// hand; the two look the same. It is not sent unless admin says so a second
// time, and it is never credited back automatically.
//
// NEVER STUCK. The reference is written on the row before Paystack is asked
// to send. If the answer never arrives, the row stays processing with no
// transfer code, which canSend() lets admin retry. A row that does have a
// transfer code is never sent again, but canRecheck() lets admin ask Paystack
// where it stands, which settles a row whose webhook never arrived. A failed
// referral row that was not credited back can be looked at again the same
// way (canCredit).
//
// ON THE LEDGER. A driver-wallet withdrawal was not debited from anywhere:
// the row is the reservation against the driver's released earnings. So it
// is checked against the earnings ledger again here, and the request itself
// must be one of the rows that check counts, still waiting to be paid.
// Nothing on the row is trusted: a browser can create a WithdrawalRequest row
// directly until the stricter create rule staged in
// docs/entity-rules-pending-publish is live.

const WITHDRAWAL_THRESHOLD_NGN = 10000;

// How long a call that wrote an "attempt" or a "claim" row can still be
// running. A row older than this with no outcome on it is taken to have died
// with its function. Lockstep in processWithdrawal and paystackTransferWebhook.
const STALE_ATTEMPT_MS = 10 * 60 * 1000;

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, undefined, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

// An id that arrived in a request, or sits on a row a browser could have
// written. entity.get(id) is a GET on …/<id>, so "abc#x" or "abc?x=1" fetches
// row "abc" while every equality check here sees a different string, and
// "../User/abc" fetches a row of another entity altogether. Only a plain id
// is ever used. Lockstep copies in every function that takes an id.
function isId(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// entity.get() rejects when there is no such row (the platform answers 404).
// This answers null for that one case and lets every other failure through,
// so "the row is gone" and "the read failed" are never confused.
async function getOrNull(entity: any, id: string) {
    try {
        return await entity.get(id);
    } catch (err) {
        const status = err && (err.status || (err.response && err.response.status));
        if (status === 404) return null;
        throw err;
    }
}

// ── Wallet arithmetic — lockstep copies, see getDriverWallet ────────────────

// Every login this driver is, or was, linked to. Lower-cased, once each.
function driverEmails(driver: any) {
    const all = [driver && driver.user_email].concat((driver && driver.previous_user_emails) || []);
    const out = [];
    for (const raw of all) {
        const email = String(raw || '').trim().toLowerCase();
        if (email && !out.includes(email)) out.push(email);
    }
    return out;
}

// The withdrawal rows that count against this driver's balance: driver-wallet
// rows carrying this driver's id AND made by a login that is, or was, linked
// to this driver. The second condition is not decoration. Until the staged
// rule that stops browsers creating WithdrawalRequest rows is live, any
// signed-in user can create one for their own email with any driver_id on it;
// the email is the one field the access rule pins to the creator.
function driverWithdrawals(driver: any, rows: any[]) {
    if (!driver) return [];
    const emails = driverEmails(driver);
    return (rows || []).filter((w) => !!w
        && w.wallet === 'driver'
        && w.driver_id === driver.id
        && emails.includes(String(w.user_email || '').trim().toLowerCase()));
}

// The driver's position in whole naira. Pass withdrawals through
// driverWithdrawals first. A failed or reversed transfer counts nowhere, so it
// needs no refund. If pay is reversed after it was withdrawn, available stops
// at zero and the difference is carried as shortfall until later pay covers it.
function walletTotals(earnings: any[], withdrawals: any[]) {
    const naira = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    let held = 0;
    let released = 0;
    for (const e of earnings || []) {
        // A row that has ever been reversed counts nowhere, whatever its
        // status says. Nothing here can lock a row, so a release can land on
        // top of a reversal made a moment earlier; reversed_at is never
        // cleared, which makes it the one mark that cannot be lost that way.
        if (!e || e.reversed_at) continue;
        if (e.status === 'held') held += naira(e.amount_ngn);
        else if (e.status === 'released') released += naira(e.amount_ngn);
    }
    let paidOut = 0;
    let reserved = 0;
    for (const w of withdrawals || []) {
        if (!w) continue;
        if (w.status === 'completed') paidOut += naira(w.amount);
        else if (w.status === 'pending' || w.status === 'processing') reserved += naira(w.amount);
    }
    const net = released - paidOut - reserved;
    return {
        held,
        released,
        paid_out: paidOut,
        reserved,
        available: Math.max(0, net),
        shortfall: Math.max(0, -net),
    };
}

// Only a withdrawal that debited a stored balance is refunded to one. A row
// written before wallets existed is a referral withdrawal. Lockstep copy in
// paystackTransferWebhook.
function refundsToBalance(withdrawal: any) {
    return !!withdrawal && withdrawal.wallet !== 'driver';
}

// ── The referral balance's paper trail — lockstep in paystackTransferWebhook ─
// WithdrawalLedger is admin-only for every operation, so unlike a
// WithdrawalRequest row it cannot be typed in from a browser. Three kinds of
// row, all for one withdrawal:
//   debit    createWithdrawalRequest took the amount off the stored balance
//   attempt  a call is about to ask Paystack to send it
//            (open, then sent | refused | unconfirmed | abandoned)
//   refund   a call claims the right to credit it back
//            (claimed, then crediting, then credited; or duplicate | held_back | no_user)

// Whether the app has on record that it took this request's amount off the
// user's referral balance.
function debitOnRecord(entries: any[], withdrawal: any) {
    const email = String((withdrawal && withdrawal.user_email) || '').trim().toLowerCase();
    const amount = Number(withdrawal && withdrawal.amount);
    if (!email || !Number.isFinite(amount) || amount <= 0) return false;
    return (entries || []).some((e) => !!e
        && e.kind === 'debit'
        && e.withdrawal_request_id === withdrawal.id
        && String(e.user_email || '').trim().toLowerCase() === email
        && Number(e.amount_ngn) === amount);
}

// Whether a ledger row was made recently enough that the call that made it
// can still be running. A row with no readable time counts as recent.
function madeRecently(entry: any, nowIso: string) {
    const made = Date.parse((entry && entry.created_date) || '');
    const now = Date.parse(nowIso || '');
    if (Number.isNaN(made) || Number.isNaN(now)) return true;
    return now - made < STALE_ATTEMPT_MS;
}

// Whether a ledger row is an attempt to send that has put a transfer out, or
// still could. While one exists, a refusal with nothing held at Paystack is
// not safe to credit back: the other attempt could succeed a moment later.
function attemptBlocksRefund(entry: any, nowIso: string) {
    if (!entry || entry.kind !== 'attempt') return false;
    if (entry.state === 'sent') return true;
    return (entry.state === 'open' || entry.state === 'unconfirmed') && madeRecently(entry, nowIso);
}

// Whether a ledger row is a claim on this withdrawal's refund that still
// stands: it has credited, is in the middle of crediting, or was made a
// moment ago and has not been decided. An attempt to send that sees one
// stands down.
function claimIsLive(entry: any, nowIso: string) {
    if (!entry || entry.kind !== 'refund') return false;
    if (entry.state === 'credited' || entry.state === 'crediting') return true;
    return entry.state === 'claimed' && madeRecently(entry, nowIso);
}

// Credit a failed referral withdrawal back to the stored balance: only what
// the app took, and exactly once.
//
// Nothing here can lock a row, so "has this been refunded?" cannot be read
// and then acted on: two calls would both read "no". Instead each call first
// writes a claim, then reads all the claims; only the oldest standing one
// credits. `unsent` says the refund is for a refusal with nothing held at
// Paystack; that one also stands down while another attempt to send could
// still put a transfer out, so a withdrawal is never both paid and credited.
//
// Answers refunded | already | no_debit | held_back | interrupted | no_user |
// not_stored. A driver-wallet request debited nothing, so marking it failed
// is its refund (not_stored).
async function refundReferralOnce(sr: any, withdrawal: any, nowIso: string, unsent: boolean) {
    if (!refundsToBalance(withdrawal)) return 'not_stored';
    const own = { withdrawal_request_id: withdrawal.id };
    const before = await fetchAll(sr.WithdrawalLedger, own);
    if (!debitOnRecord(before, withdrawal)) return 'no_debit';
    if (before.some((e) => e.kind === 'refund' && e.state === 'credited')) return 'already';
    // A credit that started and never finished: the balance may or may not
    // carry it. Only a person can tell.
    const halfDone = before.find((e) => e.kind === 'refund' && e.state === 'crediting');
    if (halfDone) return madeRecently(halfDone, nowIso) ? 'already' : 'interrupted';
    // A row refunded before the ledger existed carries only the stamp.
    const fresh = await sr.WithdrawalRequest.get(withdrawal.id);
    if (!fresh || fresh.refunded_at) return 'already';

    const amount = Math.max(0, Math.round(Number(withdrawal.amount) || 0));
    const claim = await sr.WithdrawalLedger.create({
        withdrawal_request_id: withdrawal.id,
        user_email: withdrawal.user_email,
        kind: 'refund',
        state: 'claimed',
        amount_ngn: amount,
    });
    const after = await fetchAll(sr.WithdrawalLedger, own);
    const standing = after
        .filter((e) => claimIsLive(e, nowIso))
        .sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
            || String(a.id).localeCompare(String(b.id)));
    if (standing.length === 0 || standing[0].id !== claim.id) {
        await sr.WithdrawalLedger.update(claim.id, { state: 'duplicate' });
        return 'already';
    }
    if (unsent && after.some((e) => attemptBlocksRefund(e, nowIso))) {
        await sr.WithdrawalLedger.update(claim.id, { state: 'held_back' });
        return 'held_back';
    }
    const users = await sr.User.filter({ email: withdrawal.user_email });
    if (!Array.isArray(users) || users.length === 0) {
        await sr.WithdrawalLedger.update(claim.id, { state: 'no_user' });
        return 'no_user';
    }
    await sr.WithdrawalLedger.update(claim.id, { state: 'crediting' });
    await sr.User.update(users[0].id, {
        referral_balance_ngn: (Number(users[0].referral_balance_ngn) || 0) + amount,
    });
    await sr.WithdrawalLedger.update(claim.id, { state: 'credited' });
    await sr.WithdrawalRequest.update(withdrawal.id, { refunded_at: nowIso });
    return 'refunded';
}

// ── Sending ─────────────────────────────────────────────────────────────────

// The Paystack reference for a withdrawal. Fixed per row, in the form
// Paystack requires (lowercase letters, digits, - and _, 16 to 50 characters),
// so Paystack never holds two transfers for one withdrawal.
// paystackTransferWebhook reads the row id back out of it.
function transferReferenceFor(withdrawalId: string) {
    return `wd-${String(withdrawalId).toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
}

// Whether this row may be sent now: a pending one, or one an earlier attempt
// marked processing without ever getting a transfer code back. Sending the
// second kind again is safe because its reference is the same.
function canSend(withdrawal: any) {
    if (!withdrawal) return false;
    if (withdrawal.status === 'pending') return true;
    return withdrawal.status === 'processing' && !withdrawal.transfer_code;
}

// Whether Paystack can be asked where this row's transfer stands: a row that
// was sent under a reference Paystack knows it by, has a transfer code, and
// has not been settled. Asking never sends anything.
function canRecheck(withdrawal: any) {
    return !!withdrawal && withdrawal.status === 'processing' && !!withdrawal.transfer_code && !!withdrawal.transfer_reference;
}

// Whether a closed referral row can still be looked at for crediting back:
// it failed, or was reversed, and carries no sign that it was credited.
function canCredit(withdrawal: any) {
    return refundsToBalance(withdrawal)
        && (withdrawal.status === 'failed' || withdrawal.status === 'reversed')
        && !withdrawal.refunded_at;
}

// Whether the bank account on a request is the requester's own.
function bankBelongsTo(bankAccount: any, withdrawal: any) {
    const owner = String((bankAccount && bankAccount.user_email) || '').trim().toLowerCase();
    const asker = String((withdrawal && withdrawal.user_email) || '').trim().toLowerCase();
    return !!owner && owner === asker;
}

// What Paystack's answer to "what do you hold for this reference?" means:
// the transfer; null for a definite "nothing"; undefined for "could not
// tell". When a transfer exists the answer is a 2xx carrying it, so any
// ordinary refusal means there is none. A bad key, a timeout, a rate limit
// or a fault on Paystack's side says nothing either way.
function lookupFromResponse(httpStatus: number, body: any) {
    if (httpStatus >= 200 && httpStatus < 300) {
        return body && body.status && body.data && body.data.transfer_code ? body.data : undefined;
    }
    if (httpStatus < 400 || httpStatus === 401 || httpStatus === 403) return undefined;
    if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return undefined;
    return null;
}

// Paystack's stated reason for refusing a request, or null when it gave no
// usable answer: no response at all (0), a timeout, a rate limit, a fault on
// its side, a body that was not JSON, or a 2xx without what was asked for.
// null never leads to a refund. It means "ask again", not "no".
function refusalMessage(httpStatus: number, body: any, fallback: string) {
    if (httpStatus < 400 || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return null;
    if (!body || typeof body !== 'object') return null;
    return String(body.message || fallback);
}

// What happened to a transfer request. `message` is refusalMessage's answer;
// `lookup` is lookupFromResponse's.
//   sent          Paystack accepted it
//   already_sent  not accepted, but the transfer exists: another call, or an
//                 earlier attempt, got there first
//   failed        refused for a stated reason and nothing exists: the only
//                 case in which a referral is refunded
//   unconfirmed   anything else. The row stays processing and nobody is
//                 refunded, because refunding a transfer that did go out
//                 would pay twice.
function transferOutcome(accepted: boolean, message: string | null, lookup: any) {
    if (accepted) return 'sent';
    if (lookup && lookup.transfer_code) return 'already_sent';
    if (lookup === undefined) return 'unconfirmed';
    if (message === null || message === undefined) return 'unconfirmed';
    if (/reference/i.test(String(message))) return 'unconfirmed';
    return 'failed';
}

// Where a withdrawal row should stand given the status Paystack reports for
// its transfer. '' means not settled yet: the row stays processing. A
// transfer that was abandoned, blocked or rejected never left the account,
// and Paystack sends no event for those, so they are treated as failed.
function rowStatusFor(transferStatus: string) {
    if (transferStatus === 'success') return 'completed';
    if (transferStatus === 'reversed') return 'reversed';
    if (['failed', 'abandoned', 'blocked', 'rejected'].includes(transferStatus)) return 'failed';
    return '';
}

// Why a driver-wallet withdrawal must not be paid, or '' when it may be.
// The request itself has to be one of the rows walletTotals counts, so "the
// ledger covers it" is the same as "there is no shortfall".
async function driverWithdrawalProblem(sr: any, w: any) {
    const amount = Number(w.amount);
    if (typeof w.amount !== 'number' || !Number.isInteger(amount) || amount < WITHDRAWAL_THRESHOLD_NGN) {
        return 'The amount on this request is not a valid withdrawal.';
    }
    if (!isId(w.driver_id)) return 'This request names no driver.';
    const driver = await getOrNull(sr.Driver, w.driver_id);
    if (!driver) return 'The driver profile for this request no longer exists.';
    // Whatever the lookup answered with, it must be the row the request names.
    if (driver.id !== w.driver_id) return 'This request names no driver.';
    // Only the login linked to the driver right now may start a withdrawal.
    const requester = String(w.user_email || '').trim().toLowerCase();
    if (!requester || requester !== String(driver.user_email || '').trim().toLowerCase()) {
        return 'This login is not the one linked to the driver profile.';
    }
    const earnings = await fetchAll(sr.DriverEarning, { driver_id: driver.id });
    const rows = await fetchAll(sr.WithdrawalRequest, { driver_id: driver.id });
    const counted = driverWithdrawals(driver, rows);
    // If the request is not among the counted rows, the arithmetic below says
    // nothing about it, and "no shortfall" would be meaningless.
    const own = counted.find((r) => r.id === w.id);
    if (!own) return 'This request is not on the driver\'s ledger.';
    // It must also still be waiting to be paid. A row another call has just
    // closed is on the ledger but reserves nothing, so "no shortfall" would
    // be true of it for the wrong reason.
    if (own.status !== 'pending' && own.status !== 'processing') return 'This request is no longer waiting to be paid.';
    const totals = walletTotals(earnings, counted);
    if (totals.shortfall > 0) {
        return `The driver's released earnings do not cover this request (short by ₦${totals.shortfall.toLocaleString()}).`;
    }
    return '';
}

// Send one withdrawal, or look again at one that was already sent or closed,
// and say what the response should be: { status, body }. It reads the row
// itself, so a caller never hands it a stale copy, and everything that
// touches Paystack goes through `paystack` (see paystackClient): this exact
// code runs in scripts/check-driver-wallet.mjs against a stand-in, several
// calls at once, in every order their requests could arrive.
async function sendWithdrawal(sr: any, paystack: any, withdrawalId: string, allowUnrecorded: boolean, nowIso: string) {
    const refuse = (status, error, code) => ({ status, body: { success: false, error, code } });
    const withdrawal = await getOrNull(sr.WithdrawalRequest, withdrawalId);
    if (!withdrawal || withdrawal.id !== withdrawalId) return refuse(404, 'Withdrawal request not found', 'NOT_FOUND');

    const reference = transferReferenceFor(withdrawal.id);
    const stored = refundsToBalance(withdrawal);
    const amount = Math.max(0, Math.round(Number(withdrawal.amount) || 0));
    const closed = (row) => refuse(409, row && row.refunded_at && canSend(row)
        ? 'This withdrawal has already been credited back. It cannot be sent.'
        : `Withdrawal is already ${row ? row.status : 'gone'}`, 'NOT_SENDABLE');
    const cannotAsk = () => refuse(502, 'Paystack could not be asked about this withdrawal, so nothing was sent and nothing changed. Try again in a minute.', 'UNCONFIRMED');
    // What a failed row and admin are told about the balance.
    const creditNote = (outcome) => ({
        refunded: ` ₦${amount.toLocaleString()} was credited back to the referral balance.`,
        already: ' It had already been credited back.',
        no_debit: ' It was NOT credited back: the app has no record of taking this amount off the balance. Credit it by hand if the request was genuine.',
        held_back: ' It was NOT credited back yet: another attempt to send it was still in flight. Press Credit back in a few minutes.',
        interrupted: ' It was NOT credited back: an earlier credit for it was interrupted. Check the balance and correct it by hand.',
        no_user: ' It was NOT credited back: no account has this email.',
    }[outcome] || '');
    // This call's own "attempt" row in the ledger (referral requests only),
    // and how the attempt ended.
    let attempt = null;
    const closeAttempt = async (state) => {
        if (attempt) await sr.WithdrawalLedger.update(attempt.id, { state });
    };

    // The transfer exists at Paystack. Record its codes. The row's status is
    // only ever moved forward: to its settled state if the bank has settled
    // and the row is not final yet, or from pending to processing. It is
    // never written over a state the settlement webhook may have set a
    // moment ago, which is why the row is read again here.
    const alreadySent = async (transfer) => {
        const settled = rowStatusFor(transfer.status);
        const fresh = await getOrNull(sr.WithdrawalRequest, withdrawal.id);
        const open = !!fresh && (fresh.status === 'pending' || fresh.status === 'processing');
        const bankSaid = settled === 'reversed' ? 'The bank sent this transfer back.' : 'The bank did not pay this transfer.';
        const patch = {
            transfer_reference: reference,
            transfer_code: transfer.transfer_code,
            transfer_id: String(transfer.id || ''),
        };
        if (settled && open) {
            patch.status = settled;
            patch.processed_at = nowIso;
            if (settled !== 'completed') patch.error_message = bankSaid;
        } else if (!settled && fresh && fresh.status === 'pending') {
            patch.status = 'processing';
        }
        await sr.WithdrawalRequest.update(withdrawal.id, patch);
        let note = '';
        if (open && (settled === 'failed' || settled === 'reversed')) {
            const outcome = await refundReferralOnce(sr, withdrawal, nowIso, false);
            note = creditNote(outcome);
            if (outcome !== 'refunded' && outcome !== 'not_stored' && outcome !== 'already') {
                await sr.WithdrawalRequest.update(withdrawal.id, { error_message: `${bankSaid}${note}` });
            }
        }
        const status = patch.status || (fresh && fresh.status) || 'processing';
        const what = {
            completed: 'This withdrawal had already been sent, and the bank has paid it.',
            failed: 'This withdrawal had already been sent, and the bank did not pay it. It is marked failed.',
            reversed: 'This withdrawal had already been sent, and the bank sent the money back. It is marked reversed.',
        }[status] || 'This withdrawal had already been sent to Paystack. Its status will update when the bank settles.';
        return {
            status: 200,
            body: {
                success: true,
                already_sent: true,
                status,
                message: `${what} Nothing was sent a second time.${note}`,
            },
        };
    };

    // What it means that Paystack did not accept a request. `message` is its
    // stated reason, or null when it gave no usable answer.
    const notAccepted = async (label, message, details) => {
        const lookup = await paystack.find(reference);
        const outcome = transferOutcome(false, message, lookup);
        if (outcome === 'already_sent') {
            // Somebody's transfer for this withdrawal exists. It is not this
            // attempt's: this one was turned away.
            await closeAttempt('refused');
            return alreadySent(lookup);
        }
        if (outcome === 'unconfirmed') {
            await closeAttempt('unconfirmed');
            return refuse(502, `Paystack did not confirm the transfer. The withdrawal is left as processing and cannot be sent twice. Press Retry in a minute. If it keeps happening, look up the reference ${reference} in Paystack.`, 'UNCONFIRMED');
        }
        await sr.WithdrawalRequest.update(withdrawal.id, {
            status: 'failed',
            error_message: message || label,
            processed_at: nowIso,
        });
        await closeAttempt('refused');
        const refund = await refundReferralOnce(sr, withdrawal, nowIso, true);
        if (refund !== 'refunded' && refund !== 'not_stored' && refund !== 'already') {
            await sr.WithdrawalRequest.update(withdrawal.id, { error_message: `${message || label}.${creditNote(refund)}` });
        }
        return { status: 400, body: { success: false, error: label, details, refund } };
    };

    // ── A row that was already sent: ask, never send ────────────────────────
    if (canRecheck(withdrawal)) {
        const held = await paystack.find(reference);
        if (held === undefined) return cannotAsk();
        if (!held) {
            return refuse(409, `Paystack holds no transfer under the reference ${reference}. Nothing changed. Look this withdrawal up in the Paystack dashboard by its transfer code.`, 'NO_TRANSFER');
        }
        return alreadySent(held);
    }

    // ── A failed referral row that was not credited back: look again ────────
    if (canCredit(withdrawal)) {
        const held = await paystack.find(reference);
        if (held === undefined) return cannotAsk();
        const heldStatus = held ? rowStatusFor(held.status) : 'none';
        if (held && heldStatus !== 'failed' && heldStatus !== 'reversed') {
            // Paystack holds a transfer for this withdrawal that did not fail:
            // the row was marked failed on a stale reading while the money
            // went out. Put the row right; there is nothing to credit back.
            await sr.WithdrawalRequest.update(withdrawal.id, {
                status: heldStatus || 'processing',
                transfer_reference: reference,
                transfer_code: held.transfer_code,
                transfer_id: String(held.id || ''),
                ...(heldStatus ? { processed_at: nowIso } : {}),
            });
            return {
                status: 200,
                body: {
                    success: true,
                    already_sent: true,
                    status: heldStatus || 'processing',
                    message: 'Paystack holds a transfer for this withdrawal that did not fail, so nothing was credited back. The row has been corrected.',
                },
            };
        }
        const refund = await refundReferralOnce(sr, withdrawal, nowIso, !held);
        return {
            status: 200,
            body: {
                success: true,
                credited: refund === 'refunded',
                refund,
                message: `Checked with Paystack: ${held ? 'the transfer did not go through' : 'it holds no transfer for this withdrawal'}.${creditNote(refund)}`,
            },
        };
    }

    if (!canSend(withdrawal)) return closed(withdrawal);

    // ── Send ────────────────────────────────────────────────────────────────
    // Ask before sending. A transfer for this withdrawal may already exist:
    // an earlier attempt whose answer was lost, or a press a moment ago.
    const before = await paystack.find(reference);
    if (before === undefined) return cannotAsk();
    if (before) return alreadySent(before);

    if (!stored) {
        // A driver-wallet request is only as good as the ledger behind it.
        // One that fails is closed, so it cannot be retried into a payout
        // later. Nothing was debited for it, so nothing is credited back.
        const problem = await driverWithdrawalProblem(sr, withdrawal);
        if (problem) {
            // Another call may have sent it, or closed it, while the ledger
            // was being read. Look once more before writing "failed" on it.
            const again = await paystack.find(reference);
            if (again === undefined) return cannotAsk();
            if (again) return alreadySent(again);
            const latest = await getOrNull(sr.WithdrawalRequest, withdrawal.id);
            if (!canSend(latest)) return closed(latest);
            await sr.WithdrawalRequest.update(withdrawal.id, {
                status: 'failed',
                error_message: problem,
                processed_at: nowIso,
            });
            return refuse(409, problem, 'NOT_COVERED');
        }
    } else if (!allowUnrecorded) {
        const entries = await fetchAll(sr.WithdrawalLedger, { withdrawal_request_id: withdrawal.id });
        if (!debitOnRecord(entries, withdrawal)) {
            return refuse(409, 'The app has no record of taking this amount off the referral balance. A request made before this version of the app can be genuine; one typed into the database by hand looks exactly the same. Check the person\'s referral earnings before sending it. If it is sent and then fails, it will not be credited back automatically.', 'UNRECORDED');
        }
    }

    let bankAccount = null;
    if (isId(withdrawal.bank_account_id)) bankAccount = await getOrNull(sr.UserBankAccount, withdrawal.bank_account_id);
    if (!bankAccount) return refuse(404, 'Bank account not found', 'NO_BANK');
    // createWithdrawalRequest only accepts the requester's own account, so a
    // row naming someone else's was not made by it. Left exactly as it is,
    // for a person to look at.
    if (!bankBelongsTo(bankAccount, withdrawal)) {
        return refuse(409, 'The bank account on this request does not belong to the person who asked. Nothing was sent.', 'BANK_MISMATCH');
    }

    // Read the row once more, immediately before it is marked processing.
    // Another call may have sent it or closed it since this one first read
    // it. A row that was sent in the meantime is answered the way a second
    // press on a sent row always is, by asking Paystack; a closed row stays
    // closed.
    const current = await getOrNull(sr.WithdrawalRequest, withdrawal.id);
    if (canRecheck(current)) {
        const held = await paystack.find(reference);
        if (held === undefined) return cannotAsk();
        if (held) return alreadySent(held);
    }
    if (!canSend(current) || current.refunded_at) return closed(current);

    if (stored) {
        // Say "I am about to send this" in the ledger, then look for a claim
        // on its refund. A call crediting it back does the mirror image
        // (claim, then look for attempts), so one of the two always sees the
        // other, and the withdrawal is never both sent and credited back.
        attempt = await sr.WithdrawalLedger.create({
            withdrawal_request_id: withdrawal.id,
            user_email: withdrawal.user_email,
            kind: 'attempt',
            state: 'open',
            amount_ngn: amount,
        });
        const seen = await fetchAll(sr.WithdrawalLedger, { withdrawal_request_id: withdrawal.id });
        if (seen.some((e) => claimIsLive(e, nowIso))) {
            await closeAttempt('abandoned');
            return refuse(409, 'This withdrawal is being credited back by another attempt. Nothing was sent.', 'NOT_SENDABLE');
        }
    }

    // The reference goes on the row before Paystack is asked to send.
    await sr.WithdrawalRequest.update(withdrawal.id, { status: 'processing', transfer_reference: reference });

    // Create the transfer recipient the first time this account is paid.
    let recipientCode = bankAccount.recipient_code;
    if (!recipientCode) {
        const made = await paystack.createRecipient(bankAccount);
        if (!made.ok) return notAccepted('Failed to create transfer recipient', made.message, made.details);
        recipientCode = made.code;
        await sr.UserBankAccount.update(bankAccount.id, { recipient_code: recipientCode });
    }

    const sent = await paystack.send({
        source: 'balance',
        reason: `UrbanStays withdrawal - ${String(withdrawal.id).substring(0, 8)}`,
        amount: amount * 100, // kobo
        recipient: recipientCode,
        reference,
    });
    if (!sent.ok) return notAccepted('Transfer failed', sent.message, sent.details);

    await closeAttempt('sent');
    // Paystack can answer a repeat of a reference it already knows with the
    // transfer it already holds. If that one is settled, settle the row.
    if (rowStatusFor(sent.transfer.status)) return alreadySent(sent.transfer);

    // Paystack accepted the transfer for processing. It is NOT marked
    // completed here: settlement is asynchronous and can still fail.
    // paystackTransferWebhook hears transfer.success / transfer.failed /
    // transfer.reversed and moves the row to its final state.
    await sr.WithdrawalRequest.update(withdrawal.id, {
        transfer_code: sent.transfer.transfer_code,
        transfer_id: String(sent.transfer.id || ''),
    });
    const needsCode = sent.transfer.status === 'otp';
    return {
        status: 200,
        body: {
            success: true,
            ...(needsCode ? { warning: 'NEEDS_OTP' } : {}),
            message: needsCode
                ? 'Paystack is waiting for a one-time code before it releases this transfer. Approve it in the Paystack dashboard, or turn off transfer OTP there. Then press Check with Paystack on this row.'
                : 'Transfer initiated — Paystack will confirm settlement asynchronously.',
            transfer_data: sent.transfer,
        },
    };
}

// The three Paystack calls a payout needs, in the shape sendWithdrawal reads.
function paystackClient(secretKey: string) {
    const headers = { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    // { http, body }. http is 0 when there was no response at all.
    const call = async (method: string, path: string, payload?: unknown) => {
        try {
            const res = await fetch(`https://api.paystack.co${path}`, {
                method,
                headers,
                ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
            });
            const body = await res.json().catch(() => null);
            return { http: res.status, body };
        } catch (err) {
            console.error(`Paystack ${method} ${path} gave no answer:`, err);
            return { http: 0, body: null };
        }
    };
    const accepted = (http: number, body: any) => http >= 200 && http < 300 && !!body && !!body.status && !!body.data;
    return {
        // The transfer Paystack holds for a reference: see lookupFromResponse.
        async find(reference: string) {
            const { http, body } = await call('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
            return lookupFromResponse(http, body);
        },
        async createRecipient(bankAccount: any) {
            const { http, body } = await call('POST', '/transferrecipient', {
                type: 'nuban',
                name: bankAccount.account_name,
                account_number: bankAccount.account_number,
                bank_code: bankAccount.bank_code,
                currency: 'NGN',
            });
            if (accepted(http, body) && body.data.recipient_code) return { ok: true, code: body.data.recipient_code };
            return { ok: false, message: refusalMessage(http, body, 'Failed to create transfer recipient'), details: body };
        },
        async send(payload: unknown) {
            const { http, body } = await call('POST', '/transfer', payload);
            if (accepted(http, body) && body.data.transfer_code) return { ok: true, transfer: body.data };
            return { ok: false, message: refusalMessage(http, body, 'Transfer initiation failed'), details: body };
        },
    };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);

        const user = await base44.auth.me();
        if (!user || user.role !== 'admin') {
            return Response.json({ success: false, error: 'Unauthorized. Admin access required.' }, { status: 403 });
        }

        const body = await req.json().catch(() => null);
        const withdrawal_request_id = body?.withdrawal_request_id;
        if (!isId(withdrawal_request_id)) {
            return Response.json({ success: false, error: 'Missing withdrawal_request_id' }, { status: 400 });
        }

        const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
        if (!paystackSecretKey) {
            return Response.json({ success: false, error: 'Payment service not configured' }, { status: 500 });
        }

        // sendWithdrawal reads the row itself and decides everything. Nothing
        // is decided here on a copy that could be stale by the time it is used.
        const result = await sendWithdrawal(
            base44.asServiceRole.entities,
            paystackClient(paystackSecretKey),
            withdrawal_request_id,
            body?.allow_unrecorded === true,
            new Date().toISOString(),
        );
        if (result.status >= 500) console.warn(`processWithdrawal ${withdrawal_request_id}:`, result.body.error);
        return Response.json(result.body, { status: result.status });
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
});
```

- [ ] **Step 5: Rewrite the settlement webhook's lookup, its rule for acting, and its refund**

Unchanged: the signature check, `tryPush`, `notifyAdmin`, `refundsToBalance`. `refundUser` is gone; the lockstep `refundReferralOnce` takes its place.

**Replace `base44/functions/paystackTransferWebhook/entry.ts` with:**

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

// paystackTransferWebhook
// ----------------------------------------------------------------------------
// Confirms the final outcome of an outbound transfer (withdrawal payout).
//
// processWithdrawal initiates a transfer with Paystack and leaves the
// WithdrawalRequest row in `processing` state. Paystack then settles the
// transfer asynchronously and POSTs one of:
//   transfer.success   → funds arrived at the recipient bank
//   transfer.failed    → bank rejected / NUBAN invalid / float exhausted
//   transfer.reversed  → completed transfer was reversed
//
// On success we flip the row to `completed`.
// On failure/reversal we flip to `failed`/`reversed` AND refund the user's
// referral_balance_ngn (we debited it at request creation).
//
// Security: HMAC-SHA512 of the raw body with PAYSTACK_SECRET_KEY, compared
// constant-time against the x-paystack-signature header. Anything that
// doesn't verify is silently ack'd (we still 200 so Paystack stops retrying)
// but takes no DB action — same pattern as paystackWebhook.
//
// Finding the row: processWithdrawal sends the reference wd-<row id>, so the
// row is read by that id and by nothing else. Transfers sent before
// references had that form are matched on transfer_code, then transfer_id,
// and only against rows that carry no reference of the new form.
//
// Idempotency: a row is settled once. A re-delivered success or failure finds
// it already final and is a no-op. Two events act on a final row (see
// webhookShouldAct): a reversal of a completed transfer, and a success for a
// row that was marked failed on a stale reading while the money went out.
//
// Crediting back: a referral withdrawal is credited back only if its debit is
// on record in WithdrawalLedger, and exactly once (refundReferralOnce,
// lockstep with processWithdrawal). A driver-wallet payout debited nothing.

async function hmacSha512Hex(secret: string, body: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-512' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

// Fire-and-forget push to the user. Swallows all errors so a push outage
// can never block the parent business action. Use a stable tag so re-sent
// pushes (e.g. failover + webhook re-delivery) replace each other instead
// of stacking notifications on the user's device.
async function tryPush(sdk: any, opts: {
    user_email: string;
    title: string;
    body?: string;
    url?: string;
    tag?: string;
}) {
    try {
        await sdk.functions.invoke('sendPushNotification', { ...opts, internal_secret: Deno.env.get('INTERNAL_FUNCTION_SECRET') || '' });
    } catch (err) {
        console.warn('tryPush failed (non-fatal):', err);
    }
}

async function notifyAdmin(opts: {
    title: string;
    withdrawalId: string;
    userEmail: string;
    amountNGN: number;
    reason?: string;
}) {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
    if (!token || !chatId) return;
    const reasonLine = opts.reason ? `\n• Reason: ${opts.reason}` : '';
    const text = `${opts.title}\n\n` +
        `Withdrawal \`${opts.withdrawalId.substring(0, 8)}\`\n` +
        `• User: ${opts.userEmail}\n` +
        `• Amount: ₦${opts.amountNGN.toLocaleString()}` +
        reasonLine;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Telegram withdrawal notify failed:', err);
    }
}

// Only a withdrawal that debited a stored balance is refunded to one. A row
// written before wallets existed is a referral withdrawal. Lockstep copy in
// processWithdrawal.
function refundsToBalance(withdrawal: any) {
    return !!withdrawal && withdrawal.wallet !== 'driver';
}

// The row id inside a reference built by processWithdrawal (wd-<row id>), or
// null for anything else. Only the exact shape is accepted: a reference made
// by the old code, WD-<8 hex>-<time>, must not be read as a row id whatever
// case it comes back in.
function withdrawalIdFromReference(reference: string) {
    const m = /^wd-([a-f0-9]{24})$/.exec(String(reference || ''));
    return m ? m[1] : null;
}

// Whether an event should change this row. A row is settled once: a
// re-delivered success or failure finds it already final and is ignored. Two
// events act on a final row:
//   - a reversal after success, when the bank sends the money back: the
//     payout must stop counting as paid;
//   - a success for a row marked failed. A second press that lost a race can
//     write "failed" on a stale reading while the transfer it lost to goes
//     out. The money left, so the row must say so.
function webhookShouldAct(eventName: string, row: any) {
    const status = row && row.status;
    if (status === 'processing') return true;
    if (eventName === 'transfer.reversed' && status === 'completed') return true;
    return eventName === 'transfer.success' && status === 'failed';
}

// How long a call that wrote an "attempt" or a "claim" row can still be
// running. A row older than this with no outcome on it is taken to have died
// with its function. Lockstep in processWithdrawal and paystackTransferWebhook.
const STALE_ATTEMPT_MS = 10 * 60 * 1000;

const PAGE = 500;
async function fetchAll(entity: any, query: Record<string, unknown>): Promise<any[]> {
    const out: any[] = [];
    for (let skip = 0; skip < 50000; skip += PAGE) {
        const page = await entity.filter(query, undefined, PAGE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out;
}

// ── The referral balance's paper trail — lockstep, see processWithdrawal ────
// WithdrawalLedger is admin-only for every operation, so unlike a
// WithdrawalRequest row it cannot be typed in from a browser. Three kinds of
// row, all for one withdrawal:
//   debit    createWithdrawalRequest took the amount off the stored balance
//   attempt  a call is about to ask Paystack to send it
//            (open, then sent | refused | unconfirmed | abandoned)
//   refund   a call claims the right to credit it back
//            (claimed, then crediting, then credited; or duplicate | held_back | no_user)

// Whether the app has on record that it took this request's amount off the
// user's referral balance.
function debitOnRecord(entries: any[], withdrawal: any) {
    const email = String((withdrawal && withdrawal.user_email) || '').trim().toLowerCase();
    const amount = Number(withdrawal && withdrawal.amount);
    if (!email || !Number.isFinite(amount) || amount <= 0) return false;
    return (entries || []).some((e) => !!e
        && e.kind === 'debit'
        && e.withdrawal_request_id === withdrawal.id
        && String(e.user_email || '').trim().toLowerCase() === email
        && Number(e.amount_ngn) === amount);
}

// Whether a ledger row was made recently enough that the call that made it
// can still be running. A row with no readable time counts as recent.
function madeRecently(entry: any, nowIso: string) {
    const made = Date.parse((entry && entry.created_date) || '');
    const now = Date.parse(nowIso || '');
    if (Number.isNaN(made) || Number.isNaN(now)) return true;
    return now - made < STALE_ATTEMPT_MS;
}

// Whether a ledger row is an attempt to send that has put a transfer out, or
// still could. While one exists, a refusal with nothing held at Paystack is
// not safe to credit back: the other attempt could succeed a moment later.
function attemptBlocksRefund(entry: any, nowIso: string) {
    if (!entry || entry.kind !== 'attempt') return false;
    if (entry.state === 'sent') return true;
    return (entry.state === 'open' || entry.state === 'unconfirmed') && madeRecently(entry, nowIso);
}

// Whether a ledger row is a claim on this withdrawal's refund that still
// stands: it has credited, is in the middle of crediting, or was made a
// moment ago and has not been decided. An attempt to send that sees one
// stands down.
function claimIsLive(entry: any, nowIso: string) {
    if (!entry || entry.kind !== 'refund') return false;
    if (entry.state === 'credited' || entry.state === 'crediting') return true;
    return entry.state === 'claimed' && madeRecently(entry, nowIso);
}

// Credit a failed referral withdrawal back to the stored balance: only what
// the app took, and exactly once.
//
// Nothing here can lock a row, so "has this been refunded?" cannot be read
// and then acted on: two calls would both read "no". Instead each call first
// writes a claim, then reads all the claims; only the oldest standing one
// credits. `unsent` says the refund is for a refusal with nothing held at
// Paystack; that one also stands down while another attempt to send could
// still put a transfer out, so a withdrawal is never both paid and credited.
//
// Answers refunded | already | no_debit | held_back | interrupted | no_user |
// not_stored. A driver-wallet request debited nothing, so marking it failed
// is its refund (not_stored).
async function refundReferralOnce(sr: any, withdrawal: any, nowIso: string, unsent: boolean) {
    if (!refundsToBalance(withdrawal)) return 'not_stored';
    const own = { withdrawal_request_id: withdrawal.id };
    const before = await fetchAll(sr.WithdrawalLedger, own);
    if (!debitOnRecord(before, withdrawal)) return 'no_debit';
    if (before.some((e) => e.kind === 'refund' && e.state === 'credited')) return 'already';
    // A credit that started and never finished: the balance may or may not
    // carry it. Only a person can tell.
    const halfDone = before.find((e) => e.kind === 'refund' && e.state === 'crediting');
    if (halfDone) return madeRecently(halfDone, nowIso) ? 'already' : 'interrupted';
    // A row refunded before the ledger existed carries only the stamp.
    const fresh = await sr.WithdrawalRequest.get(withdrawal.id);
    if (!fresh || fresh.refunded_at) return 'already';

    const amount = Math.max(0, Math.round(Number(withdrawal.amount) || 0));
    const claim = await sr.WithdrawalLedger.create({
        withdrawal_request_id: withdrawal.id,
        user_email: withdrawal.user_email,
        kind: 'refund',
        state: 'claimed',
        amount_ngn: amount,
    });
    const after = await fetchAll(sr.WithdrawalLedger, own);
    const standing = after
        .filter((e) => claimIsLive(e, nowIso))
        .sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || ''))
            || String(a.id).localeCompare(String(b.id)));
    if (standing.length === 0 || standing[0].id !== claim.id) {
        await sr.WithdrawalLedger.update(claim.id, { state: 'duplicate' });
        return 'already';
    }
    if (unsent && after.some((e) => attemptBlocksRefund(e, nowIso))) {
        await sr.WithdrawalLedger.update(claim.id, { state: 'held_back' });
        return 'held_back';
    }
    const users = await sr.User.filter({ email: withdrawal.user_email });
    if (!Array.isArray(users) || users.length === 0) {
        await sr.WithdrawalLedger.update(claim.id, { state: 'no_user' });
        return 'no_user';
    }
    await sr.WithdrawalLedger.update(claim.id, { state: 'crediting' });
    await sr.User.update(users[0].id, {
        referral_balance_ngn: (Number(users[0].referral_balance_ngn) || 0) + amount,
    });
    await sr.WithdrawalLedger.update(claim.id, { state: 'credited' });
    await sr.WithdrawalRequest.update(withdrawal.id, { refunded_at: nowIso });
    return 'refunded';
}

Deno.serve(async (req) => {
    const ack = (extra: Record<string, unknown> = {}) =>
        new Response(JSON.stringify({ ok: true, ...extra }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405 });
    }

    const secretKey = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secretKey) {
        console.error('PAYSTACK_SECRET_KEY not configured — rejecting webhook');
        return ack({ skipped: 'no_secret' });
    }

    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-paystack-signature') || '';
    const expected = await hmacSha512Hex(secretKey, rawBody);
    if (!safeEqual(expected, signatureHeader)) {
        console.warn('Invalid Paystack signature — ignoring');
        return ack({ skipped: 'invalid_signature' });
    }

    let event: any;
    try { event = JSON.parse(rawBody); } catch { return ack({ skipped: 'bad_json' }); }

    const eventName: string = event?.event || '';
    if (!['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(eventName)) {
        return ack({ skipped: `unhandled_event:${eventName}` });
    }

    const transferCode: string | undefined = event?.data?.transfer_code;
    const reference: string | undefined = event?.data?.reference;
    const reason: string | undefined = event?.data?.reason || event?.data?.gateway_response;

    if (!transferCode && !reference) {
        console.warn('Transfer webhook missing transfer_code and reference', event?.data);
        return ack({ skipped: 'missing_identifiers' });
    }

    const sdk = createClientFromRequest(req);

    try {
        const sr = sdk.asServiceRole.entities;
        let withdrawals: any[] = [];
        const rowId = withdrawalIdFromReference(reference || '');
        if (rowId) {
            // The reference names the row. Nothing else is tried: a row that
            // merely carries the same transfer code is not this withdrawal.
            // This also finds a row whose transfer code was never written
            // because Paystack's answer to processWithdrawal was lost.
            try {
                const row = await sr.WithdrawalRequest.get(rowId);
                if (row && row.id === rowId) withdrawals = [row];
            } catch (_err) {
                // No such row.
            }
        } else {
            // A transfer sent before references carried the row id. A row
            // that carries a reference of the new form was not sent that way,
            // whatever transfer code is written on it; of the rest, the
            // oldest is the one the old code sent.
            if (transferCode) {
                withdrawals = await sr.WithdrawalRequest.filter({ transfer_code: transferCode });
            }
            if (withdrawals.length === 0 && event?.data?.id) {
                withdrawals = await sr.WithdrawalRequest.filter({ transfer_id: String(event.data.id) });
            }
            withdrawals = withdrawals
                .filter((w: any) => !w.transfer_reference)
                .sort((a: any, b: any) => String(a.created_date || '').localeCompare(String(b.created_date || '')));
        }
        const withdrawal = withdrawals[0];
        if (!withdrawal) {
            console.warn('No WithdrawalRequest matched transfer', { transferCode, reference });
            return ack({ skipped: 'withdrawal_not_found' });
        }

        if (!webhookShouldAct(eventName, withdrawal)) {
            console.log(`Withdrawal ${withdrawal.id} is already ${withdrawal.status}: nothing to do for ${eventName}`);
            return ack({ skipped: 'already_settled', status: withdrawal.status });
        }

        const nowIso = new Date().toISOString();
        const amountNGN = Number(withdrawal.amount) || 0;
        const naira = `₦${amountNGN.toLocaleString()}`;
        // A row found by its reference may never have had its code written.
        const codePatch = transferCode && !withdrawal.transfer_code ? { transfer_code: transferCode } : {};

        if (eventName === 'transfer.success') {
            await sr.WithdrawalRequest.update(withdrawal.id, { status: 'completed', processed_at: nowIso, ...codePatch });
            // The row had been credited back and the bank has now paid it as
            // well. refundReferralOnce is built so this cannot happen, and
            // nothing here can take a credit back safely, so if it ever does
            // admin is told in the plainest terms.
            const paidAndCredited = refundsToBalance(withdrawal) && !!withdrawal.refunded_at;
            await notifyAdmin({
                title: paidAndCredited ? '⚠️ *Withdrawal PAID after it was credited back*' : '✅ *Withdrawal SETTLED*',
                withdrawalId: withdrawal.id,
                userEmail: withdrawal.user_email,
                amountNGN,
                reason: paidAndCredited
                    ? `Take ${naira} off this user's referral balance: it was credited back and the bank has now paid the transfer too.`
                    : undefined,
            });
            await tryPush(sdk, {
                user_email: withdrawal.user_email,
                title: '💸 Withdrawal sent',
                body: `${naira} is on its way to your bank.`,
                url: '/Withdrawals',
                tag: `withdrawal-${withdrawal.id}`,
            });
            return ack({ processed: true, withdrawal_id: withdrawal.id, status: 'completed' });
        }

        // Failure or reversal. The transfer existed, so its reference can
        // never carry another one: crediting back needs no look at other
        // attempts (unsent is false).
        const newStatus = eventName === 'transfer.reversed' ? 'reversed' : 'failed';
        const why = reason || `Transfer ${newStatus}`;
        await sr.WithdrawalRequest.update(withdrawal.id, {
            status: newStatus,
            error_message: why,
            processed_at: nowIso,
            ...codePatch,
        });
        const refund = await refundReferralOnce(sr, withdrawal, nowIso, false);
        const credited = refund === 'refunded' || refund === 'already';
        const stored = refundsToBalance(withdrawal);
        if (stored && !credited) {
            await sr.WithdrawalRequest.update(withdrawal.id, {
                error_message: `${why}. NOT credited back (${refund}). Open Admin → Withdrawals and press Credit back, or correct the balance by hand.`,
            });
        }
        await notifyAdmin({
            title: newStatus === 'reversed' ? '↩️ *Withdrawal REVERSED*' : '❌ *Withdrawal FAILED*',
            withdrawalId: withdrawal.id,
            userEmail: withdrawal.user_email,
            amountNGN,
            reason: stored && !credited ? `${why}. NOT credited back (${refund}): check it in Admin → Withdrawals.` : reason,
        });
        await tryPush(sdk, {
            user_email: withdrawal.user_email,
            title: newStatus === 'reversed' ? '↩️ Withdrawal reversed' : '❌ Withdrawal failed',
            body: !stored
                ? `${naira} is back in your driver wallet. Tap to try again.`
                : credited
                    ? `We've refunded ${naira} to your referral balance. Tap to try again.`
                    : `Your withdrawal of ${naira} did not go through. The team is checking your balance.`,
            url: stored ? '/Withdrawals' : '/DriverWallet',
            tag: `withdrawal-${withdrawal.id}`,
        });
        return ack({ processed: true, withdrawal_id: withdrawal.id, status: newStatus, refund });
    } catch (err) {
        console.error('paystackTransferWebhook error:', err);
        return ack({ error: (err as Error).message });
    }
});
```

- [ ] **Step 6: `createWithdrawalRequest` records the debit**

**Edit `base44/functions/createWithdrawalRequest/entry.ts`** — find:

```ts
        if (wallet === 'referral') {
            await sr.User.update(referralUser.id, {
                referral_balance_ngn: (Number(referralUser.referral_balance_ngn) || 0) - amount,
            });
        }
```

replace with:

```ts
        if (wallet === 'referral') {
            await sr.User.update(referralUser.id, {
                referral_balance_ngn: (Number(referralUser.referral_balance_ngn) || 0) - amount,
            });
            // Put the debit on record where a browser cannot write. It is
            // what lets processWithdrawal tell this request from a row typed
            // into the database by hand, and what a failed payout is credited
            // back against. If this write fails the request still stands,
            // and admin is asked to confirm it before it is sent.
            try {
                await sr.WithdrawalLedger.create({
                    withdrawal_request_id: withdrawalRequest.id,
                    user_email: user.email,
                    kind: 'debit',
                    state: 'recorded',
                    amount_ngn: amount,
                });
            } catch (err) {
                console.error(`Could not record the debit for withdrawal ${withdrawalRequest.id}:`, err);
            }
        }
```

- [ ] **Step 7: The admin screen offers exactly what the server would do**

**Create `src/lib/withdrawalRow.js`:**

```js
// What admin can do with one withdrawal row.
//
// MIRROR of canSend, canRecheck and canCredit in
// base44/functions/processWithdrawal/entry.ts. The server decides; these only
// stop the screen offering a button the server would refuse, or hiding one it
// would accept. scripts/check-driver-wallet.mjs runs both over the same rows.
// No imports on purpose: that script loads this file as it is.

export function withdrawalActions(row) {
  const status = row?.status;
  const sent = !!row?.transfer_code;
  return {
    // Not sent yet.
    send: status === 'pending',
    // Marked processing, but Paystack never answered with a transfer code.
    retry: status === 'processing' && !sent,
    // Sent under a reference Paystack knows it by, and not settled.
    recheck: status === 'processing' && sent && !!row?.transfer_reference,
    // A referral request that failed or was reversed and was not credited back.
    credit: !!row && row.wallet !== 'driver' && (status === 'failed' || status === 'reversed') && !row.refunded_at,
  };
}

// The rows that still need admin to press something to get the money out.
export const showsUnderPending = (row) => {
  const a = withdrawalActions(row);
  return a.send || a.retry;
};
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
import { invokeFn } from '@/lib/invokeFn';
```

replace with:

```jsx
import { invokeFn } from '@/lib/invokeFn';
import { withdrawalActions, showsUnderPending } from '@/lib/withdrawalRow';
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
  const [confirmTarget, setConfirmTarget] = useState(null);
```

replace with:

```jsx
  const [confirmTarget, setConfirmTarget] = useState(null);
  // A referral request the server would not send without a second yes.
  const [unrecordedTarget, setUnrecordedTarget] = useState(null);
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
  const handleProcess = async () => {
    if (!confirmTarget) return;
    const target = confirmTarget;
    setProcessingId(target.id);
    setConfirmTarget(null);
    // invokeFn never throws: a refusal arrives as r.error, the server's own
    // sentence. For a driver-wallet request that includes "The driver's
    // released earnings do not cover this request", which is the case this
    // screen most needs to be able to show.
    const r = await invokeFn('processWithdrawal', { withdrawal_request_id: target.id });
    if (r.ok) {
      toast(r.body?.already_sent
        ? {
          title: 'Already sent',
          description: r.body.message || 'This withdrawal had already gone to Paystack. Nothing was sent a second time.',
        }
        : {
          title: 'Transfer initiated',
          description: 'Paystack accepted the transfer. Status will flip to Completed when the bank settles.',
        });
    } else {
      toast({
        title: r.code === 'NOT_COVERED' ? 'Not paid: the earnings do not cover it'
          : r.code === 'UNCONFIRMED' ? 'Not confirmed yet'
            : r.code === 'BANK_MISMATCH' ? 'Not sent: check this request'
              : 'Transfer rejected',
        description: r.body?.details?.message ? `${r.error}: ${r.body.details.message}` : r.error,
        variant: 'destructive',
      });
    }
    setProcessingId(null);
    await load();
  };
```

replace with:

```jsx
  // One call behind every button on a row. The server reads the row and
  // decides what the press means: send, retry, ask Paystack, or look again
  // at a credit. invokeFn never throws: a refusal arrives as r.error, the
  // server's own sentence.
  const run = async (target, extra = {}) => {
    if (!target) return;
    setProcessingId(target.id);
    const r = await invokeFn('processWithdrawal', { withdrawal_request_id: target.id, ...extra });
    setProcessingId(null);
    if (!r.ok && r.code === 'UNRECORDED') {
      // Nothing was sent. Admin has to say yes a second time, with the reason
      // in front of them.
      setUnrecordedTarget(target);
      return;
    }
    if (r.ok) {
      const b = r.body || {};
      const notCredited = b.refund !== undefined && !b.credited;
      toast({
        title: b.warning === 'NEEDS_OTP' ? 'Paystack is waiting for a code'
          : b.refund !== undefined ? (b.credited ? 'Credited back' : 'Not credited back')
            : b.already_sent ? 'Checked with Paystack'
              : 'Transfer initiated',
        description: b.message || 'Paystack accepted the transfer. Status will flip to Completed when the bank settles.',
        variant: b.warning || notCredited ? 'destructive' : undefined,
      });
    } else {
      toast({
        title: {
          NOT_COVERED: 'Not paid: the earnings do not cover it',
          UNCONFIRMED: 'Not confirmed yet',
          BANK_MISMATCH: 'Not sent: check this request',
          NOT_SENDABLE: 'Nothing to send',
          NO_TRANSFER: 'Paystack has no such transfer',
        }[r.code] || 'Transfer rejected',
        description: r.body?.details?.message ? `${r.error}: ${r.body.details.message}` : r.error,
        variant: 'destructive',
      });
    }
    await load();
  };

  const handleProcess = async () => {
    const target = confirmTarget;
    setConfirmTarget(null);
    await run(target);
  };

  const sendUnrecorded = async () => {
    const target = unrecordedTarget;
    setUnrecordedTarget(null);
    await run(target, { allow_unrecorded: true });
  };
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
  const filtered = filter === 'all' ? requests : requests.filter((r) => r.status === filter);
```

replace with:

```jsx
  // "Pending" is everything that still needs a press to get the money out,
  // which includes a row left as processing when Paystack never answered.
  const filtered = filter === 'all' ? requests
    : filter === 'pending' ? requests.filter(showsUnderPending)
      : requests.filter((r) => r.status === filter);
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
              const isPending = r.status === 'pending';
              // Marked processing, but Paystack never answered with a transfer
              // code. Retrying is safe: the function asks Paystack what it
              // already holds for this withdrawal before it sends anything.
              const isStuck = isProcessing && !r.transfer_code;
```

replace with:

```jsx
              // What the server would do with this row, so the screen offers
              // exactly that. retry: marked processing, but Paystack never
              // answered with a transfer code. recheck: sent and not settled.
              // credit: a failed referral request that was not credited back.
              const act = withdrawalActions(r);
              const isStuck = act.retry;
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
                    {(isPending || isStuck) && (
                      <div className="flex flex-col sm:items-end gap-2 flex-shrink-0 w-full sm:w-auto">
                        <Button
                          size="sm"
                          onClick={() => setConfirmTarget(r)}
                          disabled={processingId === r.id || !bank || !bank.is_verified}
                          className="rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-700 hover:to-emerald-800 text-white w-full sm:w-auto"
                        >
                          {processingId === r.id ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Sending…
                            </>
                          ) : (
                            <>
                              <Send className="w-4 h-4 mr-2" />
                              {isStuck ? 'Retry' : 'Process now'}
                            </>
                          )}
                        </Button>
                        {bank && !bank.is_verified && (
                          <p className="text-[11px] text-rose-600 dark:text-rose-400 sm:text-right">Bank account not verified</p>
                        )}
```

replace with:

```jsx
                    {(act.send || act.retry || act.recheck || act.credit) && (
                      <div className="flex flex-col sm:items-end gap-2 flex-shrink-0 w-full sm:w-auto">
                        {/* A first send needs a verified account on screen. A
                            retry does not: the server asks Paystack what it
                            already holds before it reads the account at all. */}
                        {(act.send || act.retry) && (
                          <Button
                            size="sm"
                            onClick={() => setConfirmTarget(r)}
                            disabled={processingId === r.id || (act.send && (!bank || !bank.is_verified))}
                            className="rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-700 hover:to-emerald-800 text-white w-full sm:w-auto"
                          >
                            {processingId === r.id ? (
                              <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Sending…
                              </>
                            ) : (
                              <>
                                <Send className="w-4 h-4 mr-2" />
                                {isStuck ? 'Retry' : 'Process now'}
                              </>
                            )}
                          </Button>
                        )}
                        {/* Neither of these sends anything, so neither asks
                            "are you sure". */}
                        {(act.recheck || act.credit) && (
                          <Button
                            size="sm" variant="outline"
                            onClick={() => run(r)}
                            disabled={processingId === r.id}
                            className="rounded-xl w-full sm:w-auto"
                          >
                            {processingId === r.id
                              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              : <RefreshCw className="w-4 h-4 mr-2" />}
                            {act.recheck ? 'Check with Paystack' : 'Credit back'}
                          </Button>
                        )}
                        {act.recheck && (
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 sm:text-right sm:max-w-[220px]">
                            Asks Paystack where this transfer stands. It never sends anything.
                          </p>
                        )}
                        {act.credit && (
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 sm:text-right sm:max-w-[220px]">
                            Not credited back. This asks Paystack first, then credits it if nothing went out.
                          </p>
                        )}
                        {act.send && bank && !bank.is_verified && (
                          <p className="text-[11px] text-rose-600 dark:text-rose-400 sm:text-right">Bank account not verified</p>
                        )}
```

**Edit `src/components/admin/WithdrawalsAdmin.jsx`** — find:

```jsx
      </AlertDialog>
    </Card>
```

replace with:

```jsx
      </AlertDialog>

      <AlertDialog open={!!unrecordedTarget} onOpenChange={(open) => { if (!open) setUnrecordedTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>No record of this money leaving the balance</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {unrecordedTarget && (
                <>
                  <span className="block">
                    The app has no record of taking{' '}
                    <strong>₦{(Number(unrecordedTarget.amount) || 0).toLocaleString()}</strong> off the referral balance of{' '}
                    <strong>{unrecordedTarget.user_email}</strong> for this request. Nothing has been sent.
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    A request made before this version of the app can be genuine. One typed into the database by hand looks exactly the same. Check this person&apos;s referral earnings first. If you send it and it fails, it is not credited back automatically.
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Do not send</AlertDialogCancel>
            <AlertDialogAction
              onClick={sendUnrecorded}
              className="bg-rose-600 hover:bg-rose-700 text-white"
            >
              Send anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
```

- [ ] **Step 8: Run the checks**

Run: `npm run check`

Expected: five `PASS` lines, with every line under `— payouts: credited back once, never sent stale, never left unsettled —` ok.

Run: `for f in processWithdrawal paystackTransferWebhook createWithdrawalRequest; do node_modules/.bin/esbuild base44/functions/$f/entry.ts --format=esm --target=esnext --outfile=/dev/null || echo "PARSE FAIL $f"; done; npm run lint`

Expected: no `PARSE FAIL` line, no lint output.

- [ ] **Step 9: Sandbox checklist (after the next publish, Paystack test keys)**

1. Request a referral withdrawal through the app. Expected: a `WithdrawalLedger` row of kind `debit` exists for it. Process it. Expected: sent, as before.
2. Create a referral `WithdrawalRequest` row by hand in the data editor and press Process now. Expected: the dialog "No record of this money leaving the balance"; nothing sent. Press Do not send.
3. As a linked driver, hand-make a driver-wallet row for far more than the released pay. Open Admin → Withdrawals in two tabs and press Process now in both within a second. Expected: neither sends; the row is failed.
4. Set a pending referral row's status to `processing` by hand, leaving the transfer code empty. Expected: it appears under the Pending filter with Retry, and Retry works without its bank account being on screen.
5. Process a withdrawal, then in Paystack's test dashboard find the transfer. Clear the row's status back to `processing` by hand if the webhook already settled it. Press Check with Paystack. Expected: the row takes Paystack's status and nothing is sent.
6. Make a referral payout fail (a test account number Paystack rejects at transfer time). Expected: failed, credited back once, the Refunded badge shows, and a `refund` row with state `credited` exists. Press Credit back on any failed referral row that has no badge. Expected: it says why it was not credited, or credits it.

- [ ] **Step 10: Commit**

```bash
git add scripts/check-entities.mjs scripts/check-driver-wallet.mjs base44/entities/WithdrawalLedger.jsonc base44/functions/processWithdrawal/entry.ts base44/functions/paystackTransferWebhook/entry.ts base44/functions/createWithdrawalRequest/entry.ts src/lib/withdrawalRow.js src/components/admin/WithdrawalsAdmin.jsx
git commit -m "fix(rides): a payout is never sent on a stale reading, and is credited back once and only if it was taken" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
