# Contributing

## Development

[mise](https://mise.jdx.dev) installs the pinned Bun canary. Run `mise install --locked bun` before
development. `mise.lock` records checksums for all six platforms; the dated npm artifacts keep the
compiler available after GitHub's canary download changes.

```bash
bun install
bun run dev --help
bun test
bun run lint
bun run typecheck
bun run build
```

`bun install` applies the patch in `patches/` to `@decimalturn/toml-patch`. `bun run build` bundles
every dependency into `dist/`, so the published package has no runtime dependencies.

## Releases

Add a changeset for user-visible changes:

```bash
bun run changeset
```

Pushes to `main` run checks and compile standalone binaries before Changesets publishes anything.
Pending changesets produce a version pull request. Merge it to publish the npm package, create a
`v<version>` GitHub release, and attach archives plus SHA-256 checksums. Release jobs use the same
commit and version for the npm package and executables.

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
