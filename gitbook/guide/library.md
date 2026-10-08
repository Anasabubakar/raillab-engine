# Library

`@anas.abubakar/raillab-engine` is browser-safe (no `node:` imports, enforced by a test): `ScenarioEngine`, `runSession`, `correctedConsumer`, `defectiveConsumer`, `MUTANTS`, assertions, `parseScenario`, `parseSession`. The `/node` export adds the HTTP server and the external-command runner. JSON Schemas for scenarios and sessions are in [`schema/`](https://github.com/Rail-L-b/raillab-engine/blob/main/schema). [raillab-workbench](https://github.com/Rail-L-b/raillab-workbench) runs this same engine and the same reference clients in the browser.
