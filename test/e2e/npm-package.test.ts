import { beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildCli, createSandbox } from "#test/support/cli.ts";

import packageJson from "../../package.json" with { type: "json" };

const run = promisify(execFile);
const Root = path.resolve(import.meta.dirname, "../..");

beforeAll(buildCli);

test("the packed npm install provides working arc and agentsrc commands and supports npx", async () => {
  const sandbox = await createSandbox();

  const env = {
    ComSpec: process.env.ComSpec,
    HOME: sandbox.home,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    TEMP: sandbox.home,
    TMP: sandbox.home,
    USERPROFILE: sandbox.home,
    PATH: process.env.PATH,
    npm_config_cache: path.join(sandbox.home, ".npm-cache"),
  };

  try {
    const npm = Bun.which(process.platform === "win32" ? "npm.cmd" : "npm");

    if (npm === null) {
      throw new Error("The npm package test needs npm on PATH.");
    }

    const command = process.platform === "win32" ? "node" : npm;

    const prefix =
      process.platform === "win32"
        ? [path.join(path.dirname(npm), "node_modules/npm/bin/npm-cli.js")]
        : [];

    await run(
      command,
      [...prefix, "pack", "--ignore-scripts", "--pack-destination", sandbox.home],
      {
        cwd: Root,
        env,
      }
    );

    const files = await readdir(sandbox.home);
    const archives = files.filter((file) => file.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const [filename] = archives;

    if (filename === undefined) {
      throw new Error("npm pack created no package.");
    }

    const archive = path.join(sandbox.home, filename);
    await run(
      command,
      [
        ...prefix,
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
    expect(binaries.toSorted()).toEqual(
      process.platform === "win32"
        ? ["agentsrc", "agentsrc.cmd", "agentsrc.ps1", "arc", "arc.cmd", "arc.ps1"]
        : ["agentsrc", "arc"]
    );

    const outputs = await Promise.all(
      ["arc", "agentsrc"].map(async (name) => {
        const executable = path.join(bin, process.platform === "win32" ? `${name}.cmd` : name);
        const options = { cwd: sandbox.project, env, shell: process.platform === "win32" };
        const version = await run(executable, ["--version"], options);
        const help = await run(executable, ["init", "--help"], options);
        expect(help.stdout).toContain("--skill");

        return version.stdout.trim();
      })
    );

    expect(outputs).toEqual([`arc v${packageJson.version}`, `arc v${packageJson.version}`]);

    const npxCommand = process.platform === "win32" ? "node" : "npx";

    const npxPrefix =
      process.platform === "win32"
        ? [path.join(path.dirname(npm), "node_modules/npm/bin/npx-cli.js")]
        : [];

    const npx = await run(
      npxCommand,
      [...npxPrefix, "--offline", "--yes", pathToFileURL(archive).href, "--version"],
      {
        cwd: sandbox.home,
        env,
      }
    );

    expect(npx.stdout.trim()).toBe(`arc v${packageJson.version}`);
  } finally {
    await rm(sandbox.home, { recursive: true, force: true });
  }
}, 30_000);
