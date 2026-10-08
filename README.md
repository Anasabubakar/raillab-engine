# raillab-engine

Make the anchor fail in the lab before the wallet fails for a user.

RailLab is a deterministic simulator of a SEP-24 **withdrawal** anchor for testing the **consumer** (a wallet or integration). It serves a documented subset of the SEP-24 API with a controllable virtual clock and a seeded fault scheduler, runs your client against delayed, repeated, reordered and failing responses, stale authentication and mismatched transaction ids, and checks what your client did against eight rules. Each rule is labelled **sep** (it follows from the SEP-24 text) or **policy** (a robustness choice no standard requires), so you can tell a bug from a preference.

The same scenario and seed always produce the identical timeline. The anchor, its bank, every identifier and every payment are **simulated**; nothing touches a real anchor, bank or the Stellar network.

## See it fail, then pass

```bash
git clone https://github.com/Anasabubakar/raillab-engine.git && cd raillab-engine
pnpm install --frozen-lockfile && pnpm build

node dist/node/cli.js run baseline-withdrawal --consumer defective     # exit 1
node dist/node/cli.js run baseline-withdrawal --consumer corrected     # exit 0
```

The defective reference client tells the user "completed" while the anchor is still at `pending_anchor` (SEP-24: only `completed` means done; `pending_external` is submitted but unconfirmed). The corrected client keeps the pending state until the anchor says `completed`, and when the bank payout outlasts its polling budget (`delayed-payout`) it ends **unknown**, not completed and not failed.

```text
FAIL  [sep] Does not tell the user the withdrawal is complete before the anchor says completed
        At 70000 ms the user was told "completed" while the anchor status was "pending_anchor".
```

## Test your own client (any language)

```bash
node dist/node/cli.js test stale-authentication --seed 3 -- node my-wallet.js
```

Your command gets `RAILLAB_BASE_URL` and `RAILLAB_EVENTS_URL`, talks plain HTTP and reports its decisions as JSON events. See [docs/CONSUMER-CONTRACT.md](https://github.com/Anasabubakar/raillab-engine/blob/main/docs/CONSUMER-CONTRACT.md). An independent 60-line plain-JavaScript client with no RailLab imports ([`test/fixtures/external-corrected.mjs`](https://github.com/Anasabubakar/raillab-engine/blob/main/test/fixtures/external-corrected.mjs)) passes five scenarios in the test suite; a naive one is caught.

## Scenarios

| Name | What happens |
|---|---|
| `baseline-withdrawal` | No faults; progresses to completed |
| `delayed-payout` | Bank confirmation takes hours; the polling budget ends first |
| `reordered-and-repeated` | Two older snapshots arrive after newer ones, one exact repeat |
| `transient-outage` | The status endpoint returns 503 three times |
| `stale-authentication` | The token expires; 403 `authentication_required` |
| `mismatched-reference` | Responses carry another transaction's id |
| `everything-at-once` | Seeded probabilistic mix of every fault, with jitter |

`raillab list`, `raillab rules`, `raillab validate <file>`, `raillab run`, `raillab test`, `raillab serve`. Exit codes: 0 pass, 1 a rule failed, 3 inconclusive, 4 your command could not run or timed out, 2 invalid input.

## Mutants: each rule has a client that breaks exactly it

`MUTANTS` is the corrected client with one behavior removed (no re-authentication, no id check, no retry, no monotonic ordering, no idempotency, lax completion). The tests assert each fails the matching rule and no unrelated one, so the assertions are themselves tested against clients that are wrong in known ways.

## Library

`@anas.abubakar/raillab-engine` is browser-safe (no `node:` imports, enforced by a test): `ScenarioEngine`, `runSession`, `correctedConsumer`, `defectiveConsumer`, `MUTANTS`, assertions, `parseScenario`, `parseSession`. The `/node` export adds the HTTP server and the external-command runner. JSON Schemas for scenarios and sessions are in [`schema/`](https://github.com/Anasabubakar/raillab-engine/blob/main/schema). [raillab-workbench](https://github.com/Anasabubakar/raillab-workbench) runs this same engine and the same reference clients in the browser.

## Supported scope and limits

SEP-24 interactive withdrawal only (see [SPEC.md](https://github.com/Anasabubakar/raillab-engine/blob/main/SPEC.md)). `POST /auth` simulates the *outcome* of SEP-10 with an opaque token; it does not implement challenge signing. Not a conformance test for anchors. Faults model response behavior, not network-level conditions. Virtual time advances per request ([ADR 0002](https://github.com/Anasabubakar/raillab-engine/blob/main/docs/adr/0002-virtual-time-per-request.md)); a client is judged on request counts unless it reports its sleeps.

## Verification

```bash
pnpm run typecheck && pnpm test          # 160 tests, deterministic, no external network
```

Supported: Node 22+ (developed on 24.19), TypeScript 7.0.2, zod 4.6.5.

## Status

Engineering complete for the declared version-one scope. Published on GitHub (CI green) and npm. No wallet or anchor maintainer has reviewed the scenarios or the rules. MIT licensed.
