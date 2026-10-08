# Contributing

```bash
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test && pnpm run check:schema
pnpm run schema     # after changing the scenario or session schema; commit the output
```

- Keep `src/engine` and `src/consumers` free of `node:` imports, `process`, `Date.now()` and `Math.random()`. A test enforces it; the engine must run in a browser and stay deterministic.
- A new rule needs: a label (`sep` with the SEP-24 text it rests on, or `policy` with the policy stated), a scenario that makes it applicable, a mutant that fails exactly it, and evidence strings a developer can act on.
- A new fault needs a scenario, a test for its exact effect on the timeline, and a statement of whether it depends on the seed.
- Never mark a rule `pass` when the consumer reported nothing: that is `inconclusive`.
- Simulated data must say it is simulated. No real banks, payments, accounts with keys, or network calls.
- One logical change per commit; AI-assisted changes are welcome if you understand and verified them.
