import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MUTANTS, correctedConsumer, defectiveConsumer } from "../src/consumers/configurable.ts";
import { runSession } from "../src/engine/session.ts";
import { runCli } from "../src/node/cli.ts";
import { httpTransport } from "../src/node/http-transport.ts";
import { exitCodeFor } from "../src/node/render.ts";
import { runExternal, runOverHttp } from "../src/node/runner.ts";
import { bundledScenarioNames, loadScenario } from "../src/node/scenarios.ts";
import { startServer } from "../src/node/server.ts";
import { load } from "./engine.test.ts";

const cap = () => {
  const out: string[] = [], err: string[] = [];
  return { io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, out: () => out.join(""), err: () => err.join("") };
};
const NAMES = bundledScenarioNames();

describe("HTTP server", () => {
  it("binds the loopback interface only", async () => {
    const srv = await startServer(load("baseline-withdrawal"), 1);
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await srv.close();
  });

  it("speaks the SEP-24 surface over real HTTP, including JSON and form bodies", async () => {
    const srv = await startServer(load("baseline-withdrawal"), 1);
    const auth = await (await fetch(`${srv.url}/auth`, { method: "POST" })).json();
    const h = { authorization: `Bearer ${auth.token}` };
    const form = await fetch(`${srv.url}/transactions/withdraw/interactive`, { method: "POST", headers: { ...h, "content-type": "application/x-www-form-urlencoded" }, body: "asset_code=USDC" });
    const start = await form.json();
    expect(start).toMatchObject({ type: "interactive_customer_info_needed" });
    const poll = await fetch(`${srv.url}/transaction?id=${start.id}`, { headers: h });
    expect(poll.status).toBe(200);
    expect(poll.headers.get("x-raillab-poll")).toBe("1");
    expect((await poll.json()).kind).toBe("withdrawal");
    const denied = await fetch(`${srv.url}/transaction?id=${start.id}`);
    expect(denied.status).toBe(403);
    await srv.close();
  });

  it("rejects oversized and malformed bodies without crashing", async () => {
    const srv = await startServer(load("baseline-withdrawal"), 1);
    const big = await fetch(`${srv.url}/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: "y".repeat(70_000) }) }).catch(() => null);
    expect(big === null || big.status === 413).toBe(true);
    const bad = await fetch(`${srv.url}/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    expect((await fetch(`${srv.url}/info`)).status).toBe(200);
    await srv.close();
  });

  it("holds a latency fault in real time only when asked", async () => {
    const sc = structuredClone(load("baseline-withdrawal"));
    sc.faults = [{ type: "latency", virtualMs: 1, realMs: 120, onPolls: [1] }];
    const srv = await startServer(sc, 1);
    const t = await (await fetch(`${srv.url}/auth`, { method: "POST" })).json();
    const h = { authorization: `Bearer ${t.token}` };
    const id = (await (await fetch(`${srv.url}/transactions/withdraw/interactive`, { method: "POST", headers: h })).json()).id;
    const t0 = Date.now();
    await fetch(`${srv.url}/transaction?id=${id}`, { headers: h });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    await srv.close();
  });

  it("does not accept connections after close", async () => {
    const srv = await startServer(load("baseline-withdrawal"), 1);
    await srv.close();
    await expect(
      new Promise((resolve, reject) => {
        const r = request(srv.url + "/info", () => resolve(true));
        r.on("error", reject);
        r.end();
      }),
    ).rejects.toBeTruthy();
  });
});

describe("the same consumer over the wire", () => {
  it.each(NAMES)("%s: HTTP and in-process runs give byte-identical timelines (corrected and defective)", async (name) => {
    for (const [consumer, label] of [[correctedConsumer, "c"], [defectiveConsumer, "d"]] as const) {
      const inproc = await runSession({ scenario: load(name), seed: 5, consumer, consumerName: label });
      const http = await runOverHttp({ scenario: load(name), seed: 5, consumer, consumerName: label });
      expect(http.timelineDigest, `${name}/${label}`).toBe(inproc.timelineDigest);
      expect(http.result.verdict).toBe(inproc.result.verdict);
    }
  });

  it("mutants fail the same rule over HTTP", async () => {
    const s = await runOverHttp({ scenario: load("mismatched-reference"), seed: 1, consumer: MUTANTS.checkReference.consumer, consumerName: "m" });
    expect(s.result.assertions.find((a) => a.id === "ignores-mismatched-reference")!.outcome).toBe("fail");
  });

  it("http transport reports extra sleep to the simulator on the next request", async () => {
    const srv = await startServer(load("baseline-withdrawal"), 1);
    const { transport, clock } = httpTransport(srv.url);
    await transport({ method: "GET", path: "/info" });
    const before = srv.engine.clock.now();
    await clock.sleep(7000);
    await transport({ method: "GET", path: "/info" });
    expect(srv.engine.clock.now() - before).toBe(7000 + srv.engine.scenario.requestIntervalMs);
    await srv.close();
  });
});

describe("an external consumer in another language/runtime", () => {
  const node = process.execPath;
  it("an independent plain-JS client passes the baseline and the fault scenarios", async () => {
    for (const name of ["baseline-withdrawal", "transient-outage", "stale-authentication", "mismatched-reference", "reordered-and-repeated"]) {
      const r = await runExternal({ scenario: load(name), seed: 1, command: [node, "test/fixtures/external-corrected.mjs"], timeoutMs: 30_000 });
      const bad = r.session.result.assertions.filter((a) => a.outcome === "fail");
      expect(bad, `${name}: ${JSON.stringify(bad)} ${r.stderr}`).toEqual([]);
      expect(r.session.consumer.kind).toBe("external");
      expect(r.session.result.verdict, name).toBe("pass");
      expect(r.exitCode).toBe(0);
    }
  });

  it("an independent naive client is caught announcing completion early", async () => {
    const r = await runExternal({ scenario: load("baseline-withdrawal"), seed: 1, command: [node, "test/fixtures/external-naive.mjs"], timeoutMs: 30_000 });
    expect(r.session.result.assertions.find((a) => a.id === "no-early-completion")!.outcome).toBe("fail");
    expect(exitCodeFor(r.session)).toBe(1);
  });

  it("a silent client is inconclusive, a crashing client is reported, a hanging client is killed", async () => {
    const silent = await runExternal({ scenario: load("baseline-withdrawal"), seed: 1, command: [node, "test/fixtures/external-silent.mjs"] });
    expect(silent.session.result.verdict).toBe("inconclusive");
    expect(exitCodeFor(silent.session)).toBe(3);
    const crash = await runExternal({ scenario: load("baseline-withdrawal"), seed: 1, command: [node, "test/fixtures/external-crash.mjs"] });
    expect(crash.session.consumerError).toMatch(/exited with code 1/);
    expect(crash.stderr).toMatch(/boom/);
    const hang = await runExternal({ scenario: load("baseline-withdrawal"), seed: 1, command: [node, "test/fixtures/external-hang.mjs"], timeoutMs: 600 });
    expect(hang.timedOut).toBe(true);
    expect(exitCodeFor(hang.session)).toBe(4);
    const missing = await runExternal({ scenario: load("baseline-withdrawal"), seed: 1, command: ["/definitely/not/a/command"] });
    expect(missing.session.consumerError).toMatch(/could not be started/);
  });
});

describe("CLI", () => {
  it("lists scenarios and rules, and labels each rule sep or policy", async () => {
    const c = cap();
    expect(await runCli(["list"], c.io)).toBe(0);
    expect(c.out()).toMatch(/baseline-withdrawal/);
    const r = cap();
    await runCli(["rules"], r.io);
    expect(r.out()).toMatch(/\[sep\] Does not tell the user/);
    expect(r.out()).toMatch(/\[policy\]/);
  });

  it("run: corrected exits 0, defective exits 1, with the failing rule named", async () => {
    const ok = cap();
    expect(await runCli(["run", "baseline-withdrawal", "--consumer", "corrected"], ok.io)).toBe(0);
    expect(ok.out()).toMatch(/Verdict: PASS/);
    const bad = cap();
    expect(await runCli(["run", "baseline-withdrawal", "--consumer", "defective"], bad.io)).toBe(1);
    expect(bad.out()).toMatch(/FAIL\s+\[sep\] Does not tell the user/);
    const m = cap();
    expect(await runCli(["run", "transient-outage", "--consumer", "mutant:retryTransient"], m.io)).toBe(1);
  });

  it("run: --out writes a schema-valid session and --format json prints the same session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rl-"));
    const out = join(dir, "s.json");
    const c = cap();
    await runCli(["run", "reordered-and-repeated", "--seed", "9", "--format", "json", "--out", out], c.io);
    const file = JSON.parse(await readFile(out, "utf8"));
    expect(JSON.parse(c.out())).toEqual(file);
    expect(file.seed).toBe(9);
  });

  it("run: --over-http gives the same fingerprint as in-process", async () => {
    const a = cap(), b = cap();
    await runCli(["run", "everything-at-once", "--seed", "4", "--format", "json"], a.io);
    await runCli(["run", "everything-at-once", "--seed", "4", "--format", "json", "--over-http"], b.io);
    expect(JSON.parse(b.out()).timelineDigest).toBe(JSON.parse(a.out()).timelineDigest);
  });

  it("test: runs an external command and maps the verdict to the exit code", async () => {
    const pass = cap();
    expect(await runCli(["test", "baseline-withdrawal", "--", process.execPath, "test/fixtures/external-corrected.mjs"], pass.io)).toBe(0);
    const fail = cap();
    expect(await runCli(["test", "baseline-withdrawal", "--", process.execPath, "test/fixtures/external-naive.mjs"], fail.io)).toBe(1);
    expect(fail.out()).toMatch(/consumer external-naive|external/);
  });

  it("validate and run report invalid input with exit code 2", async () => {
    for (const args of [["validate", "no-such-scenario"], ["run", "no-such-scenario"], ["run", "baseline-withdrawal", "--consumer", "nope"], ["run", "baseline-withdrawal", "--format", "xml"], ["run", "baseline-withdrawal", "--seed", "-3"]]) {
      const c = cap();
      expect(await runCli(args, c.io), args.join(" ")).toBe(2);
    }
    const dir = await mkdtemp(join(tmpdir(), "rl-"));
    const bad = join(dir, "bad.json");
    await import("node:fs/promises").then((fs) => fs.writeFile(bad, JSON.stringify({ schemaVersion: "1", name: "x" })));
    const c = cap();
    expect(await runCli(["validate", bad], c.io)).toBe(2);
    expect(c.err()).toMatch(/invalid scenario/);
  });

  it("loads scenarios by name or by path", () => {
    expect(loadScenario("baseline-withdrawal").name).toBe("baseline-withdrawal");
    expect(loadScenario("scenarios/baseline-withdrawal.json").name).toBe("baseline-withdrawal");
    expect(JSON.parse(readFileSync("scenarios/baseline-withdrawal.json", "utf8")).name).toBe("baseline-withdrawal");
  });
});

describe("portability", () => {
  it("the engine and the reference clients import nothing from node:, so they run in a browser", () => {
    for (const dir of ["src/engine", "src/consumers"]) {
      for (const f of readdirSync(dir)) {
        const text = readFileSync(`${dir}/${f}`, "utf8");
        expect(text, `${dir}/${f}`).not.toMatch(/from "node:/);
        expect(text, `${dir}/${f}`).not.toMatch(/\bprocess\./);
        expect(text, `${dir}/${f}`).not.toMatch(/Math\.random|Date\.now\(\)/);
      }
    }
  });
});
