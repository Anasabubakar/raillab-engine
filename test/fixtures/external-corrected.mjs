// An independent, plain-JavaScript SEP-24 withdrawal client with no RailLab imports. It only uses fetch and the
// environment RailLab provides, to demonstrate that any HTTP consumer can be tested.
const base = process.env.RAILLAB_BASE_URL;
const eventsUrl = process.env.RAILLAB_EVENTS_URL;
const maxPolls = Number(process.env.RAILLAB_MAX_POLLS);
const asset = process.env.RAILLAB_ASSET_CODE;

let pendingSleepMs = 0; // reported to the simulator on the next request
async function call(method, path, token, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (pendingSleepMs) {
    headers["x-raillab-advance-ms"] = String(pendingSleepMs);
    pendingSleepMs = 0;
  }
  const res = await fetch(base + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  return { status: res.status, poll: Number(res.headers.get("x-raillab-poll")), json: await res.json().catch(() => null) };
}
const emit = (e) => fetch(eventsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) });

const RANK = ["incomplete", "pending_user_transfer_start", "pending_user_transfer_complete", "pending_anchor", "pending_stellar", "pending_external", "completed"];
let token = (await call("POST", "/auth", null, {})).json.token;
const txId = (await call("POST", "/transactions/withdraw/interactive", token, { asset_code: asset })).json.id;
let current = null;
let backoff = 1000;
let paid = false;
for (let polls = 0; polls < maxPolls; ) {
  polls++;
  const r = await call("GET", `/transaction?id=${txId}`, token);
  if (r.status === 403) { token = (await call("POST", "/auth", null, {})).json.token; continue; }
  if (r.status >= 500) { pendingSleepMs += backoff; backoff = Math.min(backoff * 2, 30000); continue; }
  backoff = 1000;
  if (r.json.id !== txId) continue;
  const rank = RANK.indexOf(r.json.status);
  if (current !== null && rank < RANK.indexOf(current)) continue;
  if (r.json.status === current) continue;
  current = r.json.status;
  await emit({ event: "status_applied", pollIndex: r.poll, txId, status: current });
  if (current === "pending_user_transfer_start" && !paid) { paid = true; await emit({ event: "business_action", txId, action: "send_payment_to_anchor", key: `pay-${txId}` }); }
  if (current === "completed") { await emit({ event: "user_status", txId, status: "completed" }); process.exit(0); }
  await emit({ event: "user_status", txId, status: "pending" });
}
await emit({ event: "user_status", txId, status: "unknown" });
