import { ClaudeCode } from "#harness/adapters/claude-code.ts";
import { Codex } from "#harness/adapters/codex.ts";
import { OpenCode } from "#harness/adapters/opencode.ts";
import { HarnessIds } from "#harness/ids.ts";
import type { HarnessId } from "#harness/ids.ts";
import type { McpEntry } from "#manifest/schema.ts";
import type { McpServer } from "#mcp/entry.ts";
import type { Scope } from "#scope.ts";
import type { ConfigTable, ConfigValue } from "#util/config-value.ts";

/** A skill as a harness sees it on disk. */
export interface HarnessSkill {
  name: string;
  /** The directory the harness reads. For a linked skill this is the link, not its target. */
  dir: string;
}

/** A skill that agentsrc has installed into `.agents/skills`. */
export interface CanonicalSkill {
  name: string;
  /** The canonical copy, `.agents/skills/<name>`. */
  dir: string;
  /** Copy into the harness directory instead of linking. */
  copy: boolean;
  /** Explicit permission to replace a foreign target. */
  force?: boolean;
}

/** An MCP server as it is in a harness config file, in the harness's own form. */
export interface HarnessServer {
  name: string;
  config: ConfigValue;
}

/**
 * Everything agentsrc knows about one harness. Only an adapter knows the harness's paths and
 * formats. `list` and `find` report what is on disk and never read `agents.lock`.
 */
export interface Adapter {
  id: HarnessId;
  /** True when the harness is installed on this machine. */
  detect: (scope?: Scope) => boolean;
  skills: {
    list: (scope: Scope) => Promise<HarnessSkill[]>;
    find: (scope: Scope, name: string) => Promise<HarnessSkill | undefined>;
    /** Makes a canonical skill available to the harness. */
    add: (scope: Scope, skill: CanonicalSkill) => Promise<void>;
    remove: (scope: Scope, name: string) => Promise<void>;
  };
  mcp: {
    /** Converts a scoped harness config to a manifest entry without resolving references. */
    import: (server: HarnessServer) => McpEntry;
    /** Check write prerequisites before any action is applied. */
    prepare?: (scope: Scope) => Promise<void>;
    list: (scope: Scope) => Promise<HarnessServer[]>;
    find: (scope: Scope, name: string) => Promise<HarnessServer | undefined>;
    /** Converts a server to the harness's own form, or throws. Reads and writes nothing. */
    render: (server: McpServer) => ConfigTable;
    /** Writes the server into the harness config. Returns a description of where it went. */
    add: (scope: Scope, server: McpServer) => Promise<string>;
    remove: (scope: Scope, name: string) => Promise<void>;
  };
}

export const Adapters = {
  "claude-code": ClaudeCode,
  codex: Codex,
  opencode: OpenCode,
} satisfies Record<HarnessId, Adapter>;

export const AllAdapters: Adapter[] = HarnessIds.map((id) => Adapters[id]);

/**
 * The harnesses one entry installs into. `agents` on the entry wins over `agents` in the manifest,
 * which wins over the harnesses detected on this machine. The `--agent` flag then limits the
 * result. When nothing else names a harness, the flag alone decides.
 *
 * The result is empty when nothing is set and nothing is detected.
 */
export function selectAdapters(choice: {
  flag: HarnessId[] | undefined;
  entry: HarnessId[] | undefined;
  manifest: HarnessId[] | undefined;
}): Adapter[] {
  const declared = choice.entry ?? choice.manifest;
  const base = declared ?? choice.flag ?? detectHarnesses();
  const ids = choice.flag ? base.filter((id) => choice.flag?.includes(id)) : base;

  return ids.map((id) => Adapters[id]);
}

export function detectHarnesses(): HarnessId[] {
  return AllAdapters.flatMap((adapter) => (adapter.detect() ? [adapter.id] : []));
}
