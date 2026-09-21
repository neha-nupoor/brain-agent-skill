# Install Brain for an agent

This bundle teaches an agent to use Brain through a central Guide and ordinary MCP
tools. The agent does not need Supabase, repository topology, or internal policy.
Node 22+, Git, and pnpm are the only local prerequisites. Keep this checkout in place:
generated client configurations use its absolute entrypoint and the current Node path.

## Decision: skill plus a small local adapter

| Client capability | Installation | Bootstrap |
|---|---|---|
| Codex, discovers Agent Skills and supports stdio MCP | Install `skills/brain`; merge generated `codex.toml` | MCP initialized hook fetches context; skill consumes its resource or calls bootstrap |
| Generic MCP client (tested with official SDK stdio/HTTP client) | Merge `mcp.json`; add generated `AGENTS.md` text to its persistent system prompt | Same MCP lifecycle hook; explicit tool call if resources are unavailable |
| Remote-only MCP client with native OAuth, no local processes | Connect its native OAuth MCP integration to the supplied Brain endpoint; install the prompt fallback | Explicit `brain.guide`, then `brain.bootstrap`; no local journal cache |

A skill alone cannot maintain one shared journal clone or reliably refresh it across
agents. The adapter exists for that local orchestration, the initialized lifecycle
hook, and doctor. It does not run agents or duplicate Brain semantics. The private
repository remains the source of truth; a dedicated public GitHub package distributes
only the Brain onboarding runtime and skill. The remote-only fallback is explicitly
less capable: published journal context
is available only through server-side bootstrap/search until remote journal read
tools exist. Do not invent local tools on remote-only clients.

## One preview/install flow

Preview the public package directly from its immutable release tag. This needs no
GitHub login, Brain service credential, or production configuration:

```sh
npx --yes github:neha-nupoor/brain-agent-skill#v0.1.2 preview
```

Preview writes nothing and prints the exact targets and both client configurations.
For a durable installation, install that tagged package globally, then set the
endpoint and optional read-only journal remote supplied by the Brain operator
(neither is a secret):

```sh
npm install --global github:neha-nupoor/brain-agent-skill#v0.1.2
export BRAIN_MCP_URL='https://YOUR-BRAIN-ENDPOINT/mcp'
export BRAIN_JOURNAL_REMOTE='git@github.com:YOUR-OWNER/YOUR-JOURNAL.git'
brain-onboard install
```

Install places the automatically discoverable skill in `~/.agents/skills/brain` and
writes configuration fragments plus the generic prompt under
`~/.local/share/brain-onboarding`. Merge **only** the generated `brain` MCP entry into the
client's existing configuration and restart the client. The tool never replaces a
client config or an existing skill. For a generic client, paste the generated
`AGENTS.md` into its persistent system prompt as well. This is the sole client-specific
activation step; generated files are not automatically loaded by arbitrary clients.

Optional non-secret installation environment variables: `BRAIN_HOME` (shared state
path, same value for all local clients), `BRAIN_SKILL_PATH`, `BRAIN_JOURNAL_BRANCH`
(default `main`), `BRAIN_CREDENTIAL_ENV` (default `BRAIN_TOKEN`), and
`BRAIN_KEYCHAIN_SERVICE` (macOS Keychain generic-password service name). A restricted
principal may set `BRAIN_EXPECTED_MISSING_TOOLS` to a comma- or space-separated list
of intentionally absent mutation capabilities. For any restricted principal that is
deliberately read-only for source evidence, use
`BRAIN_EXPECTED_MISSING_TOOLS='memory.ingest'`. Doctor reports both the declared
absence and any unexpected missing capability; only the latter fails health.

Credentials must come from an inherited environment variable, a macOS Keychain item,
OAuth client credentials, or the remote client's native OAuth provider. Enter/rotate a Keychain item with
Keychain Access; the adapter only reads it. Never put a credential in CLI arguments,
MCP URL parameters, a Git remote, client configuration, this repository, or shell
history. The installer persists only the **name** of an environment variable or
Keychain service. Codex's generated config permits the named variable; generic
clients must inherit it from their launcher, or use Keychain. The journal uses the
existing Git credential helper/SSH agent with read-only repository access.

For a machine OAuth client, set the non-secret client metadata plus a secret source before install:

```sh
export BRAIN_OAUTH_ISSUER_URL='https://YOUR-TENANT/'
export BRAIN_OAUTH_CLIENT_ID='YOUR-CLIENT-ID'
export BRAIN_OAUTH_AUDIENCE='https://YOUR-BRAIN-ENDPOINT/mcp'
export BRAIN_OAUTH_SCOPES='memory:read memory:write relationship:read relationship:write'
export BRAIN_OAUTH_CLIENT_SECRET_KEYCHAIN_SERVICE='YOUR-KEYCHAIN-SERVICE'
```

The adapter exchanges the secret only with the configured HTTPS token endpoint and uses the returned short-lived bearer for MCP. It never persists either value. `BRAIN_OAUTH_TOKEN_URL` may replace issuer-based discovery; `BRAIN_OAUTH_CLIENT_SECRET_ENV` names an inherited secret variable when Keychain is not used.

## Check operation

```sh
brain-onboard doctor
```

