#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { RULE_CATALOG } from "../engine/assertions.ts";
import { MUTANTS, correctedConsumer, defectiveConsumer, type ConsumerBehaviors } from "../consumers/configurable.ts";
import { runSession, TOOL_VERSION, type Session } from "../engine/session.ts";
import type { Consumer } from "../engine/transport.ts";
import { exitCodeFor, renderText } from "./render.ts";
import { runExternal, runOverHttp } from "./runner.ts";
import { bundledScenarioNames, loadScenario } from "./scenarios.ts";
import { startServer } from "./server.ts";

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

function int(name: string, max = 0xffffffff) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new InvalidArgumentError(`${name} must be an integer from 0 to ${max}`);
    return n;
  };
}

function pickConsumer(name: string): { consumer: Consumer; label: string } {
  if (name === "corrected") return { consumer: correctedConsumer, label: "reference corrected client" };
  if (name === "defective") return { consumer: defectiveConsumer, label: "reference defective client" };
  const m = /^mutant:(.+)$/.exec(name);
  if (m && m[1]! in MUTANTS) return { consumer: MUTANTS[m[1] as keyof ConsumerBehaviors].consumer, label: `corrected client without ${m[1]}` };
  throw new InvalidArgumentError(`--consumer must be corrected, defective or mutant:<${Object.keys(MUTANTS).join("|")}>`);
}

async function output(s: Session, opts: { format: string; timeline?: boolean; out?: string }, io: CliIo): Promise<number> {
  if (opts.out) await writeFile(opts.out, JSON.stringify(s, null, 2) + "\n");
  io.stdout(opts.format === "json" ? JSON.stringify(s, null, 2) + "\n" : renderText(s, { timeline: opts.timeline }));
  return exitCodeFor(s);
}

/**
 * Exit codes: 0 every applicable rule passed, 1 a rule failed, 3 nothing failed but a rule was inconclusive,
 * 4 the external consumer could not run or timed out, 2 invalid input or usage.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let exit = 0;
  const program = new Command();
  program.name("raillab").description("Deterministic SEP-24 consumer incident simulator.").version(TOOL_VERSION).exitOverride().configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program.command("list").description("List bundled scenarios.").action(() => {
    for (const n of bundledScenarioNames()) io.stdout(`${n.padEnd(26)} ${loadScenario(n).title}\n`);
  });

  program.command("rules").description("List the assertions and whether each is a SEP-24 requirement or an application policy.").action(() => {
    for (const r of RULE_CATALOG) io.stdout(`${r.id}\n  [${r.kind}] ${r.title}\n  basis: ${r.basis}\n`);
  });

  program.command("validate").argument("<scenario>", "scenario file or bundled name").action((ref: string) => {
    try {
      const s = loadScenario(ref);
      io.stdout(`Scenario OK: ${s.name} (${s.anchor.timeline.length} anchor steps, ${s.faults.length} fault(s))\n`);
    } catch (e) {
      io.stderr(`${(e as Error).message}\n`);
      exit = 2;
    }
  });

  program
    .command("run")
    .argument("<scenario>", "scenario file or bundled name")
    .option("--seed <n>", "seed for jitter and probabilistic faults", int("seed"), 1)
    .option("--consumer <name>", "corrected, defective or mutant:<behavior>", "corrected")
    .option("--over-http", "run the reference consumer against the HTTP server instead of in-process")
    .option("--format <f>", "text or json", "text")
    .option("--timeline", "include the full timeline in text output")
    .option("--out <file>", "also write the session JSON here")
    .description("Run a reference consumer against a scenario and evaluate the assertions.")
    .action(async (ref: string, o) => {
      try {
        const scenario = loadScenario(ref);
        const { consumer, label } = pickConsumer(o.consumer);
        if (!["text", "json"].includes(o.format)) throw new InvalidArgumentError("--format must be text or json");
        const s = o.overHttp ? await runOverHttp({ scenario, seed: o.seed, consumer, consumerName: label }) : await runSession({ scenario, seed: o.seed, consumer, consumerName: label });
        exit = await output(s, o, io);
      } catch (e) {
        io.stderr(`${(e as Error).message}\n`);
        exit = 2;
      }
    });

  program
    .command("test")
    .argument("<scenario>", "scenario file or bundled name")
    .argument("<command...>", "the consumer command, after --")
    .option("--seed <n>", "seed", int("seed"), 1)
    .option("--timeout <ms>", "kill the consumer after this long", int("timeout", 3_600_000), 60_000)
    .option("--format <f>", "text or json", "text")
    .option("--timeline", "include the full timeline in text output")
    .option("--out <file>", "also write the session JSON here")
    .description("Run YOUR consumer (any command that speaks HTTP) against a scenario. It gets RAILLAB_BASE_URL and RAILLAB_EVENTS_URL.")
    .action(async (ref: string, command: string[], o) => {
      try {
        const scenario = loadScenario(ref);
        const r = await runExternal({ scenario, seed: o.seed, command, timeoutMs: o.timeout });
        if (r.stderr.trim()) io.stderr(`consumer stderr (tail):\n${r.stderr.trim().split("\n").slice(-5).join("\n")}\n`);
        exit = await output(r.session, o, io);
      } catch (e) {
        io.stderr(`${(e as Error).message}\n`);
        exit = 2;
      }
    });

  program
    .command("serve")
    .argument("<scenario>")
    .option("--seed <n>", "seed", int("seed"), 1)
    .option("--port <n>", "port (loopback only)", int("port", 65535), 8686)
    .option("--out <file>", "write the session JSON here when stopped")
    .description("Serve a scenario on 127.0.0.1 for a consumer you run yourself. Stop with Ctrl-C.")
    .action(async (ref: string, o) => {
      try {
        const scenario = loadScenario(ref);
        const srv = await startServer(scenario, o.seed, o.port);
        io.stdout(`RailLab serving "${scenario.name}" (seed ${o.seed}) at ${srv.url}\nPOST consumer events to ${srv.url}/__raillab/events. Ctrl-C to stop.\n`);
        await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
        const { buildSession } = await import("../engine/session.ts");
        const s = buildSession(srv.engine, { name: "manual", kind: "external" }, null);
        await srv.close();
        exit = await output(s, { format: "text", out: o.out }, io);
      } catch (e) {
        io.stderr(`${(e as Error).message}\n`);
        exit = 2;
      }
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    io.stderr(`Unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }
  return exit;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }).then((c) => process.exit(c));
}
