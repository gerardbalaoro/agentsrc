import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  collectSkillFiles,
  computeLegacySkillFolderHash,
  computeSkillFolderHash,
  hashGitTree,
  hashSkillFiles,
} from "#lock/hash.ts";

import { createSourceRepo, createTempDir, git } from "../../test/conformance/source-fixture.ts";

let dir: string;

beforeEach(async () => {
  dir = await createTempDir("hash");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

async function writeFiles(files: Record<string, string | Buffer>) {
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      const target = path.join(dir, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    })
  );
}

const toFile = (file: string, content: string) => ({
  content: Buffer.from(content),
  mode: 0o644,
  path: file,
});

// The test vectors that the skills.sh README publishes for `computedHash`.
test.each([
  [[], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  [
    [toFile("SKILL.md", "# hi\n")],
    "93c36952d8843b33e68ae970ebabcc03e1687c9bb0dd1ecaf357060318952f55",
  ],
  [
    [toFile("docs/b.md", "b\n"), toFile("SKILL.md", "a\n")],
    "b22c4d22aa319d2924312fa18fcbfedc88fa89c74dbd8f298c683e1caf7b7f24",
  ],
])("hashSkillFiles matches the skills.sh test vector %#", (files, expected) => {
  expect(hashSkillFiles(files)).toBe(expected);
});

test("CRLF counts as LF in a text file but not in a binary file", () => {
  const lf = hashSkillFiles([toFile("SKILL.md", "a\nb\n")]);

  expect(hashSkillFiles([toFile("SKILL.md", "a\r\nb\r\n")])).toBe(lf);

  const binary = { content: Buffer.from([0, 13, 10]), mode: 0o644, path: "x.bin" };
  const binaryLf = { ...binary, content: Buffer.from([0, 10]) };

  expect(hashSkillFiles([binary])).not.toBe(hashSkillFiles([binaryLf]));
});

test("files are sorted by their UTF-8 bytes, not by locale", () => {
  // "B" (0x42) sorts before "a" (0x61) by bytes; a locale-aware sort puts "a" first.
  const files = [toFile("a.md", "1"), toFile("B.md", "2")];

  expect(hashSkillFiles(files)).toBe(
    new Bun.CryptoHasher("sha256").update("B.md\u00001\u00002a.md\u00001\u00001").digest("hex")
  );
});

test("the folder hash leaves out what the installer does not copy", async () => {
  await writeFiles({ "SKILL.md": "a\n", "docs/b.md": "b\n" });
  const base = await computeSkillFolderHash(dir);

  await writeFiles({
    ".git/HEAD": "ref\n",
    "__pycache__/x.pyc": "x",
    "docs/metadata.json": "{}",
    "metadata.json": "{}",
  });

  expect(base).toBe("b22c4d22aa319d2924312fa18fcbfedc88fa89c74dbd8f298c683e1caf7b7f24");
  expect(await computeSkillFolderHash(dir)).toBe(base);
});

test("a link inside the skill counts as its target, and a link outside is left out", async () => {
  await writeFiles({ "SKILL.md": "a\n", "docs/b.md": "b\n" });
  const outside = await createTempDir("outside");
  await writeFile(path.join(outside, "secret"), "secret\n");
  await symlink(path.join(outside, "secret"), path.join(dir, "leak"));
  await symlink("missing", path.join(dir, "broken"));
  await symlink("docs", path.join(dir, "docs-link"));

  const files = await collectSkillFiles(dir);
  await rm(outside, { force: true, recursive: true });

  expect(files.map((file) => file.path).toSorted()).toEqual([
    "SKILL.md",
    "docs-link/b.md",
    "docs/b.md",
  ]);
});

test("hashGitTree equals the tree hash that Git computes for the same folder", async () => {
  const repo = path.join(dir, "repo");
  await createSourceRepo(repo);
  const skills = ["skills/alpha", "skills/beta", "skills/nested/group/gamma"];

  const results = await Promise.all(
    skills.map(async (skill) => {
      const files = await collectSkillFiles(path.join(repo, skill));
      const gitHash = await git(repo, ["rev-parse", `HEAD:${skill}`]);

      return { files, gitHash };
    })
  );

  // alpha has metadata.json, which Git stores and the installer leaves out.
  const [alpha, beta, gamma] = results;
  expect(hashGitTree(alpha?.files ?? [])).not.toBe(alpha?.gitHash);
  expect(hashGitTree(beta?.files ?? [])).toBe(beta?.gitHash ?? "");
  expect(hashGitTree(gamma?.files ?? [])).toBe(gamma?.gitHash ?? "");
});

test("hashGitTree records an executable file with mode 100755", async () => {
  const repo = path.join(dir, "repo");
  await writeFiles({ "repo/SKILL.md": "a\n", "repo/run.sh": "#!/bin/sh\n" });
  await chmod(path.join(repo, "run.sh"), 0o755);
  await git(repo, ["init", "--quiet"]);
  await git(repo, ["add", "--all"]);
  await git(repo, ["commit", "--quiet", "--message", "x"]);

  // The `.git` directory is left out, as from any skill folder.
  const files = await collectSkillFiles(repo);

  expect(hashGitTree(files)).toBe(await git(repo, ["rev-parse", "HEAD^{tree}"]));
});

test("the legacy version 1 hash frames nothing and sorts by locale", async () => {
  await writeFiles({ "SKILL.md": "a\n", "b.md": "b\n" });

  // localeCompare puts "b.md" before "SKILL.md"; the content follows each path with no separator.
  const expected = new Bun.CryptoHasher("sha256").update("b.mdb\nSKILL.mda\n").digest("hex");

  expect(await computeLegacySkillFolderHash(dir)).toBe(expected);
});
