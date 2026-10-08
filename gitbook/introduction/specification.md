# Specification

## User
A wallet or anchor-integration developer whose client consumes SEP-24 withdrawal status, who wants to see how it behaves under delayed, repeated, reordered and failing responses before real users do.

## Supported scope (the documented SEP-24 subset)
Interactive **withdrawal** only. Endpoints: `GET /info`, `POST /auth` (simulated SEP-10 outcome), `POST /transactions/withdraw/interactive`, `GET /transaction`, `GET /transactions`. Status polling over the SEP-24 statuses. Faults: transient server errors, exact repeats, stale (reordered) snapshots, latency, token expiry (403 authentication_required) and mismatched transaction ids.

## Non-goals
- No deposits, no real SEP-10 challenge signing, no SEP-12/38/6, no webhooks, no callbacks, no KYC flow, no real or simulated Stellar network.
- Not a conformance test for anchors (Stellar Anchor Tests covers the other direction).
- Not a model of any particular anchor's behavior. The simulated bank, identifiers and payments are synthetic and say so in their messages.

## Model
**Scenario** (`scenario.v1.schema.json`): an anchor timeline of unique SEP-24 statuses by virtual time (with seeded jitter), a per-request interval, a list of faults, and a polling budget.

**Time**: virtual and discrete. Each consumer request advances time by `requestIntervalMs`, plus reported consumer sleep (`X-RailLab-Advance-Ms`, or `clock.sleep` for in-process consumers). Faults naming polls count `GET /transaction` requests 1-based. Probability faults draw from a per-fault seeded stream, so adding a fault never reshuffles another.

**Determinism**: the same scenario, seed and consumer behavior produce a byte-identical timeline (fingerprinted). The in-process and HTTP transports produce identical timelines for the same consumer.

**Session** (`session.v1.schema.json`): scenario, seed, consumer, timeline (anchor transitions, every request with its faults and what was served, every consumer event), assertion results and a verdict.

## Assertions
Eight rules, each labelled **sep** or **policy** with its basis (see `raillab rules`). Outcomes: pass, fail, not_applicable, inconclusive. A consumer that reports nothing yields inconclusive. Verdict: fail if any rule fails, else inconclusive if any is inconclusive, else pass.

| Rule | Kind |
|---|---|
| no-early-completion | sep |
| reauthenticates-on-403 | sep |
| ignores-mismatched-reference | sep |
| final-state-matches-anchor | policy |
| keeps-pending-until-terminal | policy |
| no-status-regression | policy |
| idempotent-business-actions | policy |
| retries-transient-errors | policy |

## Interfaces
Library (`@anas.abubakar/raillab-engine`, browser-safe): `ScenarioEngine`, `runSession`, `correctedConsumer`, `defectiveConsumer`, `MUTANTS`, assertions, schemas. Node (`/node`): HTTP server, external runner, CLI. CLI exit codes: 0 pass, 1 fail, 3 inconclusive, 4 consumer could not run or timed out, 2 invalid input.

## Safety
The server binds 127.0.0.1 only, limits bodies to 64 KiB, has a per-session request budget for runaway in-process consumers and a kill timeout for external ones. The control plane under `/__raillab` never advances time and validates every event.

## Acceptance criteria (each tested)
1. Same scenario and seed reproduce the identical timeline; a different seed changes probabilistic ones; named-poll faults ignore the seed.
2. The defective reference client announces completion early and fails the intended SEP rule.
3. The corrected client passes every applicable rule across all scenarios for twenty seeds.
4. Removing exactly one behavior from the corrected client fails the matching rule and no unrelated rule.
5. An independent plain-JS client, not written against RailLab's internals, passes; a naive one is caught.
6. In-process and HTTP runs have identical fingerprints.
7. A client that reports nothing is inconclusive, never a pass.
