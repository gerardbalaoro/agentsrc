import { expect, test } from "bun:test";

import { render } from "ink-testing-library";

import { Manager } from "#interactive/app.tsx";
import { createTempDir, readFileText, writeFiles } from "#test/support/temp.ts";

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }

    // React and Ink flush input asynchronously.
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(10);
  }

  expect(check()).toBe(true);
}

test("hidden selections still appear in previews and Escape cancels without writes", async () => {
  const root = await createTempDir();
  await writeFiles(root, {
    ".claude/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nAlpha.",
  });
  const app = render(<Manager initialGlobal={false} cwd={root} />);

  try {
    await waitFor(() => app.lastFrame()?.includes("alpha") ?? false);
    app.stdin.write(" ");
    await waitFor(() => app.lastFrame()?.includes("1 selected") ?? false);
    app.stdin.write("2");
    await waitFor(() => app.lastFrame()?.includes("1 outside") ?? false);
    app.stdin.write("s");
    await waitFor(() => app.lastFrame()?.includes("Preview sync · entire scope") ?? false);
    app.stdin.write("\u001B");
    await waitFor(
      () =>
        (app.lastFrame()?.includes("1 outside") && app.lastFrame()?.includes("m actions")) || false
    );
    await Bun.sleep(100);
    app.stdin.write("m");
    await waitFor(() => app.lastFrame()?.includes("Actions for 1 marked entry") ?? false);
    app.stdin.write("i");
    await waitFor(() => app.lastFrame()?.includes("Preview import") ?? false);
    expect(app.lastFrame()).toContain("alpha");
    app.stdin.write("\u001B");
    await waitFor(() => !app.lastFrame()?.includes("Preview import"));
    expect(await Bun.file(`${root}/.agents/agents.toml`).exists()).toBe(false);
  } finally {
    app.unmount();
  }
});

test("the MCP form edits fields and saves only after approving its preview", async () => {
  const root = await createTempDir();
  const app = render(<Manager initialGlobal={false} cwd={root} />);

  try {
    await waitFor(() => app.lastFrame()?.includes("No entries match") ?? false);
    app.stdin.write("2");
    await waitFor(() => app.lastFrame()?.includes("2 MCPs") ?? false);
    app.stdin.write("a");
    await waitFor(() => app.lastFrame()?.includes("Name · 1/8") ?? false);

    for (const [index, [label, value]] of [
      ["Name", "server"],
      ["Type", "command"],
      ["Source", "server-command"],
      ["Arguments", "[]"],
      ["Environment", "{}"],
      ["Headers", "{}"],
      ["Transport", "http"],
      ["Harnesses", "claude-code"],
    ].entries()) {
      // The next keystroke must wait for the preceding field update.
      // oxlint-disable-next-line no-await-in-loop
      await waitFor(() => app.lastFrame()?.includes(`${label} · ${index + 1}/8`) ?? false);
      app.stdin.write("\u0015");
      // The next keystroke must wait for the preceding field update.
      // oxlint-disable-next-line no-await-in-loop
      await waitFor(() => /^\s*█\s*$/mu.test(app.lastFrame() ?? ""));
      app.stdin.write(value ?? "");
      // The next keystroke must wait for the preceding field update.
      // oxlint-disable-next-line no-await-in-loop
      await waitFor(() => app.lastFrame()?.includes(`${value}█`) ?? false);
      app.stdin.write(label === "Harnesses" ? "\r" : "\t");
    }

    await waitFor(() => app.lastFrame()?.includes("Preview add") ?? false);
    expect(await Bun.file(`${root}/.agents/agents.toml`).exists()).toBe(false);
    app.stdin.write("\u001B");
    await waitFor(() => app.lastFrame()?.includes("Harnesses · 8/8") ?? false);
    expect(app.lastFrame()).toContain("claude-code");
    await Bun.sleep(100);
    app.stdin.write("\r");
    await waitFor(() => app.lastFrame()?.includes("Preview add") ?? false);
    app.stdin.write("\r");
    await waitFor(() => app.lastFrame()?.includes("Batch results") ?? false);
    expect(JSON.parse(await readFileText(root, ".mcp.json")).mcpServers.server.command).toBe(
      "server-command"
    );
  } finally {
    app.unmount();
  }
});

