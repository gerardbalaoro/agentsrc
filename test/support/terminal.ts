import assert from "node:assert/strict";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

interface TerminalOptions {
  command: string[];
  cwd: string;
  home: string;
  mode: "batch" | "scope" | "ctrlc" | "global";
  env?: Record<string, string | undefined>;
  afterExit?: (terminal: Bun.Terminal) => void;
}

/** Drives the real CLI in a PTY, including the OS terminal state before and after exit. */
export async function driveTerminal(options: TerminalOptions) {
  let output = "";
  const decoder = new TextDecoder();

  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 24,
    data(_, bytes) {
      output += decoder.decode(bytes, { stream: true });
    },
  });

  const env = terminalEnvironment(options);
  let child: Bun.Subprocess | undefined;

  async function waitFor(text: string, offset = 0) {
    const deadline = Date.now() + 12_000;

    while (Date.now() < deadline) {
      if (stripVTControlCharacters(output.slice(offset)).includes(text)) {
        return;
      }

      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        break;
      }

      // Wait for real PTY output; each check depends on the preceding read.
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(20);
    }

    throw new Error(`Missing ${JSON.stringify(text)}; terminal output: ${output.slice(-5000)}`);
  }

  async function send(value: string, expected: string) {
    const offset = output.length;
    terminal.write(value);
    await waitFor(expected, offset);

    return offset;
  }

  try {
    const before = terminalFlags(terminal);
    child = Bun.spawn(options.command, {
      cwd: options.cwd,
      env,
      terminal,
      detached: true,
      timeout: 25_000,
      killSignal: "SIGKILL",
    });
    await waitFor(options.mode === "global" ? "global-style" : "alpha");

    if (options.mode === "batch") {
      await send(" ", "1 selected");
      await send("2", "db");
      await send(" ", "2 selected");
      await send("i", "Preview import");
      const manifest = path.join(options.cwd, ".agents/agents.toml");
      assert.equal(
        await Bun.file(manifest).exists(),
        false,
        "preview wrote a manifest before approval"
      );
      await send("\r", "Batch results");
      await waitFor("success · alpha");
      await waitFor("success · db");
      assert.equal(
        await Bun.file(manifest).exists(),
        true,
        "approved batch did not create a manifest"
      );
      const text = await Bun.file(manifest).text();
      assert.ok(text.includes("alpha") && text.includes("db"), text);
      await waitFor("Failed entries remain selected for retry.");
      await send("\u001B", "db");
    } else if (options.mode === "scope") {
      await send(" ", "1 selected");
      const offset = await send("g", "global-style");
      // A resize paints a full frame instead of just the changed selection digit.
      terminal.resize(100, 25);
      process.kill(-child.pid, "SIGWINCH");
      await waitFor("0 selected", offset);
      await send("g", "alpha");
    }

    const offset = output.length;
    terminal.resize(120, 30);
    process.kill(-child.pid, "SIGWINCH");
    await waitFor("Skills & MCPs", offset);
    terminal.write(options.mode === "ctrlc" ? "\u0003" : "q");
    const exit = await child.exited;
    options.afterExit?.(terminal);
    const after = terminalFlags(terminal);
    assertTerminalColors(output, options.env?.NO_COLOR === undefined);

    const result = {
      exit,
      alternateScreenEntered: output.includes("\u001B[?1049h"),
      alternateScreenRestored: output.includes("\u001B[?1049l"),
      cursorRestored: output.includes("\u001B[?25h"),
      terminalRestored: before === after,
    };

    assert.equal(exit, 0, output.slice(-5000));
    assert.ok(result.alternateScreenEntered, "alternate screen was not entered");
    assert.ok(result.alternateScreenRestored, "alternate screen was not restored");
    assert.ok(result.cursorRestored, "cursor was not restored");
    assert.ok(result.terminalRestored, `PTY state changed: ${before} -> ${after}`);

    return result;
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }

    terminal.close();
  }
}

function terminalFlags(terminal: Bun.Terminal) {
  assert.equal(terminal.closed, false, "PTY closed before its flags could be checked");

  const flags = [
    terminal.inputFlags,
    terminal.outputFlags,
    terminal.controlFlags,
    terminal.localFlags,
  ];

  assert.notEqual(terminal.controlFlags, 0, "Could not read PTY flags");

  return flags.join(":");
}

function terminalEnvironment(options: TerminalOptions) {
  const env = {
    ...process.env,
    ...options.env,
    HOME: options.home,
    USERPROFILE: options.home,
    XDG_CACHE_HOME: path.join(options.home, ".cache"),
    TERM: "xterm-256color",
    FORCE_COLOR: options.env?.NO_COLOR === undefined ? "1" : "0",
  };

  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "CI",
  ]) {
    Reflect.deleteProperty(env, name);
  }

  if (options.env?.NO_COLOR === undefined) {
    Reflect.deleteProperty(env, "NO_COLOR");
  }

  return env;
}

function assertTerminalColors(output: string, enabled: boolean) {
  let accent = false;

  // Use terminal foreground colors; never paint backgrounds or a custom RGB palette.
  // oxlint-disable-next-line no-control-regex -- Inspect the actual terminal SGR escapes.
  for (const match of output.matchAll(/\u001B\[(?<sgr>[\d;]*)m/gu)) {
    const codes = (match.groups?.sgr ?? "").split(";").map(Number);

    const fixed = codes.some(
      (code) =>
        code === 38 || code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)
    );

    assert.equal(fixed, false, `UI set a background or custom palette color: ${match[0]}`);

    const foreground = codes.some(
      (code) => (code >= 30 && code <= 37) || (code >= 90 && code <= 97)
    );

    if (!enabled) {
      assert.equal(foreground, false, "NO_COLOR still emitted foreground colors");
    }

    accent ||= codes.includes(36);
  }

  assert.equal(accent, enabled, "Active navigation must use cyan unless NO_COLOR is set");
}
