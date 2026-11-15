import { homedir } from "node:os";
import path from "node:path";

/** The directory for files that agentsrc can fetch again, such as remote manifests. */
export function cacheDir() {
  const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");

  return path.join(base, "agentsrc");
}
