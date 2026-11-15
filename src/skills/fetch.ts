import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { OperationError } from "#errors.ts";
import { isInside } from "#lock/hash.ts";
import { parseFrontmatter } from "#skills/discover.ts";
import { getOwnerRepo, isCommitSha, isGitHubHost } from "#skills/source.ts";
import type { ParsedSource } from "#skills/source.ts";
import { Ui } from "#ui.ts";

/** A source on disk, ready for discovery. */
export interface FetchedSource {
  /** The directory to discover skills in: the clone, the download, or the local path. */
  root: string;
  /** Removes what the fetch wrote. Does nothing for a local source. */
  dispose: () => Promise<void>;
}

const run = promisify(execFile);

const DefaultCloneTimeoutMs = 300_000;
const DownloadTimeoutMs = 30_000;
const MaxDownloadBytes = 10 * 1024 * 1024;
const MaxExtractedBytes = 25 * 1024 * 1024;
const MaxArchiveEntries = 1000;
const AllowedGitProtocols = "https:http:ssh:git:file";

/**
 * Fetches a source into a temporary directory. A Git source is cloned at `ref` (a branch, a tag
 * or a full commit SHA), or at its default branch when `ref` is unset.
 */
export async function fetchSource(parsed: ParsedSource, ref: string | undefined) {
  if (parsed.type === "local") {
    if (!existsSync(parsed.url)) {
      throw new OperationError(`The local source ${parsed.url} does not exist.`);
    }

    return { dispose: () => Promise.resolve(), root: parsed.url } satisfies FetchedSource;
  }

  if (parsed.type === "download" || parsed.type === "well-known") {
    return await downloadSource(parsed.url);
  }

  return await cloneSource(parsed.url, ref);
}

/** Fetches each source and ref once per command, and removes every fetch at the end. */
export function createSourceCache() {
  const fetches = new Map<string, Promise<FetchedSource>>();

  return {
    async dispose() {
      const settled = await Promise.allSettled(fetches.values());
      fetches.clear();
      await Promise.all(
        settled.flatMap((result) => (result.status === "fulfilled" ? [result.value.dispose()] : []))
      );
    },

    fetch(parsed: ParsedSource, ref: string | undefined) {
      const key = JSON.stringify([parsed.type, parsed.url, ref ?? ""]);
      const pending = fetches.get(key) ?? fetchSource(parsed, ref);
      fetches.set(key, pending);

      return pending;
    },
  };
}

export type SourceCache = ReturnType<typeof createSourceCache>;

/** The outcome of one Git command: its output, or the error output when it failed. */
type GitResult = { isOk: true; stdout: string } | { isOk: false; output: string };

/** Turns off Git LFS for the clone, so it works whether or not `git-lfs` is installed. */
const GitConfig = [
  "-c",
  "filter.lfs.required=false",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "core.longpaths=true",
];

async function cloneSource(url: string, ref: string | undefined): Promise<FetchedSource> {
  if (/^ext::/iu.test(url)) {
    throw new OperationError(`The Git transport "ext::" is not supported: ${url}`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "agentsrc-git-"));
  const dispose = () => rm(dir, { force: true, recursive: true });
  const cloned = await cloneInto(url, dir, ref);
  const sshUrl = getGitHubSshUrl(url);
  // An HTTPS login is missing for GitHub. The user's SSH key may still have access.
  const canRetryOverSsh = !cloned.isOk && isAuthFailure(cloned.output) && sshUrl !== undefined;
  const result = canRetryOverSsh ? await cloneOverSsh(sshUrl, dir, ref, cloned) : cloned;

  if (!result.isOk) {
    await dispose();
    throw describeCloneFailure(url, result.output);
  }

  return { dispose, root: dir };
}

/** Clones over SSH. On failure, the first error is kept, because it names the URL the user gave. */
async function cloneOverSsh(
  sshUrl: string,
  dir: string,
  ref: string | undefined,
  first: GitResult
) {
  await resetDir(dir);
  const result = await cloneInto(sshUrl, dir, ref);

  return result.isOk ? result : first;
}

