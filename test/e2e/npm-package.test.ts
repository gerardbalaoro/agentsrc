import { beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildCli, createSandbox } from "#test/support/cli.ts";

import packageJson from "../../package.json" with { type: "json" };

const run = promisify(execFile);
const Root = path.resolve(import.meta.dirname, "../..");

beforeAll(buildCli);

test("the packed npm install provides working arc and agentsrc commands and supports npx", async () => {
  const sandbox = await createSandbox();

  const env = {
    HOME: sandbox.home,
    PATH: process.env.PATH,
    npm_config_cache: path.join(sandbox.home, ".npm-cache"),
  };

  try {
    await run("npm", ["pack", "--ignore-scripts", "--pack-destination", sandbox.home], {
      cwd: Root,
      env,
    });

    const files = await readdir(sandbox.home);
    const archives = files.filter((file) => file.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const [filename] = archives;

    if (filename === undefined) {
      throw new Error("npm pack created no package.");
    }

    const archive = path.join(sandbox.home, filename);
    await run(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        sandbox.project,
        archive,
      ],
      { env }
    );
    const bin = path.join(sandbox.project, "node_modules/.bin");
    const binaries = await readdir(bin);
    expect(binaries.toSorted()).toEqual(["agentsrc", "arc"]);

    const outputs = await Promise.all(
      ["arc", "agentsrc"].map(async (name) => {
        const executable = path.join(bin, name);
        const version = await run(executable, ["--version"], { cwd: sandbox.project, env });
        const help = await run(executable, ["init", "--help"], { cwd: sandbox.project, env });
        expect(help.stdout).toContain("--skill");

        return version.stdout.trim();
      })
    );

    expect(outputs).toEqual([`arc v${packageJson.version}`, `arc v${packageJson.version}`]);

    const npx = await run("npx", ["--offline", "--yes", `file:${archive}`, "--version"], {
      cwd: sandbox.home,
      env,
    });

    expect(npx.stdout.trim()).toBe(`arc v${packageJson.version}`);
  } finally {
    await rm(sandbox.home, { recursive: true, force: true });
  }
}, 30_000);
