import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromStroops, toStroops } from "../src/engine/amount.ts";
import { AnchorModel, SIM_ANCHOR_ACCOUNT } from "../src/engine/anchor.ts";
import { EPOCH_MS, VirtualClock } from "../src/engine/clock.ts";
import { ScenarioEngine, type EngineRequest } from "../src/engine/engine.ts";
import { Rng, rngFor } from "../src/engine/prng.ts";
import { parseScenario, type Scenario, type ScenarioInput } from "../src/engine/scenario.ts";

export const load = (name: string): Scenario => {
  const p = parseScenario(JSON.parse(readFileSync(`scenarios/${name}.json`, "utf8")));
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.scenario;
};
const FLOW = [
  { atMs: 0, status: "incomplete" }, { atMs: 12000, status: "pending_user_transfer_start" }, { atMs: 40000, status: "pending_user_transfer_complete" },
  { atMs: 70000, status: "pending_anchor" }, { atMs: 160000, status: "completed" },
] as const;
const base = (over: Record<string, unknown> = {}): ScenarioInput => ({ schemaVersion: "1", name: "t", title: "t", description: "", anchor: { timeline: [...FLOW] }, ...over }) as ScenarioInput;
const make = (over: Record<string, unknown> = {}, seed = 1) => {
  const p = parseScenario(base(over));
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return new ScenarioEngine(p.scenario, seed);
};

function session(e: ScenarioEngine) {
  const tok = (e.handle({ method: "POST", url: "/auth" }).body as { token: string }).token;
  const h = { authorization: `Bearer ${tok}` };
  const id = (e.handle({ method: "POST", url: "/transactions/withdraw/interactive", headers: h }).body as { id: string }).id;
  const poll = (): ReturnType<ScenarioEngine["handle"]> => e.handle({ method: "GET", url: `/transaction?id=${id}`, headers: h });
  return { tok, h, id, poll };
}

describe("rng", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = new Rng(7), b = new Rng(7), c = new Rng(8);
    const sa = Array.from({ length: 5 }, () => a.next()), sb = Array.from({ length: 5 }, () => b.next());
    expect(sa).toEqual(sb);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(sa);
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it("has stable known output (guards against accidental algorithm changes)", () => {
    const r = new Rng(1);
    // First three outputs of the published mulberry32 reference algorithm for seed 1 are 0.62707..., 0.00273..., 0.52744...
    expect([r.int(0, 999), r.int(0, 999), r.int(0, 999)]).toEqual([627, 2, 527]);
    expect(new Rng(1).hex(16)).toHaveLength(16);
  });
  it("gives each purpose an independent stream", () => {
    expect(rngFor(1, "a").next()).not.toBe(rngFor(1, "b").next());
    expect(rngFor(1, "a").next()).toBe(rngFor(1, "a").next());
  });
  it("rejects bad seeds and ranges", () => {
    expect(() => new Rng(-1)).toThrow();
    expect(() => new Rng(1.5)).toThrow();
    expect(() => new Rng(1).int(5, 1)).toThrow();
  });
});

describe("virtual clock", () => {
  it("starts at the fixed epoch and never moves backwards", () => {
    const c = new VirtualClock();
    expect(c.iso()).toBe(new Date(EPOCH_MS).toISOString().replace(".000Z", "Z"));
    c.advance(1500);
    expect(c.now()).toBe(1500);
    expect(() => c.advance(-1)).toThrow();
    expect(() => c.advance(Number.NaN)).toThrow();
  });
});

describe("amounts", () => {
  it("is exact and rejects malformed values", () => {
    expect(fromStroops(toStroops("100") - toStroops("1"))).toBe("99.0000000");
    expect(fromStroops(toStroops("0.0000001"))).toBe("0.0000001");
    for (const bad of ["", "1.", ".5", "-1", "1.00000001", "1e3"]) expect(() => toStroops(bad)).toThrow();
  });
});

