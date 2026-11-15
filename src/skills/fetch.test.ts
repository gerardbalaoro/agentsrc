import { afterAll, expect, test } from "bun:test";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { fetchSource } from "#skills/fetch.ts";

const Fixtures = path.resolve(import.meta.dirname, "../../test/fixtures/downloads");
const Skill = "---\nname: demo\ndescription: Download fixture\n---\nDownloaded skill.\n";

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const name = new URL(request.url).pathname.slice(1);

    if (name === "oversized") {
      return new Response(Buffer.alloc(10 * 1024 * 1024 + 1));
    }

    if (name === "oversized-stream") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.alloc(10 * 1024 * 1024 + 1));
            controller.close();
          },
        })
      );
    }

    if (name === "expanded.tar.gz") {
      return new Response(gzipSync(Buffer.alloc(25 * 1024 * 1024 + 1)));
    }

    if (name === "empty") {
      return new Response("");
    }

    if (name === "invalid") {
      return new Response("not an archive or a skill");
    }

    const file = Bun.file(path.join(Fixtures, name === "skill.md" ? "skill.txt" : name));

    return (await file.exists()) ? new Response(file) : new Response("missing", { status: 404 });
  },
});

afterAll(() => server.stop(true));

function download(name: string, type: "download" | "well-known" = "well-known") {
  return fetchSource({ type, url: `http://localhost:${server.port}/${name}` }, undefined);
}

test("a downloaded Markdown skill preserves its bytes and is removed on disposal", async () => {
  const source = await download("skill.md", "download");

  try {
    expect(await readFile(path.join(source.root, "SKILL.md"), "utf-8")).toBe(Skill);
  } finally {
    await source.dispose();
  }

  await expect(lstat(source.root)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["skill.tar", "skill.tar.gz", "skill.zip"])(
  "%s extracts nested files, executable modes, and its single top-level directory",
  async (name) => {
    const source = await download(name);

    try {
      expect(path.basename(source.root)).toBe("bundle");
      expect(await readFile(path.join(source.root, "demo/SKILL.md"), "utf-8")).toBe(Skill);
      expect(await readFile(path.join(source.root, "demo/docs/guide.md"), "utf-8")).toBe(
        "Fixture guide.\n"
      );
      expect(await readFile(path.join(source.root, "demo/run.sh"), "utf-8")).toBe(
        "#!/bin/sh\necho demo\n"
      );
      const script = await stat(path.join(source.root, "demo/run.sh"));
      expect(script.mode % 0o1000).toBe(0o755);
    } finally {
      await source.dispose();
    }

    await expect(lstat(source.root)).rejects.toMatchObject({ code: "ENOENT" });
  }
);

test.each([
  "unsafe-parent.tar",
  "unsafe-absolute.tar",
  "unsafe-drive.tar",
  "unsafe-backslash.tar",
  "unsafe-parent.zip",
  "unsafe-absolute.zip",
  "unsafe-drive.zip",
  "unsafe-backslash.zip",
])("%s is rejected before archive entries can escape", async (name) => {
  await expect(download(name)).rejects.toThrow("entry outside the archive");
});

test.each([
  ["oversized", "larger than 10485760 bytes"],
  ["oversized-stream", "larger than 10485760 bytes"],
  ["expanded.tar.gz", "unpacks to more than 26214400 bytes"],
  ["large.zip", "unpacks to more than 26214400 bytes"],
  ["many.zip", "more than 1000 entries"],
  ["empty", "is empty"],
  ["invalid", "neither a SKILL.md file nor a tar or zip archive"],
  ["missing", "HTTP 404"],
])("%s fails with an actionable error", async (name, message) => {
  await expect(download(name)).rejects.toThrow(message);
});