test("search edits at the cursor without triggering inventory commands", async () => {
  const root = await createTempDir();
  await writeFiles(root, {
    ".claude/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nAlpha.",
    ".claude/skills/alpine/SKILL.md": "---\nname: alpine\ndescription: Alpine\n---\nAlpine.",
  });
  const app = render(<Manager initialGlobal={false} cwd={root} />);

  try {
    await waitFor(() => app.lastFrame()?.includes("alpine") ?? false);
    app.stdin.write("/");
    await Bun.sleep(30);
    app.stdin.write("alpa");
    await waitFor(() => app.lastFrame()?.includes("No entries match") ?? false);
    app.stdin.write("\u001B[D");
    await Bun.sleep(30);
    app.stdin.write("h");
    await waitFor(() => app.lastFrame()?.includes("alpha") ?? false);
    expect(app.lastFrame()).not.toContain("alpine");
    app.stdin.write("\r");
    await waitFor(() => !app.lastFrame()?.includes("alpha█"));
    app.stdin.write("2");
    await waitFor(() => app.lastFrame()?.includes("Search mcp") ?? false);
    app.stdin.write("1");
    await waitFor(() => app.lastFrame()?.includes("❯ [ ] alpha") ?? false);
    expect(app.lastFrame()).not.toContain("alpine");
    app.stdin.write("/");
    await waitFor(() => app.lastFrame()?.includes("alpha█") ?? false);
    app.stdin.write("\u0015");
    await waitFor(() => app.lastFrame()?.includes("alpine") ?? false);
    app.stdin.write("\r");
    await Bun.sleep(30);
    app.stdin.write(" ");
    await waitFor(() => app.lastFrame()?.includes("1 selected") ?? false);
    expect(await Bun.file(`${root}/.agents/agents.toml`).exists()).toBe(false);
  } finally {
    app.unmount();
  }
});

test("skill selection previews every marked skill without saving on cancel", async () => {
  const root = await createTempDir();
  const source = `${root}/sources/${"nested-".repeat(10)}skills`;
  await writeFiles(source, {
    "alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nAlpha.",
    "bravo/SKILL.md": "---\nname: bravo\ndescription: Releases and changelogs\n---\nBravo.",
  });
  const app = render(<Manager initialGlobal={false} cwd={root} />);

  Object.defineProperty(app.stdout, "columns", { value: 80 });
  app.stdout.emit("resize");

  try {
    await waitFor(() => app.lastFrame()?.includes("No entries match") ?? false);
    app.stdin.write("a");
    await waitFor(() => app.lastFrame()?.includes("Source · 1/3") ?? false);
    app.stdin.write(source);
    await waitFor(() => app.lastFrame()?.includes("skills█") ?? false);
    expect(app.lastFrame()?.split("\n")).toHaveLength(24);
    expect(
      app
        .lastFrame()
        ?.split("\n")
        .every((line) => [...line].length <= 80)
    ).toBe(true);
    app.stdin.write("\t");
    await waitFor(() => app.lastFrame()?.includes("Harnesses · 2/3") ?? false);
    app.stdin.write("\t");
    await waitFor(() => app.lastFrame()?.includes("Install mode · 3/3") ?? false);
    app.stdin.write("\r");
    await waitFor(() => app.lastFrame()?.includes("Choose skills · 0 selected") ?? false);
    // The newly mounted selector registers its input handler after the first frame.
    await Bun.sleep(50);
    app.stdin.write(" ");
    await waitFor(() => app.lastFrame()?.includes("Choose skills · 1 selected") ?? false);
    app.stdin.write("\u001B[B");
    await Bun.sleep(30);
    app.stdin.write(" ");
    await waitFor(() => app.lastFrame()?.includes("Choose skills · 2 selected") ?? false);
    app.stdin.write("\r");
    await waitFor(() => app.lastFrame()?.includes("Preview add · 2 entries") ?? false);
    app.stdin.write("\u001B");
    await waitFor(() => !app.lastFrame()?.includes("Preview add"));
    expect(await Bun.file(`${root}/.agents/agents.toml`).exists()).toBe(false);
    expect(await Bun.file(`${root}/.agents/skills/alpha/SKILL.md`).exists()).toBe(false);
    expect(await Bun.file(`${root}/.agents/skills/bravo/SKILL.md`).exists()).toBe(false);
  } finally {
    app.unmount();
  }
});

