import { beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { buildCli, createSandbox } from "#test/support/cli.ts";
import { serveRegistry } from "#test/support/registry.ts";
import { readFileText } from "#test/support/temp.ts";

const Entry = path.resolve(import.meta.dirname, "../../dist/index.js");
const TerminalTest = test.skipIf(process.platform === "win32");

beforeAll(buildCli);

TerminalTest("a missing source can be entered interactively and keeps supplied flags", async () => {
  const result = await promptAdd(
    ["--name", "tracker", "-a", "claude-code"],
    [
      ["Server type", "\u001B[B\r"],
      ["Server URL", "https://example.test:${PORT}/mcp\r"],
    ]
  );

  expect(result.code).toBe(0);
  expect(await result.config()).toEqual({
    tracker: { type: "http", url: "https://example.test:${PORT}/mcp" },
  });
});

test.skipIf(process.platform === "win32").each([
  { source: ["npm:"], answers: [["npm package", "@example/tools-mcp@^1\r"]] },
  { source: ["--", "npm:@example/tools-mcp@^1"], answers: [] },
])("resolves the requested npm range with source $source", async ({ source, answers }) => {
  const registry = serveRegistry({
    "@example/tools-mcp": { latest: "2.0.0", versions: ["1.1.0", "2.0.0"] },
  });

  try {
    const result = await promptAdd(["-a", "claude-code", ...source], answers, {
      npm_config_registry: registry.url,
    });

    expect(result.code).toBe(0);
    expect(await result.config()).toEqual({
      tools: { args: ["-y", "@example/tools-mcp@1.1.0"], command: "npx" },
    });
  } finally {
    await registry.stop();
  }
});

TerminalTest(
  "a trailing separator asks for an executable and preserves argument boundaries",
  async () => {
    const result = await promptAdd(
      ["local-db", "-a", "claude-code", "--"],
      [
        ["Executable", "node\r"],
        ["Command arguments", '["./my server.js", "--port", "3000"]\r'],
      ]
    );

    expect(result.code).toBe(0);
    expect(await result.config()).toEqual({
      "local-db": { args: ["./my server.js", "--port", "3000"], command: "node" },
    });
  }
);

TerminalTest("a command without a name keeps its executable and arguments", async () => {
  const result = await promptAdd(
    ["-a", "claude-code", "--", "node", "./server.js"],
    [["Server name", "db\r"]]
  );

  expect(result.code).toBe(0);
  expect(await result.config()).toEqual({ db: { args: ["./server.js"], command: "node" } });
});

TerminalTest("a complete command installs without prompts in a terminal", async () => {
  const result = await promptAdd(
    ["db", "-a", "claude-code", "--", "node", "./server.js", "--", "x"],
    []
  );

  expect(result.code).toBe(0);
  expect(await result.config()).toEqual({
    db: { args: ["./server.js", "--", "x"], command: "node" },
  });
});

TerminalTest("a remote URL with no derived name asks only for a name", async () => {
  const result = await promptAdd(
    ["http://mcp", "-a", "claude-code"],
    [["Server name", "internal\r"]]
  );

  expect(result.code).toBe(0);
  expect(await result.config()).toEqual({ internal: { type: "http", url: "http://mcp" } });
});

TerminalTest("a malformed URL fails before asking for a server name", async () => {
  const result = await promptAdd(["https://[", "-a", "claude-code"], []);

  expect(result.code).toBe(2);
  expect(await result.manifest.exists()).toBe(false);
});

TerminalTest("an explicit URL after the separator stays a remote server", async () => {
  const result = await promptAdd(
    ["--name", "tracker", "-a", "claude-code", "--", "https://example.test/mcp"],
    []
  );

  expect(result.code).toBe(0);
  expect(await result.config()).toEqual({
    tracker: { type: "http", url: "https://example.test/mcp" },
  });
});

TerminalTest("cancelling after entering an executable leaves the manifest absent", async () => {
  const result = await promptAdd(
    ["local-db", "-a", "claude-code", "--"],
    [
      ["Executable", "node\r"],
      ["Command arguments", "\u0003"],
    ]
  );

  expect(result.code).toBe(0);
  expect(result.output).toContain("MCP add canceled.");
  expect(await result.manifest.exists()).toBe(false);
});

TerminalTest("--yes and CI skip prompts even with a terminal", async () => {
  const results = await Promise.all([promptAdd(["--yes"], []), promptAdd([], [], { CI: "1" })]);
  const manifestsExist = await Promise.all(results.map(({ manifest }) => manifest.exists()));

  expect(results.map(({ code }) => code)).toEqual([2, 2]);
  expect(manifestsExist).toEqual([false, false]);
});

test("a missing executable in a non-terminal fails before writing the manifest", async () => {
  const sandbox = await createSandbox();
  const result = await sandbox.agents(["mcp", "add", "local-db", "--"]);

  expect(result.code).toBe(2);
  expect(await Bun.file(path.join(sandbox.project, ".agents/agents.toml")).exists()).toBe(false);
});

async function promptAdd(
  args: string[],
  answers: readonly (readonly [string, string])[],
  env = {}
) {
  const sandbox = await createSandbox();
  const executable = process.env.ARC_TEST_EXECUTABLE;
  const command = executable ? [path.resolve(executable)] : ["node", Entry];
  const decoder = new TextDecoder();
  const pending = [...answers];
  let output = "";
  let offset = 0;

  const child = Bun.spawn([...command, "mcp", "add", ...args], {
    cwd: sandbox.project,
    env: { HOME: sandbox.home, PATH: process.env.PATH, TERM: "xterm", ...env },
    terminal: {
      cols: 100,
      rows: 24,
      data(terminal, bytes) {
        output += decoder.decode(bytes, { stream: true });
        const [next] = pending;

        if (next && stripVTControlCharacters(output.slice(offset)).includes(next[0])) {
          offset = output.length;
          pending.shift();
          terminal.write(next[1]);
        }
      },
    },
    timeout: 5000,
    killSignal: "SIGKILL",
  });

  const code = await child.exited;
  child.terminal?.close();
  expect(pending, stripVTControlCharacters(output)).toHaveLength(0);

  return {
    code,
    output: stripVTControlCharacters(output),
    config: async () => JSON.parse(await readFileText(sandbox.project, ".mcp.json")).mcpServers,
    manifest: Bun.file(path.join(sandbox.project, ".agents/agents.toml")),
  };
}
