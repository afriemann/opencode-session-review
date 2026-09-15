# opencode V2 Compatibility Audit — `opencode-session-review`

**Date:** 2026-09-15
**Tested against:** `opencode-ai@dev` (`0.0.0-dev-202609142154`), via the
`opencode2` sandbox command. See the shared
`reality/opencode-v2-sandbox-plugin-compat` memory atom and `opencode-use`'s
`docs/v2-compat-audit.md` for the general V2 background — not repeated in
full here.

## Headline finding: a client-SDK error surfaces only when this plugin loads

Similar in spirit to the `opencode-openspec` audit's finding: this plugin
triggers a genuine, reproducible error against `opencode-ai@dev` — though
here the plugin itself keeps working (the `event` hook completes and writes
to the findings ledger), and the error appears to originate from an
opencode-side client SDK bug exposed by one of this plugin's `client.session.*`
calls, not from a load-time failure in the plugin itself.

## What "opencode V2" is

See `opencode-use`'s audit doc for the full background. `opencode debug v2`
confirms V2 (`packages/core`) is live today only for the catalog domain.

## Hook registered by this plugin (`src/plugin.js`)

| Hook | Purpose |
|---|---|
| `event` | On `session.idle`, spawns `node capture.js` to accumulate recurring-failure signals into a local findings ledger; if new findings and existing open findings both exist, creates an ephemeral dedup session via `client.session.create`/`client.session.prompt`, then deletes it via `client.session.delete` |

## Empirical test result

**Setup:** scratch project (`/tmp/opencode/v2-sandbox/test-session-review`)
with `opencode.json` pointing `plugin` at this repo's `src/plugin.js`
(worktree, unmodified). **Safety note:** this plugin reads/writes real,
shared state at `~/.local/share/opencode/opencode.db` (read) and
`~/.local/share/opencode/session-findings.db` (write) by default — both were
redirected to scratch files via the `OPENCODE_DB`/`FINDINGS_DB` environment
variables for this test, so the real findings ledger was never touched.

```bash
export OPENCODE_DB="/tmp/scratch-opencode.db"
export FINDINGS_DB="/tmp/scratch-findings.db"
opencode2 run "say hello" --print-logs --log-level DEBUG
```

**Result:**

- The `event` hook fired correctly on `session.idle`: the scratch
  `FINDINGS_DB` file was created with the expected schema (`capture_watermark`,
  `finding_sessions`, `findings`, `ignored_fingerprints` tables), confirming
  the capture subprocess ran.
- However, the run also logged a top-level (not plugin-prefixed) error:
  ```
  message=failed ref=err_86a82183 error="Error: Expected a string starting
  with \"ses\", got \"%7Bid%7D\""
  ```
  (`%7Bid%7D` is URL-encoded `{id}` — a literal, unsubstituted route-template
  placeholder.)
- **Isolated via an A/B baseline test:** the identical `opencode2 run "say
  hello"` command, with no plugin loaded at all, produces **zero** occurrences
  of this error. Loading only this plugin reproduces it consistently. This
  rules out the error being generic dev-build noise unrelated to the plugin.
- The error's message shape (expects a string starting with the session-ID
  prefix `ses`) strongly suggests it originates inside one of this plugin's
  `client.session.*` calls (`create`, `prompt`, or `delete` in `runDedup`) —
  specifically, a client-SDK internal route-templating bug where a path
  placeholder like `/session/{id}` wasn't substituted with the actual session
  ID before the request was built. The exact call site could not be pinpointed
  from the available stack trace, which points into `opencode-ai@dev`'s own
  minified/bundled client code (`/$bunfs/root/chunk-*.js`), not into this
  plugin's source.

| Item | Result | Evidence |
|---|---|---|
| `event` hook fires and drives capture | ✅ Pass | Scratch `FINDINGS_DB` created with expected schema |
| A `client.session.*` call inside the dedup path | ⚠️ Errors on dev build | Top-level `Expected a string starting with "ses", got "%7Bid%7D"` error, reproduced consistently, absent in an otherwise-identical no-plugin baseline run |

No `[opencode-session-review]`-prefixed error was logged (this plugin's own
error handling correctly catches and logs failures from `handle()` via its
internal `.catch()` — but if the *logging call itself* were what failed here,
that would explain why the error surfaced as an unhandled top-level failure
rather than a plugin-prefixed log line).

## Cross-reference against the documented V2 plugin API

V2's plugin API (`packages/plugin/src/v2/{effect,promise}/README.md`)
documents only `agent`/`catalog`/`command`/`integration`/`reference`/`skill`
`.transform()` hooks and `aisdk.sdk`/`aisdk.language` runtime hooks — no
generic `event` hook, and (per its own scope) no client SDK surface at all.
This finding is unrelated to that documented gap; it looks like an incidental
client-SDK regression in the `dev` build rather than a deliberate V2 API
change.

## Risk rating and recommended action

| Item | Risk | Recommended action |
|---|---|---|
| `event` hook itself | Low | Confirmed firing and driving the capture pipeline correctly. |
| `client.session.create`/`prompt`/`delete` (dedup path) | **Medium-High** | A real client-SDK error is reproducibly triggered by this plugin's usage on `opencode-ai@dev`. Build a minimal reproduction isolating exactly which `client.session.*` call fails (create vs. prompt vs. delete) and file an upstream issue if confirmed to be a genuine `opencode-ai@dev` regression rather than a version-mismatch artifact of the local client SDK types. Re-test on each new `dev` tag. |

**Overall:** the plugin's own mechanism (capture via subprocess) is unaffected,
but its client-SDK-dependent dedup path hits a real error on the current
`dev` build. Recommend narrowing down the exact failing call as a follow-up
before filing upstream, and re-testing against fresher `dev` builds.

## How to reproduce this test

```bash
cd ~/opencode-v2-sandbox && npm install opencode-ai@dev && node node_modules/opencode-ai/postinstall.mjs
opencode2 --version

mkdir -p /tmp/session-review-v2-test && cd /tmp/session-review-v2-test
cat > opencode.json << 'EOF'
{ "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-session-review/src/plugin.js"] }
EOF

# Redirect DBs so real ledger data is never touched:
export OPENCODE_DB="/tmp/scratch-opencode.db"
export FINDINGS_DB="/tmp/scratch-findings.db"

opencode2 run "say hello" --print-logs --log-level DEBUG 2>&1 | grep -iE "Expected a string starting with|failed ref"

# Baseline (no plugin) for comparison — should show no such error:
cd /tmp && mkdir -p baseline-no-plugin && cd baseline-no-plugin
echo '{ "$schema": "https://opencode.ai/config.json" }' > opencode.json
opencode2 run "say hello" --print-logs --log-level DEBUG 2>&1 | grep -c "Expected a string starting with"
```
