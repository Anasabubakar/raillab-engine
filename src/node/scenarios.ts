import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseScenario, type Scenario } from "../engine/scenario.ts";

const BUNDLED = fileURLToPath(new URL("../../scenarios/", import.meta.url));

export function bundledScenarioNames(): string[] {
  return readdirSync(BUNDLED).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

/** Resolve a scenario by file path or by bundled name. Throws a readable error for invalid input. */
export function loadScenario(ref: string): Scenario {
  const path = existsSync(ref) ? ref : join(BUNDLED, `${ref}.json`);
  if (!existsSync(path)) throw new Error(`no scenario file "${ref}" and no bundled scenario with that name (try: raillab list)`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parseScenario(raw);
  if (!parsed.ok) throw new Error(`invalid scenario ${path}:\n` + parsed.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n"));
  return parsed.scenario;
}
