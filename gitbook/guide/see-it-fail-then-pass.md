# See it fail, then pass

```bash
git clone https://github.com/Rail-L-b/raillab-engine.git && cd raillab-engine
pnpm install --frozen-lockfile && pnpm build

node dist/node/cli.js run baseline-withdrawal --consumer defective     # exit 1
node dist/node/cli.js run baseline-withdrawal --consumer corrected     # exit 0
```

The defective reference client tells the user "completed" while the anchor is still at `pending_anchor` (SEP-24: only `completed` means done; `pending_external` is submitted but unconfirmed). The corrected client keeps the pending state until the anchor says `completed`, and when the bank payout outlasts its polling budget (`delayed-payout`) it ends **unknown**, not completed and not failed.

```text
FAIL  [sep] Does not tell the user the withdrawal is complete before the anchor says completed
        At 70000 ms the user was told "completed" while the anchor status was "pending_anchor".
```
