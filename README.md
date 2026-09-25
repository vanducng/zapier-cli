# zapier-cli (`zap`)

Automation-friendly CLI over the Zapier SDK: inspect classic Zaps, debug and manage Zapier code workflows.

## Safety model

- Classic Zaps are read-only. `zap` has no command that edits, toggles, or deletes a Zap, and it refuses every Zapier Manager write action.
- `zap zaps convert` creates a new, disabled code workflow from a Zap. The Zap itself is untouched.
- Workflow and draft writes only run on workflows `zap` created. A write passes only when:
  - the workflow is in the local ledger (`$XDG_CONFIG_HOME/zap-cli/owned.json`, override with `ZAP_CLI_HOME`), written at create/convert time, and
  - Zapier's record matches it: same creator user id, and `creation_client.harness = zap-cli` for created workflows.
- Every write needs `--confirm`.

## Setup

```bash
npm install && npm run build && npm link   # installs the `zap` binary
zapier-sdk login                           # zap reuses this session; it never stores credentials
zap auth status
```

## Output contract

- Success: one JSON value on stdout, empty stderr, exit 0. Lists return `{ "data": [...], "next_cursor": string|null }`.
- Failure: one JSON object on stderr `{ ok: false, error: { code, message, retryable, next_steps } }`, exit 1.
- Error codes: `usage_error`, `validation_error`, `confirmation_required`, `not_owned`, `blocked_action`, `connection_required`, `auth_required`, `not_found`, `forbidden`, `conflict`, `rate_limited`, `provider_unavailable`, `provider_error`, `unexpected_error`.

## Commands

Run `zap <group> --help` for exact flags.

| Group | Commands |
|---|---|
| `auth` | `status` |
| `apps` | `list`, `get` |
| `actions` | `list`, `get`, `inputs`, `choices`, `run` (write types need `--confirm`) |
| `connections` | `list`, `get` |
| `folders` | `list` |
| `zaps` | `list`, `search`, `convert` |
| `workflows` | `list`, `get`, `versions`, `version`, `validate`, `create`, `update`, `enable`, `disable`, `trigger`, `publish`, `delete` |
| `drafts` | `list`, `get`, `create`, `update`, `discard`, `run`, `publish` |
| `runs` | `list`, `get`, `trigger` |
| `durable` | `list`, `get` |

Examples:

```bash
zap zaps list --account <account-id> --folder <folder-id>
zap workflows create --name my-flow --private --confirm
zap workflows validate ./flow
zap drafts create <workflow> --confirm
zap drafts update <workflow> <draft> --source ./flow --confirm
zap drafts run <workflow> <draft> --revision 1 --confirm
zap runs list <workflow> --kind draft
```

## Limits

- The Zapier SDK does not expose classic Zap step configuration. `zaps list/search` return metadata only; `zaps convert` is the path to readable logic, and it only works on Zaps owned by the logged-in user.
- Code-workflow methods are marked experimental by Zapier and may change shape. The SDK is pinned exactly.

## Development

```bash
npm run verify   # typecheck, unit tests, packed-tarball smoke
```
