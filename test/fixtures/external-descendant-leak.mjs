// Exits immediately but leaves a detached-from-event-loop descendant holding the output pipes open.
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }).unref();
console.log("done");
