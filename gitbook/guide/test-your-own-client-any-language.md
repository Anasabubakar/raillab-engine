# Test your own client (any language)

```bash
node dist/node/cli.js test stale-authentication --seed 3 -- node my-wallet.js
```

Your command gets `RAILLAB_BASE_URL` and `RAILLAB_EVENTS_URL`, talks plain HTTP and reports its decisions as JSON events. See [docs/CONSUMER-CONTRACT.md](https://github.com/Rail-L-b/raillab-engine/blob/main/docs/CONSUMER-CONTRACT.md). An independent 60-line plain-JavaScript client with no RailLab imports ([`test/fixtures/external-corrected.mjs`](https://github.com/Rail-L-b/raillab-engine/blob/main/test/fixtures/external-corrected.mjs)) passes five scenarios in the test suite; a naive one is caught.
