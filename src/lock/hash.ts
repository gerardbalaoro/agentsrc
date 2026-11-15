import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * The skill content hashes that the skills.sh locks record, ported from skills.sh 1.8.1
 * (`skill-hash.ts` and `local-lock.ts`). Change them only together with the lock version.
 */

/** A file of a skill: its path relative to the skill folder, with `/` separators. */
export interface SkillFile {
  path: string;
  content: Buffer;
  /** The permission bits, such as `0o644`. */
  mode: number;
}

const ExcludedFiles = new Set(["metadata.json"]);
const ExcludedDirs = new Set([".git", "__pycache__", "__pypackages__"]);
const OwnerExecuteBit = 0o100;
const PermissionUnit = 0o1000;

/** True for a name that the installer does not copy, and the hash leaves out. */
export function isExcludedName(name: string, isDirectory: boolean) {
  return ExcludedFiles.has(name) || (isDirectory && ExcludedDirs.has(name));
}

/**
 * The files that an install copies from `dir`: excluded names are left out, a link counts as what
 * it points to, and a link that is broken, loops, or leaves the folder is left out.
 */
export async function collectSkillFiles(dir: string): Promise<SkillFile[]> {
  const root = await realpath(dir);
  const files: SkillFile[] = [];
  await collectFiles({ ancestors: new Set(), dir, files, prefix: "", root });

  return files;
}

/** `computedHash` of the local lock (version 2), for the files that `files` lists. */
export function hashSkillFiles(files: SkillFile[]) {
  const entries = files
    .map((file) => ({
      content: normalizeLineEndings(file.content),
      path: Buffer.from(file.path.replaceAll("\\", "/"), "utf-8"),
    }))
    .toSorted((left, right) => Buffer.compare(left.path, right.path));

  const hash = createHash("sha256");

  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.content.length));
    hash.update("\0");
    hash.update(entry.content);
  }

  return hash.digest("hex");
}

/** `computedHash` of the local lock (version 2) for the skill folder at `dir`. */
export async function computeSkillFolderHash(dir: string) {
  return hashSkillFiles(await collectSkillFiles(dir));
}

/**
 * The SHA-1 of the Git tree that holds `files`, as `git rev-parse HEAD:<folder>` prints it. The
 * global lock records it as `skillFolderHash` for a GitHub source, because skills.sh takes that
 * value from the GitHub Trees API.
 */
export function hashGitTree(files: SkillFile[]) {
  const root: TreeNode = new Map();

  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop() ?? file.path;
    let dir = root;

    for (const part of parts) {
      dir = getChildTree(dir, part);
    }

    dir.set(name, { content: file.content, isExecutable: isOwnerExecutable(file.mode) });
  }

  return writeTree(root).toString("hex");
}

/**
 * The version 1 `computedHash`, kept only to check entries when a version 1 lock is migrated:
 * regular files outside `.git` and `node_modules`, sorted with `localeCompare`, each as its path
 * and then its content with no framing.
 */
export async function computeLegacySkillFolderHash(dir: string) {
  const files: { path: string; content: Buffer }[] = [];
  await collectLegacyFiles(dir, dir, files);
  const sorted = files.toSorted((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");

  for (const file of sorted) {
    hash.update(file.path);
    hash.update(file.content);
  }

  return hash.digest("hex");
}

interface CollectState {
  dir: string;
  prefix: string;
  root: string;
  ancestors: ReadonlySet<string>;
  files: SkillFile[];
}

async function collectFiles(state: CollectState): Promise<void> {
  const realDir = await realpath(state.dir);

  if (state.ancestors.has(realDir)) {
    return;
  }

  const ancestors = new Set(state.ancestors).add(realDir);
  const entries = await readdir(state.dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      if (isExcludedName(entry.name, entry.isDirectory())) {
        return;
      }

      const fullPath = path.join(state.dir, entry.name);
      const relativePath = `${state.prefix}${entry.name}`;
      const kind = await getEntryKind(fullPath, entry, state.root);

      if (kind === "skip" || (kind === "directory" && isExcludedName(entry.name, true))) {
        return;
      }

      if (kind === "directory") {
        await collectFiles({ ...state, ancestors, dir: fullPath, prefix: `${relativePath}/` });

        return;
      }

      const stats = await stat(fullPath);
      state.files.push({
        content: await readFile(fullPath),
        mode: stats.mode % PermissionUnit,
        path: relativePath,
      });
    })
  );
}

async function getEntryKind(
  fullPath: string,
  entry: { isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean },
  root: string
) {
  if (entry.isSymbolicLink()) {
    return await getLinkKind(fullPath, root);
  }

  if (entry.isDirectory()) {
    return "directory";
  }

  return entry.isFile() ? "file" : "skip";
}

/** A link counts as what it points to. A broken link, or one that leaves `root`, is skipped. */
async function getLinkKind(link: string, root: string) {
  try {
    const target = await realpath(link);

    if (!isInside(root, target)) {
      return "skip";
    }

    const stats = await stat(target);

    return stats.isDirectory() ? "directory" : "file";
  } catch {
    return "skip";
  }
}

/** Git records a file as executable when its owner may execute it. */
function isOwnerExecutable(mode: number) {
  return Math.floor(mode / OwnerExecuteBit) % 2 === 1;
}

/** True when `target` is `root` or inside it. Both paths must be real paths. */
export function isInside(root: string, target: string) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/** A file is text when it has no NUL byte. Text files get CRLF replaced by LF. */
function normalizeLineEndings(content: Buffer) {
  if (content.includes(0) || !content.includes("\r\n")) {
    return content;
  }

  return Buffer.from(content.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
}

type TreeNode = Map<string, TreeNode | { content: Buffer; isExecutable: boolean }>;

function getChildTree(parent: TreeNode, name: string): TreeNode {
  const existing = parent.get(name);

  if (existing instanceof Map) {
    return existing;
  }

  const child: TreeNode = new Map();
  parent.set(name, child);

  return child;
}

/** Returns the binary object id of the tree. */
function writeTree(tree: TreeNode): Buffer {
  const entries = [...tree.entries()].map(([name, node]) => {
    if (node instanceof Map) {
      return { id: writeTree(node), mode: "40000", name, sortKey: `${name}/` };
    }

    const mode = node.isExecutable ? "100755" : "100644";

    return { id: hashGitObject("blob", node.content), mode, name, sortKey: name };
  });

  // Git sorts tree entries by name, comparing a directory as if its name ended in `/`.
  const sorted = entries.toSorted((left, right) =>
    Buffer.compare(Buffer.from(left.sortKey), Buffer.from(right.sortKey))
  );

  const body = Buffer.concat(
    sorted.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`), entry.id])
  );

  return hashGitObject("tree", body);
}

function hashGitObject(type: "blob" | "tree", body: Buffer) {
  return createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest();
}

async function collectLegacyFiles(
  root: string,
  dir: string,
  files: { path: string; content: Buffer }[]
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== "node_modules") {
          await collectLegacyFiles(root, fullPath, files);
        }

        return;
      }

      if (entry.isFile()) {
        const relativePath = path.relative(root, fullPath).split("\\").join("/");
        files.push({ content: await readFile(fullPath), path: relativePath });
      }
    })
  );
}
