import { confirm, multiselect } from "@crustjs/prompts";

import type { ConfigValue } from "#util/config-value.ts";

/** All terminal output and prompts. Results go to stdout; everything else goes to stderr. */
export const Ui = {
  /** Asks a yes or no question. Call it only when `isInteractive` is true. */
  async confirm(message: string) {
    return await confirm({ default: false, message });
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
