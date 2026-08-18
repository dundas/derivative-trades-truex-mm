import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

describe('reference mark-out coverage CLI', () => {
  test('rejects unknown flags before opening a database connection', () => {
    const result = spawnSync('bun', ['scripts/report-reference-markout-coverage.js', '--unknown', '1'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: bun scripts/report-reference-markout-coverage.js');
    expect(result.stderr).not.toContain('DATABASE_URL');
  });

  test('rejects unsafe numeric bounds before opening a database connection', () => {
    const result = spawnSync('bun', [
      'scripts/report-reference-markout-coverage.js', '--limit', '1e100',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--limit must be a positive safe integer');
  });
});
