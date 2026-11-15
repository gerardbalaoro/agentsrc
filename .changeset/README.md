# Changesets

Run `bun run changeset` when a change affects users. Select `agentsrc`, choose the version bump, and
describe the user-visible behavior.

The release workflow combines pending changesets into a version pull request. Merging it publishes
the npm package and uploads standalone executables to the matching GitHub release.

See [Contributing](../CONTRIBUTING.md) for release setup and verification.