async function cloneInto(url: string, dir: string, ref: string | undefined): Promise<GitResult> {
  const branch = ref === undefined ? [] : ["--branch", ref];
  const cloned = await git(["clone", "--depth", "1", ...branch, "--", url, dir]);

  // `--branch` takes only a branch or a tag, so a commit SHA is fetched on its own.
  const isMissingSha =
    !cloned.isOk && ref !== undefined && isCommitSha(ref) && isMissingRef(cloned.output);

  const result = isMissingSha ? await fetchCommit(url, dir, ref) : cloned;

  if (!result.isOk) {
    return result;
  }

  const submodules = await git([
    "-C",
    dir,
    "submodule",
    "update",
    "--init",
    "--recursive",
    "--depth",
    "1",
  ]);

  if (!submodules.isOk) {
    Ui.warn(`Could not fetch the Git submodules of ${url}. Its skills may be incomplete.`);
  }

  return result;
}

/** Fetches one commit. The server must allow fetching a commit by its SHA; GitHub and GitLab do. */
async function fetchCommit(url: string, dir: string, sha: string): Promise<GitResult> {
  await resetDir(dir);
  const init = await git(["init", "--quiet", dir]);

  if (!init.isOk) {
    return init;
  }

  const remote = await git(["-C", dir, "remote", "add", "origin", "--", url]);

  if (!remote.isOk) {
    return remote;
  }

  const fetched = await git(["-C", dir, "fetch", "--depth", "1", "origin", sha]);

  if (!fetched.isOk) {
    return fetched;
  }

  return await git(["-C", dir, "checkout", "--quiet", "FETCH_HEAD"]);
}

async function git(args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await run("git", [...GitConfig, ...args], {
      env: getGitEnv(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: getCloneTimeout(),
    });

    return { isOk: true, stdout };
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    const message = error instanceof Error ? error.message : String(error);

    return { isOk: false, output: `${message}\n${stderr}` };
  }
}

/** Git uses the user's credentials, and never prompts. A missing login fails the command. */
function getGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ALLOW_PROTOCOL: AllowedGitProtocols,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    GIT_TERMINAL_PROMPT: "0",
    // The error checks below match Git's English messages.
    LC_ALL: "C",
  };
}

function getCloneTimeout() {
  const configured = Number(process.env.SKILLS_CLONE_TIMEOUT_MS);

  return Number.isInteger(configured) && configured > 0 ? configured : DefaultCloneTimeoutMs;
}

function isMissingRef(message: string) {
  return (
    /Remote branch .* not found in upstream origin/iu.test(message) ||
    /couldn't find remote ref/iu.test(message) ||
    /upload-pack: not our ref/iu.test(message)
  );
}

function isAuthFailure(message: string) {
  return (
    message.includes("Authentication failed") ||
    message.includes("could not read Username") ||
    message.includes("Permission denied") ||
    message.includes("Repository not found") ||
    message.includes("requested URL returned error: 403") ||
    message.toLowerCase().includes("saml sso")
  );
}

function getGitHubSshUrl(url: string) {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;

  if (parsed?.protocol !== "https:" || !isGitHubHost(parsed.host)) {
    return;
  }

  const repo = getOwnerRepo({ type: "github", url });

  return repo === undefined ? undefined : `git@${parsed.host}:${repo}.git`;
}

function describeCloneFailure(url: string, message: string) {
  if (isAuthFailure(message)) {
    return new OperationError(
      `Could not clone ${url}: authentication failed. Git does not prompt for a login; set up a credential helper or an SSH key for this host.`
    );
  }

  if (message.includes("timed out") || message.includes("ETIMEDOUT")) {
    return new OperationError(`Cloning ${url} timed out.`);
  }

  const lines = message
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "");

  return new OperationError(`Could not clone ${url}: ${lines.at(-1) ?? message}`);
}

async function resetDir(dir: string) {
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
}

