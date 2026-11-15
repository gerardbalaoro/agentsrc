import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  discoverSkills,
  filterSkills,
  sanitizeMetadata,
  sanitizeName,
  setFrontmatterName,
} from "#skills/discover.ts";
import { Ui } from "#ui.ts";

import { createTempDir } from "../../test/conformance/source-fixture.ts";

let root: string;

beforeEach(async () => {
  root = await createTempDir("discover");
  spyOn(Ui, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function writeSkill(dir: string, name: string, extra = "") {
  await writeFiles({
    [`${dir}/SKILL.md`]: `---\nname: ${name}\ndescription: The ${name} skill\n${extra}---\n# ${name}\n`,
  });
}

async function writeFiles(files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    })
  );
}

async function discoverNames(options: { subpath?: string; requested?: string[] } = {}) {
  const found = await discoverSkills(root, {
    requested: options.requested,
    subpath: options.subpath,
  });

  return found.map((skill) => skill.name);
}

test.each([
  ["My Skill", "my-skill"],
  ["../../etc/passwd", "etc-passwd"],
  ["..hidden.", "hidden"],
  ["a__b..c", "a__b..c"],
  ["Ünïcode", "n-code"],
  ["---", "unnamed-skill"],
  ["x".repeat(300), "x".repeat(255)],
] as const)("sanitizeName(%s) is %s", (input, expected) => {
  expect(sanitizeName(input)).toBe(expected);
});

test("setFrontmatterName replaces a multi-line name and keeps the rest byte for byte", () => {
  const raw = "---\r\nname: >\r\n  long\r\n  name\r\ndescription: d\r\n---\r\nbody\r\n";

  expect(setFrontmatterName(raw, "short")).toBe(
    "---\r\nname: short\r\ndescription: d\r\n---\r\nbody\r\n"
  );
});

test("setFrontmatterName adds a missing name first and leaves a file without frontmatter alone", () => {
  expect(setFrontmatterName("---\ndescription: d\n---\n", "x")).toBe(
    "---\nname: x\ndescription: d\n---\n"
  );
  expect(setFrontmatterName("# no frontmatter\n", "x")).toBe("# no frontmatter\n");
});

test("sanitizeMetadata removes terminal escapes and collapses line breaks", () => {
  expect(sanitizeMetadata("\u001B[31mred\u001B[0m\u001B]0;title\u0007 a\r\nb\u0008")).toBe(
    "red a b"
  );
});

test("a path that points at a skill finds that skill alone", async () => {
  await writeSkill("skills/a", "alpha");
  await writeSkill("skills/a/inner", "inner");
  await writeSkill("skills/b", "beta");

  expect(await discoverNames({ subpath: "skills/a" })).toEqual(["alpha"]);
});

test("the root is searched one level deep and known containers three levels deep", async () => {
  await writeSkill("top", "top");
  await writeSkill("examples/deep/x", "too-deep");
  await writeSkill("skills/cat/sub/leaf", "leaf");
  await writeSkill(".claude/skills/claude-one", "claude-one");

  const names = await discoverNames();

  expect(names.toSorted()).toEqual(["claude-one", "leaf", "top"]);
});

test("nothing found in the usual places falls back to a full search", async () => {
  await writeSkill("examples/deep/x", "deep");

  expect(await discoverNames()).toEqual(["deep"]);
});

test("a requested skill missing from the usual places triggers a full search", async () => {
  await writeSkill("skills/a", "alpha");
  await writeSkill("examples/deep/x", "deep");

  expect(await discoverNames()).toEqual(["alpha"]);
  const names = await discoverNames({ requested: ["deep"] });

  expect(names.toSorted()).toEqual(["alpha", "deep"]);
});

test("the first skill of a name wins, in priority order", async () => {
  await writeSkill("skills/one", "same");
  await writeFiles({ "skills/one/marker": "first" });
  await writeSkill(".agents/skills/two", "same");

  const found = await discoverSkills(root, { requested: undefined, subpath: undefined });

  expect(found.map((skill) => path.relative(root, skill.dir))).toEqual(["skills/one"]);
});

test("an internal skill is hidden unless it is requested by name", async () => {
  await writeSkill("skills/a", "alpha");
  await writeSkill("skills/secret", "secret", 'metadata:\n  internal: "true"\n');

  expect(await discoverNames()).toEqual(["alpha"]);
  const names = await discoverNames({ requested: ["secret"] });

  expect(names.toSorted()).toEqual(["alpha", "secret"]);
});

test("a skill the source only has installed, according to its own lock, is not offered", async () => {
  await writeSkill("skills/mine", "mine");
  await writeSkill(".agents/skills/borrowed", "borrowed");
  await writeFiles({ "skills-lock.json": '{ "version": 2, "skills": { "borrowed": {} } }' });

  expect(await discoverNames()).toEqual(["mine"]);
});

test("skills.sh.json paths and plugin manifests add skill directories", async () => {
  await writeSkill("tools/extra/one", "from-config");
  await writeSkill("plugins/docs/skills/two", "from-plugin");
  await writeFiles({
    ".claude-plugin/marketplace.json": JSON.stringify({
      plugins: [{ name: "docs", skills: ["./skills/two"], source: "./plugins/docs" }],
    }),
    "skills.sh.json": JSON.stringify({ paths: ["./tools/extra", "../outside", 42] }),
  });

  const found = await discoverSkills(root, { requested: undefined, subpath: undefined });

  expect(found.map((skill) => [skill.name, skill.pluginName])).toEqual([
    ["from-config", undefined],
    ["from-plugin", "docs"],
  ]);
});

test("a SKILL.md without a name or description is skipped with a warning", async () => {
  await writeFiles({ "skills/bad/SKILL.md": "---\nname: bad\n---\n" });
  await writeSkill("skills/good", "good");

  expect(await discoverNames()).toEqual(["good"]);
  expect(Ui.warn).toHaveBeenCalledWith(expect.stringContaining("skills/bad/SKILL.md"));
});

test("a subpath that leaves the source is refused", async () => {
  await expect(discoverSkills(root, { requested: undefined, subpath: "../x" })).rejects.toThrow(
    "leaves the source"
  );
});

test("filterSkills matches the exact name first, then a name that differs in case or separators", () => {
  const skills = ["My_Skill", "my-skill", "Other Thing"].map((name) => ({
    description: "",
    dir: name,
    name,
  }));

  expect(filterSkills(skills, ["my-skill"]).map((item) => item.dir)).toEqual(["my-skill"]);
  expect(filterSkills(skills, ["other-thing"]).map((item) => item.dir)).toEqual(["Other Thing"]);
  expect(filterSkills(skills, ["MY_SKILL"]).map((item) => item.dir)).toEqual(["My_Skill"]);
});