Doctor calls a real bootstrap and reports health/auth, journal revision/sync/freshness,
required tool presence, observed contract/schema validity, and exact Guide agreement.
Every canonical write rechecks bootstrap and Guide agreement. An incomplete/degraded
report exits nonzero. A client
without resources calls `brain.bootstrap` explicitly; a host with a session-start
command hook can also run `node /absolute/path/bin/brain.mjs bootstrap` and inject
its JSON into context. The built-in MCP initialized hook requires no host-specific
hook configuration. Automatic fetch does not force a host to consume context.

Bundle version `0.1.2` expects contract `brain-v2` and Guide `2026-09-20.3`; its
machine-readable agreement is `brain/versions.json`. Runtime validators are the exact
centrally owned source snapshot under `brain/contracts/`, with repository/revision/hash
provenance. They validate full responses and typed metadata, including canonical
cross-field invariants. Never edit this snapshot independently; refresh it from the
service and run the cross-repository checker. On mismatch the adapter blocks writes,
doctor identifies the discrepancy, and valid read-only canonical search stays available.

The adapter returns bootstrap as `{ guide, bootstrap, journal, versions }` and search
as `{ search, journal }`. Nested canonical envelopes remain unchanged. Journal
freshness is local cache freshness and never replaces the service's freshness/trace.

## Journal and recovery

All local clients using the same `BRAIN_HOME`, remote and branch share one clone.
On use, refresh happens when five minutes old; `journal.refresh` or the CLI `refresh`
forces it. Refresh pulls `--ff-only`, refuses dirty worktrees and local commits,
and never resolves conflicts or pushes. Reads use committed regular `.md` blobs at
the publisher's `journal/YYYY-MM-DD.md` and `journal/YYYY-Www.md` paths (plus legacy
`daily/` and `weekly/` paths), never worktree edits or symlink targets.

Network, Git-auth, dirty/divergent, and interrupted-refresh failures retain the last
good revision and timestamp, report stale/degraded state, and leave canonical search
available. No last-good revision means journal context is unavailable, not empty
proof. Journal Markdown is never a writable MCP surface. The skill also forbids
bypassing this boundary through shell/filesystem tools. Deployment should give
ordinary clients read-only remote credentials. This is not an OS sandbox against
other programs with the same local user permissions.

For network/auth failure, fix the connection or credential, then run
`brain-onboard refresh`. For a crashed refresh, stop its owning process, then
run `brain-onboard recover-lock`; it refuses a live owner. For a dirty/divergent
or partially cloned cache, stop all Brain adapter processes and move the exact
affected `BRAIN_HOME/journals/<id>` directory aside to a backup, then run refresh.
Never reset, merge, or commit generated files. For an interrupted install, move only
the previewed state/skill targets aside and rerun install. Existing files are retained.

## Uninstall and restore

```sh
brain-onboard uninstall
```

Stop the adapter first. Uninstall moves this installation's skill and state/cache to
timestamped sibling backup paths and prints both exact paths. Remove only the `brain`
MCP entry you previously merged into your client, remove its generic prompt block
if used, then restart. Credentials, the checkout, other skills, remote data, and
client configuration are untouched. Edited skills are refused so they can be moved
aside explicitly. Restore by moving the two printed backups back to their original
paths (only if those paths are absent), restoring the generated MCP entry and restarting.
To upgrade, uninstall the Brain state, update the global package to the new immutable
tag, reinstall, and merge the new fragment. Removing the global package is separate:
`npm uninstall --global brain-agent-skill`.

## Smoke prompts and expected behavior

| Prompt | Expected observable behavior |
|---|---|
| “What did we decide about focus blocks?” | Bootstrap/Guide, then canonical search; cite relevant evidence/freshness |
| “Keep this original meeting note as evidence.” | `memory.ingest`; no claim of a classified item |
| “Remember that I prefer a morning focus block.” | Guide-driven `brain.capture`, successful key/version; no task execution |
| “Update that preference to afternoons.” | `brain.get`, then `brain.update` with current version; refetch on conflict |
| “Read yesterday's journal, and fix its Markdown.” | Read only; offer canonical correction, no journal write/commit |
| “Explain a JavaScript closure.” | No Brain call merely because the skill is installed |

Also simulate journal network failure: doctor and reads must expose degradation with
the last-good revision, while `brain.search` still returns canonical results. Change
the mock Guide version: doctor must report disagreement and writes must stop.

## Verification and integration status

```sh
pnpm test
python3 /path/to/skill-creator/scripts/quick_validate.py skills/brain
```

Tests use temporary Git repositories, SDK generic MCP clients, an authenticated local
HTTP mock, and the exact NEHA-59/58 bootstrap/search golden fixture. No production
credential is needed. Unit tests mock service responses; cross-repository tests also
exercise the actual NEHA-58 service and NEHA-57 daily/weekly materializers. These are
local integration checks, not a claim of production deployment. A failed doctor
missing the tools is not a successful install verification. The service's
`scripts/check-onboarding-bundle.mjs` enforces exact fixture/source-schema hash and
version agreement before release. In that service checkout, run:

```sh
BRAIN_ONBOARDING_BUNDLE=/absolute/path/to/personal-agent-skill node --test test/onboarding-bundle.test.mjs
```
