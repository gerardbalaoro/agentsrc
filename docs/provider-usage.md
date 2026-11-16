# Provider Usage

Run `arc usage` to check the Codex, Claude, and OpenCode Go accounts signed in on your machine. No
agentsrc manifest is required. This command retrieves provider allowances, including usage outside
agentsrc.

```bash
arc usage
arc usage --provider codex --provider claude
arc usage --provider codex --json
arc usage --provider opencode
```

Each provider has a compact card showing its account name or ID, remaining allowance, and reset
countdown. When reset credits are available, a short summary shows their count and next expiry. Use
`--json` for exact timestamps, credit IDs, individual expiries, and diagnostic notes. Providers
generally report percentages rather than a fixed number of messages or tokens. Codex model-specific
and code-review windows appear when the provider reports them.

## OpenCode Go

`arc usage --provider opencode` reads OpenCode Go's 5-hour, weekly, and monthly allowances. The
adapter uses the active Go credential, or the active OpenCode Console OAuth login when no Go
credential is selected. Other providers connected through OpenCode and Zen pay-as-you-go balances
are not included.

Install an OpenCode v2 build with `opencode auth export` available on your PATH. The adapter
captures its JSON export in memory to read current SQLite credentials. It does not use legacy
`auth.json`, which can retain stale credentials after migration. It does not print or save the
exported secrets.

Console OAuth uses the account email and organization ID. API keys use the stored credential label
and ID; these identify the selected credential, rather than a remote billing account.

Monthly reset timing comes from the provider. An untouched 5-hour window has no fixed reset yet; the
adapter omits its moving placeholder timestamp. OpenCode Go exposes automatic resets only. Banked
reset inventory and claims are unsupported.

## Banked Resets

Automatic window resets and banked reset credits are separate. The summary lists claimable reset
counts and the next expiry. Use `arc usage --json` for credit IDs, reset types, and individual
expiries. It distinguishes an explicit non-expiring credit from an unknown expiry. Expired or paused
Claude grants cannot be claimed. Fable grants return Fable's weekly usage; they do not refill the
entire week.

Find a credit ID with `arc usage --json`, then claim one reset:

```bash
arc usage reset --provider codex --credit <id>
arc usage reset --provider claude --credit <id>
```

This command spends a banked reset immediately. It does not purchase credits. A fresh claim checks
the provider's inventory first. Provider responses distinguish successful resets from cooldowns,
unavailable credits, and limits that need no reset. Run `arc usage` afterward to check the current
limits.

Before submitting, the command prints a request ID to stderr. If the result is uncertain, retry with
the same provider, credit, request ID, and signed-in account:

```bash
arc usage reset --provider codex --credit <same-id> --request-id <same-request-id>
```

A retry sends the same claim directly, even if the first attempt removed the credit from inventory.
Never change the request ID to retry an uncertain claim. There are no automatic claim retries.

## Authentication and Availability

Codex uses the ChatGPT login in `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` by default. Claude
uses `$CLAUDE_CONFIG_DIR/.credentials.json`, or `~/.claude/.credentials.json`. On macOS, Claude also
supports the default `Claude Code-credentials` Keychain entry. Claude reset claims require the
organization saved by Claude Code in its `.claude.json` configuration.

Credentials remain local and are sent only to the corresponding provider's HTTPS endpoint. The
command does not refresh or rewrite provider credentials. If your login expires, sign in through the
provider CLI again. API-key billing accounts outside OpenCode Go, custom Keychain services, and
other providers are not supported yet.

These providers use subscription endpoints that can change without notice. A failed reset-inventory
lookup leaves valid usage visible, with unknown expiry and claim IDs. Unknown reset information is
not reported as zero.

With `--json`, stdout contains a JSON object; diagnostics go to stderr. Usage output contains
`providers` and `errors` arrays. Each provider includes an `account` with its name and ID when
available. Reset output includes `outcome`, `success`, and `requestId`. A limit being reached is a
successful lookup. Retrieval failures and unsuccessful claims exit with code 1. Invalid arguments
exit with code 2. Partial retrieval failures retain successful provider reports and exit with
code 1.

## References

The provider contracts and behavior were checked against these projects:

- [ai-usage](https://github.com/owayo/ai-usage): provider windows and reset grant classification.
- [OpenUsage](https://github.com/robinebers/openusage): OAuth usage and idempotent reset claims.
- [CodexBar](https://github.com/steipete/CodexBar): usage windows and reset credit expiry handling.
- [OpenCode](https://github.com/anomalyco/opencode): credential export and Go subscription
  documentation.
- [T3 Code](https://github.com/pingdotgg/t3code): provider limits and Claude reset grant outcomes.

agentsrc does not require these applications to be installed.
