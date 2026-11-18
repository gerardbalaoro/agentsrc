import { copyFile, rm } from "node:fs/promises";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  target: "node",
  outdir: "./dist",
  splitting: true,
  // Ink's optional debugger stays in an unloaded chunk; users do not need React DevTools.
  external: ["react-devtools-core"],
  banner: "#!/usr/bin/env node",
});

if (!result.success) {
  throw new AggregateError(result.logs, "Failed to build arc.");
}

await copyFile("src/interactive/termcn/LICENSE", "dist/termcn-LICENSE.txt");
