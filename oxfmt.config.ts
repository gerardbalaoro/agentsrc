import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Installed skills must stay byte-identical to their source, or the lock hash changes.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), ".agents/skills", ".claude/skills"],
  printWidth: 100,
  proseWrap: "always",
});
