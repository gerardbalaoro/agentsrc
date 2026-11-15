import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes through a temporary file, so a crash never leaves a half-written file.
 *
 * When `file` is a link, the file it points to is replaced and the link stays. Dotfile managers
 * link harness configs such as `~/.codex/config.toml`.
 */
export async function writeFileAtomic(file: string, text: string) {
  const target = await resolveLink(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, target);
}

async function resolveLink(file: string) {
  try {
    return await realpath(file);
  } catch {
    // The file does not exist yet, so there is no link to follow.
    return file;
  }
}
