## 1. Confirm current V1 hook usage

- [x] 1.1 Confirm this plugin's single `event` hook (listens for
  `session.idle`, orchestrates the capture/dedup pipeline via a spawned
  `node capture.js` subprocess and `client.session.create/prompt/delete`)
  from `src/plugin.js` — verify by grepping the source.

## 2. Empirically test against opencode2 (opencode-ai@dev)

- [x] 2.1 In a scratch project, add an `opencode.json` pointing `plugin` at
  this repo's `src/plugin.js`, with `OPENCODE_DB`/`FINDINGS_DB` env vars
  redirected to scratch temp files (never the real
  `~/.local/share/opencode/session-findings.db`), run `opencode2 run "..."
  --print-logs --log-level DEBUG`, and capture the log — verify the
  `session.idle` event fires and the capture subprocess runs without error.
- [x] 2.2 Record the tested `opencode2`/`opencode-ai` dev build version.

## 3. Write the audit document

- [x] 3.1 Write `docs/v2-compat-audit.md` with the same structure as prior
  audits (overview, hook table, empirical results with evidence, V2-doc
  cross-reference, risk rating, reproduction steps).
