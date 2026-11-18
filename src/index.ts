// Keep explicit resource management available across supported Node versions.
import "core-js/actual/async-disposable-stack/index.js";
import { runCli } from "#cli.ts";

process.exitCode = await runCli(process.argv.slice(2));
