import { expect, test } from "bun:test";
import { lstat, readFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";

import { createTempDir, writeFiles } from "#test/support/temp.ts";
import { writeFileAtomic } from "#util/atomic-write.ts";

test("writing creates missing parent directories and leaves no temporary file", async () => {
  const root = await createTempDir();
  const file = path.join(root, "a", "b", "config.toml");

  await writeFileAtomic(file, "x = 1\n");

  expect(await readFile(file, "utf-8")).toBe("x = 1\n");
  expect(await readdir(path.dirname(file))).toEqual(["config.toml"]);
});

test("writing through a link replaces the linked file and keeps the link", async () => {
  const root = await createTempDir();
  await writeFiles(root, { "dotfiles/config.toml": "old\n" });
  const link = path.join(root, "config.toml");
  await symlink(path.join(root, "dotfiles", "config.toml"), link);

  await writeFileAtomic(link, "new\n");

  const stats = await lstat(link);
  expect(stats.isSymbolicLink()).toBe(true);
  expect(await readFile(path.join(root, "dotfiles", "config.toml"), "utf-8")).toBe("new\n");
});
