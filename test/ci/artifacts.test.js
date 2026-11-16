import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findReusableRun, restoreArtifacts, reuseCi } from "../../.github/scripts/ci-artifacts.js";

function fixture() {
  const platforms = [
    "linux-x64",
    "linux-arm64",
    "macos-x64",
    "macos-arm64",
    "windows-x64",
    "windows-arm64",
  ];

  const pull = {
    number: 12,
    merged_at: "2026-11-16T00:00:00Z",
    merge_commit_sha: "merged",
    head: { sha: "head", repo: { full_name: "owner/repo" } },
    base: { ref: "main" },
  };

  const run = {
    id: 42,
    event: "pull_request",
    conclusion: "success",
    head_sha: "head",
    head_repository: { full_name: "owner/repo" },
  };

  const commit = { tree: { sha: "tree" }, parents: [{ sha: "base" }, { sha: "head" }] };

  const artifacts = [
    { id: 1, name: `ci-snapshot-${"a".repeat(40)}`, expired: false },
    ...platforms.map((platform, index) => ({
      id: index + 2,
      name: `binary-${platform}`,
      expired: false,
    })),
  ];

  const github = {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: () => ({ data: [pull] }) },
      actions: {
        listWorkflowRuns: () => ({ data: { workflow_runs: [run] } }),
        listWorkflowRunArtifacts: () => ({ data: { artifacts } }),
      },
      git: { getCommit: () => ({ data: commit }) },
    },
  };

  const target = { owner: "owner", repo: "repo", sha: "merged", tree: "tree" };

  return { github, target, pull, run, commit, artifacts };
}

test("reuses successful PR binaries when the tested tree matches a squash merge", async () => {
  const { github, target } = fixture();
  const result = await findReusableRun(github, target);
  expect(result?.runId).toBe(42);
  expect(result?.artifacts).toHaveLength(6);
});

test("reruns checks when main includes files absent from the tested merge", async () => {
  const { github, target, commit } = fixture();
  commit.tree.sha = "older-tree";
  expect(await findReusableRun(github, target)).toBeNull();
});

test("does not promote artifacts from a fork", async () => {
  const { github, target, pull } = fixture();
  pull.head.repo.full_name = "outsider/repo";
  expect(await findReusableRun(github, target)).toBeNull();
});

test("does not reuse an unsuccessful run even if artifacts exist", async () => {
  const { github, target, run } = fixture();
  run.conclusion = "failure";
  expect(await findReusableRun(github, target)).toBeNull();
});

test("requires the snapshot to belong to the PR's tested head", async () => {
  const { github, target, commit } = fixture();
  commit.parents[1].sha = "unrelated-head";
  expect(await findReusableRun(github, target)).toBeNull();
});

test.each(["missing", "expired"])("reruns checks for a %s platform artifact", async (state) => {
  const { github, target, artifacts } = fixture();

  if (state === "missing") {
    artifacts.pop();
  } else {
    artifacts[1].expired = true;
  }

  expect(await findReusableRun(github, target)).toBeNull();
});

test("does not reuse results for another commit associated with the PR", async () => {
  const { github, target, pull } = fixture();
  pull.merge_commit_sha = "another-merge";
  expect(await findReusableRun(github, target)).toBeNull();
});

