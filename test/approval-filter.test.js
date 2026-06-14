// test/approval-filter.test.js
// Tests for all exported functions from src/lib/approval-filter.js

import {
  wildcardRegex,
  expandPattern,
  extractFirstToken,
  isDenyShape,
  resolveLastMatch,
  filterApprovalToil,
} from '../src/lib/approval-filter.js';

// APPROVAL_DENY_SHAPES from src/capture.js (mirrored here for integration tests)
const APPROVAL_DENY_SHAPES = [
  'git push *',
  'git commit *',
  'terraform apply *',
  'terraform destroy *',
  'kubectl delete *',
  'kubectl apply *',
  'kubectl drain *',
  'docker system prune *',
  'docker volume rm *',
  'docker rm *',
  'docker rmi *',
];

const APPROVAL_ALLOW_PREFIXES = [
  'go', 'gh', 'git', 'cargo', 'npm', 'pnpm', 'yarn',
  'make', 'just', 'task', 'jq', 'docker', 'kubectl', 'terraform',
];

describe('wildcardRegex()', () => {
  test('"git *" matches "git status"', () => {
    expect(wildcardRegex('git *').test('git status')).toBe(true);
  });

  test('"git *" matches "git commit -m \\"foo\\""', () => {
    expect(wildcardRegex('git *').test('git commit -m "foo"')).toBe(true);
  });

  test('"git *" matches bare "git" (trailing arg is optional)', () => {
    // Step 5: trailing ' .*' becomes '( .*)?' — space is INSIDE the group
    expect(wildcardRegex('git *').test('git')).toBe(true);
  });

  test('"ls *" matches "ls -la"', () => {
    expect(wildcardRegex('ls *').test('ls -la')).toBe(true);
  });

  test('"ls *" matches bare "ls"', () => {
    expect(wildcardRegex('ls *').test('ls')).toBe(true);
  });

  test('"go test *" matches "go test ./..."', () => {
    expect(wildcardRegex('go test *').test('go test ./...')).toBe(true);
  });

  test('"go test *" does NOT match "go build"', () => {
    expect(wildcardRegex('go test *').test('go build')).toBe(false);
  });

  test('"*" matches any string', () => {
    expect(wildcardRegex('*').test('anything at all 12345')).toBe(true);
    expect(wildcardRegex('*').test('')).toBe(true);
  });

  test('"kubectl" (no wildcard) matches only "kubectl" exactly', () => {
    const rx = wildcardRegex('kubectl');
    expect(rx.test('kubectl')).toBe(true);
    expect(rx.test('kubectl get pods')).toBe(false);
    expect(rx.test('kubectl ')).toBe(false);
  });

  test('path pattern with wildcard — after HOME expansion — matches plausible path', () => {
    const HOME = '/home/alice';
    const pattern = expandPattern('~/.agents/skills/*.sh*', HOME);
    const rx = wildcardRegex(pattern);
    expect(rx.test('/home/alice/.agents/skills/git.sh')).toBe(true);
    expect(rx.test('/home/alice/.agents/skills/pre-commit.sh')).toBe(true);
    // non-matching path
    expect(rx.test('/home/alice/.agents/other/script.sh')).toBe(false);
  });

  test('"git commit *" matches "git commit"', () => {
    expect(wildcardRegex('git commit *').test('git commit')).toBe(true);
  });

  test('"git commit *" matches "git commit -m msg"', () => {
    expect(wildcardRegex('git commit *').test('git commit -m msg')).toBe(true);
  });
});

describe('expandPattern()', () => {
  const HOME = '/home/testuser';

  test('"~" → home', () => {
    expect(expandPattern('~', HOME)).toBe(HOME);
  });

  test('"~/foo" → home + "/foo"', () => {
    expect(expandPattern('~/foo', HOME)).toBe(`${HOME}/foo`);
  });

  test('"$HOME/bar" → home + "/bar"', () => {
    expect(expandPattern('$HOME/bar', HOME)).toBe(`${HOME}/bar`);
  });

  test('"${HOME}/baz" → home + "/baz"', () => {
    expect(expandPattern('${HOME}/baz', HOME)).toBe(`${HOME}/baz`);
  });

  test('"relative/path" → unchanged', () => {
    expect(expandPattern('relative/path', HOME)).toBe('relative/path');
  });

  test('"$HOME" (no trailing slash) → home', () => {
    expect(expandPattern('$HOME', HOME)).toBe(HOME);
  });

  test('"${HOME}" (no trailing slash) → home', () => {
    expect(expandPattern('${HOME}', HOME)).toBe(HOME);
  });
});

