import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, lstat } from "node:fs/promises";
import path from "node:path";

import { buildCli, createSandbox } from "#test/support/cli.ts";
import type { Sandbox } from "#test/support/cli.ts";
import { serveRegistry } from "#test/support/registry.ts";
import { readFileText, writeFiles } from "#test/support/temp.ts";

const registry = serveRegistry({
  "@upstash/context7-mcp": { latest: "2.0.0", versions: ["1.0.0", "1.2.0", "2.0.0"] },
});

const env = { npm_config_registry: registry.url };

const Manifest = `agents = ["claude-code", "codex", "opencode"]

[mcp.context7]
package = "npm:@upstash/context7-mcp"
version = "^1"
env = { CONTEXT7_API_KEY = "\${CONTEXT7_API_KEY}" }

[mcp.linear]
url = "https://mcp.linear.app/mcp"
headers = { Authorization = "Bearer \${LINEAR_TOKEN}" }

[mcp.local-db]
command = "node"
args = ["./tools/db-mcp.js"]
`;

beforeAll(async () => {
  await buildCli();
});

afterAll(async () => {
  await registry.stop();
});

async function createProject(manifest = Manifest) {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, { ".agents/agents.toml": manifest });

  return sandbox;
}

test("install renders every server into every harness in its own format", async () => {
  const sandbox = await createProject();

  const result = await sandbox.agents(["mcp", "install"], env);

  expect(result.code).toBe(0);
  expect(JSON.parse(await readFileText(sandbox.project, ".mcp.json"))).toEqual({
    mcpServers: {
      context7: {
        args: ["-y", "@upstash/context7-mcp@1.2.0"],
        command: "npx",
        env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
      },
      linear: {
        headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
        type: "http",
        url: "https://mcp.linear.app/mcp",
      },
      "local-db": { args: ["./tools/db-mcp.js"], command: "node" },
    },
  });
  expect(await readFileText(sandbox.project, ".codex/config.toml")).toBe(
    `[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp@1.2.0"]
env_vars = ["CONTEXT7_API_KEY"]

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token_env_var = "LINEAR_TOKEN"

[mcp_servers.local-db]
command = "node"
args = ["./tools/db-mcp.js"]
`
  );
  expect(JSON.parse(await readFileText(sandbox.project, "opencode.json"))).toEqual({
    mcp: {
      servers: {
        context7: {
          command: ["npx", "-y", "@upstash/context7-mcp@1.2.0"],
          environment: { CONTEXT7_API_KEY: "{env:CONTEXT7_API_KEY}" },
          type: "local",
        },
        linear: {
          headers: { Authorization: "Bearer {env:LINEAR_TOKEN}" },
          type: "remote",
          url: "https://mcp.linear.app/mcp",
        },
        "local-db": { command: ["node", "./tools/db-mcp.js"], type: "local" },
      },
    },
  });
});

test("the lock pins the package version and holds no harness data", async () => {
  const sandbox = await createProject();

  await sandbox.agents(["mcp", "install"], env);

  const lock = JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock"));
  expect(lock.mcp.context7).toEqual({
    hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    package: "npm:@upstash/context7-mcp",
    version: "1.2.0",
  });
  expect(Object.keys(lock.mcp)).toEqual(["context7", "linear", "local-db"]);
  expect(Object.keys(lock.mcp.linear)).toEqual(["hash"]);
});

test("a second install changes nothing, and keeps the pinned version when a newer one appears", async () => {
  const sandbox = await createProject();
  await sandbox.agents(["mcp", "install"], env);
  const before = await readFileText(sandbox.project, ".mcp.json");

  const moving = serveRegistry({
    "@upstash/context7-mcp": { latest: "1.9.0", versions: ["1.2.0", "1.9.0"] },
  });

  const result = await sandbox.agents(["mcp", "install"], { npm_config_registry: moving.url });

  expect(result.stderr).toContain("up to date");
  expect(await readFileText(sandbox.project, ".mcp.json")).toBe(before);

  const updated = await sandbox.agents(["mcp", "update"], { npm_config_registry: moving.url });
  await moving.stop();
  expect(updated.code).toBe(0);
  expect(await readFileText(sandbox.project, ".mcp.json")).toContain("@upstash/context7-mcp@1.9.0");
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toBe(Manifest);
});

