# opencode-session-review

An opencode plugin that fires on the `session.idle` event, extracts tool-error,
permission-reject, and approval-toil signals from the opencode session store into
a local SQLite findings ledger, and then runs a cheap LLM dedup pass to collapse
near-duplicate findings so only actionable, distinct failure patterns surface for
the `opencode-session-review` skill to act on.

---

## Signal types

| Signal | Description |
|---|---|
| `tool-error` | A tool call returned an error or threw an exception during the session |
| `permission-reject` | A permission request was explicitly rejected by the user |
| `approval-toil` | A permission prompt was approved but recurred ≥2 times in the session (repetitive toil) |

---

## Requirements

- **Node ≥ 22.5** — the plugin uses the built-in `node:sqlite` module (available
  since Node 22.5.0); no external `better-sqlite3` or `sqlite3` npm package is
  needed, and the `sqlite3` CLI is not required.
- An opencode installation with plugin support (`@opencode-ai/plugin >=1.15.0`).

---

## Installation

```bash
# 1. Clone the repository
git clone git@github.com:YOUR_ORG/opencode-session-review.git ~/git/opencode-session-review

# 2. Install dependencies
cd ~/git/opencode-session-review
npm install

# 3. Register the plugin in opencode
#    Edit ~/.config/opencode/opencode.jsonc (or the project-level opencode.jsonc)
#    and add the plugin path:
```

```jsonc
{
  "plugins": [
    "../../git/opencode-session-review/src/plugin.js"
  ]
}
```

```bash
# 4. Install the wrapper shim (see section below)
mkdir -p ~/.agents/scripts
cp scripts/session-finding-capture.sh ~/.agents/scripts/session-finding-capture.sh
chmod +x ~/.agents/scripts/session-finding-capture.sh

# 5. Restart opencode so the plugin is loaded
```

---

## Wrapper shim

`~/.agents/scripts/session-finding-capture.sh` is a thin two-line Bash shim that
lets the `opencode-session-review` skill (and other callers) invoke the capture
CLI without knowing the absolute installation path:

```bash
#!/usr/bin/env bash
exec node "$(dirname "$0")/../../git/opencode-session-review/src/capture.js" "$@"
```

Create it manually or copy from `scripts/session-finding-capture.sh` in this
repo. Make sure it is executable (`chmod +x`).

---

## CLI reference

All subcommands are invoked as:

```bash
node src/capture.js <subcommand> [args]
# or, via the wrapper shim:
~/.agents/scripts/session-finding-capture.sh <subcommand> [args]
```

| Subcommand | Arguments | Description |
|---|---|---|
| `init` | — | Create (or migrate) the findings ledger at `$FINDINGS_DB` |
| `capture` | `<sessionID>` | Extract signals from the given opencode session and write new findings |
| `merge` | `<dupID> <intoID>` | Merge finding `<dupID>` into `<intoID>` (marks dup as resolved) |
| `resolve` | `<id>...` | Mark one or more findings as resolved |
| `reopen` | `<id>...` | Reopen one or more previously resolved or ignored findings |
| `ignore` | `<id>...` | Permanently ignore one or more findings (excluded from `list` by default) |
| `list` | — | Print open findings in human-readable form |
| `json-open` | — | Print open findings as a JSON array (for programmatic consumption) |

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | Path to the opencode session store SQLite database |
| `FINDINGS_DB` | `~/.local/share/opencode/findings.db` | Path to the local findings ledger SQLite database |
| `CAPTURE_MIN_INTERVAL_MS` | `30000` (30 s) | Minimum milliseconds between consecutive `capture` runs for the same session (debounce guard) |

---

## Running tests

```bash
npm test
```

Tests use Jest with `--experimental-vm-modules` for ESM support (Node ≥ 22.5).

---

## Architecture

See `ARCHITECTURE.md` (to be added) for a detailed description of the plugin
lifecycle, signal-extraction queries, dedup strategy, and ledger schema.