describe("scenario schema", () => {
  it("accepts every bundled scenario", () => {
    const files = readdirSync("scenarios").filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(7);
    for (const f of files) expect(parseScenario(JSON.parse(readFileSync(`scenarios/${f}`, "utf8"))).ok, f).toBe(true);
  });
  it.each([
    ["first entry not at 0", { anchor: { timeline: [{ atMs: 5, status: "incomplete" }, { atMs: 10, status: "completed" }] } }],
    ["non-increasing times", { anchor: { timeline: [{ atMs: 0, status: "incomplete" }, { atMs: 10, status: "pending_anchor" }, { atMs: 10, status: "completed" }] } }],
    ["duplicate status", { anchor: { timeline: [{ atMs: 0, status: "incomplete" }, { atMs: 10, status: "pending_anchor" }, { atMs: 20, status: "incomplete" }] } }],
    ["terminal status not last", { anchor: { timeline: [{ atMs: 0, status: "incomplete" }, { atMs: 10, status: "completed" }, { atMs: 20, status: "pending_anchor" }] } }],
    ["fault without a trigger", { faults: [{ type: "duplicate_response" }] }],
    ["unknown fault type", { faults: [{ type: "meteor", onPolls: [1] }] }],
    ["unknown top-level field", { score: 1 }],
    ["bad name", { name: "Bad Name" }],
    ["window ends before it starts", { faults: [{ type: "latency", virtualMs: 1, fromMs: 100, toMs: 50 }] }],
  ])("rejects %s", (_, over) => {
    expect(parseScenario(base(over as Record<string, unknown>)).ok).toBe(false);
  });
});

describe("anchor model", () => {
  const sc = load("baseline-withdrawal");
  const mk = (seed: number, jitter = 0) => {
    const s = structuredClone(sc);
    s.anchor.jitterMs = jitter;
    return new AnchorModel(s, seed, (ms) => new VirtualClock().iso(ms));
  };
  it("is deterministic in the seed, including jitter", () => {
    expect(mk(5, 9000).schedule).toEqual(mk(5, 9000).schedule);
    expect(mk(5, 9000).schedule).not.toEqual(mk(6, 9000).schedule);
    expect(mk(5, 9000).id).toBe(mk(5, 9000).id);
  });
  it("keeps jittered transitions strictly increasing", () => {
    for (let seed = 0; seed < 50; seed++) {
      const t = mk(seed, 50_000).schedule.map((s) => s.atMs);
      expect(t.every((v, i) => i === 0 || v > t[i - 1]!)).toBe(true);
    }
  });
  it("produces SEP-24 fields at the right statuses and exact amounts", () => {
    const a = mk(1);
    expect(a.record(0).status).toBe("incomplete");
    const start = a.record(12000);
    expect(start).toMatchObject({ kind: "withdrawal", status: "pending_user_transfer_start", amount_in: "100.0000000", amount_fee: "1.0000000", amount_out: "99.0000000", withdraw_anchor_account: SIM_ANCHOR_ACCOUNT, withdraw_memo_type: "id" });
    expect(start.stellar_transaction_id).toBeUndefined();
    expect(a.record(70000).withdraw_anchor_account).toBeUndefined();
    const ext = a.record(130000);
    expect(ext.status).toBe("pending_external");
    expect(ext.external_transaction_id).toMatch(/^SIMBANK-/);
    expect(ext.stellar_transaction_id).toMatch(/^[0-9a-f]{64}$/);
    const done = a.record(160000);
    expect(done).toMatchObject({ status: "completed", completed_at: "2026-01-01T00:02:40Z" });
    expect(done.message).toMatch(/SIMULATED/);
    expect(a.record(0).message).toMatch(/SIMULATED/);
  });
});

