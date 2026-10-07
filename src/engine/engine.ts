import { AnchorModel, type Sep24Transaction } from "./anchor.ts";
import { VirtualClock } from "./clock.ts";
import { rngFor, type Rng } from "./prng.ts";
import type { Fault, Scenario } from "./scenario.ts";
import { consumerEventSchema, digest, type ConsumerEvent, type FaultApplied, type RequestEvent, type TimelineEvent } from "./timeline.ts";

export interface EngineRequest {
  method: string;
  /** Path with optional query string, e.g. "/transaction?id=abc". */
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface EngineResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** Extra real milliseconds a network server should hold the response (latency faults with realMs). */
  holdRealMs?: number;
}

export const CONTROL_PREFIX = "/__raillab";

type NoSeq = TimelineEvent extends infer U ? (U extends unknown ? Omit<U, "seq"> : never) : never;

/**
 * The scenario server as a pure, transport-agnostic object: give it a request, get a response. The Node HTTP server
 * and the in-process test transport both call `handle`, so what a browser demo executes is the same code an external
 * consumer talks to over HTTP.
 *
 * Time model: virtual time advances by `requestIntervalMs` for every consumer request (plus any milliseconds a
 * cooperating consumer reports with the X-RailLab-Advance-Ms header or by sleeping on an in-process clock). Faults
 * that name poll numbers count GET /transaction requests, 1-based, including ones rejected for authentication.
 */
export class ScenarioEngine {
  readonly clock = new VirtualClock();
  readonly anchor: AnchorModel;
  readonly timeline: TimelineEvent[] = [];

  private seq = 0;
  private requests = 0;
  private polls = 0;
  private tokens = new Map<string, number>(); // token -> issued at (virtual ms)
  private tokenCounter = 0;
  private lastOkBody: Sep24Transaction | null = null;
  private maxServedRank = -1;
  private transitionsLogged = 0;
  private txStarted = false;
  private faultRngs: Rng[];

  readonly scenario: Scenario;
  readonly seed: number;

  constructor(scenario: Scenario, seed: number) {
    this.scenario = scenario;
    this.seed = seed;
    this.anchor = new AnchorModel(scenario, seed, (ms) => this.clock.iso(ms));
    this.faultRngs = scenario.faults.map((_, i) => rngFor(seed, `fault-${i}`));
  }

  private log(e: NoSeq): void {
    this.timeline.push({ ...e, seq: ++this.seq } as TimelineEvent);
  }

  private logTransitionsUpTo(ms: number): void {
    while (this.transitionsLogged < this.anchor.schedule.length && this.anchor.schedule[this.transitionsLogged]!.atMs <= ms) {
      const i = this.transitionsLogged++;
      this.log({ kind: "anchor_transition", atMs: this.anchor.schedule[i]!.atMs, from: i === 0 ? null : this.anchor.schedule[i - 1]!.status, to: this.anchor.schedule[i]!.status });
    }
  }

  advance(ms: number): number {
    return this.clock.advance(ms);
  }

  handle(req: EngineRequest): EngineResponse {
    const u = new URL(req.url, "http://raillab.invalid");
    const method = req.method.toUpperCase();
    if (u.pathname.startsWith(CONTROL_PREFIX)) return this.control(method, u, req);
    return this.simulated(method, u, req);
  }

