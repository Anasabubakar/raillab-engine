import { TERMINAL_STATUSES, type Sep24Status } from "../engine/scenario.ts";
import type { Consumer, TransportResponse } from "../engine/transport.ts";

/**
 * Behaviors of a SEP-24 withdrawal client that incidents are made of. Each flag, when false, reproduces one real
 * integration mistake. Turning exactly one flag off gives a mutant that should fail exactly the matching assertion.
 */
export interface ConsumerBehaviors {
  /** Treat only `completed` as completion. Off: announce completion once the anchor starts processing. (SEP rule) */
  strictCompletion: boolean;
  /** On 403 authentication_required, authenticate again and carry on. Off: treat it as the transaction failing. (SEP rule) */
  reauthenticate: boolean;
  /** Ignore a response whose transaction id differs from the one requested. Off: apply it. (SEP rule) */
  checkReference: boolean;
  /** Retry 5xx with bounded backoff. Off: treat the first error as the transaction failing. (policy) */
  retryTransient: boolean;
  /** Never move to an earlier status. Off: apply whatever arrives. (policy) */
  monotonic: boolean;
  /** Run each side effect once. Off: run it every time a response shows the status. (policy) */
  idempotentActions: boolean;
}

export const ALL_ON: ConsumerBehaviors = { strictCompletion: true, reauthenticate: true, checkReference: true, retryTransient: true, monotonic: true, idempotentActions: true };
export const ALL_OFF: ConsumerBehaviors = { strictCompletion: false, reauthenticate: false, checkReference: false, retryTransient: false, monotonic: false, idempotentActions: false };

/**
 * Ordering is an application policy, not a SEP-24 rule: later in this list wins, and statuses outside it never
 * override a ranked one. SEP-24 does not define a total order of statuses.
 */
const ORDER: readonly Sep24Status[] = ["incomplete", "pending_user_transfer_start", "pending_user_transfer_complete", "pending_anchor", "pending_stellar", "pending_external", "completed"];
const rank = (s: Sep24Status) => ORDER.indexOf(s);

/** Statuses a naive client wrongly reads as "the money has been paid out". */
const NAIVELY_DONE: readonly Sep24Status[] = ["pending_anchor", "pending_stellar", "pending_external", "completed"];

const MAX_BACKOFF_MS = 30_000;

export function buildConsumer(b: ConsumerBehaviors): Consumer {
  return async (ctx) => {
    let token = "";
    const authenticate = async () => {
      const auth = await ctx.transport({ method: "POST", path: "/auth", body: {} });
      token = (auth.json as { token: string }).token;
    };
    await authenticate();
    const start = await ctx.transport({ method: "POST", path: "/transactions/withdraw/interactive", headers: { authorization: `Bearer ${token}` }, body: { asset_code: ctx.assetCode } });
    const txId = (start.json as { id: string }).id;

    let current: Sep24Status | null = null;
    const done = new Set<string>();
    const act = async (action: string, key: string) => {
      if (b.idempotentActions && done.has(key)) return;
      done.add(key);
      await ctx.emit({ event: "business_action", txId, action, key });
    };
    const giveUp = async (status: "failed" | "unknown", reason: string, pollIndex?: number) => {
      await ctx.emit({ event: "user_status", txId, status, ...(pollIndex ? { pollIndex } : {}) });
      await ctx.emit({ event: "gave_up", reason });
    };
    let backoff = 1000;

    for (let polls = 0; polls < ctx.maxPolls; ) {
      polls += 1;
      const res: TransportResponse = await ctx.transport({ method: "GET", path: `/transaction?id=${encodeURIComponent(txId)}`, headers: { authorization: `Bearer ${token}` } });
      const pollIndex = Number(res.headers["x-raillab-poll"]);

      if (res.status === 403 && (res.json as { type?: string })?.type === "authentication_required") {
        if (!b.reauthenticate) return giveUp("failed", "HTTP 403", pollIndex);
        await authenticate();
        await ctx.emit({ event: "auth_refreshed" });
        continue;
      }
      if (res.status >= 500) {
        if (!b.retryTransient) return giveUp("failed", `HTTP ${res.status}`, pollIndex);
        await ctx.clock.sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      if (res.status !== 200) return giveUp(b.strictCompletion ? "unknown" : "failed", `unexpected HTTP ${res.status}`, pollIndex);
      backoff = 1000;

      const tx = res.json as { id?: string; status?: Sep24Status };
      if (tx.status === undefined) return giveUp("unknown", "response has no status", pollIndex);
      if (b.checkReference && tx.id !== txId) {
        await ctx.emit({ event: "response_ignored", pollIndex, reason: `response is for transaction ${String(tx.id)}, not ${txId}` });
        continue;
      }
      if (b.monotonic && current !== null && rank(tx.status) !== -1 && rank(tx.status) < rank(current)) {
        await ctx.emit({ event: "response_ignored", pollIndex, reason: `older status ${tx.status} after ${current}` });
        continue;
      }
      const changed = current !== tx.status;
      if (!changed && b.idempotentActions) continue; // a repeat of what is already applied changes nothing
      current = tx.status;
      await ctx.emit({ event: "status_applied", pollIndex, txId, status: tx.status });

      if (tx.status === "pending_user_transfer_start") await act("send_payment_to_anchor", `pay-${txId}`);

      const complete = b.strictCompletion ? tx.status === "completed" : NAIVELY_DONE.includes(tx.status);
      if (complete) {
        await act("notify_withdrawal_completed", `done-${txId}`);
        await ctx.emit({ event: "user_status", txId, status: "completed", pollIndex });
        return;
      }
      if (TERMINAL_STATUSES.includes(tx.status)) {
        await ctx.emit({ event: "user_status", txId, status: "failed", pollIndex });
        return;
      }
      await ctx.emit({ event: "user_status", txId, status: "pending", pollIndex });
    }
    await ctx.emit({ event: "user_status", txId, status: b.strictCompletion ? "unknown" : "pending" });
    await ctx.emit({ event: "gave_up", reason: "polling budget exhausted before a terminal status" });
  };
}

export const correctedConsumer: Consumer = buildConsumer(ALL_ON);
export const defectiveConsumer: Consumer = buildConsumer(ALL_OFF);

/** One mutant per behavior: the corrected client with exactly that behavior removed, and the rule it should break. */
export const MUTANTS: Record<keyof ConsumerBehaviors, { consumer: Consumer; breaks: string }> = {
  strictCompletion: { consumer: buildConsumer({ ...ALL_ON, strictCompletion: false }), breaks: "no-early-completion" },
  reauthenticate: { consumer: buildConsumer({ ...ALL_ON, reauthenticate: false }), breaks: "reauthenticates-on-403" },
  checkReference: { consumer: buildConsumer({ ...ALL_ON, checkReference: false }), breaks: "ignores-mismatched-reference" },
  retryTransient: { consumer: buildConsumer({ ...ALL_ON, retryTransient: false }), breaks: "retries-transient-errors" },
  monotonic: { consumer: buildConsumer({ ...ALL_ON, monotonic: false }), breaks: "no-status-regression" },
  idempotentActions: { consumer: buildConsumer({ ...ALL_ON, idempotentActions: false }), breaks: "idempotent-business-actions" },
};
