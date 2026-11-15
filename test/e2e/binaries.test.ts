import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import packageJson from "../../package.json" with { type: "json" };

const run = promisify(execFile);
const Executable = process.env.ARC_TEST_EXECUTABLE;

test.skipIf(Executable === undefined).each(["agents", "agentsrc", "arc"])(
  "the release archive provides a working %s command",
  async (name) => {
    if (Executable === undefined) {
      throw new Error("This test needs ARC_TEST_EXECUTABLE to point at the extracted release.");
    }

    const extension = process.platform === "win32" ? ".exe" : "";
    const executable = path.resolve(path.dirname(Executable), `${name}${extension}`);
    const version = await run(executable, ["--version"]);
    const help = await run(executable, ["init", "--help"]);

    expect(version.stdout.trim()).toBe(`arc v${packageJson.version}`);
    expect(help.stdout).toContain("--skill");
  }
);
