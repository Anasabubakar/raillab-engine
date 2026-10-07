import type { AnchorModel } from "./anchor.ts";
import type { Scenario, Sep24Status } from "./scenario.ts";
import { TERMINAL_STATUSES } from "./scenario.ts";
import type { ConsumerEvent, RequestEvent, TimelineEvent } from "./timeline.ts";

export type Outcome = "pass" | "fail" | "not_applicable" | "inconclusive";

/**
 * Where a rule comes from. `sep` rules follow from the SEP-24 text; `policy` rules are an application's own choice
 * about robust behavior and are not required by any standard. The distinction is shown everywhere results are shown.
 */
export type RuleKind = "sep" | "policy";

export interface AssertionResult {
  id: string;
  title: string;
  kind: RuleKind;
  /** The SEP-24 statement the rule rests on, or the policy being applied. */
  basis: string;
  outcome: Outcome;
  evidence: string[];
}

export interface AssertionContext {
  scenario: Scenario;
  anchor: AnchorModel;
  timeline: TimelineEvent[];
}

interface Rule {
  id: string;
  title: string;
  kind: RuleKind;
  basis: string;
  check(c: Ctx): { outcome: Outcome; evidence: string[] };
}

interface Ctx extends AssertionContext {
  requests: RequestEvent[];
  consumer: Array<{ atMs: number; seq: number; event: ConsumerEvent }>;
  truthAt(ms: number): Sep24Status;
}

const SEP = "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md";
const isConsumerEvent = <E extends ConsumerEvent["event"]>(kind: E) => (x: { event: ConsumerEvent }): x is { atMs: number; seq: number; event: Extract<ConsumerEvent, { event: E }> } => x.event.event === kind;