describe("scenario engine", () => {
  it("requires a token: 403 authentication_required with no valid bearer", () => {
    const e = make();
    const r = e.handle({ method: "GET", url: "/transaction?id=x" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ type: "authentication_required" });
    const t = e.timeline.find((x) => x.kind === "request");
    expect(t).toMatchObject({ authFailure: true, httpStatus: 403 });
  });

  it("advances virtual time by the interval on every request and numbers polls", () => {
    const e = make({ requestIntervalMs: 1000 });
    const s = session(e);
    expect(e.clock.now()).toBe(2000); // two requests so far: /auth and the interactive start
    const r = s.poll();
    expect(r.status).toBe(200);
    expect(r.headers["x-raillab-poll"]).toBe("1");
    expect(r.headers["x-raillab-request"]).toBe("3");
    expect(r.headers["x-raillab-time-ms"]).toBe("3000");
    expect(s.poll().headers["x-raillab-poll"]).toBe("2");
  });

  it("adds a cooperating consumer's reported sleep to virtual time", () => {
    const e = make({ requestIntervalMs: 1000 });
    const s = session(e);
    const before = e.clock.now();
    e.handle({ method: "GET", url: `/transaction?id=${s.id}`, headers: { ...s.h, "x-raillab-advance-ms": "4000" } });
    expect(e.clock.now() - before).toBe(5000);
  });

  it("answers 404 for an unknown transaction id and before one is started", () => {
    const e = make();
    const tok = (e.handle({ method: "POST", url: "/auth" }).body as { token: string }).token;
    expect(e.handle({ method: "GET", url: "/transaction?id=nope", headers: { authorization: `Bearer ${tok}` } }).status).toBe(404);
  });

  it("serves /info and /transactions in the SEP-24 shape", () => {
    const e = make();
    const info = e.handle({ method: "GET", url: "/info" }).body as { withdraw: Record<string, { enabled: boolean }> };
    expect(info.withdraw.USDC?.enabled).toBe(true);
    const s = session(e);
    const list = e.handle({ method: "GET", url: "/transactions", headers: s.h }).body as { transactions: Array<{ id: string }> };
    expect(list.transactions[0]?.id).toBe(s.id);
  });

  it("transient_error serves the configured status and Retry-After on exactly the named polls", () => {
    const e = make({ faults: [{ type: "transient_error", status: 503, retryAfterSeconds: 2, onPolls: [2] }] });
    const s = session(e);
    expect(s.poll().status).toBe(200);
    const bad = s.poll();
    expect(bad.status).toBe(503);
    expect(bad.headers["retry-after"]).toBe("2");
    expect(s.poll().status).toBe(200);
  });

  it("duplicate_response repeats the previous body exactly, even though the anchor has moved on", () => {
    const e = make({ requestIntervalMs: 10000, faults: [{ type: "duplicate_response", onPolls: [2] }] });
    const s = session(e);
    const first = s.poll(); // t=30000: pending_user_transfer_start
    const second = s.poll(); // t=40000: the anchor is now pending_user_transfer_complete, but this is a repeat
    const third = s.poll(); // t=50000: back to the truth
    expect((first.body as { status: string }).status).toBe("pending_user_transfer_start");
    expect(second.body).toEqual(first.body);
    expect((third.body as { status: string }).status).toBe("pending_user_transfer_complete");
    const reqs = e.timeline.filter((x) => x.kind === "request") as Array<{ duplicate: boolean; pollIndex: number | null; anchorStatus: string }>;
    expect(reqs.filter((r) => r.duplicate).map((r) => r.pollIndex)).toEqual([2]);
    expect(reqs.find((r) => r.pollIndex === 2)?.anchorStatus).toBe("pending_user_transfer_complete");
  });

  it("stale_snapshot serves an older status after a newer one and flags it as reordered", () => {
    const e = make({ requestIntervalMs: 10000, faults: [{ type: "stale_snapshot", serveAsOfMs: 12000, onPolls: [4] }] });
    const s = session(e); // /auth at 10000, start at 20000
    const p1 = s.poll().body as { status: string }; // t=30000: pending_user_transfer_start
    const p2 = s.poll().body as { status: string }; // t=40000: pending_user_transfer_complete
    s.poll(); // t=50000
    const stale = s.poll(); // t=60000: truly pending_user_transfer_complete, served as of 12000
    expect(p1.status).toBe("pending_user_transfer_start");
    expect(p2.status).toBe("pending_user_transfer_complete");
    expect((stale.body as { status: string }).status).toBe("pending_user_transfer_start");
    const last = e.timeline.filter((x) => x.kind === "request").at(-1) as { reordered: boolean; anchorStatus: string; servedStatus: string };
    expect(last).toMatchObject({ reordered: true, anchorStatus: "pending_user_transfer_complete", servedStatus: "pending_user_transfer_start" });
  });

  it("mismatched_reference changes only the id and flags it", () => {
    const e = make({ faults: [{ type: "mismatched_reference", onPolls: [1] }] });
    const s = session(e);
    const r = s.poll().body as { id: string; status: string };
    expect(r.id).not.toBe(s.id);
    expect(r.id).toMatch(/^other-/);
    expect(e.timeline.filter((x) => x.kind === "request").at(-1)).toMatchObject({ mismatchedId: true });
  });

  it("token_expiry expires tokens afterMs after issue and a new token works again", () => {
    const e = make({ requestIntervalMs: 10000, faults: [{ type: "token_expiry", afterMs: 15000 }] });
    const s = session(e); // token issued at t=10000, start at 20000
    expect(s.poll().status).toBe(403); // 30000 - 10000 >= 15000
    const fresh = (e.handle({ method: "POST", url: "/auth" }).body as { token: string }).token;
    expect(e.handle({ method: "GET", url: `/transaction?id=${s.id}`, headers: { authorization: `Bearer ${fresh}` } }).status).toBe(200);
  });

  it("latency advances virtual time before answering", () => {
    const e = make({ requestIntervalMs: 1000, faults: [{ type: "latency", virtualMs: 7000, onPolls: [1] }] });
    const s = session(e);
    const before = e.clock.now();
    const r = s.poll();
    expect(e.clock.now() - before).toBe(8000);
    expect(r.headers["x-raillab-time-ms"]).toBe(String(e.clock.now()));
  });

  it("holds the response for real time only when realMs is set", () => {
    const e = make({ faults: [{ type: "latency", virtualMs: 1, realMs: 25, onPolls: [1] }] });
    expect(session(e).poll().holdRealMs).toBe(25);
    expect(session(make({ faults: [{ type: "latency", virtualMs: 1, onPolls: [1] }] })).poll().holdRealMs).toBeUndefined();
  });

  it("logs anchor transitions as time passes, in order, with increasing sequence numbers", () => {
    const e = make({ requestIntervalMs: 20000 });
    const s = session(e);
    for (let i = 0; i < 8; i++) s.poll();
    const tr = e.timeline.filter((x) => x.kind === "anchor_transition") as Array<{ to: string; atMs: number }>;
    expect(tr.map((t) => t.to)).toEqual(["incomplete", "pending_user_transfer_start", "pending_user_transfer_complete", "pending_anchor", "completed"]);
    const seqs = e.timeline.map((x) => x.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("control plane validates consumer events and clock advances", () => {
    const e = make();
    const post = (url: string, body: unknown): ReturnType<ScenarioEngine["handle"]> => e.handle({ method: "POST", url, body } as EngineRequest);
    expect(post("/__raillab/events", { event: "user_status", txId: "x", status: "pending" }).status).toBe(200);
    expect(post("/__raillab/events", { event: "user_status", txId: "x", status: "happy" }).status).toBe(400);
    expect(post("/__raillab/events", { event: "launch_missiles" }).status).toBe(400);
    expect(post("/__raillab/clock/advance", { ms: 500 }).body).toEqual({ nowMs: 500 });
    expect(post("/__raillab/clock/advance", { ms: -5 }).status).toBe(400);
    expect(post("/__raillab/clock/advance", { ms: "soon" }).status).toBe(400);
    expect(e.handle({ method: "GET", url: "/__raillab/nope" }).status).toBe(404);
    expect(e.timeline.filter((x) => x.kind === "consumer")).toHaveLength(1);
  });
});

describe("determinism", () => {
  const run = (name: string, seed: number) => {
    const e = new ScenarioEngine(load(name), seed);
    const s = session(e);
    for (let i = 0; i < 70; i++) s.poll();
    return JSON.stringify(e.timeline);
  };
  it("the same scenario and seed reproduce the identical timeline", () => {
    expect(run("everything-at-once", 42)).toBe(run("everything-at-once", 42));
  });
  it("a different seed changes the probabilistic timeline", () => {
    expect(run("everything-at-once", 42)).not.toBe(run("everything-at-once", 43));
  });
  it("fault-named polls do not depend on the seed", () => {
    const faultPolls = (seed: number) => {
      const e = new ScenarioEngine(load("transient-outage"), seed);
      const s = session(e);
      for (let i = 0; i < 10; i++) s.poll();
      return (e.timeline.filter((x) => x.kind === "request") as Array<{ pollIndex: number | null; httpStatus: number }>).filter((r) => r.httpStatus === 503).map((r) => r.pollIndex);
    };
    expect(faultPolls(1)).toEqual([5, 6, 7]);
    expect(faultPolls(999)).toEqual([5, 6, 7]);
  });
});