test("a hand-edited server is reported, fails a frozen run, and is restored by install", async () => {
  const sandbox = await createProject();
  await sandbox.agents(["mcp", "install"], env);
  const original = await readFileText(sandbox.project, ".mcp.json");
  await writeFiles(sandbox.project, { ".mcp.json": original.replace('"node"', '"deno"') });

  const listed = await sandbox.agents(["mcp", "list", "--json"], env);
  const rows = JSON.parse(listed.stdout);
  expect(rows.find((row: { name: string }) => row.name === "local-db").status).toBe("modified");
  expect(rows.find((row: { name: string }) => row.name === "linear").status).toBe("ok");

  const frozen = await sandbox.agents(["sync", "--frozen-lockfile"], env);
  expect(frozen.code).toBe(1);
  expect(await readFileText(sandbox.project, ".mcp.json")).toContain('"deno"');

  const restored = await sandbox.agents(["mcp", "install"], env);
  expect(restored.code).toBe(0);
  expect(await readFileText(sandbox.project, ".mcp.json")).toBe(original);
});

test("CI makes install frozen by default, and --no-frozen-lockfile turns that off", async () => {
  const sandbox = await createProject();

  const frozen = await sandbox.agents(["mcp", "install"], { ...env, CI: "true" });
  expect(frozen.code).toBe(1);
  expect(frozen.stderr).toContain("frozen");

  const normal = await sandbox.agents(["mcp", "install", "--no-frozen-lockfile"], {
    ...env,
    CI: "true",
  });

  expect(normal.code).toBe(0);
});

test("a harness that leaves `agents` loses its managed servers, and other servers stay", async () => {
  const sandbox = await createProject();
  await writeFiles(sandbox.project, {
    ".codex/config.toml": `[mcp_servers.mine]\ncommand = "mine"\n`,
  });
  await sandbox.agents(["mcp", "install"], env);
  await writeFiles(sandbox.project, {
    ".agents/agents.toml": Manifest.replace('"claude-code", "codex", "opencode"', '"claude-code"'),
  });

  const result = await sandbox.agents(["mcp", "install"], env);

  expect(result.code).toBe(0);
  expect(await readFileText(sandbox.project, ".codex/config.toml")).toBe(
    `[mcp_servers.mine]\ncommand = "mine"\n`
  );
  expect(
    JSON.parse(await readFileText(sandbox.project, "opencode.json")).mcp?.servers ?? {}
  ).toEqual({});
  expect(await readFileText(sandbox.project, ".mcp.json")).toContain("local-db");
});

test("a server that one harness cannot express stops the command before any file is written", async () => {
  const sandbox = await createProject(
    `agents = ["claude-code", "codex"]\n\n[mcp.events]\nurl = "https://x.test/sse"\ntransport = "sse"\n`
  );

  const result = await sandbox.agents(["mcp", "install"], env);

  await expect(result.code).toBe(1);
  expect(result.stderr).toContain("codex cannot express the MCP server events");
  await expect(readFileText(sandbox.project, ".mcp.json")).rejects.toThrow("ENOENT");
});

test("a server that the user wrote under the same name is not replaced without --force", async () => {
  const sandbox = await createProject(`agents = ["claude-code"]\n\n[mcp.db]\ncommand = "node"\n`);
  const own = `{ "mcpServers": { "db": { "command": "my-own-db" } } }\n`;
  await writeFiles(sandbox.project, { ".mcp.json": own });

  const refused = await sandbox.agents(["mcp", "install"], env);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("claude-code: db");
  expect(await readFileText(sandbox.project, ".mcp.json")).toBe(own);

  const forced = await sandbox.agents(["mcp", "install", "--force"], env);
  expect(forced.code).toBe(0);
  expect(JSON.parse(await readFileText(sandbox.project, ".mcp.json")).mcpServers.db).toEqual({
    command: "node",
  });
});

