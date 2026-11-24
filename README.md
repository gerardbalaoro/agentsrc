# agentsrc

Keep your agent skills and MCP servers in one configuration file.

## Supported Agents

| Agent       | Skills | MCP Servers | Usage |
| ----------- | ------ | ----------- | ----- |
| Claude Code | ✅     | ✅          | ✅    |
| Codex       | ✅     | ✅          | ✅    |
| OpenCode v2 | ✅     | ✅          | ✅    |

## Installation

Install with npm (Node 22 or later):

```bash
npm install -g agentsrc
```

Or install a standalone binary with [mise](https://mise.jdx.dev):

```bash
mise use -g github:gerardbalaoro/agentsrc
```

Both provide the `arc` command.

## Quick Start

Run these commands from your project directory and follow the prompts:

```bash
arc init
arc skills add vercel-labs/agent-skills
arc mcp add npm:@upstash/context7-mcp
```

The selected skills and Context7 MCP server are now installed for your coding agents.

## Interactive Mode

Run `arc ui` to manage your project in a full-screen interface, or `arc ui -g` for your personal
setup.

Use Space to mark entries, Tab to switch between Skills and MCPs, and `/` to search. Selection stays
across tabs and filters. Press `u` to update, `r` to repair, `i` to import, or `d` to remove
selected entries. Review the combined plan, then press Enter to apply it.

Press `a` to add skills or an MCP server. Press `g` to switch scope; this clears your selection.
Press `?` for shortcuts or `q` to exit. Interactive mode requires a terminal and uses the keyboard.

## Configuration

The configuration file lives in `.agents/agents.toml`, and typically looks like:

```toml
agents = ["claude-code", "codex", "opencode"]

[skills]
web-design-guidelines = "vercel-labs/agent-skills"

[mcp.context7]
package = "npm:@upstash/context7-mcp"
```

Use `extends` to share configuration from local files or URLs. See the
[configuration overview](docs/configuration.md) for scope, agent selection, and inheritance.

### Global Scope

Use the `-g` flag to manage `~/.agents/agents.toml` and install skills and servers for use across
projects:

```bash
arc init -g
arc skills add vercel-labs/agent-skills -g
arc sync -g
```

Project and global configuration are managed separately. Project configuration does not
automatically inherit global configuration.

## Common Commands

| Task   | Skills                         | MCP Servers                              |
| ------ | ------------------------------ | ---------------------------------------- |
| Add    | `arc skills add <source>`      | [`arc mcp add`](docs/mcp.md#add-servers) |
| List   | `arc skills list`              | `arc mcp list`                           |
| Update | `arc skills update [names...]` | `arc mcp update [names...]`              |
| Remove | `arc skills remove <names...>` | `arc mcp remove <names...>`              |

You can also check subscription allowances for your signed-in accounts:

```bash
arc usage
```

See [account limits](docs/account-limits.md) for account support and banked resets.

## Documentation

- [Configuration](docs/configuration.md): manifest structure, scope, agent selection, sharing, and
  CI.
- [Skills](docs/skills.md): imports, sources, configuration, commands, and Vercel Skills CLI
  compatibility.
- [MCP servers](docs/mcp.md): imports, configuration, authentication, commands, and agent
  compatibility.
- [Interactive mode](docs/interactive.md): keyboard controls, batch actions, and adding entries.
- [Account limits](docs/account-limits.md): allowances, authentication, and reset claims.
- [Contributing](CONTRIBUTING.md): development and releases.

Run `arc --help` or `arc <command> --help` for command options.

## License

[AGPL-3.0](LICENSE).
