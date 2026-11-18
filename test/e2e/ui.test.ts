import { beforeAll, expect, test } from "bun:test";
import path from "node:path";

import { buildCli, createSandbox } from "#test/support/cli.ts";
import { writeFiles } from "#test/support/temp.ts";
import { driveTerminal } from "#test/support/terminal.ts";

const Entry = path.resolve(import.meta.dirname, "../../dist/index.js");

beforeAll(buildCli);

test("ui requires a terminal and prints help without starting a session", async () => {
  const sandbox = await createSandbox();
  const help = await sandbox.agents(["ui", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("--global");
  const result = await sandbox.agents(["ui"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("interactive terminal");
  expect(await Bun.file(path.join(sandbox.project, ".agents/agents.toml")).exists()).toBe(false);
});

for (const mode of ["batch", "scope", "ctrlc", "global"] as const) {
  test.skipIf(process.platform === "win32")(
    `real terminal ${mode} restores terminal state`,
    async () => {
      const sandbox = await createSandbox();
      await writeFiles(sandbox.project, {
        ".claude/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nAlpha.",
        ".mcp.json": '{"mcpServers":{"db":{"command":"db"}}}',
      });
      await writeFiles(sandbox.home, {
        ".agents/skills/global-style/SKILL.md":
          "---\nname: global-style\ndescription: Global\n---\nGlobal.",
      });

      const command = process.env.ARC_TEST_EXECUTABLE
        ? [path.resolve(process.env.ARC_TEST_EXECUTABLE), "ui"]
        : ["node", Entry, "ui"];

      if (mode === "global") {
        command.push("-g");
      }

      const result = await driveTerminal({
        command,
        cwd: sandbox.project,
        home: sandbox.home,
        mode,
      });

      expect(result).toEqual({
        exit: 0,
        alternateScreenEntered: true,
        alternateScreenRestored: true,
        cursorRestored: true,
        terminalRestored: true,
      });
    },
    30_000
  );
}

test.skipIf(process.platform === "win32")("NO_COLOR keeps the TUI monochrome", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, {
    ".claude/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nAlpha.",
  });

  const command = process.env.ARC_TEST_EXECUTABLE
    ? [path.resolve(process.env.ARC_TEST_EXECUTABLE), "ui"]
    : ["node", Entry, "ui"];

  await driveTerminal({
    command,
    cwd: sandbox.project,
    home: sandbox.home,
    mode: "ctrlc",
    env: { NO_COLOR: "1" },
  });
});

test.skipIf(process.platform === "win32")(
  "the PTY driver rejects a terminal left in raw mode",
  async () => {
    const sandbox = await createSandbox();
    await writeFiles(sandbox.project, {
      ".claude/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nAlpha.",
    });

    const command = process.env.ARC_TEST_EXECUTABLE
      ? [path.resolve(process.env.ARC_TEST_EXECUTABLE), "ui"]
      : ["node", Entry, "ui"];

    await expect(
      driveTerminal({
        command,
        cwd: sandbox.project,
        home: sandbox.home,
        mode: "ctrlc",
        afterExit(terminal) {
          terminal.setRawMode(true);
        },
      })
    ).rejects.toThrow("PTY state changed");
  }
);
