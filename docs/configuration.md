# Configuration

Define project skills and MCP servers in `.agents/agents.toml`. For global configuration, use
`~/.agents/agents.toml` and add `-g` to commands.

```toml
extends = ["https://example.com/team/agents.toml"]
agents = ["claude-code", "codex", "opencode"]

[skills]
web-design-guidelines = "vercel-labs/agent-skills"

[mcp.context7]
package = "npm:@upstash/context7-mcp"
```

All top-level fields are optional. Unknown fields are rejected.

| Field     | Purpose                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `agents`  | Select coding agents; defaults to detection on this machine.                                         |
| `extends` | Reuse manifests from local paths or URLs, in order.                                                  |
| `skills`  | Declare skills by installed name. See [Skills](skills.md) for sources and options.                   |
| `mcp`     | Declare servers by name. See [MCP Servers](mcp.md) for packages, commands, URLs, and authentication. |

## Apply Configuration

After editing the manifest or pulling a teammate's changes, run:

```bash
arc sync
```

This installs skills, then MCP servers. Use `arc skills install` or `arc mcp install` to apply only
one feature. See the [Skills](skills.md#import-existing-skills) and
[MCP Servers](mcp.md#import-existing-servers) guides to import an existing setup.

## Scope and Flags

Project commands use the nearest ancestor containing `.agents/agents.toml`, or the current directory
when none exists. Global commands use `~/.agents/agents.toml`. The scopes are managed separately.

The `init`, `sync`, `skills`, and `mcp` commands accept these flags:

| Flag                 | Effect                                                             |
| -------------------- | ------------------------------------------------------------------ |
| `-g`, `--global`     | Manage global configuration.                                       |
| `-a`, `--agent <id>` | Limit selected agents. Repeat the flag or use comma-separated IDs. |
| `-y`, `--yes`        | Skip confirmation prompts.                                         |
| `--dry-run`          | Print the plan without changing managed files.                     |

`arc usage` has separate options and does not require a manifest. The npm installation provides
`arc` and `agentsrc`; standalone archives also provide `agents`.

## Agent Selection

Supported IDs are `claude-code`, `codex`, and `opencode` (OpenCode v2).

An entry's `agents` array replaces the top-level selection for that entry. Without either selection,
agentsrc uses detected agents. `--agent` limits the result; if the manifest has no selection, the
flag selects agents directly. An empty `agents = []` selects no agents.

See [skill installation](skills.md#configuration) for shared skill visibility and
[MCP compatibility](mcp.md#agent-compatibility) for agent-specific limits.

## Shared Configuration

Put `extends` at the top of the manifest, before any tables:

```toml
extends = ["../team.toml", "https://example.com/company/agents.toml"]
agents = ["claude-code", "codex"]

[skills]
unused-skill = false

[mcp.context7]
package = "npm:@upstash/context7-mcp"
version = "^1"
agents = ["codex"]
```

Extended manifests load in array order, followed by your manifest. Later entries replace earlier
entries with the same name in full. The `context7` entry above replaces all inherited fields,
including environment values. An explicit `agents` array also replaces the earlier selection.

Set a skill or MCP entry to `false` to disable an inherited entry:

```toml
[skills]
unused-skill = false

[mcp]
unused-server = false
```

Local `extends` paths resolve relative to the declaring manifest. Remote manifests can extend other
URLs, including relative URLs. They cannot extend local files. Cycles and nesting beyond eight
levels are rejected.

Project configuration does not automatically inherit personal configuration. To reuse a personal
manifest explicitly, add `extends = ["~/.agents/agents.toml"]` to the project manifest.

### Changed Shared Configuration

When a previously locked remote manifest changes, agentsrc shows the changes and asks you to accept
them. Use `--yes` to accept without prompts. Frozen mode rejects added, removed, or changed remote
manifest pins.

If a remote manifest cannot be fetched, agentsrc uses its locked cached copy when available. Without
a cached copy, the command fails; restore network access and try again.

## Files to Commit

Commit `.agents/agents.toml` and `.agents/agents.lock` when present. The manifest describes the
setup; the lock records managed skill names, resolved MCP package versions, and remote manifest
hashes. Global manifests and `agents.lock` live under `~/.agents/`.

For skill lock files and installed copies, see
[skill files and ownership](skills.md#files-and-ownership). For generated agent files, see
[MCP configuration](mcp.md#generated-configuration).

## CI

When `CI` is set, `sync` and `install` without a source use frozen mode. You can request it
explicitly:

```bash
arc sync --frozen-lockfile
```

Frozen mode checks that the manifest, locks, installed skills, and agent entries agree. It fails if
anything needs installing or changing, and does not restore missing files. Commit the installed
files needed by your CI check, or prepare the setup before checking it.

To install on a fresh CI machine, explicitly disable frozen mode:

```bash
arc sync --no-frozen-lockfile --yes
```

This permits file and lock changes. Check the resulting changes if your pipeline requires the
committed setup to stay current.
