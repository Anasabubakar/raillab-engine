// An external client with the classic mistake: it reports completion as soon as the anchor starts processing.
const base = process.env.RAILLAB_BASE_URL;
const eventsUrl = process.env.RAILLAB_EVENTS_URL;
const post = (path, token, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ headers: r.headers, json: await r.json() }));
const emit = (e) => fetch(eventsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) });
const token = (await post("/auth", null)).json.token;
const txId = (await post("/transactions/withdraw/interactive", token, {})).json.id;
for (let i = 0; i < 200; i++) {
  const r = await fetch(`${base}/transaction?id=${txId}`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (["pending_anchor", "pending_stellar", "pending_external", "completed"].includes(j.status)) {
    await emit({ event: "user_status", txId, status: "completed" });
    process.exit(0);
  }
}
