import { z } from "zod";
import { consumerEventSchema } from "./timeline.ts";
import { SEP24_STATUSES, scenarioSchema } from "./scenario.ts";
import { SESSION_VERSION, type Session } from "./session.ts";

const status = z.enum(SEP24_STATUSES);

const faultApplied = z.strictObject({ type: z.string(), detail: z.string().optional() });

const requestEvent = z.strictObject({
  kind: z.literal("request"), seq: z.number().int().min(1), atMs: z.number().int().min(0), n: z.number().int().min(1), pollIndex: z.number().int().min(1).nullable(),
  method: z.string(), path: z.string(), httpStatus: z.number().int(), faults: z.array(faultApplied), anchorStatus: status, servedStatus: status.nullable(),
  servedId: z.string().nullable(), servedRank: z.number().int().nullable(), reordered: z.boolean(), duplicate: z.boolean(), mismatchedId: z.boolean(), authFailure: z.boolean(), digest: z.string(),
});
const transitionEvent = z.strictObject({ kind: z.literal("anchor_transition"), seq: z.number().int().min(1), atMs: z.number().int().min(0), from: status.nullable(), to: status });
const consumerTimelineEvent = z.strictObject({ kind: z.literal("consumer"), seq: z.number().int().min(1), atMs: z.number().int().min(0), event: consumerEventSchema });

const assertion = z.strictObject({
  id: z.string(), title: z.string(), kind: z.enum(["sep", "policy"]), basis: z.string(),
  outcome: z.enum(["pass", "fail", "not_applicable", "inconclusive"]), evidence: z.array(z.string()),
});

export const sessionSchema = z.strictObject({
  sessionVersion: z.literal(SESSION_VERSION),
  tool: z.strictObject({ name: z.string(), version: z.string() }),
  scenario: scenarioSchema,
  seed: z.number().int().min(0).max(0xffffffff),
  consumer: z.strictObject({ name: z.string(), kind: z.enum(["reference", "external"]), note: z.string().optional() }),
  endedAtMs: z.number().int().min(0),
  consumerError: z.string().nullable(),
  result: z.strictObject({ verdict: z.enum(["pass", "fail", "inconclusive"]), assertions: z.array(assertion) }),
  timeline: z.array(z.discriminatedUnion("kind", [requestEvent, transitionEvent, consumerTimelineEvent])),
  timelineDigest: z.string().regex(/^[0-9a-f]{8}$/),
  simulationNotice: z.string(),
});

export function parseSession(input: unknown): { ok: true; session: Session } | { ok: false; error: string } {
  const r = sessionSchema.safeParse(input);
  return r.success ? { ok: true, session: r.data as Session } : { ok: false, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}
