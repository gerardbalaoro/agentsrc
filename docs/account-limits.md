# Account Limits

Check subscription allowances and claim available banked resets from your existing agent logins.
This command works independently of skill and MCP configuration.

## Check Allowances

Run `arc usage` to check the Codex, Claude, and OpenCode Go accounts signed in on your machine. With
no harness argument, only detected harnesses are queried. This command retrieves provider
allowances, including usage outside agentsrc.

```bash
arc usage
arc usage codex
arc usage claude-code --json
arc usage opencode
```

Each provider has a compact card showing its account name or ID, remaining allowance, and reset
countdown. When reset credits are available, a short summary shows their count and next expiry. Use
`--json` for exact timestamps, credit IDs, individual expiries, and diagnostic notes. Providers
generally report percentages rather than a fixed number of messages or tokens. Codex model-specific
and code-review windows appear when the provider reports them.

## Claim a Banked Reset

Automatic window resets and banked reset credits are separate. The summary lists claimable reset
counts and the next expiry. Use `arc usage --json` for credit IDs, reset types, and individual
expiries. It distinguishes an explicit non-expiring credit from an unknown expiry. Expired or paused
Claude grants cannot be claimed. Fable grants return Fable's weekly usage; they do not refill the
entire week.

Choose a harness and reset interactively:

```bash
arc usage reset
arc usage reset codex
arc usage reset claude-code
```

With no harness argument, the command lists detected, signed-in harnesses that support reset claims.
The reset picker lists claimable resets by expiry, earliest first. Credits without a reported expiry
appear last. Cancelling either picker or declining confirmation spends nothing.

Use `--next` to select the first expiring reset without opening the reset picker:

```bash
arc usage reset codex --next
arc usage reset codex --next --yes
```

Every claim requires confirmation unless you pass `--yes`. Scripts must provide a harness and use
`--next --yes`. Warnings remain visible with `--yes`.

### Reset Coverage

A reset's coverage determines its warnings:

- A reset can help an exhausted limit even when another covered limit is full.
- The command warns about unused allowance unless the credit expires in under 12 hours.
- The command warns when an exhausted limit falls outside the reset's coverage and may still block
  usage.
- The command reports unknown coverage or expiry.

For example, a full reset can help when weekly usage is exhausted but session usage is empty. A
session-only reset cannot refill that weekly allowance. Fable credits do not reset the entire weekly
allowance.

Claims spend existing credits immediately; they do not purchase credits. Fresh claims check
inventory before selection. The provider determines the final outcome. Run `arc usage` afterward to
check current limits.

### Retry an Uncertain Claim

Before submitting, the command prints a request ID to stderr. If the result is uncertain, reuse the
same harness, credit ID, request ID, and signed-in account:

```bash
arc usage reset codex --credit <same-id> --request-id <same-request-id>
```

`--credit` and `--request-id` support explicit selection and recovery. A retry sends the original
claim directly, even if the first attempt removed the credit from inventory. It still requires
confirmation unless `--yes` is passed. Never change the request ID to retry an uncertain claim.
There are no automatic claim retries.

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

### OpenCode Go

`arc usage opencode` reads OpenCode Go's 5-hour, weekly, and monthly allowances. The adapter uses
the active Go credential, or the active OpenCode Console OAuth login when no Go credential is
selected. Other providers connected through OpenCode and Zen pay-as-you-go balances are not
included.

Install an OpenCode v2 build with `opencode auth export` available on your PATH. The adapter
captures its JSON export in memory to read current SQLite credentials. It does not use legacy
`auth.json`, which can retain stale credentials after migration. It does not print or save the
exported secrets.

Console OAuth uses the account email and organization ID. API keys use the stored credential label
and ID; these identify the selected credential, rather than a remote billing account.

Monthly reset timing comes from the provider. An untouched 5-hour window has no fixed reset yet; the
adapter omits its moving placeholder timestamp. OpenCode Go exposes automatic resets only. Banked
reset inventory and claims are unsupported.

## JSON Output and Exit Codes

With `--json`, stdout contains a JSON object; diagnostics go to stderr. Usage output contains
`providers` and `errors` arrays. Each provider includes an `account` with its name and ID when
available. Reset output includes `outcome`, `success`, and `requestId`. A limit being reached is a
successful lookup. Retrieval failures and unsuccessful claims exit with code 1. Invalid arguments
exit with code 2. Partial retrieval failures retain successful provider reports and exit with
code 1.
