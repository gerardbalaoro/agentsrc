import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Where a command reads and writes: one project, or the user's home. */
export interface Scope {
  kind: "project" | "global";
  /** The project root, or the home directory in global scope. */
  root: string;
}

const AgentsDir = ".agents";
const ManifestName = "agents.toml";

export function resolveScope(options: { global: boolean; cwd: string }): Scope {
  if (options.global) {
    return { kind: "global", root: homedir() };
  }

  return { kind: "project", root: findProjectRoot(options.cwd) };
}

export function manifestPath(scope: Scope) {
  return path.join(scope.root, AgentsDir, ManifestName);
}

export function agentsLockPath(scope: Scope) {
  return path.join(scope.root, AgentsDir, "agents.lock");
}

export function skillsDir(scope: Scope) {
  return path.join(scope.root, AgentsDir, "skills");
}

export function skillsLockPath(scope: Scope) {
  if (scope.kind === "project") {
    return path.join(scope.root, "skills-lock.json");
  }

  const stateHome = process.env.XDG_STATE_HOME;

  if (stateHome) {
    return path.join(stateHome, "skills", ".skill-lock.json");
  }

  return path.join(scope.root, AgentsDir, ".skill-lock.json");
}

/** The nearest ancestor that holds a manifest, or `cwd` when there is none. */
function findProjectRoot(cwd: string) {
  const start = path.resolve(cwd);
  const home = homedir();
  let dir = start;

  while (true) {
    // `~/.agents/agents.toml` is the global manifest, never a project manifest.
    if (dir !== home && existsSync(path.join(dir, AgentsDir, ManifestName))) {
      return dir;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return start;
    }

    dir = parent;
  }
}