const RULES: Rule[] = [
  {
    id: "no-early-completion",
    title: "Does not tell the user the withdrawal is complete before the anchor says completed",
    kind: "sep",
    basis: `SEP-24 (${SEP}): \`completed\` means the withdrawal is fully completed; \`pending_external\` means it was submitted to the external network but is not confirmed.`,
    check(c) {
      const told = c.consumer.filter(isConsumerEvent("user_status"));
      if (told.length === 0) return { outcome: "inconclusive", evidence: ["The consumer reported no user_status events, so what the user was told is unknown."] };
      const early = told.filter((t) => t.event.status === "completed" && c.truthAt(t.atMs) !== "completed");
      if (early.length > 0) return { outcome: "fail", evidence: early.map((t) => `At ${t.atMs} ms the user was told "completed" while the anchor status was "${c.truthAt(t.atMs)}".`) };
      return { outcome: "pass", evidence: [`${told.length} user status message(s); none said completed before the anchor did.`] };
    },
  },
  {
    id: "final-state-matches-anchor",
    title: "Ends with the anchor's terminal outcome once polling has run past it",
    kind: "policy",
    basis: "Policy: a consumer that keeps polling must eventually show the terminal outcome the anchor reached.",
    check(c) {
      const end = c.anchor.schedule[c.anchor.schedule.length - 1]!;
      if (!TERMINAL_STATUSES.includes(end.status)) return { outcome: "not_applicable", evidence: ["The scenario never reaches a terminal status."] };
      const lastReq = c.requests[c.requests.length - 1];
      if (!lastReq || lastReq.atMs < end.atMs) return { outcome: "not_applicable", evidence: [`The session ended at ${lastReq?.atMs ?? 0} ms, before the anchor reached ${end.status} at ${end.atMs} ms.`] };
      const told = c.consumer.filter(isConsumerEvent("user_status"));
      const last = told[told.length - 1];
      if (!last) return { outcome: "inconclusive", evidence: ["No user_status events were reported."] };
      const want = end.status === "completed" ? "completed" : "failed";
      return last.event.status === want
        ? { outcome: "pass", evidence: [`The final user message was "${last.event.status}" and the anchor ended at "${end.status}".`] }
        : { outcome: "fail", evidence: [`The final user message was "${last.event.status}" but the anchor ended at "${end.status}" at ${end.atMs} ms.`] };
    },
  },
  {
    id: "keeps-pending-until-terminal",
    title: "Does not report failure while the anchor is still processing",
    kind: "policy",
    basis: "Policy: only a terminal anchor status or an explicit give-up may produce a failure message; a non-terminal status means pending.",
    check(c) {
      const told = c.consumer.filter(isConsumerEvent("user_status"));
      if (told.length === 0) return { outcome: "inconclusive", evidence: ["No user_status events were reported."] };
      const bad = told.filter((t) => t.event.status === "failed" && !TERMINAL_STATUSES.includes(c.truthAt(t.atMs)));
      if (bad.length > 0) return { outcome: "fail", evidence: bad.map((t) => `At ${t.atMs} ms the user was told "failed" while the anchor status was the non-terminal "${c.truthAt(t.atMs)}".`) };
      return { outcome: "pass", evidence: ["No failure was reported while the anchor was non-terminal."] };
    },
  },
  {
    id: "no-status-regression",
    title: "Does not move to an earlier status because of a stale or repeated response",
    kind: "policy",
    basis: "Policy: once a later status is accepted, a response showing an earlier one must not replace it (responses can arrive out of order).",
    check(c) {
      const stale = c.requests.filter((r) => r.reordered);
      if (stale.length === 0) return { outcome: "not_applicable", evidence: ["No reordered response was served in this session."] };
      const applied = c.consumer.filter(isConsumerEvent("status_applied"));
      if (applied.length === 0) return { outcome: "inconclusive", evidence: ["The consumer reported no status_applied events."] };
      let max = -1;
      const bad: string[] = [];
      for (const a of applied) {
        const rank = c.anchor.rankOf(a.event.status);
        if (rank < max) bad.push(`At ${a.atMs} ms (poll ${a.event.pollIndex}) the consumer applied "${a.event.status}" after having accepted a later status.`);
        max = Math.max(max, rank);
      }
      return bad.length ? { outcome: "fail", evidence: bad } : { outcome: "pass", evidence: [`${stale.length} reordered response(s) were served; the consumer's applied status never moved backwards.`] };
    },
  },
  {
    id: "idempotent-business-actions",
    title: "Performs each business action once, even when the same status is served again",
    kind: "policy",
    basis: "Policy: a repeated response must not repeat a side effect such as crediting or notifying.",
    check(c) {
      const dups = c.requests.filter((r) => r.duplicate);
      const actions = c.consumer.filter(isConsumerEvent("business_action"));
      if (dups.length === 0 && actions.length === 0) return { outcome: "not_applicable", evidence: ["No repeated response was served and no business action was reported."] };
      const seen = new Map<string, number>();
      for (const a of actions) seen.set(`${a.event.txId}|${a.event.key}`, (seen.get(`${a.event.txId}|${a.event.key}`) ?? 0) + 1);
      const repeated = [...seen.entries()].filter(([, n]) => n > 1);
      if (repeated.length > 0) return { outcome: "fail", evidence: repeated.map(([k, n]) => `Business action "${k.split("|")[1]}" ran ${n} times for transaction ${k.split("|")[0]}.`) };
      if (dups.length === 0) return { outcome: "not_applicable", evidence: ["No repeated response was served."] };
      return { outcome: "pass", evidence: [`${dups.length} repeated response(s) were served; every business action ran once.`] };
    },
  },
  {
    id: "retries-transient-errors",
    title: "Keeps polling after a transient server error instead of failing the transaction",
    kind: "policy",
    basis: "Policy: a 5xx from the status endpoint says nothing about the transaction; retry with bounded backoff.",
    check(c) {
      const errs = c.requests.filter((r) => r.pollIndex !== null && r.httpStatus >= 500);
      if (errs.length === 0) return { outcome: "not_applicable", evidence: ["No transient server error was served."] };
      const told = c.consumer.filter(isConsumerEvent("user_status"));
      const bad: string[] = [];
      for (const e of errs) {
        const later = c.requests.some((r) => r.pollIndex !== null && r.pollIndex > e.pollIndex!);
        const failedAfter = told.find((t) => t.event.status === "failed" && t.atMs >= e.atMs && !TERMINAL_STATUSES.includes(c.truthAt(t.atMs)));
        if (!later) bad.push(`After the ${e.httpStatus} on poll ${e.pollIndex} the consumer never polled again.`);
        else if (failedAfter) bad.push(`After the ${e.httpStatus} on poll ${e.pollIndex} the user was told "failed" at ${failedAfter.atMs} ms.`);
      }
      return bad.length ? { outcome: "fail", evidence: bad } : { outcome: "pass", evidence: [`${errs.length} transient error(s); the consumer polled again each time and never reported failure.`] };
    },
  },
  {
    id: "reauthenticates-on-403",
    title: "Obtains a new token after 403 authentication_required and carries on",
    kind: "sep",
    basis: `SEP-24 (${SEP}): a 403 with type authentication_required means the endpoint requires authentication; the wallet must authenticate again (SEP-10) rather than treat the transaction as failed.`,
    check(c) {
      const denied = c.requests.filter((r) => r.authFailure);
      if (denied.length === 0) return { outcome: "not_applicable", evidence: ["No 403 authentication_required was served."] };
      const told = c.consumer.filter(isConsumerEvent("user_status"));
      const bad: string[] = [];
      for (const d of denied) {
        const afterAuth = c.requests.find((r) => r.n > d.n && r.method === "POST" && r.path === "/auth");
        const laterPoll = c.requests.find((r) => r.n > d.n && r.pollIndex !== null && r.httpStatus === 200);
        const failed = told.find((t) => t.event.status === "failed" && t.atMs >= d.atMs && !TERMINAL_STATUSES.includes(c.truthAt(t.atMs)));
        if (!afterAuth) bad.push(`After the 403 on request ${d.n} the consumer never requested a new token.`);
        else if (!laterPoll) bad.push(`After re-authenticating following request ${d.n} the consumer never completed another poll.`);
        if (failed) bad.push(`After the 403 on request ${d.n} the user was told "failed" at ${failed.atMs} ms.`);
      }
      return bad.length ? { outcome: "fail", evidence: bad } : { outcome: "pass", evidence: [`${denied.length} authentication failure(s); the consumer re-authenticated and polled successfully again.`] };
    },
  },
  {
    id: "ignores-mismatched-reference",
    title: "Does not apply a response whose transaction id differs from the one requested",
    kind: "sep",
    basis: `SEP-24 (${SEP}): the wallet queries /transaction by the anchor's \`id\`; a record with another id describes a different transaction and must not update this one.`,
    check(c) {
      const mism = c.requests.filter((r) => r.mismatchedId && r.pollIndex !== null);
      if (mism.length === 0) return { outcome: "not_applicable", evidence: ["No mismatched response was served."] };
      const applied = c.consumer.filter(isConsumerEvent("status_applied"));
      if (applied.length === 0) return { outcome: "inconclusive", evidence: ["The consumer reported no status_applied events."] };
      const polls = new Set(mism.map((m) => m.pollIndex));
      const bad = applied.filter((a) => polls.has(a.event.pollIndex));
      return bad.length
        ? { outcome: "fail", evidence: bad.map((a) => `The consumer applied status "${a.event.status}" from poll ${a.event.pollIndex}, whose response carried a different transaction id.`) }
        : { outcome: "pass", evidence: [`${mism.length} mismatched response(s) were served; none was applied.`] };
    },
  },
];

export const RULE_CATALOG: ReadonlyArray<Pick<Rule, "id" | "title" | "kind" | "basis">> = RULES.map(({ id, title, kind, basis }) => ({ id, title, kind, basis }));

export function evaluate(c: AssertionContext): AssertionResult[] {
  const requests = c.timeline.filter((e): e is RequestEvent => e.kind === "request");
  const consumer = c.timeline.flatMap((e) => (e.kind === "consumer" ? [{ atMs: e.atMs, seq: e.seq, event: e.event }] : []));
  const ctx: Ctx = { ...c, requests, consumer, truthAt: (ms) => c.anchor.schedule[c.anchor.indexAt(ms)]!.status };
  return RULES.map((r) => ({ id: r.id, title: r.title, kind: r.kind, basis: r.basis, ...r.check(ctx) }));
}

export type SessionVerdict = "pass" | "fail" | "inconclusive";

export function verdictOf(results: AssertionResult[]): SessionVerdict {
  if (results.some((r) => r.outcome === "fail")) return "fail";
  if (results.some((r) => r.outcome === "inconclusive")) return "inconclusive";
  return "pass";
}
