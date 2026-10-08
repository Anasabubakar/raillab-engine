import { spawn } from "node:child_process";
import type { Consumer } from "../engine/transport.ts";
import { buildSession, type Session } from "../engine/session.ts";
import type { Scenario } from "../engine/scenario.ts";
import { RequestBudgetExceeded } from "../engine/transport.ts";
import { httpTransport } from "./http-transport.ts";
import { startServer } from "./server.ts";

/** Run an in-process consumer against the HTTP server (proves the same consumer behaves the same over the wire). */
export async function runOverHttp(opts: { scenario: Scenario; seed: number; consumer: Consumer; consumerName: string }): Promise<Session> {
  const srv = await startServer(opts.scenario, opts.seed);
  let error: string | null = null;
  try {
    const { transport, clock, emit } = httpTransport(srv.url);
    let used = 0;
    const budget = Math.max(200, opts.scenario.maxPolls * 8);
    await opts.consumer({
      transport: async (r) => {
        if (++used > budget) throw new RequestBudgetExceeded(budget);
        return transport(r);
      },
      clock,
      emit,
      assetCode: opts.scenario.anchor.assetCode,
      maxPolls: opts.scenario.maxPolls,
    });
  } catch (e) {
    error = e instanceof RequestBudgetExceeded ? e.message : `consumer threw: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await srv.close();
  }
  return buildSession(srv.engine, { name: opts.consumerName, kind: "reference" }, error);
}

export interface ExternalResult {
  session: Session;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run any external command as the consumer. It receives the scenario server's address in its environment and talks
 * plain HTTP to it. The command is the consumer under test: RailLab does not need to know its language.
 *
 * Environment: RAILLAB_BASE_URL, RAILLAB_EVENTS_URL (POST consumer events here), RAILLAB_ASSET_CODE,
 * RAILLAB_MAX_POLLS, RAILLAB_SCENARIO, RAILLAB_SEED.
 */
export async function runExternal(opts: { scenario: Scenario; seed: number; command: string[]; timeoutMs?: number; consumerName?: string }): Promise<ExternalResult> {
  const [cmd, ...args] = opts.command;
  if (!cmd) throw new Error("no consumer command given");
  const srv = await startServer(opts.scenario, opts.seed);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>((resolve) => {
      // detached puts the consumer in its own process group so the whole tree can be signalled, not just the child.
      const child = spawn(cmd, args, {
        detached: true,
        env: {
          ...process.env,
          RAILLAB_BASE_URL: srv.url,
          RAILLAB_EVENTS_URL: `${srv.url}/__raillab/events`,
          RAILLAB_ASSET_CODE: opts.scenario.anchor.assetCode,
          RAILLAB_MAX_POLLS: String(opts.scenario.maxPolls),
          RAILLAB_SCENARIO: opts.scenario.name,
          RAILLAB_SEED: String(opts.seed),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      const killTree = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* the group is already gone */
        }
      };
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        killTree(); // descendants that outlived the consumer would otherwise keep our pipes open
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(code);
      };
      let grace: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
        // Bounded cleanup: do not wait on pipes a surviving descendant might still hold.
        grace = setTimeout(() => finish(null), 2000);
      }, opts.timeoutMs ?? 60_000);
      child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(-20_000)));
      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-20_000)));
      child.on("error", (e) => {
        stderr += String(e);
        finish(null);
      });
      // 'exit' fires when the child ends even if a descendant still holds its pipes; give output a moment to flush.
      child.on("exit", (code) => {
        grace = setTimeout(() => finish(code), 300);
      });
      child.on("close", (code) => finish(code));
    });
  } finally {
    await srv.close();
  }
  const err = timedOut ? "the consumer command timed out and was killed" : exitCode === null ? "the consumer command could not be started" : exitCode !== 0 ? `the consumer command exited with code ${exitCode}` : null;
  const session = buildSession(srv.engine, { name: opts.consumerName ?? cmd, kind: "external", note: `command: ${opts.command.join(" ")}` }, err);
  return { session, exitCode, timedOut, stdout, stderr };
}