test("restores all six platforms from real artifact ZIPs", async () => {
  const { github, artifacts, target, commit } = fixture();
  const directory = await mkdtemp(path.join(tmpdir(), "ci-restore-test-"));
  const source = await mkdtemp(path.join(tmpdir(), "ci-upload-test-"));

  try {
    const downloads = new Map();

    await Promise.all(
      artifacts.slice(1).map(async (artifact) => {
        const platform = artifact.name.slice("binary-".length);
        const name = `agentsrc-v0.1.0-${platform}.tar.gz`;
        const contents = Buffer.from(`binary for ${platform}`);
        const checksum = createHash("sha256").update(contents).digest("hex");
        await writeFile(path.join(source, name), contents);
        await writeFile(path.join(source, `${name}.sha256`), `${checksum}  ${name}\n`);
        const archive = path.join(source, `${platform}.zip`);
        execFileSync("zip", ["-q", archive, name, `${name}.sha256`], { cwd: source });
        downloads.set(artifact.id, await readFile(archive));
      })
    );

    github.rest.actions.downloadArtifact = ({ artifact_id }) => ({
      data: downloads.get(artifact_id),
    });
    await restoreArtifacts(github, target, artifacts.slice(1), directory);
    expect(await readdir(directory)).toHaveLength(12);
    expect(
      await readFile(path.join(directory, "agentsrc-v0.1.0-windows-arm64.tar.gz"), "utf-8")
    ).toBe("binary for windows-arm64");

    commit.tree.sha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      encoding: "utf-8",
    }).trim();
    const outputs = new Map();
    const messages = [];
    await reuseCi({
      github,
      context: { eventName: "push", ref: "refs/heads/main", repo: target, sha: "merged" },
      core: {
        setOutput: (key, value) => outputs.set(key, value),
        info: (message) => messages.push(message),
        warning: (message) => messages.push(message),
      },
    });

    try {
      expect(outputs.get("reused")).toBe("true");
      expect(outputs.get("run-id")).toBe("42");
      expect(await readdir(outputs.get("directory"))).toHaveLength(12);
    } finally {
      if (outputs.has("directory")) {
        await rm(outputs.get("directory"), { recursive: true, force: true });
      }
    }

    // Corruption in transit must prevent the successful reuse decision.
    const archive = path.join(source, "linux-x64.zip");
    await writeFile(path.join(source, "agentsrc-v0.1.0-linux-x64.tar.gz"), "corrupted");
    execFileSync("zip", ["-q", archive, "agentsrc-v0.1.0-linux-x64.tar.gz"], { cwd: source });
    downloads.set(2, await readFile(archive));
    await expect(restoreArtifacts(github, target, artifacts.slice(1), directory)).rejects.toThrow(
      "Checksum mismatch"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("rejects artifact ZIPs containing paths outside the binary directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ci-path-test-"));

  try {
    await writeFile(path.join(directory, "unexpected"), "not a binary");
    const source = path.join(directory, "source");
    await mkdir(source);
    execFileSync("zip", ["-q", path.join(directory, "artifact.zip"), "../unexpected"], {
      cwd: source,
    });
    const archive = await readFile(path.join(directory, "artifact.zip"));
    const github = { rest: { actions: { downloadArtifact: () => ({ data: archive }) } } };
    await expect(
      restoreArtifacts(github, {}, [{ id: 1, name: "binary-linux-x64" }], directory)
    ).rejects.toThrow("Unexpected files");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a GitHub API failure falls back to full CI", async () => {
  const { github } = fixture();
  github.rest.repos.listPullRequestsAssociatedWithCommit = () => {
    throw new Error("GitHub unavailable");
  };

  const outputs = new Map();
  const warnings = [];
  await reuseCi({
    github,
    context: {
      eventName: "push",
      ref: "refs/heads/main",
      repo: { owner: "owner", repo: "repo" },
      sha: "merged",
    },
    core: {
      setOutput: (key, value) => outputs.set(key, value),
      warning: (value) => warnings.push(value),
    },
  });
  expect(outputs.get("reused")).toBe("false");
  expect(warnings[0]).toContain("running full CI");
});

test.each(["pull_request", "workflow_dispatch"])(
  "%s always runs fresh checks",
  async (eventName) => {
    const outputs = new Map();
    await reuseCi({
      github: {},
      context: { eventName, ref: "refs/heads/main" },
      core: { setOutput: (key, value) => outputs.set(key, value) },
    });
    expect(outputs.get("reused")).toBe("false");
  }
);
