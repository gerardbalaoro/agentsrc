import { expect, test } from "bun:test";

import {
  getLockSource,
  getLockSourceType,
  getLockSourceUrl,
  parseSource,
  toManifestSource,
} from "#skills/source.ts";

const cwd = "/work/app";

// Expectations follow skills.sh 1.8.1 (`source-parser.test.ts`) where it has a case.
test.each([
  [
    "vercel-labs/agent-skills",
    { type: "github", url: "https://github.com/vercel-labs/agent-skills.git" },
  ],
  [
    "owner/repo/skills/pdf",
    { subpath: "skills/pdf", type: "github", url: "https://github.com/owner/repo.git" },
  ],
  [
    "owner/repo@pdf",
    { skillFilter: "pdf", type: "github", url: "https://github.com/owner/repo.git" },
  ],
  [
    "owner/repo@v1.2.0",
    { ref: "v1.2.0", type: "github", url: "https://github.com/owner/repo.git" },
  ],
  [
    "owner/repo@v2",
    { skillFilter: "v2", type: "github", url: "https://github.com/owner/repo.git" },
  ],
  [
    "owner/repo@0123456789abcdef0123456789abcdef01234567",
    {
      ref: "0123456789abcdef0123456789abcdef01234567",
      type: "github",
      url: "https://github.com/owner/repo.git",
    },
  ],
  [
    "vercel-labs/agent-skills#feature/install",
    {
      ref: "feature/install",
      type: "github",
      url: "https://github.com/vercel-labs/agent-skills.git",
    },
  ],
  [
    "owner/repo#main@pdf",
    { ref: "main", skillFilter: "pdf", type: "github", url: "https://github.com/owner/repo.git" },
  ],
  [
    "https://github.com/owner/repo/tree/main/skills/pdf",
    {
      ref: "main",
      subpath: "skills/pdf",
      type: "github",
      url: "https://github.com/owner/repo.git",
    },
  ],
  [
    "https://github.com/owner/repo/blob/main/README.md#L10",
    { type: "github", url: "https://github.com/owner/repo.git" },
  ],
  [
    "github:owner/repo@pdf",
    { skillFilter: "pdf", type: "github", url: "https://github.com/owner/repo.git" },
  ],
  [
    "https://gitlab.com/group/sub/repo",
    { type: "gitlab", url: "https://gitlab.com/group/sub/repo.git" },
  ],
  [
    "https://git.corp.com/group/subgroup/project/-/tree/main/src",
    {
      ref: "main",
      subpath: "src",
      type: "gitlab",
      url: "https://git.corp.com/group/subgroup/project.git",
    },
  ],
  [
    "git@github.com:owner/repo.git#feature/install",
    { ref: "feature/install", type: "git", url: "git@github.com:owner/repo.git" },
  ],
  [
    "https://dev.azure.com/org/project/_git/skills?path=/skills/pdf&version=GBmain",
    {
      ref: "main",
      subpath: "skills/pdf",
      type: "git",
      url: "https://dev.azure.com/org/project/_git/skills",
    },
  ],
  [
    "https://gh-proxy.org/github.com/owner/repo/tree/dev/skills",
    {
      ref: "dev",
      subpath: "skills",
      type: "git",
      url: "https://gh-proxy.org/github.com/owner/repo.git",
    },
  ],
  [
    "https://git.mycompany.com/team/repo.git",
    { type: "git", url: "https://git.mycompany.com/team/repo.git" },
  ],
  [
    "https://raw.githubusercontent.com/o/r/main/SKILL.md",
    { type: "download", url: "https://raw.githubusercontent.com/o/r/main/SKILL.md" },
  ],
  [
    "https://example.com/skills.tar.gz",
    { type: "well-known", url: "https://example.com/skills.tar.gz" },
  ],
  [
    "coinbase/agentWallet",
    { type: "github", url: "https://github.com/coinbase/agentic-wallet-skills.git" },
  ],
  ["./skills/house", { type: "local", url: "/work/app/skills/house" }],
  ["../shared", { type: "local", url: "/work/shared" }],
  ["/opt/skills", { type: "local", url: "/opt/skills" }],
] as const)("%s", (input, expected) => {
  expect(parseSource(input, { cwd })).toEqual(expected);
});

test.each(["owner/repo/../../etc", "https://github.com/o/r/tree/main/../x"])(
  "%s is refused because its path leaves the source",
  (input) => {
    expect(() => parseSource(input, { cwd })).toThrow("..");
  }
);

test.each([
  ["owner/repo", "owner/repo", "github", undefined],
  [
    "git@github.com:owner/repo.git",
    "git@github.com:owner/repo.git",
    "git",
    "git@github.com:owner/repo.git",
  ],
  [
    "https://gitlab.com/group/repo",
    "https://gitlab.com/group/repo.git",
    "gitlab",
    "https://gitlab.com/group/repo.git",
  ],
  [
    "https://example.com/skill.md",
    "https://example.com/skill.md",
    "download",
    "https://example.com/skill.md",
  ],
  ["./skills/house", "/work/app/skills/house", "local", undefined],
] as const)("%s is locked as %s with type %s", (input, source, sourceType, projectUrl) => {
  const parsed = parseSource(input, { cwd });

  expect(getLockSource(parsed)).toBe(source);
  expect(getLockSourceType(parsed)).toBe(sourceType);
  expect(getLockSourceUrl(parsed, "project")).toBe(projectUrl);
  expect(getLockSourceUrl(parsed, "global")).toBe(parsed.url);
});

test.each([
  ["owner/repo", "owner/repo"],
  ["https://github.com/owner/repo/tree/main/skills", "owner/repo"],
  ["https://gitlab.com/group/repo", "https://gitlab.com/group/repo.git"],
  ["./vendor/skills", "../vendor/skills"],
  ["./.agents/local", "./local"],
] as const)("%s is written to the manifest as %s", (input, expected) => {
  expect(toManifestSource(parseSource(input, { cwd }), "/work/app/.agents")).toBe(expected);
});
