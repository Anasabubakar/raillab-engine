import type { Session } from "../engine/session.ts";
import type { RequestEvent } from "../engine/timeline.ts";

const TAG: Record<string, string> = { pass: "PASS", fail: "FAIL", not_applicable: "N/A ", inconclusive: "????" };

export function renderText(s: Session, opts: { timeline?: boolean } = {}): string {
  const out: string[] = [];
  out.push(`RailLab session: ${s.scenario.title}`);
  out.push(`scenario ${s.scenario.name}  seed ${s.seed}  consumer ${s.consumer.name} (${s.consumer.kind})  ended at ${s.endedAtMs} ms virtual`);
  out.push(`timeline fingerprint ${s.timelineDigest}`);
  out.push(`Verdict: ${s.result.verdict.toUpperCase()}`);
  if (s.consumerError) out.push(`Consumer problem: ${s.consumerError}`);
  out.push("");
  for (const a of s.result.assertions) {
    out.push(`${TAG[a.outcome]}  [${a.kind}] ${a.title}`);
    for (const e of a.evidence) out.push(`        ${e}`);
  }
  if (opts.timeline) {
    out.push("");
    out.push("Timeline:");
    for (const e of s.timeline) {
      if (e.kind === "anchor_transition") out.push(`  ${String(e.atMs).padStart(8)} ms  anchor ${e.from ?? "(start)"} -> ${e.to}`);
      else if (e.kind === "request") {
        const r: RequestEvent = e;
        const flags = [r.reordered && "reordered", r.duplicate && "repeat", r.mismatchedId && "wrong-id", r.authFailure && "403", ...r.faults.map((f) => f.type)].filter(Boolean);
        out.push(`  ${String(r.atMs).padStart(8)} ms  #${r.n} ${r.method} ${r.path} -> ${r.httpStatus}${r.servedStatus ? ` ${r.servedStatus}` : ""}${flags.length ? `  [${[...new Set(flags)].join(", ")}]` : ""}`);
      } else out.push(`  ${String(e.atMs).padStart(8)} ms  consumer ${JSON.stringify(e.event)}`);
    }
  }
  out.push("");
  out.push(s.simulationNotice);
  return out.join("\n") + "\n";
}

export function exitCodeFor(s: Session): number {
  if (s.consumerError?.includes("timed out") || s.consumerError?.includes("could not be started")) return 4;
  return s.result.verdict === "pass" ? 0 : s.result.verdict === "fail" ? 1 : 3;
}
