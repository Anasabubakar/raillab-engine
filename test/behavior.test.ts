import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_OFF, ALL_ON, MUTANTS, buildConsumer, correctedConsumer, defectiveConsumer } from "../src/consumers/configurable.ts";
import { RULE_CATALOG, evaluate, verdictOf } from "../src/engine/assertions.ts";
import { ScenarioEngine } from "../src/engine/engine.ts";
import { runSession } from "../src/engine/session.ts";
import { parseSession } from "../src/engine/sessionSchema.ts";
import { RequestBudgetExceeded, engineTransport, type Consumer } from "../src/engine/transport.ts";
import { load } from "./engine.test.ts";

const SCENARIOS = readdirSync("scenarios").filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const outcome = (s: Awaited<ReturnType<typeof runSession>>, id: string) => s.result.assertions.find((a) => a.id === id)!.outcome;

describe("the corrected client", () => {
  it.each(SCENARIOS)("passes every applicable rule in %s for twenty seeds", async (name) => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = await runSession({ scenario: load(name), seed, consumer: correctedConsumer, consumerName: "corrected" });
      const failed = s.result.assertions.filter((a) => a.outcome === "fail" || a.outcome === "inconclusive");
      expect(failed, `${name} seed ${seed}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(s.consumerError).toBeNull();
    }
  });

  it("retains a pending/unknown state when the bank payout outlasts its polling budget", async () => {
    const s = await runSession({ scenario: load("delayed-payout"), seed: 1, consumer: correctedConsumer, consumerName: "corrected" });
    const told = s.timeline.flatMap((e) => (e.kind === "consumer" && e.event.event === "user_status" ? [e.event.status] : []));
    expect(told.at(-1)).toBe("unknown");
    expect(told).not.toContain("completed");
    expect(told).not.toContain("failed");
    expect(outcome(s, "keeps-pending-until-terminal")).toBe("pass");
  });

  it("carries out the withdrawal payment exactly once and completes once", async () => {
    const s = await runSession({ scenario: load("reordered-and-repeated"), seed: 1, consumer: correctedConsumer, consumerName: "corrected" });
    const actions = s.timeline.flatMap((e) => (e.kind === "consumer" && e.event.event === "business_action" ? [e.event.action] : []));
    expect(actions).toEqual(["send_payment_to_anchor", "notify_withdrawal_completed"]); // each exactly once
  });
});

describe("the defective client", () => {
  it("announces completion too early in the baseline scenario", async () => {
    const s = await runSession({ scenario: load("baseline-withdrawal"), seed: 1, consumer: defectiveConsumer, consumerName: "defective" });
    expect(s.result.verdict).toBe("fail");
    const early = s.result.assertions.find((a) => a.id === "no-early-completion")!;
    expect(early).toMatchObject({ outcome: "fail", kind: "sep" });
    expect(early.evidence[0]).toMatch(/told "completed" while the anchor status was "pending_anchor"/);
  });
});

describe("mutants: remove exactly one behavior and exactly the matching rule fails", () => {
  const scenarioFor: Record<keyof typeof MUTANTS, string> = {
    strictCompletion: "baseline-withdrawal",
    reauthenticate: "stale-authentication",
    checkReference: "mismatched-reference",
    retryTransient: "transient-outage",
    monotonic: "reordered-and-repeated",
    idempotentActions: "reordered-and-repeated",
  };
  for (const key of Object.keys(MUTANTS) as Array<keyof typeof MUTANTS>) {
    it(`without ${key}`, async () => {
      const s = await runSession({ scenario: load(scenarioFor[key]), seed: 1, consumer: MUTANTS[key].consumer, consumerName: key });
      const failed = s.result.assertions.filter((a) => a.outcome === "fail").map((a) => a.id);
      expect(failed).toContain(MUTANTS[key].breaks);
      // no unrelated rule fails: the mutant breaks one behavior, so one family of rules fails
      const related = new Set([MUTANTS[key].breaks]);
      if (key === "retryTransient" || key === "reauthenticate") related.add("keeps-pending-until-terminal"); // giving up early also reports failure
      expect(failed.filter((id) => !related.has(id)), `${key} also failed ${failed.join(",")}`).toEqual([]);
    });
  }

  it("flags are independent: ALL_ON passes and ALL_OFF fails in a fault-free baseline", async () => {
    const on = await runSession({ scenario: load("baseline-withdrawal"), seed: 1, consumer: buildConsumer(ALL_ON), consumerName: "on" });
    const off = await runSession({ scenario: load("baseline-withdrawal"), seed: 1, consumer: buildConsumer(ALL_OFF), consumerName: "off" });
    expect([on.result.verdict, off.result.verdict]).toEqual(["pass", "fail"]);
  });
});

describe("assertion semantics", () => {
  it("every rule is labelled sep or policy and cites a basis", () => {
    expect(RULE_CATALOG.length).toBe(8);
    for (const r of RULE_CATALOG) {
      expect(["sep", "policy"]).toContain(r.kind);
      expect(r.basis.length).toBeGreaterThan(20);
    }
    expect(RULE_CATALOG.filter((r) => r.kind === "sep").map((r) => r.id).sort()).toEqual(["ignores-mismatched-reference", "no-early-completion", "reauthenticates-on-403"]);
    for (const r of RULE_CATALOG.filter((x) => x.kind === "sep")) expect(r.basis).toMatch(/sep-0024\.md/);
  });

  it("a consumer that reports nothing gets inconclusive, never pass", async () => {
    const silent: Consumer = async (ctx) => void (await ctx.transport({ method: "GET", path: "/info" }));
    const s = await runSession({ scenario: load("baseline-withdrawal"), seed: 1, consumer: silent, consumerName: "silent" });
    expect(outcome(s, "no-early-completion")).toBe("inconclusive");
    expect(s.result.verdict).toBe("inconclusive");
  });

  it("a runaway consumer is stopped by the request budget and still evaluated", async () => {
    const runaway: Consumer = async (ctx) => {
      for (;;) await ctx.transport({ method: "GET", path: "/info" });
    };
    const s = await runSession({ scenario: load("baseline-withdrawal"), seed: 1, consumer: runaway, consumerName: "runaway" });
    expect(s.consumerError).toMatch(/more than \d+ requests/);
  });

  it("a consumer that throws is reported, not swallowed", async () => {
    const s = await runSession({ scenario: load("baseline-withdrawal"), seed: 1, consumer: async () => { throw new Error("kaboom"); }, consumerName: "thrower" });
    expect(s.consumerError).toBe("consumer threw: kaboom");
  });

  it("the budget error type is exported for transports", () => {
    const e = new ScenarioEngine(load("baseline-withdrawal"), 1);
    const { transport } = engineTransport(e, 1);
    return expect((async () => { await transport({ method: "GET", path: "/info" }); await transport({ method: "GET", path: "/info" }); })()).rejects.toBeInstanceOf(RequestBudgetExceeded);
  });

  it("verdictOf prioritises fail over inconclusive over pass", () => {
    const r = (outcome: string) => ({ id: "x", title: "", kind: "sep" as const, basis: "", outcome: outcome as "pass", evidence: [] });
    expect(verdictOf([r("pass"), r("not_applicable")])).toBe("pass");
    expect(verdictOf([r("pass"), r("inconclusive")])).toBe("inconclusive");
    expect(verdictOf([r("inconclusive"), r("fail")])).toBe("fail");
  });

  it("evaluate works on a raw timeline (no consumer events -> inconclusive where it matters)", () => {
    const e = new ScenarioEngine(load("baseline-withdrawal"), 1);
    const results = evaluate({ scenario: e.scenario, anchor: e.anchor, timeline: e.timeline });
    expect(results.find((r) => r.id === "no-early-completion")!.outcome).toBe("inconclusive");
  });
});

describe("reproducibility and sessions", () => {
  it("the same scenario, seed and consumer give the identical session", async () => {
    const run = () => runSession({ scenario: load("everything-at-once"), seed: 7, consumer: correctedConsumer, consumerName: "corrected" });
    const [a, b] = await Promise.all([run(), run()]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.timelineDigest).toBe(b.timelineDigest);
    const c = await runSession({ scenario: load("everything-at-once"), seed: 8, consumer: correctedConsumer, consumerName: "corrected" });
    expect(c.timelineDigest).not.toBe(a.timelineDigest);
  });

  it("every produced session validates against the published session schema", async () => {
    for (const name of SCENARIOS) {
      for (const consumer of [correctedConsumer, defectiveConsumer]) {
        const s = await runSession({ scenario: load(name), seed: 3, consumer, consumerName: "x" });
        const parsed = parseSession(JSON.parse(JSON.stringify(s)));
        expect(parsed, `${name}: ${JSON.stringify(parsed)}`).toMatchObject({ ok: true });
      }
    }
  });

  it("the session schema rejects a tampered verdict field type and extra fields", async () => {
    const s = JSON.parse(JSON.stringify(await runSession({ scenario: load("baseline-withdrawal"), seed: 1, consumer: correctedConsumer, consumerName: "x" })));
    expect(parseSession({ ...s, safetyScore: 100 }).ok).toBe(false);
    expect(parseSession({ ...s, result: { ...s.result, verdict: "great" } }).ok).toBe(false);
  });
});
