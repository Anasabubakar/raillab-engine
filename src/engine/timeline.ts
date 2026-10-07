import { z } from "zod";
import { SEP24_STATUSES, type Sep24Status } from "./scenario.ts";

const status = z.enum(SEP24_STATUSES);

/** What a consumer tells the simulator about its own decisions. This is the contract external consumers implement. */
export const consumerEventSchema = z.discriminatedUnion("event", [
  /** The consumer accepted this status as the transaction's current state. `pollIndex` echoes the X-RailLab-Poll response header. */
  z.strictObject({ event: z.literal("status_applied"), pollIndex: z.number().int().min(1), txId: z.string().max(100), status }),
  /** What the user was told. */
  z.strictObject({ event: z.literal("user_status"), txId: z.string().max(100), status: z.enum(["pending", "completed", "failed", "unknown"]), pollIndex: z.number().int().min(1).optional() }),
  /** A side effect with business meaning (crediting a balance, sending a receipt). `key` identifies the effect for idempotency checks. */
  z.strictObject({ event: z.literal("business_action"), txId: z.string().max(100), action: z.string().min(1).max(60), key: z.string().min(1).max(200) }),
  /** The consumer saw a response and deliberately did not apply it. */
  z.strictObject({ event: z.literal("response_ignored"), pollIndex: z.number().int().min(1), reason: z.string().max(200) }),
  z.strictObject({ event: z.literal("auth_refreshed") }),
  z.strictObject({ event: z.literal("gave_up"), reason: z.string().max(200) }),
]);
export type ConsumerEvent = z.infer<typeof consumerEventSchema>;

export interface FaultApplied {
  type: string;
  detail?: string;
}

export interface RequestEvent {
  kind: "request";
  seq: number;
  atMs: number;
  n: number;
  pollIndex: number | null;
  method: string;
  path: string;
  httpStatus: number;
  faults: FaultApplied[];
  /** The anchor's true status when the request arrived. */
  anchorStatus: Sep24Status;
  /** The status carried in the body that was served, if any. */
  servedStatus: Sep24Status | null;
  servedId: string | null;
  /** Rank (timeline index) of the served snapshot. */
  servedRank: number | null;
  /** True when the served snapshot is older than one already served earlier. */
  reordered: boolean;
  duplicate: boolean;
  mismatchedId: boolean;
  authFailure: boolean;
  digest: string;
}

export interface TransitionEvent {
  kind: "anchor_transition";
  seq: number;
  atMs: number;
  from: Sep24Status | null;
  to: Sep24Status;
}

export interface ConsumerTimelineEvent {
  kind: "consumer";
  seq: number;
  atMs: number;
  event: ConsumerEvent;
}

export type TimelineEvent = RequestEvent | TransitionEvent | ConsumerTimelineEvent;

/** FNV-1a over canonical JSON: a stable, dependency-free fingerprint (not a security hash). */
export function digest(value: unknown): string {
  const text = canonical(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
