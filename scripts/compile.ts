import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import packageJson from "../package.json" with { type: "json" };

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

if (platform !== native) {
  throw new Error(
    `AoT compilation for ${platform} requires a native runner; this host is ${native}.`
  );
}

const extension = platform.startsWith("windows") ? ".exe" : "";
const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "release");
const staging = await mkdtemp(path.join(tmpdir(), "agentsrc-binary-"));
const run = promisify(execFile);

try {
  await mkdir(output, { recursive: true });
  const executable = path.join(staging, `arc${extension}`);

  const result = await Bun.build({
    entrypoints: [path.join(root, "src/index.ts")],
    compile: {
      aot: true,
      // Dependency globals make automatic trimming conservative. Native CI checks these exclusions.
      trim: {
        remove: [
          "cli",
          "bundler",
          "test",
          "inspector",
          "profiler",
          "image",
          "sqlite",
          "sql",
          "redis",
          "s3",
          "html-rewriter",
          "ffi",
          "native-addons",
          "native-code",
          "shell",
          "webview",
          "serve",
          "http2",
          "http3",
          "websocket",
          "udp",
          "worker",
          "node-vm",
          "bun-jsc",
          "plugin",
          "fs-router",
          "terminal",
          "cron",
          "secrets",
          "markdown",
          "password",
          "temporal",
          "repl",
          "dialogs",
        ],
      },
      outfile: executable,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    minify: true,
  });

  if (!result.success) {
    throw new AggregateError(result.logs, "Failed to compile arc.");
  }

  const version = await run(executable, ["--version"], { cwd: staging });

  if (version.stdout.trim() !== `arc v${packageJson.version}`) {
    throw new Error("Compiled version does not match package.json.");
  }

  const aliases = ["agents", "agentsrc"].map((name) => `${name}${extension}`);
  // Tar records hard links without another copy of the executable's payload.
  await Promise.all(aliases.map((name) => link(executable, path.join(staging, name))));

  await copyFile(
    path.join(root, "src/interactive/termcn/LICENSE"),
    path.join(staging, "termcn-LICENSE.txt")
  );

  const name = `agentsrc-v${packageJson.version}-${platform}.tar.gz`;
  const archive = path.join(output, name);
  // GNU tar treats the colon in an absolute Windows archive path as a remote host separator.
  await run(
    "tar",
    ["-czf", name, "-C", staging, `arc${extension}`, ...aliases, "termcn-LICENSE.txt"],
    { cwd: output }
  );

  const checksum = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");

  await writeFile(`${archive}.sha256`, `${checksum}  ${name}\n`);
  process.stdout.write(`${archive}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
