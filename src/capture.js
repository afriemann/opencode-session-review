#!/usr/bin/env node
// src/capture.js — CLI entry-point for the session-findings capture pipeline.
//
// Replaces session-finding-capture.sh as the subprocess target.
// Invoked as: node src/capture.js <subcommand> [args...]
//
// Exit codes:
//   0 — success
//   2 — usage / environment error
//
// Subcommands:
//   capture   <sessionID>       Run the capture pass; prints JSON to stdout.
//   merge     <dupID> <intoID>  Merge a duplicate finding into the canonical one.
//   resolve   <id...>           Set status='resolved' for each finding id.
//   reopen    <id...>           Set status='open' for each finding id.
//   ignore    <id...>           Suppress fingerprint + resolve each finding.
//   list                        Print open findings as a human-readable table.
//   json-open                   Print open findings as a JSON array.
//   init                        Create the ledger schema if absent, then exit.
//   -h | --help                 Print this help text.

import { cmdCapture } from './lib/commands/capture.js';
import { cmdMerge } from './lib/commands/merge.js';
import { cmdResolve, cmdReopen } from './lib/commands/status.js';
import { cmdIgnore } from './lib/commands/ignore.js';
import { cmdList } from './lib/commands/list.js';
import { cmdJsonOpen } from './lib/commands/json-open.js';
import { openLedger } from './lib/db.js';
import { ensureSchema } from './lib/schema.js';

// ── Configuration ─────────────────────────────────────────────────────────────
const HOME = process.env.HOME || '';

const OPENCODE_DB =
  process.env.OPENCODE_DB ||
  `${HOME}/.local/share/opencode/opencode.db`;

const FINDINGS_DB =
  process.env.FINDINGS_DB ||
  `${HOME}/.local/share/opencode/session-findings.db`;

const CAPTURE_MIN_INTERVAL_MS = (() => {
  const raw = process.env.CAPTURE_MIN_INTERVAL_MS ?? '60000';
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0 || String(n) !== raw) {
    die(`CAPTURE_MIN_INTERVAL_MS must be a non-negative integer: ${raw}`);
  }
  return n;
})();

// Agents whose sessions must never be analysed (recursion guard).
// session-finding-deduper has been removed: its sessions are now identified
// by title marker (see SKIP_TITLES below) rather than by agent name.
const EXCLUDED_AGENTS = ['agent-engineer'];

// Session titles to skip (title-marker recursion/cross-plugin guard, layer 2).
// Provides defence-in-depth for the event-handler title check in plugin.js.
//
//   'session-finding dedup' = ephemeral dedup sessions spawned by this plugin.
//   'agent-memory distil'   = ephemeral distil sub-sessions from the
//                             opencode-agent-memory plugin (run as the default
//                             agent, so EXCLUDED_AGENTS cannot catch them).
const SKIP_TITLES = ['session-finding dedup', 'agent-memory distil'];

// First-token allowlist for approval-toil candidates.
const APPROVAL_ALLOW_PREFIXES = [
  'go', 'gh', 'git', 'cargo', 'npm', 'pnpm', 'yarn',
  'make', 'just', 'task', 'jq', 'docker', 'kubectl', 'terraform',
];

// Destructive phrase denylist for approval-toil (substring check).
const APPROVAL_DENY_SHAPES = [
  'git push *', 'git commit *',
  'terraform apply *', 'terraform destroy *',
  'kubectl delete *', 'kubectl apply *', 'kubectl drain *',
  'docker system prune *', 'docker volume rm *', 'docker rm *', 'docker rmi *',
];

