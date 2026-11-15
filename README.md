# agentsrc

Manage agent skills and MCP servers for Claude Code, Codex, and OpenCode v2 from one configuration
file. Share your project's setup with your team, or keep a personal setup across projects.

- Add skills and MCP servers once and use them across your coding agents.
- Import the skills and servers you already use.
- Reuse shared configuration with local files or URLs.
- Use skills from the [skills.sh ecosystem](https://github.com/vercel-labs/skills) with a compatible
  lock file.

## Installation

Install with npm (Node 20 or later):

```bash
npm install -g agentsrc
```

Or install a standalone binary with [mise](https://mise.jdx.dev):

```bash
mise use -g github:gerardbalaoro/agentsrc
```

The examples use `arc`. The npm package also provides the `agentsrc` command.

## Getting Started

Initialize your project, then add a skill and an MCP server:

```bash
arc init
arc skills add vercel-labs/agent-skills
arc mcp add npm:@upstash/context7-mcp
```

`init` detects your coding agents and offers to import existing skills and servers. The `add`
commands save your choices in `.agents/agents.toml` and install them for your configured agents.

For a project that already has a manifest, install its skills and servers with:

```bash
arc sync
```

If you imported existing entries with `init`, use `arc sync --force` to let agentsrc manage those
entries.

## Configuration

The manifest at `.agents/agents.toml` describes your project's setup:

```toml
agents = ["claude-code", "codex", "opencode"]

[skills]
frontend-design = "vercel-labs/agent-skills"

[mcp.context7]
package = "npm:@upstash/context7-mcp"
```

Use `arc init -g` for personal configuration at `~/.agents/agents.toml`. Add `-g` to subsequent
commands to manage that setup.

To reuse a team configuration, add `extends` at the top of your manifest:

```toml
extends = ["https://example.com/team/agents.toml"]
```

## Everyday Commands

| Task   | Skills                         | MCP Servers                    |
| ------ | ------------------------------ | ------------------------------ |
| Add    | `arc skills add <source>`      | `arc mcp add <package or URL>` |
| List   | `arc skills list`              | `arc mcp list`                 |
| Update | `arc skills update [names...]` | `arc mcp update [names...]`    |
| Remove | `arc skills remove <names...>` | `arc mcp remove <names...>`    |

See the [usage guide](docs/usage.md) for import options, configuration examples, and command
behavior. Run `arc --help` to explore the CLI.

For development and release instructions, see [Contributing](CONTRIBUTING.md).
