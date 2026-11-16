/* eslint-disable no-await-in-loop -- Stop at the first verified run and restore large archives one at a time. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Keep these names aligned with the native matrix in check.yml.
const Platforms = [
  "linux-x64",
  "linux-arm64",
  "macos-x64",
  "macos-arm64",
  "windows-x64",
  "windows-arm64",
];

export async function findReusableRun(github, target) {
  const { owner, repo, sha, tree } = target;
  const repository = `${owner}/${repo}`;

  const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: sha,
    per_page: 100,
  });

  const pull = pulls.find(
    (candidate) =>
      candidate.merged_at &&
      candidate.merge_commit_sha === sha &&
      candidate.base.ref === "main" &&
      candidate.head.repo?.full_name === repository
  );

  if (!pull) {
    return null;
  }

  const { data } = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: "check.yml",
    event: "pull_request",
    status: "success",
    head_sha: pull.head.sha,
    per_page: 20,
  });

  for (const run of data.workflow_runs) {
    if (
      run.event !== "pull_request" ||
      run.conclusion !== "success" ||
      run.head_sha !== pull.head.sha ||
      run.head_repository?.full_name !== repository
    ) {
      continue;
    }

    const { data: uploads } = await github.rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: run.id,
      per_page: 100,
    });

    const available = uploads.artifacts.filter((artifact) => !artifact.expired);
    const snapshot = available.find((artifact) => /^ci-snapshot-[a-f\d]{40}$/u.test(artifact.name));

    const artifacts = Platforms.map((platform) =>
      available.find((artifact) => artifact.name === `binary-${platform}`)
    );

    if (!snapshot || artifacts.some((artifact) => !artifact)) {
      continue;
    }

    // The PR workflow checks out GitHub's synthetic merge, not its head branch.
    // Verify its tree and parent through GitHub rather than trusting artifact contents.
    const { data: commit } = await github.rest.git.getCommit({
      owner,
      repo,
      commit_sha: snapshot.name.slice("ci-snapshot-".length),
    });

    if (commit.tree.sha === tree && commit.parents[1]?.sha === pull.head.sha) {
      return { runId: run.id, artifacts };
    }
  }

  return null;
}

export async function restoreArtifacts(github, repository, artifacts, directory) {
  for (const artifact of artifacts) {
    const { data } = await github.rest.actions.downloadArtifact({
      ...repository,
      artifact_id: artifact.id,
      archive_format: "zip",
    });

    const archive = path.join(directory, "download.zip");
    await writeFile(archive, Buffer.from(data));
    const platform = artifact.name.slice("binary-".length);

    const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf-8" })
      .trim()
      .split("\n");

    const pattern = new RegExp(`^agentsrc-v[^/\\\\]+-${platform}\\.tar\\.gz(?:\\.sha256)?$`, "u");

    if (entries.length !== 2 || entries.some((entry) => !pattern.test(entry))) {
      throw new Error(`Unexpected files in ${artifact.name}.`);
    }

    execFileSync("unzip", ["-oq", archive, "-d", directory]);
    await rm(archive);
  }

  await verifyChecksums(directory);
}

async function verifyChecksums(directory) {
  const files = await readdir(directory);

  for (const platform of Platforms) {
    const archive = files.find((file) => file.endsWith(`-${platform}.tar.gz`));

    if (!archive || !files.includes(`${archive}.sha256`)) {
      throw new Error(`Missing archive or checksum for ${platform}.`);
    }

    const digest = createHash("sha256")
      .update(await readFile(path.join(directory, archive)))
      .digest("hex");

    const checksum = await readFile(path.join(directory, `${archive}.sha256`), "utf-8");

    if (checksum.trim() !== `${digest}  ${archive}`) {
      throw new Error(`Checksum mismatch for ${archive}.`);
    }
  }
}

export async function reuseCi({ github, context, core }) {
  core.setOutput("reused", "false");

  // Manual dispatch always provides a fresh run for toolchain changes and recovery.
  if (context.eventName !== "push" || context.ref !== "refs/heads/main") {
    return;
  }

  const directory = await mkdtemp(path.join(tmpdir(), "agentsrc-ci-"));

  try {
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf-8" }).trim();
    const result = await findReusableRun(github, { ...context.repo, sha: context.sha, tree });

    if (!result) {
      core.info("No matching successful PR run with all binaries; running full CI.");
      await rm(directory, { recursive: true, force: true });

      return;
    }

    await restoreArtifacts(github, context.repo, result.artifacts, directory);
    core.setOutput("directory", directory);
    core.setOutput("run-id", String(result.runId));
    core.setOutput("reused", "true");
    core.info(`Reusing verified PR checks and binaries from run ${result.runId}.`);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    core.warning(`CI artifacts unavailable; running full CI. ${error.message}`);
  }
}