// Research-style agents to check for suspect-fabrication (cites sources without webfetch).
const FABRICATION_AGENTS = ['web-researcher'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

function parseIds(args, subcmd) {
  if (!args || args.length === 0) die(`${subcmd}: requires at least one finding id`);
  return args.map((a) => {
    const n = parseInt(a, 10);
    if (isNaN(n) || n <= 0 || String(n) !== a) die(`${subcmd}: invalid id: ${a}`);
    return n;
  });
}

function printTable(rows) {
  if (rows.length === 0) {
    process.stdout.write('(no open findings)\n');
    return;
  }
  // Simple fixed-width table matching the column headings from the bash script.
  const header = 'id   sev     signal              tool            n   sess  description';
  const sep    = '---  ------  ------------------  --------------  --  ----  ' + '-'.repeat(42);
  process.stdout.write(header + '\n' + sep + '\n');
  for (const r of rows) {
    const id   = String(r.id).padEnd(4);
    const sev  = String(r.sev || '').padEnd(7);
    const sig  = String(r.signal || '').slice(0, 18).padEnd(19);
    const tool = String(r.tool || '').slice(0, 14).padEnd(15);
    const n    = String(r.n).padEnd(4);
    const sess = String(r.sessions).padEnd(5);
    const desc = String(r.description || '').slice(0, 90);
    process.stdout.write(`${id} ${sev} ${sig} ${tool} ${n} ${sess} ${desc}\n`);
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const [, , sub, ...rest] = process.argv;

const HELP_TEXT = `session-findings capture pipeline

Subcommands:
  capture   <sessionID>       Run the capture pass; prints JSON to stdout.
  merge     <dupID> <intoID>  Merge a duplicate finding into the canonical one.
  resolve   <id...>           Set status='resolved'.
  reopen    <id...>           Set status='open'.
  ignore    <id...>           Suppress fingerprint + resolve.
  list                        Print open findings as a human-readable table.
  json-open                   Print open findings as a JSON array.
  init                        Ensure the ledger schema exists, then exit.

Env:
  OPENCODE_DB              Session store path (default: ~/.local/share/opencode/opencode.db)
  FINDINGS_DB              Ledger path       (default: ~/.local/share/opencode/session-findings.db)
  CAPTURE_MIN_INTERVAL_MS  Throttle interval in ms (default: 60000)
`;

(async () => {
  switch (sub) {
    case '-h':
    case '--help':
    case undefined:
      process.stdout.write(HELP_TEXT);
      process.exit(0);
      break;

    case 'capture': {
      const sessionId = rest[0];
      if (!sessionId) die('capture: requires a sessionID');
      let result;
      try {
        result = await cmdCapture(sessionId, {
          openCodeDb: OPENCODE_DB,
          findingsDb: FINDINGS_DB,
          captureMinIntervalMs: CAPTURE_MIN_INTERVAL_MS,
          excludedAgents: EXCLUDED_AGENTS,
          skipTitles: SKIP_TITLES,
          approvalAllowPrefixes: APPROVAL_ALLOW_PREFIXES,
          approvalDenyShapes: APPROVAL_DENY_SHAPES,
          fabricationAgents: FABRICATION_AGENTS,
        });
      } catch (err) {
        die(err.message || String(err));
      }
      process.stdout.write(JSON.stringify(result) + '\n');
      break;
    }

    case 'merge': {
      const dupId = parseInt(rest[0], 10);
      const intoId = parseInt(rest[1], 10);
      if (isNaN(dupId) || isNaN(intoId)) die('merge: requires two numeric IDs');
      const ledger = openLedger(FINDINGS_DB);
      ensureSchema(ledger);
      try {
        cmdMerge(ledger, dupId, intoId);
      } catch (err) {
        die(err.message || String(err));
      }
      process.stdout.write(`merged ${dupId} into ${intoId}\n`);
      break;
    }

    case 'resolve': {
      const ids = parseIds(rest, 'resolve');
      const ledger = openLedger(FINDINGS_DB);
      ensureSchema(ledger);
      try {
        cmdResolve(ledger, ids);
      } catch (err) {
        die(err.message || String(err));
      }
      for (const id of ids) process.stdout.write(`resolved ${id}\n`);
      break;
    }

    case 'reopen': {
      const ids = parseIds(rest, 'reopen');
      const ledger = openLedger(FINDINGS_DB);
      ensureSchema(ledger);
      try {
        cmdReopen(ledger, ids);
      } catch (err) {
        die(err.message || String(err));
      }
      for (const id of ids) process.stdout.write(`open ${id}\n`);
      break;
    }

    case 'ignore': {
      const ids = parseIds(rest, 'ignore');
      const ledger = openLedger(FINDINGS_DB);
      ensureSchema(ledger);
      try {
        cmdIgnore(ledger, ids);
      } catch (err) {
        die(err.message || String(err));
      }
      for (const id of ids) {
        process.stdout.write(
          `ignored ${id} (fingerprint suppressed; will not be counted again)\n`
        );
      }
      break;
    }

    case 'list': {
      const ledger = openLedger(FINDINGS_DB);
      ensureSchema(ledger);
      let rows;
      try {
        rows = cmdList(ledger);
      } catch (err) {
        die(err.message || String(err));
      }
      printTable(rows);
      break;
    }

    case 'json-open': {
      const ledger = openLedger(FINDINGS_DB);
      ensureSchema(ledger);
      let rows;
      try {
        rows = cmdJsonOpen(ledger);
      } catch (err) {
        die(err.message || String(err));
      }
      process.stdout.write(JSON.stringify(rows) + '\n');
      break;
    }

    case 'init': {
      const ledger = openLedger(FINDINGS_DB);
      ensureSchema(ledger);
      process.stdout.write('schema ok\n');
      break;
    }

    default:
      die(`unknown subcommand: ${sub}`);
  }
})();