  // ---- control plane (not part of the SEP-24 surface; does not advance time) ----
  private control(method: string, u: URL, req: EngineRequest): EngineResponse {
    const ok = (body: unknown, status = 200): EngineResponse => ({ status, headers: { "content-type": "application/json" }, body });
    const route = u.pathname.slice(CONTROL_PREFIX.length);
    if (method === "POST" && route === "/events") {
      const parsed = consumerEventSchema.safeParse(req.body);
      if (!parsed.success) return ok({ error: "invalid consumer event", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
      this.recordConsumerEvent(parsed.data);
      return ok({ ok: true });
    }
    if (method === "POST" && route === "/clock/advance") {
      const ms = (req.body as { ms?: unknown } | undefined)?.ms;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > 24 * 3600 * 1000) return ok({ error: "ms must be a number from 0 to 86400000" }, 400);
      return ok({ nowMs: this.clock.advance(ms) });
    }
    if (method === "GET" && route === "/timeline") return ok({ scenario: this.scenario.name, seed: this.seed, nowMs: this.clock.now(), timeline: this.timeline });
    return ok({ error: "unknown control endpoint" }, 404);
  }

  recordConsumerEvent(e: ConsumerEvent): void {
    this.log({ kind: "consumer", atMs: this.clock.now(), event: e });
  }

  // ---- simulated SEP-24 surface ----
  private simulated(method: string, u: URL, req: EngineRequest): EngineResponse {
    this.requests += 1;
    const n = this.requests;
    const extra = Number(req.headers?.["x-raillab-advance-ms"] ?? 0);
    this.clock.advance(this.scenario.requestIntervalMs + (Number.isFinite(extra) && extra > 0 ? Math.min(extra, 24 * 3600 * 1000) : 0));
    const now = this.clock.now();
    this.logTransitionsUpTo(now);

    const isPoll = method === "GET" && u.pathname === "/transaction";
    const pollIndex = isPoll ? ++this.polls : null;
    const faults: FaultApplied[] = [];
    let holdRealMs: number | undefined;
    const finish = (status: number, body: unknown, extra2: Partial<RequestEvent> = {}): EngineResponse => {
      const served = body !== null && typeof body === "object" && "status" in (body as object) && "id" in (body as object) ? (body as Sep24Transaction) : null;
      this.log({
        kind: "request", atMs: this.clock.now(), n, pollIndex, method, path: u.pathname + u.search, httpStatus: status, faults,
        anchorStatus: this.anchor.schedule[this.anchor.indexAt(this.clock.now())]!.status,
        servedStatus: served ? served.status : null, servedId: served ? served.id : null, servedRank: served ? this.anchor.rankOf(served.status) : null,
        reordered: false, duplicate: false, mismatchedId: false, authFailure: false, digest: digest(body), ...extra2,
      });
      const headers: Record<string, string> = { "content-type": "application/json", "x-raillab-request": String(n), "x-raillab-time-ms": String(this.clock.now()) };
      if (pollIndex !== null) headers["x-raillab-poll"] = String(pollIndex);
      return { status, headers, body, ...(holdRealMs ? { holdRealMs } : {}) };
    };

    if (method === "GET" && u.pathname === "/info") {
      return finish(200, {
        deposit: {},
        withdraw: { [this.scenario.anchor.assetCode]: { enabled: true, fee_fixed: Number(this.scenario.anchor.fee), fee_percent: 0, min_amount: 1, max_amount: 10000 } },
        fee: { enabled: false },
        features: { account_creation: false, claimable_balances: false },
      });
    }
    if (method === "POST" && u.pathname === "/auth") {
      const token = `rl-token-${++this.tokenCounter}`;
      this.tokens.set(token, now);
      return finish(200, { token, simulated: "SEP-10 is not implemented: this issues an opaque bearer token so consumers can exercise re-authentication." });
    }

    // Everything below requires a valid bearer token.
    const auth = req.headers?.authorization ?? req.headers?.Authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const issued = this.tokens.get(token);
    const expiry = this.scenario.faults.find((f) => f.type === "token_expiry");
    const expired = issued !== undefined && expiry !== undefined && expiry.type === "token_expiry" && now - issued >= expiry.afterMs;
    if (issued === undefined || expired) {
      faults.push({ type: "token_expiry", detail: issued === undefined ? "no valid token" : `token issued at ${issued} ms expired after ${(expiry as Extract<Fault, { type: "token_expiry" }>).afterMs} ms` });
      return finish(403, { type: "authentication_required" }, { authFailure: true });
    }

    if (method === "POST" && u.pathname === "/transactions/withdraw/interactive") {
      this.txStarted = true;
      return finish(200, { type: "interactive_customer_info_needed", url: `https://sim.anchor.invalid/interactive/${this.anchor.id}`, id: this.anchor.id });
    }
    if (method === "GET" && u.pathname === "/transactions") {
      return finish(200, { transactions: this.txStarted ? [this.anchor.record(now)] : [] });
    }
    if (isPoll) return this.poll(u, pollIndex!, now, faults, finish, (ms) => (holdRealMs = ms));
    return finish(404, { error: "unknown endpoint" });
  }

  private applies(f: Fault, i: number, pollIndex: number, now: number): boolean {
    if (f.type === "token_expiry") return false;
    const roll = this.faultRngs[i]!.next(); // always drawn, so each fault's randomness is independent of the others
    if (f.onPolls !== undefined) return f.onPolls.includes(pollIndex) && (f.probability === undefined || roll < f.probability);
    if (f.fromMs !== undefined) return now >= f.fromMs && now <= (f.toMs ?? Infinity) && (f.probability === undefined || roll < f.probability);
    return f.probability !== undefined && roll < f.probability;
  }

  private poll(
    u: URL,
    pollIndex: number,
    now: number,
    faults: FaultApplied[],
    finish: (status: number, body: unknown, extra?: Partial<RequestEvent>) => EngineResponse,
    setHold: (ms: number) => void,
  ): EngineResponse {
    const id = u.searchParams.get("id");
    if (id !== this.anchor.id || !this.txStarted) return finish(404, { error: "transaction not found" });

    const active = this.scenario.faults.map((f, i) => (this.applies(f, i, pollIndex, now) ? f : null));
    let at = now;
    for (const f of active) {
      if (f?.type === "latency") {
        this.clock.advance(f.virtualMs);
        at = this.clock.now();
        this.logTransitionsUpTo(at);
        faults.push({ type: "latency", detail: `${f.virtualMs} virtual ms${f.realMs ? `, ${f.realMs} real ms` : ""}` });
        if (f.realMs) setHold(f.realMs);
      }
    }
    for (const f of active) {
      if (f?.type === "transient_error") {
        faults.push({ type: "transient_error", detail: String(f.status) });
        const body = { error: "simulated transient failure" };
        const res = finish(f.status, body);
        if (f.retryAfterSeconds) res.headers["retry-after"] = String(f.retryAfterSeconds);
        return res;
      }
    }
    const dup = active.find((f) => f?.type === "duplicate_response");
    if (dup && this.lastOkBody) {
      faults.push({ type: "duplicate_response", detail: "exact repeat of the previous successful response" });
      const body = structuredClone(this.lastOkBody);
      return finish(200, body, { duplicate: true, reordered: this.anchor.rankOf(body.status) < this.maxServedRank });
    }
    let asOf = at;
    const stale = active.find((f) => f?.type === "stale_snapshot");
    if (stale && stale.type === "stale_snapshot" && stale.serveAsOfMs < at) {
      asOf = stale.serveAsOfMs;
      faults.push({ type: "stale_snapshot", detail: `served the state as of ${asOf} ms` });
    }
    const body = this.anchor.record(asOf);
    const rank = this.anchor.rankOf(body.status);
    const reordered = rank < this.maxServedRank;
    if (rank > this.maxServedRank) this.maxServedRank = rank;
    let mismatched = false;
    if (active.some((f) => f?.type === "mismatched_reference")) {
      faults.push({ type: "mismatched_reference", detail: "response carries a different transaction id" });
      this.lastOkBody = body;
      return finish(200, { ...body, id: `other-${rngFor(this.seed, "mismatch").hex(12)}` }, { mismatchedId: true, reordered });
    }
    this.lastOkBody = body;
    void mismatched;
    return finish(200, body, { reordered });
  }
}