describe('extractFirstToken()', () => {
  test('"go test ./..." → "go"', () => {
    expect(extractFirstToken('go test ./...')).toBe('go');
  });

  test('"cd /tmp && git status" → "git"', () => {
    expect(extractFirstToken('cd /tmp && git status')).toBe('git');
  });

  test('"env GOPATH=/tmp go build" → "go"', () => {
    expect(extractFirstToken('env GOPATH=/tmp go build')).toBe('go');
  });

  test('"FOO=bar BAZ=qux make install" → "make"', () => {
    expect(extractFirstToken('FOO=bar BAZ=qux make install')).toBe('make');
  });

  test('"  git   log  " → "git"', () => {
    expect(extractFirstToken('  git   log  ')).toBe('git');
  });

  test('empty string → ""', () => {
    expect(extractFirstToken('')).toBe('');
  });

  test('whitespace-only string → ""', () => {
    expect(extractFirstToken('   ')).toBe('');
  });

  test('"npm install" → "npm"', () => {
    expect(extractFirstToken('npm install')).toBe('npm');
  });

  test('"cd /tmp ; git push" → "git"', () => {
    expect(extractFirstToken('cd /tmp ; git push')).toBe('git');
  });
});

describe('isDenyShape()', () => {
  test('"git push origin main" → true', () => {
    expect(isDenyShape('git push origin main', APPROVAL_DENY_SHAPES)).toBe(true);
  });

  test('"terraform destroy -auto-approve" → true', () => {
    expect(isDenyShape('terraform destroy -auto-approve', APPROVAL_DENY_SHAPES)).toBe(true);
  });

  test('"cd ~/project && git push" → true (deny phrase anywhere in compound)', () => {
    expect(isDenyShape('cd ~/project && git push', APPROVAL_DENY_SHAPES)).toBe(true);
  });

  test('"git commit -m msg" → true', () => {
    expect(isDenyShape('git commit -m msg', APPROVAL_DENY_SHAPES)).toBe(true);
  });

  test('"git status" → false', () => {
    expect(isDenyShape('git status', APPROVAL_DENY_SHAPES)).toBe(false);
  });

  test('"go build ./..." → false', () => {
    expect(isDenyShape('go build ./...', APPROVAL_DENY_SHAPES)).toBe(false);
  });

  test('"kubectl get pods" → false', () => {
    expect(isDenyShape('kubectl get pods', APPROVAL_DENY_SHAPES)).toBe(false);
  });

  test('"docker rm container-id" → true', () => {
    expect(isDenyShape('docker rm container-id', APPROVAL_DENY_SHAPES)).toBe(true);
  });

  test('empty deny shapes → always false', () => {
    expect(isDenyShape('git push origin main', [])).toBe(false);
  });
});

describe('resolveLastMatch()', () => {
  const HOME = '/home/testuser';

  test('empty rules → "ask"', () => {
    expect(resolveLastMatch([], 'git status', HOME)).toBe('ask');
  });

  test('single allow rule matching → "allow"', () => {
    const rules = [{ action: 'allow', pattern: 'git *' }];
    expect(resolveLastMatch(rules, 'git status', HOME)).toBe('allow');
  });

  test('single allow rule not matching → "ask"', () => {
    const rules = [{ action: 'allow', pattern: 'git *' }];
    expect(resolveLastMatch(rules, 'npm install', HOME)).toBe('ask');
  });

  test('last matching rule wins: allow then deny → "deny" for git push', () => {
    const rules = [
      { action: 'allow', pattern: 'git *' },
      { action: 'deny', pattern: 'git push *' },
    ];
    expect(resolveLastMatch(rules, 'git push origin', HOME)).toBe('deny');
  });

  test('last matching rule wins: allow then deny → "allow" for git status', () => {
    const rules = [
      { action: 'allow', pattern: 'git *' },
      { action: 'deny', pattern: 'git push *' },
    ];
    expect(resolveLastMatch(rules, 'git status', HOME)).toBe('allow');
  });

  test('tilde in pattern is expanded', () => {
    const rules = [{ action: 'allow', pattern: '~/.agents/skills/*' }];
    const cmd = `${HOME}/.agents/skills/git.sh`;
    expect(resolveLastMatch(rules, cmd, HOME)).toBe('allow');
  });
});

