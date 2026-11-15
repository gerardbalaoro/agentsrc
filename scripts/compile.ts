import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import packageJson from "../package.json" with { type: "json" };

const Platforms = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "macos-x64": "bun-darwin-x64",
  "macos-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
  "windows-arm64": "bun-windows-arm64",
} as const;

const PlatformSchema = z.enum([
  "linux-x64",
  "linux-arm64",
  "macos-x64",
  "macos-arm64",
  "windows-x64",
  "windows-arm64",
]);

const NativeOS = new Map([
  ["darwin", "macos"],
  ["win32", "windows"],
]);

const native = `${NativeOS.get(process.platform) ?? process.platform}-${process.arch}`;
const platform = PlatformSchema.parse(process.argv[2] ?? native);
const extension = platform.startsWith("windows") ? ".exe" : "";
const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "release");
const staging = await mkdtemp(path.join(tmpdir(), "agentsrc-binary-"));
const run = promisify(execFile);

try {
  await mkdir(output, { recursive: true });
  const executable = path.join(staging, `arc${extension}`);
  await Bun.build({
    entrypoints: [path.join(root, "src/index.ts")],
    compile: {
      target: Platforms[platform],
      outfile: executable,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    minify: true,
  });

  if (platform === native) {
    const result = await run(executable, ["--version"], { cwd: staging });

    if (result.stdout.trim() !== `arc v${packageJson.version}`) {
      throw new Error("Compiled version does not match package.json.");
    }
  }

  const name = `agentsrc-v${packageJson.version}-${platform}.tar.gz`;
  const archive = path.join(output, name);
  await run("tar", ["-czf", archive, "-C", staging, `arc${extension}`]);

  const checksum = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");

  await writeFile(`${archive}.sha256`, `${checksum}  ${name}\n`);
  process.stdout.write(`${archive}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
