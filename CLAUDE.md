# raillab-engine: working notes

Commands: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm test`, `pnpm run build`, `pnpm run schema` / `check:schema`, `pnpm run pack:artifact` (writes artifacts/*.tgz for the workbench).
Constraints: `src/engine` + `src/consumers` are browser-safe and deterministic (no node:, process, Date.now, Math.random); scripts run with `--experimental-strip-types` so no parameter properties or enums in code they import; simulated data is always labelled simulated; no AI co-author trailers.
Unfinished: GitHub publishing and CI run, npm publish, tagged release, maintainer review of the rules.
