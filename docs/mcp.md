# MCP Servers

Add, import, configure, and update MCP servers with `arc mcp`. Commands use project scope by
default; add `-g` for global scope. See [configuration](configuration.md) for scope and agent
selection.

## Add Servers

Choose the command that matches your server.

| Server        | Example                                                       |
| ------------- | ------------------------------------------------------------- |
| npm package   | `arc mcp add npm:@upstash/context7-mcp`                       |
| Remote URL    | `arc mcp add https://mcp.linear.app/mcp --name linear`        |
| Local command | `arc mcp add local-tools -- node /absolute/path/to/server.js` |

`arc mcp add` saves the server in `.agents/agents.toml` and installs from the manifest.

- **npm package.** agentsrc derives the server name from the package. Use `--name` to choose another
  name. To limit the version, add a range such as `'npm:@upstash/context7-mcp@^1'`.
- **Remote URL.** agentsrc derives the server name from the hostname unless you pass `--name`. Use
  `--header KEY=VALUE` to set a header or `--transport sse` to select SSE instead of HTTP.
- **Local command.** Put the server name and any `arc` options before `--`. Put the executable and
  its arguments after `--`.

Use `--env KEY=VALUE` to set an environment variable for an npm package or local command. Repeat
`--env` or `--header` to set multiple values.

In a terminal, run `arc mcp add` to choose a server type and enter its details. If you run
`arc mcp add local-tools --`, `arc` asks for the executable and any arguments. Enter arguments as a
JSON array of strings, such as `["./server.js", "--port", "3000"]`, or leave the field blank. If
`arc` cannot derive a server name, it asks for one. Press Ctrl+C to cancel before any files change.
In CI, without a terminal, or with `--yes`, supply all required details on the command line.

## Import Existing Servers

Inspect existing project servers, then select imports while creating the manifest:

```bash
arc init --list
arc init --mcp codex:db
arc mcp install --force
```

Use a name from `--list`, or `--mcp '*'` to import all server candidates. For conflicting names,
select one agent explicitly, such as `codex:db`. Add `-g` to inspect and import global servers
instead; the two scopes are inspected separately.

`init` leaves existing agent files unchanged and never overwrites a manifest. `--yes` skips import
selection unless you pass `--mcp` explicitly. The install command's `--force` adopts selected
imports and permits replacing conflicting MCP entries.

If a manifest already exists, add the server with `arc mcp add` or edit its entries, then install.
Review imported credentials before committing: literal values remain literal.

## Configuration

Each server entry must contain exactly one of `package`, `command`, or `url`. Use `agents` to select
target agents for any server type.

### npm Packages

```toml
[mcp.context7]
package = "npm:@upstash/context7-mcp"
version = "^1"
args = []
env = { CONTEXT7_API_KEY = "${CONTEXT7_API_KEY}" }
```

Package servers run through `npx`, which must be available on `PATH`, including with standalone
agentsrc installations.

`package` requires the `npm:` prefix. Optional `version` sets a version range; without it, agentsrc
resolves the latest version. The lock records the resolved version. `arc mcp update` selects the
newest version within the range. `args` adds arguments for the server; `env` sets its environment.

### Local Commands

```toml
[mcp.local-tools]
command = "node"
args = ["/absolute/path/to/server.js"]
env = { LOG_LEVEL = "info" }
```

The agent runs `command` with the optional `args` and `env`. Use an executable on `PATH` or an
absolute path. agentsrc does not resolve command arguments relative to the manifest.

### Remote Servers

```toml
[mcp.linear]
url = "https://mcp.linear.app/mcp"
transport = "http"
headers = { Authorization = "Bearer ${LINEAR_TOKEN}" }
```

`transport` defaults to `http`; `sse` is also available where the target agent supports it.
`headers` is optional. Remote entries do not accept `env`, `args`, or `version`.

## Environment Variables

Use `${VAR}` in MCP environment values, arguments, URLs, or headers where the target agent supports
references. agentsrc preserves references and translates them into each agent's syntax. It does not
read the variable's value into generated configuration.

Set the variables in the environment available to your coding agent. In shell commands, use single
quotes to preserve the reference:

```bash
arc mcp add npm:@upstash/context7-mcp --env 'CONTEXT7_API_KEY=${CONTEXT7_API_KEY}'
```

Use `$${VAR}` in the manifest for literal `${VAR}` text, subject to agent compatibility. Literal
values, including tokens imported from existing configurations, remain literal. Review imported
credentials before committing a manifest.

## Agent Compatibility

- Codex supports HTTP remote servers, but not SSE. Project MCP configuration requires a trusted
  project.
- Codex forwards environment variables under their own names, such as `KEY = "${KEY}"`. It cannot
  expand references in arguments or URLs.
- Codex headers accept a whole variable reference or `Authorization = "Bearer ${TOKEN}"`. Other
  mixtures of text and references are unsupported.
- Claude Code cannot express literal `${` text. Global MCP changes require the `claude` command on
  `PATH`.
- OpenCode MCP installation requires an OpenCode v2 executable on `PATH`. OpenCode v1 configuration
  is unsupported.

Use `arc mcp list` to inspect compatibility. Installation rejects entries a selected agent cannot
express.

## Install, List, Update, and Remove

| Command                     | Result                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `arc mcp install`           | Write declared servers into the selected agents' configuration.                       |
| `arc mcp install <server>`  | Add and install a server with a complete command line. Use `arc mcp add` for prompts. |
| `arc mcp list`              | Show servers, their status, and compatibility problems.                               |
| `arc mcp update [names...]` | Resolve newest package versions within configured ranges; omit names to update all.   |
| `arc mcp remove <names...>` | Remove servers from the manifest and agent configuration.                             |

`install` also accepts the alias `i`; `update` accepts `up`. Use `arc sync` to install both MCP
servers and skills. Removing an inherited server sets its entry to `false` in your manifest.

Preview changes with `--dry-run`. Use `-a <agent>` to limit agent selection and `-g` for global
scope. See [CI](configuration.md#ci) for frozen installation checks.

### Conflicts and Unsupported Entries

An unmanaged entry with a conflicting name requires `--force` before agentsrc takes ownership.
Preview adoption with `arc mcp install --force --dry-run`, then apply with
`arc mcp install --force`. Choose a different name if you want to keep the existing server.

`arc mcp list` reports incompatible entries as `unsupported`, explains why, and continues listing
other servers. Installation rejects incompatible entries before writing MCP configuration. Use an
entry's `agents` field to select agents that can express the server.

## Generated Configuration

| Agent       | Project Destination                                        | Global Destination                                      |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Claude Code | `.mcp.json`                                                | User configuration managed through the `claude` CLI.    |
| Codex       | `.codex/config.toml`                                       | `$CODEX_HOME/config.toml`, or `~/.codex/config.toml`.   |
| OpenCode v2 | `opencode.json`, or an existing supported JSON/JSONC file. | `$XDG_CONFIG_HOME/opencode/`, or `~/.config/opencode/`. |

Claude Code global configuration respects `CLAUDE_CONFIG_DIR` when set.

agentsrc records MCP hashes and resolved package versions in `.agents/agents.lock`. Commit it with
the manifest. Team-owned agent configuration can also be committed after checking for literal
credentials. Otherwise, teammates can generate those entries with `arc mcp install` or `arc sync`.
