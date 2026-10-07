import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ScenarioEngine } from "../engine/engine.ts";
import type { Scenario } from "../engine/scenario.ts";

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size === 0) return resolve(undefined);
      const text = Buffer.concat(chunks).toString("utf8");
      const type = String(req.headers["content-type"] ?? "");
      try {
        if (type.includes("application/json")) return resolve(JSON.parse(text));
        // SEP-24 requests are form-encoded or JSON; accept both and expose form fields as an object.
        return resolve(Object.fromEntries(new URLSearchParams(text)));
      } catch {
        reject(Object.assign(new Error("malformed request body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export interface RunningServer {
  engine: ScenarioEngine;
  url: string;
  close(): Promise<void>;
}

/** Serve a scenario over HTTP on the loopback interface only. All behavior comes from ScenarioEngine.handle. */
export async function startServer(scenario: Scenario, seed: number, port = 0): Promise<RunningServer> {
  const engine = new ScenarioEngine(scenario, seed);
  const server: Server = createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
      const out = engine.handle({ method: req.method ?? "GET", url: req.url ?? "/", headers, body });
      if (out.holdRealMs) await new Promise((r) => setTimeout(r, out.holdRealMs));
      res.writeHead(out.status, { ...out.headers, "access-control-allow-origin": "*" });
      res.end(JSON.stringify(out.body));
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: status === 500 ? "internal error" : (e as Error).message }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo;
  return {
    engine,
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}
