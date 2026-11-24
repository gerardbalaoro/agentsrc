import { z } from "zod";

import { UsageError } from "#errors.ts";
import {
  incompleteServerSource,
  MissingMcpNameError,
  parseAddRequest,
  parsePackageSpec,
  validateServerUrl,
} from "#mcp/spec.ts";
import type { AddRequest, NamedEntry } from "#mcp/spec.ts";
import { Ui } from "#ui.ts";

const ServerTypes = [
  { value: "package", label: "npm package" },
  { value: "url", label: "Remote URL" },
  { value: "command", label: "Local command" },
] as const;

const ArgumentsSchema = z.array(z.string());

/** Fills in required input before the command opens the workspace. */
export async function completeAddRequest(
  request: AddRequest,
  { canPrompt, isCommand, signal }: { canPrompt: boolean; isCommand: boolean; signal: AbortSignal }
): Promise<NamedEntry | null> {
  const needsSource = isCommand
    ? !request.command[0]?.trim()
    : !request.spec.trim() || incompleteServerSource(request.spec) !== undefined;

  let completed: AddRequest | null = request;

  if (needsSource) {
    if (!canPrompt) {
      throw new UsageError(
        isCommand
          ? "Pass an executable after `--`. Run `arc mcp add --help` for examples."
          : "Pass an npm package, an HTTP(S) URL, or a name followed by `-- <command>`. Run `arc mcp add --help` for examples."
      );
    }

    completed = await promptForSource(request, isCommand, signal);
  }

  if (completed === null) {
    return null;
  }

  try {
    return parseAddRequest(completed);
  } catch (error) {
    if (!canPrompt || !(error instanceof MissingMcpNameError)) {
      throw error;
    }
  }

  const name = await Ui.text({
    message: "Server name",
    placeholder: "my-tools",
    signal,
    validate: (value) => (value?.trim() ? undefined : "Enter a server name."),
  });

  return name === null ? null : parseAddRequest({ ...completed, name: name.trim() });
}

async function promptForSource(
  request: AddRequest,
  isCommand: boolean,
  signal: AbortSignal
): Promise<AddRequest | null> {
  const type = isCommand ? "command" : await chooseServerType(request, signal);

  switch (type) {
    case "command": {
      const command = await promptForCommand(request.command.slice(1), signal);

      return command === null ? null : { ...request, command };
    }

    case "package": {
      const spec = await Ui.text({
        message: "npm package",
        placeholder: "@upstash/context7-mcp",
        signal,
        validate: (value) => validationMessage(value, parsePackageSpec),
      });

      return spec === null ? null : { ...request, spec: spec.trim() };
    }

    case "url": {
      const spec = await Ui.text({
        message: "Server URL",
        placeholder: "https://mcp.example.com/mcp",
        signal,
        validate: (value) => validationMessage(value, validateServerUrl),
      });

      return spec === null ? null : { ...request, spec: spec.trim() };
    }

    default: {
      return null;
    }
  }
}

async function chooseServerType(request: AddRequest, signal: AbortSignal) {
  const hint = incompleteServerSource(request.spec);

  if (hint) {
    return hint;
  }

  if (request.transport || Object.keys(request.headers).length) {
    return "url";
  }

  const hasEnv = Object.keys(request.env).length > 0;

  return await Ui.pick(
    "Server type",
    ServerTypes.filter(({ value }) => !hasEnv || value !== "url"),
    signal
  );
}

function validationMessage(value: string | undefined, validate: (value: string) => void) {
  try {
    validate(value?.trim() ?? "");
  } catch (error) {
    if (error instanceof UsageError) {
      return error.message;
    }

    throw error;
  }
}

async function promptForCommand(args: string[], signal: AbortSignal) {
  const executable = await Ui.text({
    message: "Executable (without arguments)",
    placeholder: "node",
    signal,
    validate: (value) => (value?.trim() ? undefined : "Enter an executable."),
  });

  if (executable === null) {
    return null;
  }

  if (args.length > 0) {
    return [executable.trim(), ...args];
  }

  const input = await Ui.text({
    message: "Command arguments (optional JSON array)",
    placeholder: '["./server.js", "--port", "3000"]',
    signal,
    validate: (value) => {
      try {
        ArgumentsSchema.parse(JSON.parse(value?.trim() || "[]"));
      } catch {
        return "Enter a JSON array of strings, or leave this blank.";
      }
    },
  });

  return input === null
    ? null
    : [executable.trim(), ...ArgumentsSchema.parse(JSON.parse(input.trim() || "[]"))];
}