describe('filterApprovalToil()', () => {
  const rules = [];
  const allowPrefixes = APPROVAL_ALLOW_PREFIXES;
  const denyShapes = APPROVAL_DENY_SHAPES;

  // Gate 1: command resolves to 'allow' → dropped
  test('Gate 1: command resolving to "allow" (matched allow rule) → dropped', () => {
    const allowRules = [{ action: 'allow', pattern: 'git *' }];
    const result = filterApprovalToil(['git status'], allowRules, allowPrefixes, denyShapes);
    expect(result).toHaveLength(0);
  });

  // Gate 1: command resolves to 'ask' (no matching rule) → proceeds
  test('Gate 1: command resolving to "ask" (no rule matches) → proceeds to gate 2', () => {
    // 'go test ./...' has no matching rule (rules is empty), but 'go' IS in allowPrefixes
    // and it's not a deny shape and not severe → should appear in output
    const result = filterApprovalToil(['go test ./...'], [], allowPrefixes, denyShapes);
    expect(result).toHaveLength(1);
    expect(result[0].firstToken).toBe('go');
  });

  // Gate 2: first token not in allowPrefixes → dropped
  test('Gate 2: first token "rm" not in allowPrefixes → dropped', () => {
    const result = filterApprovalToil(['rm -rf /tmp'], rules, allowPrefixes, denyShapes);
    expect(result).toHaveLength(0);
  });

  // Gate 2: first token in allowPrefixes → proceeds
  test('Gate 2: first token "go" in allowPrefixes → proceeds', () => {
    const result = filterApprovalToil(['go test ./...'], rules, allowPrefixes, denyShapes);
    expect(result).toHaveLength(1);
  });

  // Gate 3: command containing deny shape → dropped
  test('Gate 3: "git push origin main" → dropped even though "git" is allowlisted', () => {
    const result = filterApprovalToil(
      ['git push origin main'],
      rules,
      allowPrefixes,
      denyShapes,
    );
    expect(result).toHaveLength(0);
  });

  // Gate 4: normalised command classified 'severe' → dropped
  test('Gate 4: command containing "token" → dropped by severity gate', () => {
    // 'git' is in allowPrefixes; no deny shape; but normalised contains 'token'
    // which is in the severe phrases list
    const result = filterApprovalToil(
      ['git token-scan'], // 'token' appears in normalised form
      rules,
      allowPrefixes,
      denyShapes,
    );
    expect(result).toHaveLength(0);
  });

  // Combined: command that passes all 4 gates
  test('Combined: "go build ./..." passes all 4 gates → correct output shape', () => {
    const result = filterApprovalToil(['go build ./...'], rules, allowPrefixes, denyShapes);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('firstToken', 'go');
    expect(result[0]).toHaveProperty('normalised');
    expect(typeof result[0].normalised).toBe('string');
    expect(result[0].normalised.length).toBeGreaterThan(0);
  });

  test('empty command list → empty output', () => {
    expect(filterApprovalToil([], rules, allowPrefixes, denyShapes)).toHaveLength(0);
  });

  test('multiple commands: only gate-passing ones survive', () => {
    const cmds = [
      'go test ./...',           // passes all gates
      'git push origin main',    // gate 3 deny
      'rm -rf /tmp',             // gate 2 deny (rm not in allowPrefixes)
      'go build ./...',          // passes all gates
    ];
    const result = filterApprovalToil(cmds, rules, allowPrefixes, denyShapes);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.firstToken)).toEqual(['go', 'go']);
  });

  test('Gate 4: "git secret-scan" → dropped (contains "secret")', () => {
    // normalise() lowercases, so 'secret' survives and triggers severe
    const result = filterApprovalToil(['git secret-scan'], rules, allowPrefixes, denyShapes);
    expect(result).toHaveLength(0);
  });
});
