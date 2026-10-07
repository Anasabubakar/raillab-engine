import { z } from "zod";

export const SCENARIO_VERSION = "1" as const;

/** SEP-24 transaction statuses (https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md). */
export const SEP24_STATUSES = [
  "incomplete",
  "pending_user_transfer_start",
  "pending_user_transfer_complete",
  "pending_external",
  "pending_anchor",
  "pending_stellar",
  "pending_trust",
  "pending_user",
  "completed",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
  "error",
] as const;
export type Sep24Status = (typeof SEP24_STATUSES)[number];

export const TERMINAL_STATUSES: readonly Sep24Status[] = ["completed", "refunded", "expired", "no_market", "too_small", "too_large", "error"];

const ms = z.number().int().min(0).max(7 * 24 * 3600 * 1000);
const polls = z.array(z.number().int().min(1).max(10_000)).min(1).max(200);

const amount = z.string().regex(/^\d+(\.\d{1,7})?$/, "up to 7 decimals");

const timelineEntry = z.strictObject({
  atMs: ms,
  status: z.enum(SEP24_STATUSES),
  message: z.string().max(200).optional(),
});

/** A fault that applies on specific polls of GET /transaction (1-based), or within a virtual-time window. */
const when = { onPolls: polls.optional(), fromMs: ms.optional(), toMs: ms.optional(), probability: z.number().min(0).max(1).optional() };

const fault = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("transient_error"), status: z.union([z.literal(500), z.literal(502), z.literal(503), z.literal(504)]).default(503), retryAfterSeconds: z.number().int().min(1).max(3600).optional(), ...when }),
  z.strictObject({ type: z.literal("duplicate_response"), ...when }),
  z.strictObject({ type: z.literal("stale_snapshot"), serveAsOfMs: ms, ...when }),
  z.strictObject({ type: z.literal("latency"), virtualMs: ms, realMs: z.number().int().min(0).max(10_000).optional(), ...when }),
  z.strictObject({ type: z.literal("mismatched_reference"), ...when }),
  z.strictObject({ type: z.literal("token_expiry"), afterMs: ms }),
]);

export const scenarioSchema = z
  .strictObject({
    schemaVersion: z.literal(SCENARIO_VERSION),
    name: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens"),
    title: z.string().min(1).max(120),
    description: z.string().max(1000),
    anchor: z.strictObject({
      assetCode: z.string().regex(/^[A-Za-z0-9]{1,12}$/).default("USDC"),
      amountIn: amount.default("100"),
      fee: amount.default("1"),
      /** Anchor-side status changes by virtual time. The first entry must be at 0. */
      timeline: z.array(timelineEntry).min(2).max(40),
      /** Seeded jitter added to each transition after the first, in virtual ms. */
      jitterMs: ms.default(0),
    }),
    /** Virtual time each consumer request consumes. */
    requestIntervalMs: z.number().int().min(1).max(3_600_000).default(5000),
    faults: z.array(fault).max(50).default([]),
    /** Polls after which a consumer should stop and report unknown. The runner enforces this. */
    maxPolls: z.number().int().min(1).max(10_000).default(60),
  })
  .superRefine((s, ctx) => {
    const t = s.anchor.timeline;
    if (t[0]!.atMs !== 0) ctx.addIssue({ code: "custom", path: ["anchor", "timeline", 0, "atMs"], message: "the first timeline entry must be at 0" });
    for (let i = 1; i < t.length; i++) {
      if (t[i]!.atMs <= t[i - 1]!.atMs) ctx.addIssue({ code: "custom", path: ["anchor", "timeline", i, "atMs"], message: "timeline entries must be strictly increasing in time" });
    }
    const seen = new Set<string>();
    t.forEach((e, i) => {
      if (seen.has(e.status)) ctx.addIssue({ code: "custom", path: ["anchor", "timeline", i, "status"], message: `status ${e.status} appears twice; statuses must be unique so progress has an order` });
      seen.add(e.status);
    });
    const terminal = t.findIndex((e) => TERMINAL_STATUSES.includes(e.status));
    if (terminal !== -1 && terminal !== t.length - 1) ctx.addIssue({ code: "custom", path: ["anchor", "timeline", terminal], message: "a terminal status must be the last timeline entry" });
    s.faults.forEach((f, i) => {
      if ("fromMs" in f && f.fromMs !== undefined && f.toMs !== undefined && f.toMs < f.fromMs) {
        ctx.addIssue({ code: "custom", path: ["faults", i, "toMs"], message: "toMs must not be before fromMs" });
      }
      if (f.type !== "token_expiry" && f.onPolls === undefined && f.fromMs === undefined && f.probability === undefined) {
        ctx.addIssue({ code: "custom", path: ["faults", i], message: "a fault needs onPolls, a fromMs/toMs window or a probability" });
      }
    });
  });

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioInput = z.input<typeof scenarioSchema>;
export type Fault = Scenario["faults"][number];

export type ScenarioParse = { ok: true; scenario: Scenario } | { ok: false; issues: Array<{ path: string; message: string }> };

export function parseScenario(input: unknown): ScenarioParse {
  const r = scenarioSchema.safeParse(input);
  if (r.success) return { ok: true, scenario: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.length ? i.path.map(String).join(".") : "(root)", message: i.message })) };
}
