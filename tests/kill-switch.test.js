import { describe, it, expect, mock } from 'bun:test';
import { resolveConfig, runKillSwitch, decideExit, renderText, parseArgs, decideCliExit } from '../scripts/kill-switch.js';

// --- Exit-code contract (roborev round 4) ---

describe('decideCliExit (exit-code contract)', () => {
  it('dry-run exits 0 even with orders present — presence is not failure', () => {
    expect(decideCliExit({ dryRun: true, listed: [{ id: 'x' }], residual: [{ id: 'x' }], canceled: [], failed: [] })).toBe(0);
  });
  it('live clean sweep → 0; residuals → 1; unclear → 3', () => {
    expect(decideCliExit({ dryRun: false, residual: [], failed: [], canceled: ['a'] })).toBe(0);
    expect(decideCliExit({ dryRun: false, residual: [{ id: 'x' }], failed: [], canceled: [] })).toBe(1);
    expect(decideCliExit({ dryRun: false, residual: [], failed: [], sweepFailed: true })).toBe(3);
  });
});

// --- CLI argument safety (roborev round 3) ---

describe('parseArgs (typo safety)', () => {
  it('rejects unknown flags instead of silently ignoring them', () => {
    expect(parseArgs(['--dry-rnu']).error).toContain('--dry-rnu');
    expect(parseArgs(['--dryrun']).error).toContain('refusing to guess');
    expect(parseArgs(['--prod', '--json', '--typo']).error).toContain('--typo');
  });
  it('rejects --prod --uat conflict', () => {
    expect(parseArgs(['--prod', '--uat']).error).toContain('only one');
  });
  it('accepts known flags and defaults to UAT', () => {
    expect(parseArgs([])).toMatchObject({ prod: false, uat: false, dryRun: false, json: false });
    expect(parseArgs(['--dry-run', '--prod', '--json'])).toMatchObject({ dryRun: true, prod: true, json: true });
  });
});

// --- AC1: fail-safe venue selection ---

describe('resolveConfig (AC1, AC3)', () => {
  it('bare invocation targets UAT with defaults, never prod', () => {
    const cfg = resolveConfig({ TRUEX_API_KEY: 'k', TRUEX_SECRET_KEY: 's' }, 'uat');
    expect(cfg.mode).toBe('uat');
    expect(cfg.baseURL).toContain('38.32.101.229:9742');
    expect(cfg.clientId).toBe('78972918929686546');
    expect(cfg.usedLegacyClientId).toBe(true);
  });

  it('prod requires explicit keys + client id', () => {
    const cfg = resolveConfig(
      { TRUEX_PROD_API_KEY: 'pk', TRUEX_PROD_SECRET_KEY: 'ps', TRUEX_CLIENT_ID: 'cid' },
      'prod'
    );
    expect(cfg.mode).toBe('prod');
    expect(cfg.baseURL).toContain('178.156.230.110:3006');
    expect(cfg.clientId).toBe('cid');
  });

  it('missing prod keys → error (exit 2 path)', () => {
    const cfg = resolveConfig({}, 'prod');
    expect(cfg.error).toContain('TRUEX_PROD_API_KEY');
  });

  it('missing uat keys → error (exit 2 path)', () => {
    expect(resolveConfig({}, 'uat').error).toContain('TRUEX_API_KEY');
  });

  it('env overrides win for URLs and UAT client id', () => {
    const cfg = resolveConfig(
      { TRUEX_API_KEY: 'k', TRUEX_SECRET_KEY: 's', TRUEX_UAT_REST_URL: 'http://x:1', TRUEX_CLIENT_ID_UAT: 'u2' },
      'uat'
    );
    expect(cfg.baseURL).toBe('http://x:1/api/v1');
    expect(cfg.clientId).toBe('u2');
    expect(cfg.usedLegacyClientId).toBe(false);
  });
});

// --- Mock client harness ---

// TrueX REST order shape: nested order_info (see TrueXRESTClient.parseOrder)
function mockOrder(id, side = 'sell', price = 64000, qty = 0.001) {
  return {
    id,
    external_id: `ext-${id}`,
    status: 'LIVE',
    order_info: { side, type: 'LIMIT', instrument_id: 'BTC-PYUSD', price: String(price), qty: String(qty) },
    pending_qty: '0',
    leaves_qty: String(qty),
    exeuted_qty: '0',
    executed_vwap: '0',
    timestamp: String(Date.now() * 1e6),
    update_timestamp: String(Date.now() * 1e6),
  };
}

