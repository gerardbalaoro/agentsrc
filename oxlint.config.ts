import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // The TypeScript standards prefer named function declarations, with helpers below their caller.
    "func-style": ["error", "declaration", { allowArrowFunctions: true }],
    // A `${VAR}` in a plain string is this tool's own reference syntax, not a missed template.
    "no-template-curly-in-string": "off",
    // False positive: an adapter's own `find(scope, name)` is not `Array#find` with a `thisArg`.
    "unicorn/no-array-method-this-argument": "off",
    "no-use-before-define": ["error", { classes: true, functions: false, variables: true }],
  },
});
