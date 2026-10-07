// Run with: node --experimental-strip-types scripts/gen-schema.ts [--check]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { scenarioSchema } from "../src/engine/scenario.ts";
import { sessionSchema } from "../src/engine/sessionSchema.ts";

const check = process.argv.includes("--check");
const targets: Array<[string, z.ZodType, string]> = [
  ["schema/scenario.v1.schema.json", scenarioSchema, "RailLab scenario v1"],
  ["schema/session.v1.schema.json", sessionSchema, "RailLab session v1"],
];
mkdirSync("schema", { recursive: true });
let stale = false;
for (const [path, schema, title] of targets) {
  const text = JSON.stringify({ title, ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) }, null, 2) + "\n";
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      /* missing counts as stale */
    }
    if (current !== text) {
      console.error(`${path} is out of date; run pnpm schema`);
      stale = true;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exit(1);