// live=false (dry-run): first/only fetch returns `active`.
// live=true (sweep): cancelAllOrders owns its own snapshot; the single
// getActiveOrders fetch is the verification pass → returns `afterCancel`.
function mockClient({ active = [], cancelAll = null, afterCancel = [], live = false } = {}) {
  const first = live ? afterCancel : active;
  const second = live ? [] : afterCancel;
  let calls = 0;
  return {
    getActiveOrders: mock(async () => (calls++ === 0 ? first : second)),
    cancelAllOrders: mock(async () => cancelAll ?? { success: true, canceled: active.map((o) => o.id), failed: [] }),
  };
}

// --- AC2/AC4: flow behavior ---

describe('runKillSwitch (AC2, AC4)', () => {
  it('dry-run lists orders and performs zero cancel calls', async () => {
    const client = mockClient({ active: [mockOrder('A'), mockOrder('B', 'buy')] });
    const result = await runKillSwitch(client, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.listed.length).toBe(2);
    expect(result.verificationFailed).toBe(false);
    expect(client.cancelAllOrders).not.toHaveBeenCalled();
  });

  it('cancel path sweeps, verifies, and reports residuals', async () => {
    const stuck = mockOrder('STUCK');
    const client = mockClient({
      active: [mockOrder('A'), mockOrder('STUCK')],
      cancelAll: { success: false, canceled: ['A'], failed: [{ id: 'STUCK', error: 'too late' }] },
      afterCancel: [stuck],
      live: true,
    });
    const result = await runKillSwitch(client, {});
    expect(result.canceled).toEqual(['A']);
    expect(result.failed.length).toBe(1);
    expect(result.residual.length).toBe(1);
    expect(result.residual[0].id).toBe('STUCK');
    // Live path: verification pass only (no separate pre-fetch to diverge)
    expect(client.getActiveOrders).toHaveBeenCalledTimes(1);
    expect(result.listed).toEqual([]);
  });

  it('clean sweep leaves no residuals', async () => {
    const client = mockClient({ active: [mockOrder('A')], live: true });
    const result = await runKillSwitch(client, {});
    expect(result.residual.length).toBe(0);
    expect(result.failed.length).toBe(0);
  });

  it('cancelAllOrders throwing is an unclear outcome, not a config error (roborev round 2)', async () => {
    const client = {
      getActiveOrders: mock(async () => []),
      cancelAllOrders: mock(async () => { throw new Error('socket hang up mid-sweep'); }),
    };
    const result = await runKillSwitch(client, {});
    expect(result.sweepFailed).toBe(true);
    expect(result.sweepError).toContain('socket hang up');
    expect(decideExit(result)).toBe(3); // distinguishable from config error (2)
  });

  it('verification failure is reported distinctly (roborev round 1)', async () => {
    let calls = 0;
    const client = {
      getActiveOrders: mock(async () => {
        calls++;
        if (calls === 1) throw new Error('connection reset during verification');
        return [];
      }),
      cancelAllOrders: mock(async () => ({ success: true, canceled: ['A'], failed: [] })),
    };
    const result = await runKillSwitch(client, {});
    expect(result.verificationFailed).toBe(true);
    expect(result.verificationError).toContain('connection reset');
    expect(result.canceled).toEqual(['A']); // the sweep itself succeeded
    expect(decideExit(result)).toBe(3); // distinct from config error (2)
  });
});

// --- AC3: exit code decision ---

describe('decideExit (AC3)', () => {
  it('clean sweep → 0', () => {
    expect(decideExit({ failed: [], residual: [] })).toBe(0);
  });
  it('any failure → 1', () => {
    expect(decideExit({ failed: [{ id: 'x', error: 'e' }], residual: [] })).toBe(1);
  });
  it('any residual → 1', () => {
    expect(decideExit({ failed: [], residual: [{ id: 'x' }] })).toBe(1);
  });
});

// --- Reporting ---

describe('renderText', () => {
  it('renders dry-run header and order lines', () => {
    const result = {
      dryRun: true,
      listed: [{ id: 'A1', side: 'sell', qty: 0.001, price: 64000, status: 'LIVE', createdAt: new Date() }],
      canceled: [], failed: [], residual: [],
    };
    const text = renderText(result, { mode: 'prod', baseURL: 'http://x/api/v1', clientId: 'cid' });
    expect(text).toContain('venue=prod');
    expect(text).toContain('[DRY RUN]');
    expect(text).toContain('A1');
    expect(text).toContain('sell');
  });

  it('renders failures and residuals after a live sweep', () => {
    const result = {
      dryRun: false,
      listed: [],
      canceled: ['A'],
      failed: [{ id: 'B', error: 'too late' }],
      residual: [{ id: 'B', side: 'buy', qty: 0.001, price: 64000, status: 'LIVE', createdAt: new Date() }],
    };
    const text = renderText(result, { mode: 'uat', baseURL: 'http://x/api/v1', clientId: 'cid' });
    expect(text).toContain('Canceled: 1  Failed: 1');
    expect(text).toContain('FAILED B: too late');
    expect(text).toContain('Residual after verification: 1');
  });
});
