# Agent Instructions

## Documentation Scope

- Keep the README product-focused and written for users. Do not assume they build from source.
- Keep `AGENTS.md` focused on lasting decisions and constraints, not descriptions of the current
  implementation.
- Keep detailed conventions in the linked skills; add project-specific rules here only when those
  skills do not cover them.

## Vendored Skills

- Treat skills tracked in `skills-lock.json` as vendored content. Do not edit their files manually.
- Update vendored skills through the skills CLI, preserving their upstream sources and lockfile.
- Exclude vendored skill files from code reviews. Review project-authored skills normally.
