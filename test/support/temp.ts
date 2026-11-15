import { mkdtemp, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Creates an empty directory that the operating system cleans up later. */
export async function createTempDir() {
  return await mkdtemp(path.join(tmpdir(), "agentsrc-"));
}

/** Writes files under `root`. Keys are paths relative to `root`. */
export async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    // Sequential, so parent directories exist before their files.
    // oxlint-disable-next-line no-await-in-loop
    await mkdir(path.dirname(file), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop
    await writeFile(file, text);
  }
}

export async function readFileText(root: string, name: string) {
  return await readFile(path.join(root, name), "utf-8");
}

/** Records file bytes and link targets without following links outside the sandbox. */
export async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { withFileTypes: true });

  const files = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(root, entry.name);

      if (entry.isSymbolicLink()) {
        return [[entry.name, `link:${await readlink(file)}`]];
      }

      if (entry.isDirectory()) {
        return Object.entries(await snapshotFiles(file)).map(([name, value]) => [
          path.join(entry.name, name),
          value,
        ]);
      }

      const content = await readFile(file);

      return [[entry.name, content.toString("base64")]];
    })
  );

  return Object.fromEntries(files.flat());
}
