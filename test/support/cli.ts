import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createTempDir } from "#test/support/temp.ts";

const run = promisify(execFile);
const Entry = path.resolve(import.meta.dirname, "..", "..", "dist", "index.js");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One isolated machine: a home directory with no harness, and a project directory. */
export interface Sandbox {
  home: string;
  project: string;
  /** Runs the built CLI under Node in the project directory. */
  agents: (args: string[], env?: Record<string, string>) => Promise<CliResult>;
}

/** Builds the CLI once per test file. Call it in `beforeAll`. */
export async function buildCli() {
  await run("bun", ["run", "build"], { cwd: path.resolve(import.meta.dirname, "..", "..") });
}

/**
 * Creates a sandbox. `detected` names config directories to create in the home, relative to it,
 * such as `.claude`, so that the harness counts as installed.
 */
export async function createSandbox(detected: string[] = []): Promise<Sandbox> {
  const home = await createTempDir();
  const project = path.join(home, "project");
  await mkdir(project, { recursive: true });
  await Promise.all(detected.map((dir) => mkdir(path.join(home, dir), { recursive: true })));

  return {
    agents: (args, env = {}) => runCli(args, { cwd: project, env, home }),
    home,
    project,
  };
}

async function runCli(
  args: string[],
  options: { cwd: string; home: string; env: Record<string, string> }
): Promise<CliResult> {
  // Only what the CLI needs, so the developer's own harness settings cannot leak into a test.
  const env = {
    HOME: options.home,
    PATH: process.env.PATH ?? "",
    XDG_CACHE_HOME: path.join(options.home, ".cache"),
    ...options.env,
  };

  try {
    const result = await run("node", [Entry, ...args], { cwd: options.cwd, env });

    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    if (isExitError(error)) {
      return { code: error.code, stderr: error.stderr, stdout: error.stdout };
    }

    throw error;
  }
}

function isExitError(error: unknown): error is { code: number; stdout: string; stderr: string } {
  return error instanceof Error && "code" in error && Number.isInteger(error.code);
}