test("the minimum terminal size keeps selection and shortcut controls visible", async () => {
  const root = await createTempDir();
  await writeFiles(root, {
    ".claude/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nAlpha.",
  });
  const app = render(<Manager initialGlobal={false} cwd={root} />);
  Object.defineProperty(app.stdout, "columns", { value: 48 });
  Object.defineProperty(app.stdout, "rows", { value: 18 });
  app.stdout.emit("resize");

  try {
    await waitFor(() => app.lastFrame()?.includes("alpha") ?? false);
    app.stdin.write(" ");
    await waitFor(() => app.lastFrame()?.includes("1 selected") ?? false);
    expect(app.lastFrame()?.split("\n")).toHaveLength(18);
    expect(
      app
        .lastFrame()
        ?.split("\n")
        .every((line) => [...line].length <= 48)
    ).toBe(true);
    expect(app.lastFrame()).toContain("space");
    expect(app.lastFrame()).toContain("help");
    expect(app.lastFrame()).toContain("add");
    expect(app.lastFrame()).not.toMatch(/[╭╮╰╯┌┐└┘│┬┴┼]/u);
    app.stdin.write("a");
    await waitFor(() => app.lastFrame()?.includes("Source · 1/3") ?? false);
    expect(app.lastFrame()).toContain("enter");
    expect(app.lastFrame()).toContain("esc");
    expect(app.lastFrame()?.split("\n")).toHaveLength(18);
    expect(await Bun.file(`${root}/.agents/agents.toml`).exists()).toBe(false);
  } finally {
    app.unmount();
  }
});

test("entry details offer import without changing files before approval", async () => {
  const root = await createTempDir();
  await writeFiles(root, {
    ".claude/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nAlpha.",
    ".claude/skills/bravo/SKILL.md":
      "---\nname: bravo\ndescription: Releases and changelogs\n---\nBravo.",
  });
  const app = render(<Manager initialGlobal={false} cwd={root} />);

  try {
    await waitFor(() => app.lastFrame()?.includes("alpha") ?? false);
    app.stdin.write(" ");
    await waitFor(() => app.lastFrame()?.includes("1 selected") ?? false);
    app.stdin.write("\u001B[B");
    await Bun.sleep(30);
    app.stdin.write("\r");
    await waitFor(() => app.lastFrame()?.includes("enter actions") ?? false);
    expect(app.lastFrame()).toMatch(/\n +Releases and changelogs *\n *\n +Configuration/u);
    expect(app.lastFrame()).toContain("enter actions");
    app.stdin.write("i");
    await waitFor(() => app.lastFrame()?.includes("Preview import") ?? false);
    expect(app.lastFrame()).toContain("skill · bravo");
    expect(app.lastFrame()).not.toContain("skill · alpha");
    expect(await Bun.file(`${root}/.agents/agents.toml`).exists()).toBe(false);
    app.stdin.write("\u001B");
    await waitFor(() => !app.lastFrame()?.includes("Preview import"));
    expect(await Bun.file(`${root}/.agents/agents.toml`).exists()).toBe(false);
  } finally {
    app.unmount();
  }
});

