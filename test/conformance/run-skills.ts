/**
 * Runs one skills command in a child process. Global scope is found through the home directory,
 * which Bun reads once at startup, so a test that uses global scope sets HOME for this process.
 *
 * Usage: bun test/conformance/run-skills.ts <install|list> <cwd> [--global]
 */
import { installSkills, listSkills } from "#skills/index.ts";
import { loadWorkspace } from "#workspace.ts";

import { createFlags } from "./source-fixture.ts";

const [command, cwd = process.cwd(), ...rest] = process.argv.slice(2);

const workspace = await loadWorkspace(
  createFlags({ global: rest.includes("--global"), frozen: rest.includes("--frozen") }),
  cwd
);

await (command === "install"
  ? installSkills(workspace, { force: false })
  : listSkills(workspace, { json: true }));
