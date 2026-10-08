import { evaluate, verdictOf, type AssertionResult, type SessionVerdict } from "./assertions.ts";
import { digest, type TimelineEvent } from "./timeline.ts";
import { ScenarioEngine } from "./engine.ts";
import type { Scenario } from "./scenario.ts";
import { engineTransport, RequestBudgetExceeded, type Consumer } from "./transport.ts";

export const SESSION_VERSION = "1" as const;
export const TOOL_NAME = "raillab-engine";
export const TOOL_VERSION = "0.1.1";

export interface Session {
  sessionVersion: typeof SESSION_VERSION;
  tool: { name: string; version: string };
  scenario: Scenario;
  seed: number;
  consumer: { name: string; kind: "reference" | "external"; note?: string };
  /** Virtual time at the end of the session. */
  endedAtMs: number;
  /** Set when the consumer threw or exceeded its request budget; assertions are still evaluated on what happened. */
  consumerError: string | null;
  result: { verdict: SessionVerdict; assertions: AssertionResult[] };
  timeline: TimelineEvent[];
  /** Fingerprint of the timeline: equal fingerprints mean identical timelines. */
  timelineDigest: string;
  simulationNotice: string;
}

export const SIMULATION_NOTICE = "Everything here is simulated: the anchor, its bank, every identifier and every payment. Nothing touches a real bank, a real anchor or the Stellar network.";

export function buildSession(engine: ScenarioEngine, consumer: Session["consumer"], consumerError: string | null): Session {
  const assertions = evaluate({ scenario: engine.scenario, anchor: engine.anchor, timeline: engine.timeline });
  return {
    sessionVersion: SESSION_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    scenario: engine.scenario,
    seed: engine.seed,
    consumer,
    endedAtMs: engine.clock.now(),
    consumerError,
    result: { verdict: verdictOf(assertions), assertions },
    timeline: engine.timeline,
    timelineDigest: digest(engine.timeline),
    simulationNotice: SIMULATION_NOTICE,
  };
}

/** Run an in-process consumer against a fresh engine and evaluate the assertions. */
export async function runSession(opts: { scenario: Scenario; seed: number; consumer: Consumer; consumerName: string; kind?: "reference" | "external"; note?: string }): Promise<Session> {
  const engine = new ScenarioEngine(opts.scenario, opts.seed);
  const { transport, clock, emit } = engineTransport(engine);
  let error: string | null = null;
  try {
    await opts.consumer({ transport, clock, emit, assetCode: opts.scenario.anchor.assetCode, maxPolls: opts.scenario.maxPolls });
  } catch (e) {
    error = e instanceof RequestBudgetExceeded ? e.message : `consumer threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  return buildSession(engine, { name: opts.consumerName, kind: opts.kind ?? "reference", note: opts.note }, error);
}