test("Page Down advances one visible page of two-line entries", async () => {
  const root = await createTempDir();

  const files = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => {
      const name = `skill-${String(index + 1).padStart(2, "0")}`;

      return [
        `.claude/skills/${name}/SKILL.md`,
        `---\nname: ${name}\ndescription: Skill\n---\nSkill.`,
      ];
    })
  );

  await writeFiles(root, files);
  const app = render(<Manager initialGlobal={false} cwd={root} />);

  try {
    await waitFor(() => app.lastFrame()?.includes("❯ [ ] skill-01") ?? false);
    app.stdin.write("\u001B[6~");
    await waitFor(() => app.lastFrame()?.includes("❯ [ ] skill-07") ?? false);
    app.stdin.write("\u001B[5~");
    await waitFor(() => app.lastFrame()?.includes("❯ [ ] skill-01") ?? false);
  } finally {
    app.unmount();
  }
});

test("details expose readable fields and an action menu without exposing credentials or applying changes", async () => {
  const root = await createTempDir();
  await writeFiles(root, {
    ".agents/agents.toml":
      'agents = ["claude-code"]\n[mcp.db]\ncommand = "database-server"\nenv = { TOKEN = "private-token" }\n',
    ".agents/agents.lock": '{"version":1,"skills":[],"mcp":{"db":{"hash":"previous"}}}',
    ".mcp.json":
      '{"mcpServers":{"db":{"command":"database-server","env":{"TOKEN":"private-token"}}}}',
  });
  const app = render(<Manager initialGlobal={false} cwd={root} />);

  try {
    await waitFor(() => app.lastFrame()?.includes("No entries match") ?? false);
    app.stdin.write("2");
    await waitFor(() => app.lastFrame()?.includes("❯ [ ] db") ?? false);
    app.stdin.write("\r");
    await waitFor(() => app.lastFrame()?.includes("Configuration") ?? false);
    expect(app.lastFrame()).toContain("enter actions");
    expect(app.lastFrame()).toContain("Command");
    expect(app.lastFrame()).toContain("database-server");
    expect(app.lastFrame()).not.toContain("private-token");
    expect(app.lastFrame()).toContain("[hidden]");
    expect(app.lastFrame()).not.toContain("0 selected");
    expect(app.lastFrame()).not.toContain("Search mcp");
    Object.defineProperty(app.stdout, "columns", { value: 48 });
    Object.defineProperty(app.stdout, "rows", { value: 18 });
    app.stdout.emit("resize");
    await waitFor(() => app.lastFrame()?.split("\n").length === 18);
    expect(
      app
        .lastFrame()
        ?.split("\n")
        .every((line) => [...line].length <= 48)
    ).toBe(true);
    app.stdin.write("\u001B[6~");
    await waitFor(() => app.lastFrame()?.includes("[hidden]") ?? false);
    app.stdin.write("\r");
    await waitFor(() => app.lastFrame()?.includes("Actions for db") ?? false);
    app.stdin.write("\u001B[B");
    await waitFor(() => app.lastFrame()?.includes("❯ Repair") ?? false);
    app.stdin.write("\u001B[B");
    await waitFor(() => app.lastFrame()?.includes("❯ Remove") ?? false);
    app.stdin.write("\r");
    await waitFor(() => app.lastFrame()?.includes("Preview remove") ?? false);
    app.stdin.write("\u001B");
    await waitFor(() => app.lastFrame()?.includes("❯ Remove") ?? false);
    await Bun.sleep(100);
    app.stdin.write("\u001B");
    await waitFor(() => app.lastFrame()?.includes("Configuration") ?? false);
    expect(await readFileText(root, ".mcp.json")).toContain("database-server");
    expect(await readFileText(root, ".agents/agents.toml")).toContain("[mcp.db]");
  } finally {
    app.unmount();
  }
});
