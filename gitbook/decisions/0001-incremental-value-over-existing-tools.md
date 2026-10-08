# ADR 0001: What RailLab adds over existing Stellar tools

Status: accepted, 2026-10-07. Based on the README of each project read on that date; none was executed, and READMEs describe intent, not tested behavior.

## What the existing tools say they are
- **stellar/stellar-anchor-tests**: "a library and CLI tool for testing Stellar anchors", with a web UI. It tests an anchor server for SEP compliance. That is the opposite direction from RailLab, which simulates an anchor to test the **client** that consumes it.
- **stellar/anchor-platform**: a platform for deploying a SEP-compatible anchor service, with a Kotlin reference server. It is an anchor implementation intended to behave correctly, not a harness that injects delayed, repeated, reordered, failing or wrong-id responses on a schedule.
- **stellar/typescript-wallet-sdk**: a library for building wallets, with its own unit tests. A client built on it still has to handle the incident behaviors; the SDK repo does not provide a scenario server for them.

## The gap this fills (and does not claim beyond)
A deterministic, scriptable simulator of SEP-24 withdrawal *misbehavior* for consumer testing, with assertions that separate SEP requirements from application policy. The claim is narrow and checkable. Absence from three READMEs is not proof that no such tool exists, and wallet teams may have private harnesses.

## Decision
Build a small simulator that models only the SEP-24 withdrawal subset, runs with a virtual clock and a seeded fault scheduler, and works with any consumer over HTTP. Do not reimplement an anchor, SEP-10 or any real payment path. If Stellar Anchor Tests or the Wallet SDK later gain consumer-side fault scenarios, contribute the scenarios there.

## Consequences
- `POST /auth` simulates the outcome of SEP-10 only. Consumers that must exercise real challenge signing are out of scope.
- Everything about the bank is synthetic and labeled so.
- No wallet or anchor maintainer has reviewed the scenarios or the rule set. That validation is outstanding and tracked separately from engineering.
