import { expect, test } from "bun:test";

import {
  createSkillsLock,
  parseSkillsLock,
  removeLockedSkill,
  serializeSkillsLock,
  setLockedSkill,
} from "#lock/skills-lock.ts";
import type { LockedSkillFields } from "#lock/skills-lock.ts";

const Project = { kind: "project", root: "/work/app" } as const;
const Global = { kind: "global", root: "/home/me" } as const;

const LocalLock = `{
  "version": 2,
  "skills": {
    "pdf": {
      "source": "anthropics/skills",
      "ref": "v1.2.0",
      "sourceType": "github",
      "skillPath": "skills/pdf/SKILL.md",
      "computedHash": "abc",
      "via": "."
    },
    "house": {
      "source": "./skills/house",
      "sourceType": "local",
      "computedHash": "def"
    }
  },
  "futureField": { "kept": true }
}
`;

const pdfFields: LockedSkillFields = {
  hash: "abc",
  ref: "v1.2.0",
  skillPath: "skills/pdf/SKILL.md",
  source: "anthropics/skills",
  sourceType: "github",
};

test("a local source is absolute in memory and relative to the lock on disk", () => {
  const lock = parseSkillsLock(LocalLock, createSkillsLock(Project));

  expect(lock.skills.house?.source).toBe("/work/app/skills/house");
  expect(serializeSkillsLock(lock)).toContain('"source": "./skills/house"');
});

test("fields and top-level keys that agentsrc does not know survive a rewrite", () => {
  const lock = parseSkillsLock(LocalLock, createSkillsLock(Project));
  setLockedSkill(lock, "pdf", { ...pdfFields, hash: "new" }, new Date(0));

  expect(JSON.parse(serializeSkillsLock(lock))).toEqual({
    futureField: { kept: true },
    skills: {
      house: { computedHash: "def", source: "./skills/house", sourceType: "local" },
      pdf: {
        computedHash: "new",
        ref: "v1.2.0",
        skillPath: "skills/pdf/SKILL.md",
        source: "anthropics/skills",
        sourceType: "github",
        via: ".",
      },
    },
    version: 2,
  });
});

test("the local lock is sorted by name and its fields follow the skills.sh order", () => {
  const lock = createSkillsLock(Project);
  setLockedSkill(
    lock,
    "zeta",
    {
      hash: "h",
      installMode: "copy",
      skillName: "orig",
      skillPath: "a/SKILL.md",
      source: "https://git.example.com/x.git",
      sourceType: "git",
      sourceUrl: "https://git.example.com/x.git",
    },
    new Date(0)
  );
  setLockedSkill(
    lock,
    "alpha",
    { hash: "h2", source: "/work/app/vendor", sourceType: "local" },
    new Date(0)
  );

  expect(serializeSkillsLock(lock)).toBe(`{
  "version": 2,
  "skills": {
    "alpha": {
      "source": "./vendor",
      "sourceType": "local",
      "computedHash": "h2"
    },
    "zeta": {
      "source": "https://git.example.com/x.git",
      "sourceUrl": "https://git.example.com/x.git",
      "sourceType": "git",
      "skillPath": "a/SKILL.md",
      "computedHash": "h",
      "skillName": "orig",
      "installMode": "copy"
    }
  }
}
`);
});

test("the global lock keeps entry order, has no final newline, and starts with dismissed", () => {
  const lock = createSkillsLock(Global);
  setLockedSkill(
    lock,
    "zeta",
    { hash: "1", source: "o/r", sourceType: "github", sourceUrl: "u" },
    new Date(0)
  );
  setLockedSkill(
    lock,
    "alpha",
    { hash: "2", source: "o/r", sourceType: "github", sourceUrl: "u" },
    new Date(0)
  );
  const text = serializeSkillsLock(lock);

  expect(Object.keys(JSON.parse(text).skills)).toEqual(["zeta", "alpha"]);
  expect(text.endsWith("}")).toBe(true);
  expect(JSON.parse(text).dismissed).toEqual({});
  expect(JSON.parse(text).skills.zeta).toEqual({
    installedAt: "1970-01-01T00:00:00.000Z",
    skillFolderHash: "1",
    source: "o/r",
    sourceType: "github",
    sourceUrl: "u",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
});

test("a global entry keeps installedAt, and updatedAt moves only when the entry changes", () => {
  const lock = createSkillsLock(Global);
  const fields = { hash: "1", source: "o/r", sourceType: "github", sourceUrl: "u" };
  setLockedSkill(lock, "pdf", fields, new Date("2026-01-01T00:00:00Z"));
  setLockedSkill(lock, "pdf", fields, new Date("2026-02-01T00:00:00Z"));

  expect(lock.skills.pdf?.updatedAt).toBe("2026-01-01T00:00:00.000Z");

  setLockedSkill(lock, "pdf", { ...fields, hash: "2" }, new Date("2026-03-01T00:00:00Z"));

  expect(lock.skills.pdf?.installedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(lock.skills.pdf?.updatedAt).toBe("2026-03-01T00:00:00.000Z");
});

test("a global lock older than version 3 is replaced, as skills.sh does", () => {
  const lock = parseSkillsLock(
    '{ "version": 2, "skills": { "x": { "source": "a" } } }',
    createSkillsLock(Global)
  );

  expect(lock.skills).toEqual({});
  expect(lock.exists).toBe(true);
});

test("a version 1 local lock is read, so it can be migrated", () => {
  const text =
    '{ "version": 1, "skills": { "x": { "source": "o/r", "sourceType": "github", "computedHash": "v1" } } }';

  const lock = parseSkillsLock(text, createSkillsLock(Project));

  expect(lock.version).toBe(1);
  expect(lock.skills.x?.hash).toBe("v1");
  expect(serializeSkillsLock(lock)).toStartWith('{\n  "version": 2,');
});

test.each([
  ['{ "version": 3, "skills": {} }', Project, "lock version 3"],
  ['{ "version": 4, "skills": {} }', Global, "lock version 4"],
  ['{ "skills": {} }', Project, "numeric"],
  ['{ "version": 2, "skills": { "x": { "sourceType": "github" } } }', Project, "skills.x"],
  ["<<<<<<< HEAD", Project, "not valid JSON"],
] as const)("%s is refused", (text, scope, message) => {
  expect(() => parseSkillsLock(text, createSkillsLock(scope))).toThrow(message);
});

test("removing an entry keeps the order of the others", () => {
  const lock = createSkillsLock(Global);
  const fields = { hash: "1", source: "o/r", sourceType: "github", sourceUrl: "u" };
  setLockedSkill(lock, "c", fields, new Date(0));
  setLockedSkill(lock, "a", fields, new Date(0));
  setLockedSkill(lock, "b", fields, new Date(0));
  removeLockedSkill(lock, "a");

  expect(Object.keys(lock.skills)).toEqual(["c", "b"]);
});

test("commit fields from other tools are preserved as opaque extras", () => {
  const text = JSON.stringify({
    version: 2,
    skills: {
      pdf: {
        source: "anthropics/skills",
        sourceType: "github",
        computedHash: "abc",
        commit: "external-value",
      },
    },
  });

  const lock = parseSkillsLock(text, createSkillsLock(Project));
  expect(lock.skills.pdf?.extra.commit).toBe("external-value");
  setLockedSkill(lock, "pdf", pdfFields, new Date(0));
  expect(JSON.parse(serializeSkillsLock(lock)).skills.pdf.commit).toBe("external-value");
});
