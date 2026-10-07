# Testing your own consumer with RailLab

RailLab does not need your client's language. Any command that speaks HTTP can be the consumer:

```bash
raillab test stale-authentication --seed 3 -- node my-wallet-withdrawal.js
```

The scenario server starts on `127.0.0.1` with a free port and your command runs with:

| Variable | Meaning |
|---|---|
| `RAILLAB_BASE_URL` | the simulated anchor's base URL (`/info`, `/auth`, `/transactions/withdraw/interactive`, `/transaction`, `/transactions`) |
| `RAILLAB_EVENTS_URL` | where to POST the decisions your client makes (below) |
| `RAILLAB_ASSET_CODE`, `RAILLAB_MAX_POLLS`, `RAILLAB_SCENARIO`, `RAILLAB_SEED` | scenario facts |

## The simulated anchor

- `POST /auth` returns `{ "token": "..." }`. This **simulates the outcome of SEP-10**; it does not implement challenge signing. Use the token as `Authorization: Bearer <token>`.
- `POST /transactions/withdraw/interactive` returns `{ "type": "interactive_customer_info_needed", "url": "...", "id": "..." }`.
- `GET /transaction?id=<id>` returns the SEP-24 transaction record. A missing or expired token gets `403 {"type":"authentication_required"}`; a 5xx can be a transient fault.
- Every response carries `X-RailLab-Poll` (the number of this status request) and `X-RailLab-Request`. Echo the poll number in your events so RailLab can link what you decided to what you were served.

## Time

Virtual time advances by the scenario's `requestIntervalMs` on every request. Your own sleeps do not matter unless you report them: send `X-RailLab-Advance-Ms: <ms>` on your next request to say "I waited this long" (a backoff, for example). A run therefore does not depend on how fast your client or machine is.

## Events your client should POST to `RAILLAB_EVENTS_URL` (JSON)

| Event | When |
|---|---|
| `{"event":"status_applied","pollIndex":N,"txId":"...","status":"pending_anchor"}` | your client accepted this status as current |
| `{"event":"user_status","txId":"...","status":"pending"\|"completed"\|"failed"\|"unknown"}` | what the user was told |
| `{"event":"business_action","txId":"...","action":"send_payment_to_anchor","key":"pay-<txId>"}` | a side effect with business meaning; `key` names the effect so repeats can be seen |
| `{"event":"response_ignored","pollIndex":N,"reason":"..."}` | you saw a response and deliberately did not apply it |
| `{"event":"auth_refreshed"}`, `{"event":"gave_up","reason":"..."}` | informational |

If you report nothing, rules that depend on your decisions are **inconclusive**, never pass.

## Reading the results

Each rule is labelled **sep** (it follows from the SEP-24 text, with a link) or **policy** (a robustness choice that no standard requires; you may legitimately choose differently). A rule is `not_applicable` when the scenario never created the situation. Exit codes of `raillab test`: `0` pass, `1` a rule failed, `3` inconclusive, `4` your command could not run or timed out, `2` invalid input.

`independent client`: `test/fixtures/external-corrected.mjs` is a 60-line plain-JavaScript client with no RailLab imports that passes the baseline, outage, authentication, reordering and wrong-id scenarios. `test/fixtures/external-naive.mjs` announces completion early and is caught.
