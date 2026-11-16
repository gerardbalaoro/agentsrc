import { styleText } from "node:util";
import type { InspectColor } from "node:util";

import { log, note, spinner } from "@clack/prompts";
import { confirm, multiselect } from "@crustjs/prompts";

import type { ConfigValue } from "#util/config-value.ts";

/** All terminal output and prompts. Results go to stdout; everything else goes to stderr. */
export const Ui = {
  /** Asks a yes or no question. Call it only when `isInteractive` is true. */
  async confirm(message: string) {
    return await confirm({ default: false, message });
  },

  style(format: InspectColor | InspectColor[], text: string, enabled = true) {
    const forced = process.env.FORCE_COLOR;

    const supported =
      forced === undefined
        ? Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb"
        : forced !== "0";

    if (!enabled || process.env.NO_COLOR !== undefined || !supported) {
      return text;
    }

    return styleText(format, text, { validateStream: false });
  },

  success(message: string) {
    log.success(message, { output: process.stdout, withGuide: false });
  },

  note(message: string, title: string) {
    note(message, title, { output: process.stdout, withGuide: false });
  },

  spinner() {
    return spinner({ output: process.stderr, withGuide: false });
  },

  info(message: string) {
    process.stderr.write(`${message}\n`);
  },

  /** True when a person can answer a prompt. */
  isInteractive() {
    return Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI;
  },

  json(value: ConfigValue) {
    process.stdout.write(`${JSON.stringify(value, undefined, 2)}\n`);
  },

  /** Prints a result line, such as one row of `list`. */
  print(message: string) {
    process.stdout.write(`${message}\n`);
  },

  /** Asks the user to pick from a list. Call it only when `isInteractive` is true. */
  async select(message: string, choices: string[]) {
    return await multiselect({ choices, message, required: true });
  },

  /** Init imports may be skipped entirely. */
  async selectOptional(message: string, choices: string[]) {
    return await multiselect({ choices, message, required: false });
  },

  warn(message: string) {
    process.stderr.write(`warning: ${message}\n`);
  },
};
