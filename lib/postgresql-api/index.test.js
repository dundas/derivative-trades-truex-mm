import { describe, expect, it } from 'bun:test';

describe('PostgreSQL TLS policy', () => {
  it('allows local plaintext, verifies remote TLS, and rejects unsafe configuration', async () => {
    // Keep this isolated from the manager suite's process-global module mock.
    const program = `
      import { resolvePostgreSQLSSL } from './lib/postgresql-api/index.js';
      const capture = fn => { try { return { value: fn() }; } catch (error) { return { error: error.message }; } };
      console.log(JSON.stringify({
        local: resolvePostgreSQLSSL('postgresql://localhost/db'),
        localDisabled: resolvePostgreSQLSSL('postgresql://127.0.0.1/db?sslmode=disable'),
        localIpv6Disabled: resolvePostgreSQLSSL('postgresql://[::1]/db?sslmode=disable'),
        remote: resolvePostgreSQLSSL('postgresql://db.example.com/db'),
        remoteCa: resolvePostgreSQLSSL('postgresql://db.example.com/db', 'trusted-ca'),
        remoteDisabled: capture(() => resolvePostgreSQLSSL('postgresql://db.example.com/db?sslmode=disable')),
        invalidCa: capture(() => resolvePostgreSQLSSL('postgresql://db.example.com/db', '')),
      }));
    `;
    const subprocess = Bun.spawn(['bun', '-e', program], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(subprocess.stdout).text();
    expect(await subprocess.exited).toBe(0);
    const evidence = JSON.parse(output);
    expect(evidence).toEqual({
      local: false,
      localDisabled: false,
      localIpv6Disabled: false,
      remote: { rejectUnauthorized: true },
      remoteCa: { rejectUnauthorized: true, ca: 'trusted-ca' },
      remoteDisabled: { error: 'sslmode=disable is only permitted for local PostgreSQL connections' },
      invalidCa: { error: 'PostgreSQL TLS CA must be a non-empty PEM string when provided' },
    });
  });

  it('keeps URL TLS knobs from overriding the effective Pool and Client TLS policy', async () => {
    const program = `
      import pg from 'pg';
      import { resolvePostgreSQLConnectionConfig } from './lib/postgresql-api/index.js';
      const effective = (url, ca) => {
        const config = resolvePostgreSQLConnectionConfig(url, ca);
        const pool = new pg.Pool(config);
        const client = new pool.Client(pool.options);
        return {
          sanitized: config.connectionString,
          poolSsl: pool.options.ssl,
          clientSsl: client.connectionParameters.ssl,
        };
      };
      const capture = fn => { try { return fn(); } catch (error) { return { error: error.message }; } };
      console.log(JSON.stringify({
        noVerify: effective('postgresql://db.example.com/app?sslmode=no-verify'),
        directSslAndClientFiles: effective('postgresql://db.example.com/app?ssl=no-verify&sslcert=/tmp/hostile-cert&sslkey=/tmp/hostile-key'),
        libpqRequire: effective('postgresql://db.example.com/app?uselibpqcompat=true&sslmode=require'),
        duplicateTlsSanitized: effective('postgresql://db.example.com/app?sslmode=no-verify&sslmode=require&ssl=no-verify&ssl=no-verify'),
        verifyFullCa: effective('postgresql://db.example.com/app?sslmode=verify-full&sslrootcert=/tmp/hostile', 'trusted-ca'),
        localIpv4: effective('postgresql://127.0.0.1/app?sslmode=disable'),
        localIpv6: effective('postgresql://[::1]/app?sslmode=disable'),
        authorityLocalButEffectiveRemote: capture(() => effective('postgresql://localhost/app?host=db.example.com&sslmode=disable')),
        duplicateHostLocalThenRemote: capture(() => effective('postgresql://localhost/app?host=localhost&host=db.example.com&sslmode=disable')),
        duplicateHostRemoteThenLocal: capture(() => effective('postgresql://localhost/app?host=db.example.com&host=localhost&sslmode=disable')),
      }));
    `;
    const subprocess = Bun.spawn(['bun', '-e', program], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(subprocess.stdout).text();
    const error = await new Response(subprocess.stderr).text();
    expect(await subprocess.exited).toBe(0);
    expect(error).toBe('');
    const evidence = JSON.parse(output);
    expect(evidence.noVerify).toEqual({
      sanitized: 'postgresql://db.example.com/app',
      poolSsl: { rejectUnauthorized: true }, clientSsl: { rejectUnauthorized: true },
    });
    expect(evidence.directSslAndClientFiles).toEqual({
      sanitized: 'postgresql://db.example.com/app',
      poolSsl: { rejectUnauthorized: true }, clientSsl: { rejectUnauthorized: true },
    });
    expect(evidence.libpqRequire).toEqual({
      sanitized: 'postgresql://db.example.com/app',
      poolSsl: { rejectUnauthorized: true }, clientSsl: { rejectUnauthorized: true },
    });
    expect(evidence.duplicateTlsSanitized).toEqual({
      sanitized: 'postgresql://db.example.com/app',
      poolSsl: { rejectUnauthorized: true }, clientSsl: { rejectUnauthorized: true },
    });
    expect(evidence.verifyFullCa).toEqual({
      sanitized: 'postgresql://db.example.com/app',
      poolSsl: { rejectUnauthorized: true, ca: 'trusted-ca' },
      clientSsl: { rejectUnauthorized: true, ca: 'trusted-ca' },
    });
    expect(evidence.localIpv4).toEqual({
      sanitized: 'postgresql://127.0.0.1/app', poolSsl: false, clientSsl: false,
    });
    expect(evidence.localIpv6).toEqual({
      sanitized: 'postgresql://[::1]/app', poolSsl: false, clientSsl: false,
    });
    expect(evidence.authorityLocalButEffectiveRemote).toEqual({
      error: 'sslmode=disable is only permitted for local PostgreSQL connections',
    });
    expect(evidence.duplicateHostLocalThenRemote).toEqual({
      error: 'PostgreSQL connection URL must not contain duplicate host parameters',
    });
    expect(evidence.duplicateHostRemoteThenLocal).toEqual({
      error: 'PostgreSQL connection URL must not contain duplicate host parameters',
    });
  });
});

describe('PostgreSQLAdapter bounded telemetry queries', () => {
  it('sets server-side statement/lock bounds and reports latency/pool state', async () => {
    // Isolate this contract from the legacy manager suite's process-global module mock.
    const program = `
      import { PostgreSQLAdapter } from './lib/postgresql-api/index.js';
      const calls = [];
      const client = { query: async input => {
        calls.push(input);
        return typeof input === 'object' && input.text === 'SELECT $1'
          ? { rows: [{ ok: true }] } : { rows: [] };
      }, release() {} };
      const adapter = new PostgreSQLAdapter({
        connectionString: 'postgresql://local/test', connectionTimeoutMillis: 750,
        monotonicNow: () => 0,
      });
      adapter.pool = { connect: async () => client, totalCount: 2, idleCount: 1, waitingCount: 3 };
      const result = await adapter.boundedQuery('SELECT $1', [7], {
        lockTimeoutMs: 100, statementTimeoutMs: 500, queryTimeoutMs: 750,
      });
      console.log(JSON.stringify({ calls, result, stats: adapter.getPoolStats() }));
    `;
    const subprocess = Bun.spawn(['bun', '-e', program], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(subprocess.stdout).text();
    const error = await new Response(subprocess.stderr).text();
    expect(await subprocess.exited).toBe(0);
    expect(error).toBe('');
    const evidence = JSON.parse(output);
    expect(evidence.calls[1]).toEqual({
      text: "SET LOCAL lock_timeout = '100ms'", values: [], query_timeout: 750,
    });
    expect(evidence.calls[2]).toEqual({
      text: "SET LOCAL statement_timeout = '500ms'", values: [], query_timeout: 750,
    });
    expect(evidence.calls[3]).toEqual({ text: 'SELECT $1', values: [7], query_timeout: 750 });
    expect(evidence.result).toEqual({ rows: [{ ok: true }] });
    expect(evidence.stats).toMatchObject({
      totalConnections: 2, idleConnections: 1, waitingRequests: 3,
      activeQueries: 0, queriesExecuted: 1, queryErrors: 0,
      lastQueryLatencyMs: expect.any(Number),
    });
  });

  it('accounts for pool acquisition timeout without leaking active query state', async () => {
    const program = `
      import { PostgreSQLAdapter } from './lib/postgresql-api/index.js';
      const adapter = new PostgreSQLAdapter({
        connectionString: 'postgresql://local/test', connectionTimeoutMillis: 100,
      });
      adapter.pool = { connect: async () => { throw new Error('pool acquisition timeout'); } };
      try {
        await adapter.boundedQuery('SELECT 1', [], {
          lockTimeoutMs: 50, statementTimeoutMs: 75, queryTimeoutMs: 100,
        });
      } catch (error) {
        console.log(JSON.stringify({ message: error.message, stats: adapter.getPoolStats() }));
      }
    `;
    const subprocess = Bun.spawn(['bun', '-e', program], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(subprocess.stdout).text();
    expect(await subprocess.exited).toBe(0);
    const evidence = JSON.parse(output);
    expect(evidence.message).toBe('pool acquisition timeout');
    expect(evidence.stats).toMatchObject({
      activeQueries: 0, queriesExecuted: 1, queryErrors: 1,
      lastQueryLatencyMs: expect.any(Number),
    });
  });

  it('uses one absolute deadline across pool acquisition and five delayed protocol steps', async () => {
    const program = `
      import { PostgreSQLAdapter } from './lib/postgresql-api/index.js';
      let now = 0;
      const calls = [];
      const releases = [];
      const client = { query: async input => {
        calls.push(input);
        const delay = 18;
        if (delay >= input.query_timeout) {
          now += input.query_timeout;
          throw new Error('protocol step timeout');
        }
        now += delay;
        return input.text === 'SELECT 1' ? { rows: [{ ok: true }] } : { rows: [] };
      }, release(value) { releases.push(value ?? 'ordinary'); } };
      const adapter = new PostgreSQLAdapter({
        connectionString: 'postgresql://local/test', connectionTimeoutMillis: 95,
        monotonicNow: () => now,
      });
      adapter.pool = { connect: async () => { now += 5; return client; } };
      try {
        await adapter.boundedQuery('SELECT 1', [], {
          lockTimeoutMs: 50, statementTimeoutMs: 75, queryTimeoutMs: 95,
        });
      } catch (error) {
        console.log(JSON.stringify({ message: error.message, now, calls, releases,
          stats: adapter.getPoolStats() }));
      }
    `;
    const subprocess = Bun.spawn(['bun', '-e', program], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(subprocess.stdout).text();
    expect(await subprocess.exited).toBe(0);
    const evidence = JSON.parse(output);
    expect(evidence.message).toBe('protocol step timeout');
    expect(evidence.now).toBe(95);
    expect(evidence.calls.map(call => call.query_timeout)).toEqual([90, 72, 54, 36, 18]);
    expect(evidence.calls[1].text).toContain("lock_timeout = '50ms'");
    expect(evidence.calls[2].text).toContain("statement_timeout = '54ms'");
    expect(evidence.releases).toEqual([true]);
    expect(evidence.stats).toMatchObject({ activeQueries: 0, queryErrors: 1, lastQueryLatencyMs: 95 });
  });

  it('destroys the client when rollback rejects after a business-query failure', async () => {
    const program = `
      import { PostgreSQLAdapter } from './lib/postgresql-api/index.js';
      let now = 0;
      const releases = [];
      const client = { query: async input => {
        now += 5;
        if (input.text === 'SELECT broken') throw new Error('business failure');
        if (input.text === 'ROLLBACK') throw new Error('rollback failure');
        return { rows: [] };
      }, release(value) { releases.push(value ?? 'ordinary'); } };
      const adapter = new PostgreSQLAdapter({
        connectionString: 'postgresql://local/test', connectionTimeoutMillis: 100,
        monotonicNow: () => now,
      });
      adapter.pool = { connect: async () => client };
      try {
        await adapter.boundedQuery('SELECT broken', [], {
          lockTimeoutMs: 25, statementTimeoutMs: 50, queryTimeoutMs: 100,
        });
      } catch (error) {
        console.log(JSON.stringify({ message: error.message, releases,
          stats: adapter.getPoolStats() }));
      }
    `;
    const subprocess = Bun.spawn(['bun', '-e', program], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(subprocess.stdout).text();
    expect(await subprocess.exited).toBe(0);
    const evidence = JSON.parse(output);
    expect(evidence.message).toBe('business failure');
    expect(evidence.releases).toEqual([true]);
    expect(evidence.stats).toMatchObject({ activeQueries: 0, queryErrors: 1 });
  });
});
