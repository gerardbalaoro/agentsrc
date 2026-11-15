// Crust uses explicit resource management, which Node 20 does not provide yet.
import "core-js/actual/async-disposable-stack/index.js";
import { runCli } from "#cli.ts";

process.exitCode = await runCli(process.argv.slice(2));
