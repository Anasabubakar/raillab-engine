import { chmodSync, existsSync } from "node:fs";
const cli = "dist/node/cli.js";
if (existsSync(cli)) chmodSync(cli, 0o755);
