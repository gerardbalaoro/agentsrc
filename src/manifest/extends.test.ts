import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";

import { resolveLayers } from "#manifest/extends.ts";
import { mergeLayers } from "#manifest/merge.ts";
import { createTempDir, writeFiles } from "#test/support/temp.ts";

const remote = { text: "" };

const server = Bun.serve({
  fetch: (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === "/down.toml") {
      return new Response("unavailable", { status: 503 });
    }

    return new Response(
      pathname.endsWith("/base.toml") ? `[skills]\nbase = "o/base"\n` : remote.text
    );
  },
  port: 0,
});

const origin = `http://localhost:${server.port}`;
const previousCache = process.env.XDG_CACHE_HOME;

beforeAll(async () => {
  // The cache of fetched manifests must not land in the real user cache.
  process.env.XDG_CACHE_HOME = await createTempDir();
});

afterAll(async () => {
  if (previousCache === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = previousCache;
  }

  await server.stop();
});

async function resolve(files: Record<string, string>, lockedHashes: Record<string, string> = {}) {
  const root = await createTempDir();
  await writeFiles(root, files);
  const file = path.join(root, "agents.toml");
  const { layers, remoteHashes } = await resolveLayers(file, lockedHashes, "network");

  return { manifest: mergeLayers(layers), remoteHashes, root };
}

test("a later extends item overrides an earlier one, and the manifest overrides both", async () => {
  const { manifest } = await resolve({
    "a.toml": `agents = ["codex"]\n[skills]\none = "o/a"\ntwo = "o/a"\nthree = "o/a"\n`,
    "agents.toml": `extends = ["./a.toml", "./b.toml"]\n[skills]\nthree = "o/own"\n`,
    "b.toml": `agents = ["opencode"]\n[skills]\ntwo = "o/b"\nthree = "o/b"\n`,
  });

  expect(manifest.agents).toEqual(["opencode"]);
  expect(
    Object.fromEntries(
      Object.entries(manifest.skills).map(([name, skill]) => [name, skill.entry.source])
    )
  ).toEqual({
    one: "o/a",
    three: "o/own",
    two: "o/b",
  });
});

test("an entry replaces the inherited entry as a whole", async () => {
  const { manifest } = await resolve({
    "agents.toml": `extends = ["./base.toml"]\n[mcp.db]\ncommand = "bun"\n`,
    "base.toml": `[mcp.db]\ncommand = "node"\nargs = ["x.js"]\nenv = { A = "1" }\n`,
  });

  expect(manifest.mcp.db?.entry).toEqual({ command: "bun" });
});

test("false removes an inherited skill and an inherited server", async () => {
  const { manifest } = await resolve({
    "agents.toml": `extends = ["./base.toml"]\n[skills]\nold = false\n[mcp]\nlinear = false\n`,
    "base.toml": `[skills]\nold = "o/old"\nkept = "o/kept"\n[mcp.linear]\nurl = "https://l.test"\n`,
  });

  expect(Object.keys(manifest.skills)).toEqual(["kept"]);
  expect(manifest.mcp).toEqual({});
});

test("each entry records the manifest that declared it", async () => {
  const { manifest, root } = await resolve({
    "agents.toml": `extends = ["./base.toml"]\n[skills]\nown = "o/own"\n`,
    "base.toml": `[skills]\nbase = "o/base"\n`,
  });

  expect(manifest.skills.base?.declaredIn).toEqual({
    kind: "file",
    path: path.join(root, "base.toml"),
  });
  expect(manifest.skills.own?.declaredIn).toEqual({
    kind: "file",
    path: path.join(root, "agents.toml"),
  });
});

test("a local skill source is anchored to the manifest that declares it", async () => {
  const { manifest, root } = await resolve({
    "agents.toml": `extends = ["./shared/base.toml"]\n`,
    "shared/base.toml": `[skills]\nstyle = "./skills/style"\n`,
  });

  expect(manifest.skills.style?.entry.source).toBe(path.join(root, "shared", "skills", "style"));
});

test("a cycle is an error that shows the chain", async () => {
  const files = {
    "a.toml": `extends = ["./agents.toml"]\n`,
    "agents.toml": `extends = ["./a.toml"]\n`,
  };

  await expect(resolve(files)).rejects.toThrow("forms a cycle");
});

test("a missing extended manifest is an error, but a missing own manifest is empty", async () => {
  await expect(resolve({ "agents.toml": `extends = ["./nope.toml"]\n` })).rejects.toThrow(
    "does not exist"
  );

  const { manifest } = await resolve({});
  expect(manifest).toEqual({ agents: undefined, mcp: {}, skills: {} });
});

test("a remote manifest is hashed, and its relative extends resolve against its URL", async () => {
  remote.text = `extends = ["./base.toml"]\n[skills]\nteam = "o/team"\n`;

  const { manifest, remoteHashes } = await resolve({
    "agents.toml": `extends = ["${origin}/team/agents.toml"]\n`,
  });

  expect(Object.keys(manifest.skills).toSorted()).toEqual(["base", "team"]);
  expect(Object.keys(remoteHashes).toSorted()).toEqual([
    `${origin}/team/agents.toml`,
    `${origin}/team/base.toml`,
  ]);
  expect(remoteHashes[`${origin}/team/agents.toml`]).toMatch(/^[0-9a-f]{64}$/u);
});

test("a remote manifest cannot use a local skill path or extend a local path", async () => {
  remote.text = `[skills]\nstyle = "./skills/style"\n`;
  const usesLocalSkill = resolve({ "agents.toml": `extends = ["${origin}/x.toml"]\n` });
  await expect(usesLocalSkill).rejects.toThrow("cannot use a local path");

  remote.text = `extends = ["/etc/agents.toml"]\n`;
  const extendsLocal = resolve({ "agents.toml": `extends = ["${origin}/y.toml"]\n` });
  await expect(extendsLocal).rejects.toThrow("can extend only URLs");
});

test("an offline run uses the cached copy that the lock pins", async () => {
  remote.text = `[skills]\nteam = "o/team"\n`;
  const online = await resolve({ "agents.toml": `extends = ["${origin}/pinned.toml"]\n` });
  const hash = online.remoteHashes[`${origin}/pinned.toml`] ?? "";

  // The same content is now served only from the cache, under a URL that fails.
  const offline = await resolve(
    { "agents.toml": `extends = ["${origin}/down.toml"]\n` },
    { [`${origin}/down.toml`]: hash }
  );

  expect(Object.keys(offline.manifest.skills)).toEqual(["team"]);
});

test("a remote manifest that cannot be fetched and is not cached is an error", async () => {
  const files = { "agents.toml": `extends = ["${origin}/down.toml"]\n` };

  await expect(resolve(files)).rejects.toThrow(
    `Cannot fetch the extended manifest ${origin}/down.toml`
  );
});