/** Downloads a `SKILL.md` file, or a tar, tar.gz or zip archive. */
async function downloadSource(url: string): Promise<FetchedSource> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentsrc-download-"));
  const dispose = () => rm(dir, { force: true, recursive: true });

  try {
    const bytes = await download(url);

    if (isSkillMarkdown(bytes)) {
      const skillDir = path.join(dir, "skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), bytes);

      return { dispose, root: skillDir };
    }

    const extractDir = path.join(dir, "extract");
    const files = readArchive(bytes, url);
    await writeArchive(files, extractDir);

    return { dispose, root: await getSingleTopDir(extractDir) };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function download(url: string) {
  let response: Response;

  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DownloadTimeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new OperationError(`Could not download ${url}: ${reason}`);
  }

  if (!response.ok) {
    throw new OperationError(`Could not download ${url}: HTTP ${response.status}.`);
  }

  const declared = Number(response.headers.get("content-length"));

  if (declared > MaxDownloadBytes) {
    throw new OperationError(`${url} is larger than ${MaxDownloadBytes} bytes.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length > MaxDownloadBytes) {
    throw new OperationError(`${url} is larger than ${MaxDownloadBytes} bytes.`);
  }

  if (bytes.length === 0) {
    throw new OperationError(`${url} is empty.`);
  }

  return bytes;
}

function isSkillMarkdown(bytes: Buffer) {
  try {
    return parseFrontmatter(bytes.toString("utf-8")).data !== undefined;
  } catch {
    return false;
  }
}

/** A file in an archive, at a path that has been checked to stay inside the archive. */
interface ArchiveFile {
  path: string;
  content: Buffer;
  mode: number;
}

function readArchive(bytes: Buffer, url: string): ArchiveFile[] {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (isZip) {
    return readZip(bytes, url);
  }

  const tar = isGzip ? gunzip(bytes, url) : bytes;

  if (!isTar(tar)) {
    throw new OperationError(`${url} is neither a SKILL.md file nor a tar or zip archive.`);
  }

  return readTar(tar, url);
}

function gunzip(bytes: Buffer, url: string) {
  try {
    return gunzipSync(bytes, { maxOutputLength: MaxExtractedBytes });
  } catch {
    throw new OperationError(
      `${url} is not a valid gzip file, or it unpacks to more than ${MaxExtractedBytes} bytes.`
    );
  }
}

const TarBlock = 512;

function isTar(bytes: Buffer) {
  return bytes.length >= TarBlock && bytes.toString("latin1", 257, 262) === "ustar";
}

/** Reads a POSIX or GNU tar archive. Only files and directories are kept, as skills.sh does. */
function readTar(bytes: Buffer, url: string): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  let offset = 0;
  let longName: string | undefined;
  let entries = 0;
  let total = 0;

  while (offset + TarBlock <= bytes.length) {
    const header = bytes.subarray(offset, offset + TarBlock);

    if (header.every((byte) => byte === 0)) {
      break;
    }

    const size = Number.parseInt(readTarText(header, 124, 12) || "0", 8);
    const type = readTarText(header, 156, 1) || "0";
    const body = bytes.subarray(offset + TarBlock, offset + TarBlock + size);
    offset += TarBlock + Math.ceil(size / TarBlock) * TarBlock;

    if (type === "L" || type === "x") {
      longName = type === "L" ? readCString(body) : (readPaxPath(body) ?? longName);
      continue;
    }

    if (type === "g") {
      continue;
    }

    const prefix = readTarText(header, 345, 155);
    const shortName = readTarText(header, 0, 100);
    const name = longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    longName = undefined;
    const safePath = checkArchivePath(name, url);
    entries += 1;
    total += size;
    checkArchiveLimits(entries, total, url);

    const isFile = type === "0" || type === "7";

    if (isFile && safePath !== "") {
      const mode = Number.parseInt(readTarText(header, 100, 8) || "644", 8);
      files.push({ content: Buffer.from(body), mode, path: safePath });
    }
  }

  return files;
}

function readTarText(header: Buffer, start: number, length: number) {
  return readCString(header.subarray(start, start + length)).trim();
}

function readCString(bytes: Buffer) {
  const end = bytes.indexOf(0);

  return bytes.toString("utf-8", 0, end === -1 ? bytes.length : end);
}

function readPaxPath(body: Buffer) {
  const records = body.toString("utf-8").split("\n");

  return records.flatMap((record) => {
    const value = /^\d+ path=(?<value>.*)$/u.exec(record)?.groups?.value;

    return value === undefined ? [] : [value];
  })[0];
}

const ZipLocalHeader = 0x04_03_4b_50;
const ZipCentralHeader = 0x02_01_4b_50;
const ZipEndOfDirectory = 0x06_05_4b_50;
const ZipEndSize = 22;
const ZipMaxComment = 0xff_ff;
const ZipStored = 0;
const ZipDeflated = 8;
const ZipEncryptedFlag = 0x1;
const ZipUtf8Flag = 0x8_00;

// The high 16 bits of a zip entry's external attributes hold its Unix mode.
const UnixModeShift = 0x1_00_00;
const UnixFileTypeUnit = 0o1_0000;
const UnixLinkType = 0o12;
const PermissionUnit = 0o1000;
const DefaultFileMode = 0o644;

/** Reads a zip archive from its central directory. ZIP64 and encrypted archives are refused. */
function readZip(bytes: Buffer, url: string): ArchiveFile[] {
  const end = findZipEnd(bytes);

  if (end === -1) {
    throw new OperationError(`${url} is not a valid zip archive.`);
  }

  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files: ArchiveFile[] = [];
  let total = 0;

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== ZipCentralHeader) {
      throw new OperationError(`${url} is not a valid zip archive.`);
    }

    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const unixMode = Math.floor(bytes.readUInt32LE(offset + 38) / UnixModeShift);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = rawName.toString(hasBit(flags, ZipUtf8Flag) ? "utf-8" : "latin1");
    offset += 46 + nameLength + extraLength + commentLength;

    const safePath = checkArchivePath(name, url);
    total += size;
    checkArchiveLimits(index + 1, total, url);

    if (hasBit(flags, ZipEncryptedFlag)) {
      throw new OperationError(`${url} has an encrypted entry, ${name}.`);
    }

    if (Math.floor(unixMode / UnixFileTypeUnit) === UnixLinkType) {
      throw new OperationError(
        `${url} has a link entry, ${name}. Archives with links are refused.`
      );
    }

    if (safePath === "" || name.endsWith("/")) {
      continue;
    }

    const content = readZipEntry(bytes, { compressedSize, localOffset, method, size }, url);
    files.push({ content, mode: unixMode % PermissionUnit || DefaultFileMode, path: safePath });
  }

  return files;
}

function findZipEnd(bytes: Buffer) {
  const lowest = Math.max(0, bytes.length - ZipMaxComment - ZipEndSize);

  for (let offset = bytes.length - ZipEndSize; offset >= lowest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZipEndOfDirectory) {
      return offset;
    }
  }

  return -1;
}

function readZipEntry(
  bytes: Buffer,
  entry: { localOffset: number; compressedSize: number; size: number; method: number },
  url: string
) {
  const isLocalHeader =
    entry.localOffset + 30 <= bytes.length &&
    bytes.readUInt32LE(entry.localOffset) === ZipLocalHeader;

  if (!isLocalHeader) {
    throw new OperationError(`${url} is not a valid zip archive.`);
  }

  const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
  const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === ZipStored) {
    return Buffer.from(data);
  }

  if (entry.method === ZipDeflated) {
    return inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) });
  }

  throw new OperationError(
    `${url} uses zip compression method ${entry.method}, which is not supported.`
  );
}

/** The entry path with `/` separators, or an error when it leaves the archive. */
function checkArchivePath(name: string, url: string) {
  const normalized = name.replaceAll("\\", "/").replace(/^\.\//u, "");

  const isUnsafe =
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..");

  if (isUnsafe) {
    throw new OperationError(`${url} has an entry outside the archive: ${name}`);
  }

  return normalized.replace(/\/+$/u, "");
}

function checkArchiveLimits(entries: number, bytes: number, url: string) {
  if (entries > MaxArchiveEntries) {
    throw new OperationError(`${url} has more than ${MaxArchiveEntries} entries.`);
  }

  if (bytes > MaxExtractedBytes) {
    throw new OperationError(`${url} unpacks to more than ${MaxExtractedBytes} bytes.`);
  }
}

async function writeArchive(files: ArchiveFile[], dir: string) {
  await mkdir(dir, { recursive: true });

  const targets = files.map((file) => {
    const target = path.join(dir, file.path);

    if (!isInside(dir, target)) {
      throw new OperationError(`The archive entry ${file.path} leaves the archive.`);
    }

    return { file, target };
  });

  await Promise.all(
    targets.map(async ({ file, target }) => {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, { mode: file.mode % PermissionUnit });
    })
  );
}

/** True when `flag`, a power of two, is set in `value`. */
function hasBit(value: number, flag: number) {
  return Math.floor(value / flag) % 2 === 1;
}

/** An archive that holds one top-level directory has its skills inside that directory. */
async function getSingleTopDir(dir: string) {
  const names = await readdir(dir);
  const entries = names.filter((name) => name !== "__MACOSX");
  const only = entries.length === 1 ? entries[0] : undefined;

  if (only === undefined) {
    return dir;
  }

  const candidate = path.join(dir, only);
  const stats = await stat(candidate);

  return stats.isDirectory() ? candidate : dir;
}
