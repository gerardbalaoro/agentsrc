# agentsrc

agentsrc installs agent skills and MCP servers from one manifest into every AI harness a project
uses. It supports Claude Code, Codex and OpenCode v2.

Skill handling is compatible with the [skills.sh CLI](https://github.com/vercel-labs/skills). Both
tools read and write the same lock file.

## Installation

agentsrc needs Node 20 or later.

```bash
npm install -g agentsrc
```

The npm package provides `arc` and `agentsrc`. Both run the same CLI. You can also run it without
installing globally:

```bash
npx agentsrc init
```

Standalone releases provide only `arc` and do not require Node or Bun. Install them with mise:

```bash
mise use -g github:gerardbalaoro/agentsrc
```

## Getting Started

```bash
arc init
arc sync --force
```

`init` detects project harnesses and lets you choose existing skills and MCP servers to import. Use
`arc init -g` for global configuration and imports. The two scopes are inspected separately.
Existing harness files remain unchanged until you sync; `--force` adopts the imports you chose.

To inspect candidates or initialize without prompts:

```bash
arc init --list
arc init --mcp codex:db --skill style
arc init --yes
```

`--yes` creates a manifest with detected harnesses and no imports unless you select them explicitly.
Use `--skill '*'` or `--mcp '*'` to select all candidates of that kind. Conflicting names require an
explicit origin such as `codex:db`. `init` never overwrites an existing manifest.

## Manifest

The manifest is `.agents/agents.toml` in a project, or `~/.agents/agents.toml` with `-g`.

```toml
extends = ["https://example.com/team/agents.toml"]
agents = ["claude-code", "codex", "opencode"]

[skills]
frontend-design = "vercel-labs/agent-skills"
pdf = { source = "anthropics/skills", ref = "v1.2.0" }

[mcp.context7]
package = "npm:@upstash/context7-mcp"
version = "^1"
env = { CONTEXT7_API_KEY = "${CONTEXT7_API_KEY}" }

[mcp.linear]
url = "https://mcp.linear.app/mcp"
headers = { Authorization = "Bearer ${LINEAR_TOKEN}" }
```

A `${VAR}` reference is never resolved into a file. agentsrc rewrites it into each harness's own
reference syntax.

## Commands

| Command                           | Result                                                       |
| --------------------------------- | ------------------------------------------------------------ |
| `arc init [-g]`                   | Detect harnesses, choose imports and create the manifest.    |
| `arc sync`                        | Installs skills, then MCP servers, from the manifest.        |
| `arc skills add <source>`         | Adds skills to the manifest and installs them.               |
| `arc skills install`              | Installs the skills in the manifest.                         |
| `arc skills update [names...]`    | Fetches skills again and reinstalls the ones that changed.   |
| `arc skills list`                 | Lists skills and their status.                               |
| `arc skills remove <names...>`    | Removes skills from the manifest and the harnesses.          |
| `arc mcp add <package or URL>`    | Adds an MCP server to the manifest and installs it.          |
| `arc mcp add <name> -- <command>` | Adds a server that runs a local command.                     |
| `arc mcp install`                 | Writes the servers in the manifest into each harness config. |
| `arc mcp update [names...]`       | Moves package servers to the newest version in range.        |
| `arc mcp list`                    | Lists MCP servers and their status.                          |
| `arc mcp remove <names...>`       | Removes servers from the manifest and the harness configs.   |

Every command accepts `-g` for global scope, `-a <harness>` to limit the run, `-y` to skip prompts
and `--dry-run` to print the plan. Run `arc <command> --help` for the other flags.

`sync` and `install` are frozen when `CI` is set: they fail, and write nothing, if anything is out
of date.

Untracked skills and MCP servers require `--force` before agentsrc takes ownership. Unmarked harness
copies are preserved during cleanup; use `--force` to replace them explicitly.

`arc mcp list` reports incompatible entries as `unsupported`, explains why, and continues listing
the other servers. Installation still rejects incompatible entries before writing files.