test("add writes the manifest entry and installs it; remove undoes both", async () => {
  const sandbox = await createProject(`agents = ["claude-code"]\n`);

  const added = await sandbox.agents(
    ["mcp", "add", "local-db", "-e", "MODE=fast", "--", "node", "./db.js", "--port", "1"],
    env
  );

  expect(added.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toBe(
    `agents = ["claude-code"]\n\n[mcp.local-db]\ncommand = "node"\nargs = ["./db.js", "--port", "1"]\nenv = {MODE = "fast"}\n`
  );
  expect(
    JSON.parse(await readFileText(sandbox.project, ".mcp.json")).mcpServers["local-db"]
  ).toEqual({
    args: ["./db.js", "--port", "1"],
    command: "node",
    env: { MODE: "fast" },
  });

  const again = await sandbox.agents(["mcp", "add", "local-db", "--", "other"], env);
  expect(again.code).toBe(2);

  const removed = await sandbox.agents(["mcp", "rm", "local-db"], env);
  expect(removed.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toBe(
    `agents = ["claude-code"]\n`
  );
  expect(JSON.parse(await readFileText(sandbox.project, ".mcp.json")).mcpServers).toEqual({});
  expect(JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock")).mcp).toEqual({});
});

test("removing an inherited server writes false and uninstalls it", async () => {
  const sandbox = await createProject(`extends = ["./base.toml"]\nagents = ["claude-code"]\n`);
  await writeFiles(sandbox.project, {
    ".agents/base.toml": `[mcp.linear]\nurl = "https://mcp.linear.app/mcp"\n`,
  });
  await sandbox.agents(["mcp", "install"], env);

  const removed = await sandbox.agents(["mcp", "remove", "linear"], env);

  expect(removed.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toContain("linear = false");
  expect(await readFileText(sandbox.project, ".agents/base.toml")).toContain("[mcp.linear]");
  expect(JSON.parse(await readFileText(sandbox.project, ".mcp.json")).mcpServers).toEqual({});
});

test("with no `agents` and no harness on the machine, nothing is installed and a warning says why", async () => {
  const sandbox = await createProject(`[mcp.db]\ncommand = "node"\n`);

  const result = await sandbox.agents(["mcp", "install"], env);

  await expect(result.code).toBe(0);
  expect(result.stderr).toContain("none was detected");
  await expect(readFileText(sandbox.project, ".mcp.json")).rejects.toThrow("ENOENT");
});

test("a detected harness is the target when `agents` is unset", async () => {
  const sandbox = await createSandbox([".claude"]);
  await writeFiles(sandbox.project, { ".agents/agents.toml": `[mcp.db]\ncommand = "node"\n` });

  await sandbox.agents(["mcp", "install"], env);

  await expect(JSON.parse(await readFileText(sandbox.project, ".mcp.json")).mcpServers.db).toEqual({
    command: "node",
  });
  await expect(readFileText(sandbox.project, ".codex/config.toml")).rejects.toThrow("ENOENT");
});

test("--dry-run prints the plan and writes nothing", async () => {
  const sandbox = await createProject();

  const result = await sandbox.agents(["mcp", "install", "--dry-run"], env);

  await expect(result.code).toBe(0);
  expect(result.stderr).toContain("claude-code: write linear (missing)");
  await expect(readFileText(sandbox.project, ".mcp.json")).rejects.toThrow("ENOENT");
  await expect(readFileText(sandbox.project, ".agents/agents.lock")).rejects.toThrow("ENOENT");
});

test.each([
  ["an unknown flag", ["mcp", "install", "--nope"], Manifest],
  ["an unknown command", ["mcp", "frobnicate"], Manifest],
  ["an unknown harness in --agent", ["mcp", "install", "-a", "cursor"], Manifest],
  ["a manifest with an unknown key", ["mcp", "install"], `agnets = ["codex"]\n`],
  [
    "a malformed reference",
    ["mcp", "install"],
    `agents = ["codex"]\n[mcp.x]\ncommand = "x"\nargs = ["\${not valid}"]\n`,
  ],
])("%s exits with code 2", async (_case, args, manifest) => {
  const sandbox = await createProject(manifest);

  const result = await sandbox.agents(args, env);

  expect(result.code).toBe(2);
});

test("matching unmanaged servers still require force before adoption", async () => {
  const sandbox = await createProject('agents = ["claude-code"]\n[mcp.demo]\ncommand = "demo"\n');
  const config = '{"mcpServers":{"demo":{"command":"demo"}}}\n';
  await writeFiles(sandbox.project, { ".mcp.json": config });
  const result = await sandbox.agents(["mcp", "install"]);
  expect(result.code).toBe(1);
  expect(await readFileText(sandbox.project, ".mcp.json")).toBe(config);
});

test("limited removal retains ownership until excluded harnesses are cleaned up", async () => {
  const sandbox = await createProject(
    'agents = ["claude-code", "codex"]\n[mcp.demo]\ncommand = "demo"\n'
  );

  const installed = await sandbox.agents(["mcp", "install"]);
  expect(installed.code).toBe(0);
  const limited = await sandbox.agents(["mcp", "remove", "demo", "-a", "claude-code"]);
  expect(limited.code).toBe(0);
  expect(JSON.parse(await readFileText(sandbox.project, ".mcp.json")).mcpServers).toEqual({});
  const pending = JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock"));
  expect(pending.mcp.demo).toBeDefined();
  expect(await readFileText(sandbox.project, ".codex/config.toml")).toContain("demo");
  const cleaned = await sandbox.agents(["mcp", "install"]);
  expect(cleaned.code).toBe(0);
  expect(await readFileText(sandbox.project, ".codex/config.toml")).not.toContain("demo");
  expect(
    JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock")).mcp.demo
  ).toBeUndefined();
});

test("list reports unsupported targets and continues with supported and untracked servers", async () => {
  const sandbox = await createProject(`agents = ["claude-code", "codex"]
[mcp.incompatible]
command = "db"
env = { TOKEN = "\${DB_TOKEN}" }
[mcp.supported]
command = "db"
`);

  await writeFiles(sandbox.project, {
    ".mcp.json": '{"mcpServers":{"foreign":{"command":"mine"}}}',
  });
  const original = await readFileText(sandbox.project, ".mcp.json");
  const listed = await sandbox.agents(["mcp", "list", "--json"]);
  expect(listed.code).toBe(0);
  const rows = JSON.parse(listed.stdout);
  expect(rows.find((row: { name: string }) => row.name === "supported").status).toBe("missing");
  expect(rows.find((row: { name: string }) => row.name === "foreign").status).toBe("untracked");
  const unsupported = rows.find((row: { name: string }) => row.name === "incompatible");
  expect(unsupported.status).toBe("unsupported");
  expect(unsupported.issues).toEqual([
    { harness: "codex", message: expect.stringContaining("cannot express") },
  ]);
  const human = await sandbox.agents(["mcp", "list"]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("unsupported");
  expect(human.stdout).toContain("codex cannot express");
  expect(human.stdout).toContain("supported");
  const installed = await sandbox.agents(["mcp", "install"]);
  expect(installed.code).toBe(1);
  expect(await readFileText(sandbox.project, ".mcp.json")).toBe(original);
});

async function stub(sandbox: Sandbox, name: string, body: string) {
  await writeFiles(sandbox.home, { [`bin/${name}`]: `#!/usr/bin/env node\n${body}\n` });
  await chmod(path.join(sandbox.home, "bin", name), 0o755);

  return { PATH: `${path.join(sandbox.home, "bin")}:${process.env.PATH ?? ""}` };
}

test("old excluded OpenCode is never probed; selected old OpenCode fails before any harness write", async () => {
  const sandbox = await createProject('agents = ["claude-code"]\n[mcp.db]\ncommand = "db"\n');

  const cliEnv = await stub(
    sandbox,
    "opencode",
    'require("node:fs").writeFileSync(process.env.HOME + "/probed", "yes"); console.log("1.4.0");'
  );

  const installed = await sandbox.agents(["mcp", "install"], cliEnv);
  expect(installed.code).toBe(0);
  await expect(lstat(path.join(sandbox.home, "probed"))).rejects.toThrow();
  const before = await readFileText(sandbox.project, ".mcp.json");
  await writeFiles(sandbox.project, {
    ".agents/agents.toml": 'agents = ["claude-code", "opencode"]\n[mcp.db]\ncommand = "changed"\n',
  });
  const dry = await sandbox.agents(["mcp", "install", "--dry-run"], cliEnv);
  expect(dry.code).toBe(0);
  await expect(lstat(path.join(sandbox.home, "probed"))).rejects.toThrow();
  const failed = await sandbox.agents(["mcp", "install"], cliEnv);
  expect(failed.code).toBe(1);
  expect(await readFileText(sandbox.project, ".mcp.json")).toBe(before);
  const listed = await sandbox.agents(["mcp", "list"], cliEnv);
  expect(listed.code).toBe(0);
});

test("failed MCP additions preserve the manifest for clashes and inexpressible entries", async () => {
  const sandbox = await createProject('agents = ["claude-code"]\n');
  await writeFiles(sandbox.project, { ".mcp.json": '{"mcpServers":{"db":{"command":"foreign"}}}' });
  const before = await readFileText(sandbox.project, ".agents/agents.toml");
  const failed = await sandbox.agents(["mcp", "add", "db", "--", "db"]);
  expect(failed.code).toBe(1);
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toBe(before);

  const unsupported = await sandbox.agents([
    "mcp",
    "add",
    "https://example.com/sse",
    "--transport",
    "sse",
    "-a",
    "codex",
  ]);

  expect(unsupported.code).toBe(1);
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toBe(before);
});

test("Claude global writes delimit names and verify the CLI actually stored the server", async () => {
  const sandbox = await createSandbox();

  const cliEnv = await stub(
    sandbox,
    "claude",
    'require("node:fs").appendFileSync(process.env.HOME + "/argv.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");'
  );

  await writeFiles(sandbox.home, {
    ".agents/agents.toml": 'agents = ["claude-code"]\n[mcp."--help"]\ncommand = "db"\n',
  });
  const result = await sandbox.agents(["mcp", "install", "-g"], cliEnv);
  expect(result.code).toBe(1);
  const calls = await readFileText(sandbox.home, "argv.jsonl");
  expect(JSON.parse(calls.trim())).toEqual([
    "mcp",
    "add-json",
    "--scope",
    "user",
    "--",
    "--help",
    '{"command":"db"}',
  ]);
  expect(result.stderr).toContain("did not");
});

test("an apply failure removes a newly created manifest", async () => {
  const sandbox = await createSandbox();

  const cliEnv = await stub(
    sandbox,
    "claude",
    "// Exit successfully without installing the requested server."
  );

  const failed = await sandbox.agents(
    ["mcp", "add", "db", "-g", "-a", "claude-code", "--", "db"],
    cliEnv
  );

  expect(failed.code).toBe(1);
  await expect(lstat(path.join(sandbox.home, ".agents/agents.toml"))).rejects.toThrow();
});

test("Claude validates names per adapter while Codex keeps dotted names", async () => {
  const sandbox = await createProject('agents = ["codex"]\n[mcp."db.main"]\ncommand = "db"\n');
  const codex = await sandbox.agents(["mcp", "install"]);
  expect(codex.code).toBe(0);
  await writeFiles(sandbox.project, {
    ".agents/agents.toml": 'agents = ["claude-code"]\n[mcp."db.main"]\ncommand = "db"\n',
  });
  const claude = await sandbox.agents(["mcp", "install"]);
  expect(claude.code).toBe(1);
  await expect(lstat(path.join(sandbox.project, ".mcp.json"))).rejects.toThrow();
});

test("global Claude removal passes option-like names after the delimiter", async () => {
  const sandbox = await createSandbox();

  const cliEnv = await stub(
    sandbox,
    "claude",
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + "/argv.jsonl", JSON.stringify(args) + "\\n");
const file = process.env.HOME + "/.claude.json";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
delete config.mcpServers[args[5]];
fs.writeFileSync(file, JSON.stringify(config));
`
  );

  await writeFiles(sandbox.home, {
    ".agents/agents.toml": 'agents = ["claude-code"]\n[mcp."--help"]\ncommand = "db"\n',
    ".agents/agents.lock": '{"version":1,"mcp":{"--help":{"hash":"old"}}}',
    ".claude.json": '{"mcpServers":{"--help":{"command":"db"}}}',
  });
  const removed = await sandbox.agents(["mcp", "remove", "--global", "--", "--help"], cliEnv);
  expect(removed.code).toBe(0);
  const calls = await readFileText(sandbox.home, "argv.jsonl");
  expect(JSON.parse(calls.trim())).toEqual(["mcp", "remove", "--scope", "user", "--", "--help"]);
  expect(JSON.parse(await readFileText(sandbox.home, ".claude.json")).mcpServers).toEqual({});
});
