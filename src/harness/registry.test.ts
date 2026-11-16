import { expect, test } from "bun:test";

import { Adapters } from "#harness/registry.ts";

test("the harness registry exposes supported usage capabilities", () => {
  expect(Adapters.codex.usage?.provider).toBe("codex");
  expect(Adapters["claude-code"].usage?.provider).toBe("claude");
  expect(Adapters.opencode.usage?.provider).toBe("opencode");
});
