# agentsrc

## 0.3.0

### Minor Changes

- 5e0ee29: Add `arc ui`, a keyboard-driven full-screen manager for project and global skills and MCP
  servers. Select entries across tabs, review combined plans, and apply batch updates, repairs,
  imports, and removals. Add skills from discovered sources and configure MCP servers through forms.

  Require Node.js 22 or later for npm installations.

## 0.2.0

### Minor Changes

- 0dcc74d: Add `arc usage` with account identity, subscription limits, and reset timing for Codex,
  Claude, and OpenCode Go. Support banked reset credits and claims for Codex and Claude.

## 0.1.0

### Minor Changes

- f4cd6f9: Add the `arc` CLI and npm alias `agentsrc`, with interactive project and global
  initialization and selective imports from existing harnesses. Add source development commands and
  standalone platform binaries to automated releases.

### Patch Changes

- 43a42cb: Provide `agents` and `agentsrc` aliases alongside `arc` in standalone archives and mise
  installations.
- 6f3c409: Reduce standalone executable size with ahead-of-time compilation and runtime trimming.
  Build and test release executables on native runners for all supported platforms.
