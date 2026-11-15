# Skills CLI Lock Fixtures

These fixtures record locks written by skills CLI 1.8.1. `source.json` preserves the source files,
line endings, binary content and modes. `test/conformance/source-fixture.ts` recreates that source
and its deterministic Git commit.

## GitHub Source

`github-lock.json` was generated with the real skills CLI using:

```sh
skills add https://github.com/agentsrc-fixtures/skills/tree/main/skills/alpha --skill alpha --agent codex --yes
```

A temporary Git configuration rewrote the fixture repository URL to the local source repository:

```gitconfig
[url "file:///path/to/fixture-repo"]
    insteadOf = https://github.com/agentsrc-fixtures/skills.git
```

The command ran in an empty project with an isolated home directory and `GIT_CONFIG_GLOBAL` pointing
to that temporary configuration. It did not require a GitHub repository or credentials.

The GitHub fixture has no `commit` field, matching skills CLI 1.8.1. The conformance test compares
agentsrc output with the complete upstream fixture and verifies repeated restores and frozen runs
leave it unchanged. The Git entry in `project-lock.json` was also regenerated with CLI 1.8.1:

```sh
skills add file:///path/to/fixture-repo --skill gamma --agent codex --copy --yes
```

Use an explicit SHA in the manifest's `ref` field for immutable restoration. agentsrc does not add
private revision fields to the shared lock. Existing fields from other tools remain opaque extras.
