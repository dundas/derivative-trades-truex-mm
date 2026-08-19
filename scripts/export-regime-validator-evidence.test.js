import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

function run(args, env = {}) {
  return spawnSync('bun', ['scripts/export-regime-validator-evidence.js', ...args], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
  });
}

describe('regime validator evidence export CLI', () => {
  test('rejects incomplete and unknown arguments before database access', () => {
    for (const args of [[], ['--from', '1'], ['--unknown', '1', '--to', '2']]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage: bun scripts/export-regime-validator-evidence.js');
      expect(result.stderr).not.toContain('DATABASE_URL');
    }
  });

  test('rejects reversed ranges, unsafe limits, and unbounded timeouts', () => {
    const cases = [
      [['--from', '2', '--to', '1'], '--from must not exceed --to'],
      [['--from', '1', '--to', '2', '--max-fills', '-1'], '--max-fills must be'],
      [['--from', '1', '--to', '2', '--max-references', '1000001'],
        '--max-references must be between'],
      [['--from', '1', '--to', '2', '--query-timeout-ms', '999'],
        '--query-timeout-ms must be between'],
    ];
    for (const [args, message] of cases) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain('DATABASE_URL');
    }
  });

  test('rejects an ambiguous real rollout toggle before database access', () => {
    const result = run(['--from', '1', '--to', '2'], {
      REFERENCE_MARKOUT_ENABLED: 'sometimes',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REFERENCE_MARKOUT_ENABLED must be an unambiguous boolean');
    expect(result.stderr).not.toContain('DATABASE_URL');
  });
});
