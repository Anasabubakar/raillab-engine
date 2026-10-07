import type { Clock } from "../engine/clock.ts";
import type { ConsumerEvent } from "../engine/timeline.ts";
import type { Transport } from "../engine/transport.ts";

/** A transport that talks to a running scenario server over HTTP, so in-process consumers can be checked over the wire too. */
export function httpTransport(baseUrl: string): { transport: Transport; clock: Clock; emit: (e: ConsumerEvent) => Promise<void> } {
  const transport: Transport = async (r) => {
    const res = await fetch(baseUrl + r.path, {
      method: r.method,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
      body: r.method === "GET" ? undefined : JSON.stringify(r.body ?? {}),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, json: await res.json().catch(() => null) };
  };
  // Over HTTP the simulator advances virtual time per request; sleeping reports the extra time on the next request.
  let pending = 0;
  const wrapped: Transport = (r) => {
    const extra = pending;
    pending = 0;
    return transport(extra > 0 ? { ...r, headers: { ...(r.headers ?? {}), "x-raillab-advance-ms": String(extra) } } : r);
  };
  const clock: Clock = { now: () => 0, sleep: async (ms) => void (pending += ms) };
  const emit = async (e: ConsumerEvent) => {
    await transport({ method: "POST", path: "/__raillab/events", body: e });
  };
  return { transport: wrapped, clock, emit };
}
