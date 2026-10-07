import type { ScenarioEngine } from "./engine.ts";
import type { Clock } from "./clock.ts";
import type { ConsumerEvent } from "./timeline.ts";

export interface TransportRequest {
  method: string;
  /** Path with optional query string. */
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}

/** How a consumer reaches the anchor. In-process and over HTTP implement the same shape, so one consumer runs both ways. */
export type Transport = (r: TransportRequest) => Promise<TransportResponse>;

export interface ConsumerContext {
  transport: Transport;
  clock: Clock;
  assetCode: string;
  /** The consumer should stop polling after this many GET /transaction requests. */
  maxPolls: number;
  emit(e: ConsumerEvent): Promise<void>;
}

export type Consumer = (ctx: ConsumerContext) => Promise<void>;

export class RequestBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`the consumer made more than ${limit} requests; stopping a runaway client`);
  }
}

/** In-process transport over an engine, with a hard request budget. */
export function engineTransport(engine: ScenarioEngine, budget = Math.max(200, engine.scenario.maxPolls * 8)): { transport: Transport; clock: Clock; emit: (e: ConsumerEvent) => Promise<void> } {
  let used = 0;
  const transport: Transport = async (r) => {
    if (!r.path.startsWith("/__raillab") && ++used > budget) throw new RequestBudgetExceeded(budget);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v;
    const res = engine.handle({ method: r.method, url: r.path, headers, body: r.body });
    return { status: res.status, headers: res.headers, json: structuredClone(res.body) };
  };
  const clock: Clock = {
    now: () => engine.clock.now(),
    sleep: async (ms) => {
      engine.advance(ms);
    },
  };
  const emit = async (e: ConsumerEvent) => {
    engine.recordConsumerEvent(e);
  };
  return { transport, clock, emit };
}
