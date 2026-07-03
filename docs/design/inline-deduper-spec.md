<!--
Migration spec authored by the agent-engineer agent. It specifies a refactor of
an EXISTING, deployed plugin; it does not itself change code. The runnable
changes (plugin.js, capture.js, dedup-prompt.js, tests, the new prompt file) are
the `build` agent's work; the agent-dotfiles governance changes (removing the
named agent, its opencode.jsonc binding) are routed through agent-engineer.
-->

# Inline Deduper Migration Spec

## Purpose

Convert the per-session review pipeline's semantic-dedup step from an invocation
of the **named `session-finding-deduper` agent** to an **inline model call**
whose system prompt is loaded from a file in *this* repository. This mirrors the
conversion already applied to the agent-memory subsystem's distiller, giving the
dedup instructions a single source of truth that ships and versions with the
plugin.

Adopt opencode's native structured-output (`format: { type: "json_schema" }`)
for the verdict array at the same time, so the JSON-array contract is enforced
by the platform rather than only by a natural-language "reply with only JSON"
instruction plus a tolerant regex parser.

This is a refactor of a **deployed** plugin. Behaviour must be preserved
exactly: same dedup semantics, same verdict shape, same fail-safe degradation to
"no merge". The one genuinely new risk it introduces — the plugin capturing its
own dedup sub-session — is addressed in [The Critical Risk](#the-critical-risk-sub-session-capture-recursion)
and its mitigation is **mandatory**, not optional.

## Current State (as-is)

The dedup step lives in `src/plugin.js` `runDedup()` (lines ~165–192):

1. `buildDedupPrompt(fresh, others)` (from `src/lib/dedup-prompt.js`) builds a
   **single prompt string** containing the task instruction, the `NEW` and
   `EXISTING` finding arrays as JSON, and the "reply with only a JSON array"
   instruction.
2. `client.session.create({ body: { title: "session-finding dedup" } })` spawns
   an ephemeral session.
3. `client.session.prompt({ path: { id }, body: { agent: DEDUP_AGENT, parts:
   [{ type: "text", text: prompt }] } })` runs it, where
   `DEDUP_AGENT = "session-finding-deduper"` (module constant, `src/plugin.js:34`).
   Because a **named agent** is passed, the model *and the governing system
   prompt* are that agent's — the rich rules in
   `agent-dotfiles/.config/opencode/agents/session-finding-deduper.md` (73 lines)
   are the system prompt; `buildDedupPrompt`'s output is the user message.
4. The reply's text parts are joined and passed to `parseDedupReply()`, which
   regex-extracts the first `[{…}]` array and `JSON.parse`s it, returning `[]`
   on any malformed input (fail-safe).

**Model binding (to preserve):** `session-finding-deduper` →
`github-copilot/gpt-5-mini` (agent-dotfiles `opencode.jsonc`, the
`session-finding-deduper` agent block: "Cheap, high-frequency dedup verdicts …
trivial JSON-only task").

**Recursion guard (today, dual and name-based):** the dedup sub-session runs as
`agent: session-finding-deduper`, which is excluded in **two** places:

- Cheap pre-guard in the plugin event handler (`src/plugin.js:68`):
  `if (agent && EXCLUDED_AGENTS.has(agent)) return;` where
  `EXCLUDED_AGENTS = new Set(["agent-engineer", DEDUP_AGENT])` (`:37`).
- **Authoritative** guard in `src/capture.js`: `EXCLUDED_AGENTS =
  ['agent-engineer', 'session-finding-deduper']` (`:52`) passed as
  `excludedAgents` into `cmdCapture` (`:148`); the capture pass returns
  `{"new":[]}` for an excluded-by-name session so no dedup ever spawns off it.

Both guards key on the **agent name**. Removing the named agent removes both.

## Target State (to-be)

`runDedup()` calls `client.session.prompt` **without** a named `agent`:

- `body.system` = the dedup instructions, **loaded at runtime** from a new
  in-repo file `src/prompts/deduper.md` (plain Markdown, no frontmatter — it is
  never discovered as an opencode agent or skill; this repo is not a discovery
  path). See [Appendix A](#appendix-a-proposed-srcpromptsdedupermd) for the full
  proposed content.
- `body.model` = a plugin env var with a pinned default that **preserves the
  current model**: `DEDUP_MODEL` (default `github-copilot/gpt-5-mini`).
- `body.format = { type: "json_schema", schema: <verdict-array schema>,
  retryCount: <small, e.g. 2> }` — see
  [Appendix B](#appendix-b-verdict-json-schema). Build **must confirm** the
  `github-copilot/gpt-5-mini` provider honours structured outputs through
  opencode; if it does not, fall back to `format: { type: "text" }` and keep
  `parseDedupReply()` as the strict parser with its `[]` default.
- `body.parts` = the **data only**: the `NEW` and `EXISTING` finding arrays.
  `buildDedupPrompt` is reduced to emitting this compact data payload; the task
  instruction and the output contract move into `body.system` and `body.format`
  respectively. This preserves instruction/data separation — rules in `system`,
  untrusted captured findings in `parts`.

`parseDedupReply()` is retained unchanged as the fail-safe parser for the
`format: text` fallback path; on the structured-output path the reply is already
strict JSON and can be `JSON.parse`d directly (still wrapped fail-safe → `[]`).

## The Critical Risk: Sub-Session Capture Recursion

With no named agent, the ephemeral dedup session runs as opencode's **default
agent**. Neither name-based guard (`plugin.js:68`, `capture.js:52`) recognises
it any more. Because session-review captures **all** non-excluded agents (unlike
the agent-memory plugin, which acts only when `agent === 'build'` and therefore
ignored its default-agent distiller session for free), the dedup sub-session
would itself go idle, be captured, and be analysed — a recursion/noise bug.

**Mitigation (mandatory — implement both layers):**

1. **Primary, fast path — plugin tracks its own spawned sessions.** In
   `src/plugin.js`, keep an in-memory `Set` of dedup session IDs the plugin has
   created (add `created.data.id` right after `session.create`). In the `event`
   handler, skip any `sessionID` in that set — the same shape as the existing
   `inFlight` guard, but keyed on identity, not agent name. This prevents the
   plugin from ever spawning a capture for its own dedup session in the normal
   (single-process) case.

2. **Secondary, durable defense-in-depth — marker-based skip in the capture
   pass.** The in-memory set is lost if the plugin process restarts between
   creating the dedup session and its idle event, leaving an orphan the fast
   path can no longer recognise. To cover that, give every dedup session a
   durable, recognisable marker and have the **capture pass** skip it by that
   marker instead of by agent name:
   - The dedup session is already created with `title: "session-finding dedup"`.
     Adopt a stable marker (keep that exact title, or a documented prefix such as
     `"[session-review:dedup] …"`).
   - In `capture.js`, replace the name-based exclusion of
     `"session-finding-deduper"` with a check that skips a session whose title
     matches the marker (returning `{"new":[]}`), while **keeping**
     `"agent-engineer"` in the name-based `EXCLUDED_AGENTS` (that exclusion is
     unrelated to this change and must remain).

3. **Optional cleanup.** After reading the reply, delete the ephemeral dedup
   session via `client.session.delete` **if that method is available** in the
   deployed SDK (build verifies). Deletion is a nicety (less clutter, extra
   safety); it must **not** be relied on as the sole guard because it can race
   the idle event.

## Changes by Owner

### Build (runnable code in this repo)

- **`src/prompts/deduper.md`** — new file; content per Appendix A.
- **`src/plugin.js`** —
  - drop the `DEDUP_AGENT` constant and remove it from `EXCLUDED_AGENTS` (keep
    `"agent-engineer"`);
  - add a `DEDUP_MODEL` env var (default `github-copilot/gpt-5-mini`);
  - load `src/prompts/deduper.md` at runtime (resolve relative to
    `import.meta.url`, as `SCRIPT` is);
  - rewrite `runDedup()` to call `session.prompt` with `system` + `model` +
    `format` + data-only `parts` (no `agent`);
  - add the in-memory spawned-dedup-session `Set` and skip it in the `event`
    handler (mitigation layer 1).
- **`src/lib/dedup-prompt.js`** — reduce `buildDedupPrompt` to a data-only
  payload (the `NEW` + `EXISTING` arrays); keep `parseDedupReply` for the
  `format: text` fallback.
- **`src/capture.js`** — replace the name-based exclusion of
  `"session-finding-deduper"` with the title-marker skip (mitigation layer 2);
  keep `"agent-engineer"`.
- **Tests** — update `test/dedup-prompt.test.js` and `test/plugin.test.js`, and
  add coverage for: the spawned-session skip, the capture title-marker skip, the
  structured-output happy path, and the `format: text` fallback parse. Every
  behaviour above must have a test.
- **`README.md`** — document the new `DEDUP_MODEL` env var and the inline-prompt
  mechanism.

### agent-engineer (governance, in agent-dotfiles — on user go-ahead, not now)

- `git rm .config/opencode/agents/session-finding-deduper.md` once the inline
  path is built and verified.
- Remove the `session-finding-deduper` model binding from `opencode.jsonc`.
- Confirm nothing else references the agent name (grep) before removal.

### Deferred

- Ownership/governance of `src/prompts/deduper.md` (which agent may edit it, and
  any validation hook for the plugin repo) is **deferred**, exactly as for the
  agent-memory distiller prompt.

## Open Questions Build Must Confirm

1. Does `github-copilot/gpt-5-mini` honour `format: json_schema` through
   opencode? If not, take the `format: text` + `parseDedupReply` fallback.
2. Is `client.session.delete` available in the deployed SDK? If yes, use it for
   post-read cleanup (optional layer 3).
3. Does an ephemeral session created via `session.create` + `session.prompt`
   actually emit a `session.idle` event the plugin would see? This determines
   whether the sub-session-capture risk can fire at all; implement the
   mitigation regardless (defense in depth), but the answer informs test design.

## Success Criteria (for reviewing build's generated code)

- The dedup step runs with **no named agent**; instructions come from
  `src/prompts/deduper.md` via `body.system`; the model is `DEDUP_MODEL`
  (default `github-copilot/gpt-5-mini`); findings data travels in `body.parts`,
  not in the system prompt.
- Verdict output is the **same shape** as today: a JSON array of
  `{"new_id": <int>, "duplicate_of": <int|null>}`, one object per NEW finding;
  malformed/absent output degrades to `[]` (no merges), never throws into
  opencode.
- Structured output via `format: json_schema` is used when the provider
  supports it; otherwise the `format: text` + `parseDedupReply` fallback is in
  place — both paths are covered by tests.
- **Recursion is impossible:** the plugin never captures its own dedup
  sub-session — proven by (1) the in-memory spawned-session skip and (2) the
  capture-pass title-marker skip; `"agent-engineer"` remains excluded by name.
- Dedup semantics are unchanged: root-cause matching, at-most-one match per NEW
  finding, conservative `null`, ids only from the supplied arrays.
- No `session-finding-deduper` agent name remains referenced anywhere in this
  repo after the change.
- Fail-safe posture preserved: every step wrapped; a failure degrades to "no
  dedup / no merge" for that session.

## Appendix A: Proposed `src/prompts/deduper.md`

Derived from `agent-dotfiles/.config/opencode/agents/session-finding-deduper.md`,
trimmed of interactive-agent scaffolding (the verbatim Methodology preamble and
the Escalation section are dropped) into a lean one-shot system prompt. Ready to
drop in.

```markdown
<!--
Loaded by the opencode-session-review plugin as `body.system` for the inline
dedup model call (see docs/design/inline-deduper-spec.md). The NEW and EXISTING
finding arrays arrive as untrusted data in `body.parts`, not here. The strict
JSON-array output contract is enforced by the call's `format` (json_schema),
with a tolerant text-parse fallback in the plugin. Source of substance: the
former agent-dotfiles `.config/opencode/agents/session-finding-deduper.md`,
trimmed of interactive-agent scaffolding. Ownership/governance deferred.
-->

You decide whether newly captured session-review findings describe the same
underlying root cause as existing ledger entries, returning a machine-parseable
merge verdict. You never edit files, never fix anything, and never write to the
ledger — you only judge.

## Task

You are given two arrays in the message: NEW (just-captured findings) and
EXISTING (open findings to compare against). For each NEW finding, decide
whether it is a semantic duplicate of exactly one EXISTING finding — that is,
whether they share the same underlying root cause.

## Rules

- Match on root cause (the same tool failing the same way for the same reason),
  not on surface string equality. Ignore volatile differences already normalised
  away (ids, line numbers, paths, digits).
- Map each NEW finding to at most one EXISTING finding — never to another NEW
  finding, and never to more than one.
- Use `duplicate_of: null` whenever a NEW finding has no clear single match, when
  there is ambiguity, or when more than one EXISTING finding plausibly matches.
  Be conservative: prefer null over a doubtful merge.
- Do not merge findings from different agents or different tools unless the root
  cause is unmistakably identical.
- Reference only ids that appear in the supplied NEW or EXISTING arrays. Never
  invent ids and never use anything outside the supplied arrays.

## Output

Return a single JSON array, one object per NEW finding, and nothing else:

[{"new_id": <id>, "duplicate_of": <existing id or null>}]

When the NEW array is empty, or either array is missing or unparseable, return
[]. No prose, no markdown, no code fence, no commentary.
```

## Appendix B: Verdict JSON Schema

For `body.format = { type: "json_schema", schema: <this>, retryCount: 2 }`:

```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "new_id": { "type": "integer" },
      "duplicate_of": { "type": ["integer", "null"] }
    },
    "required": ["new_id", "duplicate_of"],
    "additionalProperties": false
  }
}
```
