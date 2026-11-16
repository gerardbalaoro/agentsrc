# Contributing

## Development

Install the pinned Bun canary with [mise](https://mise.jdx.dev):

```bash
mise install --locked bun
```

Install dependencies, then run the CLI locally:

```bash
bun install
bun run dev --help
```

Before submitting a change, run:

```bash
bun run format:check
bun test
bun run lint
bun run typecheck
bun run build
```

`bun run build` writes the npm CLI to `dist/` and bundles its dependencies. For user documentation,
see the [README](README.md), [Skills](docs/skills.md), and [MCP Servers](docs/mcp.md) guides.

## Releases

### Changesets

Add a changeset for user-visible changes:

```bash
bun run changeset
```

Pushes to `main` reuse successful PR checks and standalone binaries when the tested Git tree matches
exactly. Reuse requires a branch in this repository and all six binary artifacts, retained for seven
days. Missing, expired, or invalid artifacts trigger fresh checks and native builds. Manually
dispatch the Release workflow to bypass reuse and run fresh checks.

Pending changesets produce a version pull request. Merge it to publish the npm package, create a
`v<version>` GitHub release, and attach archives plus SHA-256 checksums. Release jobs use the same
commit and version for the npm package and executables.

### Standalone Binaries

The archives contain `arc`, with `agents` and `agentsrc` hard links, for Linux, macOS and Windows on
x64 and ARM64. Build one platform locally with:

```bash
bun run compile linux-x64
```

Compilation uses Bun's experimental AoT and runtime trimming. Build on the target OS and CPU;
cross-compilation is rejected. CI builds each of the six targets on a native runner, extracts its
archive, and runs the end-to-end suite against that executable. Publishing uses those tested
archives.

Artifacts go to the ignored `release/` directory. The GitHub backend in mise detects platform
archives by their names, such as `agentsrc-v0.1.0-linux-x64.tar.gz`.

### One-Time Repository Setup

1. In GitHub Actions settings, allow Actions to create pull requests.
2. Configure the npm package's trusted publisher for GitHub Actions:
   - Organization or user: `gerardbalaoro`
   - Repository: `agentsrc`
   - Workflow: `release.yml`
3. If the npm package does not exist, bootstrap its first publication from an authenticated npm
   account, then configure its trusted publisher before merging the first release PR.

The workflow uses npm OIDC and provenance. No long-lived npm token is stored in the repository. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) and the
[Changesets action](https://github.com/changesets/action) for account prerequisites.

A failed asset upload can be retried with `gh release upload v<version> release/* --clobber` after
rebuilding that exact tagged version. Do not rebuild release assets from a different commit.
