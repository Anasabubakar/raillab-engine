# Scenarios

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
