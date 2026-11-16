# Skills

Add, import, configure, and update agent skills with `arc skills`. Commands use project scope by
default; add `-g` for global scope. See [configuration](configuration.md) for scope and agent
selection.

## Add Skills

Initialize the manifest if it does not exist, then browse and select skills from a source:

```bash
arc init
arc skills add vercel-labs/agent-skills --list
arc skills add vercel-labs/agent-skills --skill web-design-guidelines
```

`add` saves the selected skills in `.agents/agents.toml` and installs from the manifest. Without
`--skill`, a source with multiple skills opens a picker. Non-interactive runs must select skills
explicitly. Repeat `--skill` to select several, or use `--skill '*'` for all.

To rename one selected skill or copy it instead of linking:

```bash
arc skills add vercel-labs/agent-skills --skill web-design-guidelines --rename web-review --copy
```

`--rename` requires exactly one selected skill. The installed directory and `SKILL.md` name use the
new name; updates retain the original source name.

## Import Existing Skills

Inspect existing project skills, then select imports while creating the manifest:

```bash
arc init --list
arc init --skill style
arc skills install --force
```

Use a name from `--list`, or `--skill '*'` to import all skill candidates. For conflicting names,
select one origin explicitly, such as `--skill codex:style`. Add `-g` to inspect and import global
skills instead; the two scopes are inspected separately.

`init` leaves existing agent files unchanged and never overwrites a manifest. `--yes` skips import
selection unless you pass `--skill` explicitly. The install command's `--force` adopts selected
imports and permits replacing conflicting installed skills.

If a manifest already exists, use `arc skills add <source>` or edit its skill entries, then install.

## Configuration

The table key is the installed skill name. A string entry selects that name from its source:

```toml
[skills]
web-design-guidelines = "vercel-labs/agent-skills"
```

Use a table for additional options or a different installed name:

```toml
[skills.web-review]
source = "vercel-labs/agent-skills"
skill = "web-design-guidelines"
agents = ["claude-code"]
copy = true
```

| Field    | Meaning                                                                                   |
| -------- | ----------------------------------------------------------------------------------------- |
| `source` | Required. Repository, Git URL, local path, or download URL.                               |
| `skill`  | Name in the source. Defaults to a name selected in the source string, then the table key. |
| `ref`    | Git branch, tag, or commit. Overrides a ref in the source string.                         |
| `path`   | Directory within the source to search. Overrides a path in the source string.             |
| `agents` | Agent selection for this entry.                                                           |
| `copy`   | Copy into agent skill directories instead of linking. Defaults to `false`.                |

The shared copy always lives in `.agents/skills/<name>`. When linking fails, agentsrc falls back to
copying. `copy` does not change the location used by Codex and OpenCode.

An empty agent selection does not hide an installed skill from Codex or OpenCode: both read
`.agents/skills` directly. See [agent selection](configuration.md#agent-selection).

## Sources

| Source                    | Example                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| GitHub repository         | `vercel-labs/agent-skills`                                         |
| Named skill               | `vercel-labs/agent-skills@web-design-guidelines`                   |
| Repository subdirectory   | `owner/repo/skills`                                                |
| Git ref                   | `owner/repo#main`                                                  |
| Git ref and named skill   | `owner/repo#main@my-skill`                                         |
| Version tag               | `owner/repo@v1.2.3`                                                |
| GitLab repository         | `https://gitlab.com/group/repo`                                    |
| Git over SSH              | `git@github.com:owner/repo.git`                                    |
| Local directory           | `../team-skills`                                                   |
| Skill or archive download | `https://example.com/SKILL.md` or `https://example.com/skills.zip` |

A version-like suffix or full 40-character commit SHA after `@` selects a ref. Other `@` suffixes
select a skill. For clarity, use explicit `ref` and `skill` fields when both are needed.

Local paths resolve relative to the manifest that declares them. For example, `../team-skills` in
`.agents/agents.toml` points to `team-skills` at the project root. Remote manifests cannot declare
local skill sources.

A branch or tag can move. To keep a Git source fixed, set `ref` to a full commit SHA. Skill updates
fetch the configured ref again; a content hash alone does not pin a mutable source to a commit.

## Install, List, Update, and Remove

| Command                        | Result                                                  |
| ------------------------------ | ------------------------------------------------------- |
| `arc skills install`           | Install skills declared in the manifest.                |
| `arc skills install <source>`  | Add the source to the manifest and install, like `add`. |
| `arc skills list`              | Show installed skills and their status.                 |
| `arc skills update [names...]` | Fetch selected sources again; omit names to update all. |
| `arc skills remove <names...>` | Remove skills from the manifest and agents.             |

`install` also accepts the alias `i`; `update` accepts `up`. Use `arc sync` to install both skills
and MCP servers. Removing an inherited skill sets its entry to `false` in your manifest.

Preview changes with `--dry-run`. Use `-a <agent>` to limit agent selection and `-g` for global
scope. See [CI](configuration.md#ci) for frozen installation checks.

### Conflicts and Local Edits

An untracked skill with the same name requires `--force` before agentsrc takes ownership. Preview
adoption with `arc skills install --force --dry-run`, then apply with `arc skills install --force`.
Alternatively, rename the skill to keep the existing installation.

Cleanup preserves unmarked agent copies. Installed managed skills can be restored during install;
make changes in their source and run `arc skills update` rather than editing installed copies.

## Vercel Skills CLI Compatibility

agentsrc uses skills from the [Vercel Skills CLI ecosystem](https://github.com/vercel-labs/skills).
Source discovery and lock compatibility are based on Skills CLI 1.8.1. Compatibility with that
baseline does not imply support for every feature in newer releases.

| Capability                           | agentsrc Support                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Add, install, list, update, remove   | `arc skills` commands above.                                                       |
| Skill selection and source browsing  | `--skill`, `--skill '*'`, and `--list`.                                            |
| Renaming and installation mode       | `--rename` and `--copy`.                                                           |
| Project, global, and agent selection | `-g` and `-a`; limited to agentsrc's supported agents.                             |
| Source discovery                     | Repository layouts, `skills.sh.json` paths, and skills in Claude plugin manifests. |
| Project locks                        | Read versions 1 and 2; write version 2.                                            |
| Global locks                         | Use the ecosystem's version 3 format.                                              |

Plugin manifests help discover skills; agentsrc does not install the rest of a Claude plugin.

agentsrc preserves unknown lock fields, including fields written by newer tools, without
interpreting them. It does not use an upstream `commit` lock field to pin restoration. Set the
manifest's `ref` to a full commit SHA when the source must remain fixed.

agentsrc has no equivalents for the upstream `find`, `check`, or `use` commands, skill-template
creation, or experimental npm dependency sync. `arc init` creates an agentsrc manifest; it does not
create a skill template. Discover skills at [skills.sh](https://skills.sh).

## Files and Ownership

Project skills live in `.agents/skills/<name>`. Claude Code receives links or copies in
`.claude/skills/`; Codex and OpenCode read the shared directory. `skills-lock.json` records sources
and content hashes. Commit it with the manifest and `.agents/agents.lock`, which tracks ownership.

An existing Skills CLI lock alone does not make its entries managed by agentsrc. Import and adopt
them with the steps above. Do not alternate tools to edit managed skills without checking the
manifest and locks afterward.

For skills to be available on checkout or pass frozen CI checks, commit the installed files and
required links or copies as well. Treat those files as managed content.

Global skills live in `~/.agents/skills/`. The global skill lock is `~/.agents/.skill-lock.json`, or
`$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set.
