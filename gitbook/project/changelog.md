# Changelog

## 0.1.1
- The external-command runner now kills the consumer's whole process tree on timeout and bounds cleanup, so a surviving descendant can no longer hang a run. Package metadata and absolute documentation links.

## 0.1.0 (unreleased)
- Scenario engine for the SEP-24 withdrawal subset with a virtual clock and seeded fault scheduler.
- Faults: transient errors, repeats, stale snapshots, latency, token expiry, mismatched ids.
- Eight assertions labelled sep or policy; session and scenario JSON Schemas.
- Reference corrected and defective clients, plus one mutant per rule.
- Node HTTP server (loopback), external-command runner, CLI.
- Seven bundled scenarios; consumer contract documentation.
