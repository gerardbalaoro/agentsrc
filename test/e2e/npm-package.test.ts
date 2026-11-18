import { beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildCli, createSandbox } from "#test/support/cli.ts";
import { writeFiles } from "#test/support/temp.ts";
import { driveTerminal } from "#test/support/terminal.ts";

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
    // npm file specs are filesystem paths; a tilde catches accidental URL percent-encoding.
    const packed = path.join(sandbox.home, "package~fixture");
    await mkdir(packed);
    const npm = Bun.which(process.platform === "win32" ? "npm.cmd" : "npm");

    if (npm === null) {
      throw new Error("The npm package test needs npm on PATH.");
    }

    const command = process.platform === "win32" ? "node" : npm;

    const prefix =
      process.platform === "win32"
        ? [path.join(path.dirname(npm), "node_modules/npm/bin/npm-cli.js")]
        : [];

    await run(command, [...prefix, "pack", "--ignore-scripts", "--pack-destination", packed], {
      cwd: Root,
      env,
    });

    const files = await readdir(packed);
    const archives = files.filter((file) => file.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const [filename] = archives;

    if (filename === undefined) {
      throw new Error("npm pack created no package.");
    }

    const archive = path.join(packed, filename);
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
      [...npxPrefix, "--offline", "--yes", `file:${archive}`, "--version"],
      {
        cwd: sandbox.home,
        env,
      }
    );

    expect(npx.stdout.trim()).toBe(`arc v${packageJson.version}`);

    if (process.platform !== "win32") {
      await writeFiles(sandbox.project, {
        ".claude/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nAlpha.",
        ".mcp.json": '{"mcpServers":{"db":{"command":"db"}}}',
      });

      const result = await driveTerminal({
        command: [npxCommand, ...npxPrefix, "--offline", "--yes", `file:${archive}`, "ui"],
        cwd: sandbox.project,
        home: sandbox.home,
        mode: "batch",
        env,
      });

      expect(result.terminalRestored).toBe(true);
    }
  } finally {
    await rm(sandbox.home, { recursive: true, force: true });
  }
}, 30_000);
