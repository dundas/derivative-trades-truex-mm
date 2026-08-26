import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import { AlertManager, normalizeAlertReason } from './alert-manager.js';

// Capture the real fetch so we can restore it
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
}

function makeFetchMock(ok = true, status = 200) {
  return mock(() => Promise.resolve({ ok, status }));
}

// -----------------------------------------------------------------------
// Slack
// -----------------------------------------------------------------------
describe('AlertManager — Slack', () => {
  it('calls fetch with slackWebhookUrl and correct JSON body on sendAlert', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      logger: makeLogger(),
      cooldownMs: 0, // no cooldown for tests
    });

    await am.sendAlert({ reason: 'OE disconnected', level: 'error', details: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/test');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.text).toContain('OE disconnected');
    expect(body.username).toBe('TrueX MM Monitor');
    expect(body.icon_emoji).toBe(':rotating_light:');
  });

  it('suppresses second sendAlert within cooldown window', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      logger: makeLogger(),
      cooldownMs: 600000, // 10 minutes
    });

    const r1 = await am.sendAlert({ reason: 'OE disconnected' });
    const r2 = await am.sendAlert({ reason: 'OE disconnected' });

    expect(r1.sent).toBe(true);
    expect(r2.suppressed).toBe(true);
    // fetch called only once (for slack) plus possibly email skip — but Slack only once
    const slackCalls = fetchMock.mock.calls.filter(([url]) =>
      url === 'https://hooks.slack.com/test'
    );
    expect(slackCalls).toHaveLength(1);
  });

  it('suppresses second sendAlert when only the idle duration suffix differs', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      logger: makeLogger(),
      cooldownMs: 600000,
    });

    await am.sendAlert({ reason: 'Quoting idle for 100s' });
    await am.sendAlert({ reason: 'Quoting idle for 99999s' });

    const slackCalls = fetchMock.mock.calls.filter(([url]) =>
      url === 'https://hooks.slack.com/test'
    );
    expect(slackCalls).toHaveLength(1);
  });

  it('fires both alerts when reasons differ (no cross-deduplication)', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      logger: makeLogger(),
      cooldownMs: 600000,
    });

    await am.sendAlert({ reason: 'OE disconnected' });
    await am.sendAlert({ reason: 'MD disconnected' });

    const slackCalls = fetchMock.mock.calls.filter(([url]) =>
      url === 'https://hooks.slack.com/test'
    );
    expect(slackCalls).toHaveLength(2);
  });

  it('sendRecovery sends to Slack and clears the cooldown', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      logger: makeLogger(),
      cooldownMs: 600000,
    });

    // Fire alert to set cooldown
    await am.sendAlert({ reason: 'OE disconnected' });
    expect(am._lastAlertTime['OE disconnected']).toBeDefined();

    // Recovery should clear cooldown
    await am.sendRecovery({ reason: 'OE disconnected' });
    expect(am._lastAlertTime['OE disconnected']).toBeUndefined();

    // After recovery, another alert for same reason should fire (not suppressed)
    const r3 = await am.sendAlert({ reason: 'OE disconnected' });
    expect(r3.sent).toBe(true);

    // Slack should have been called: initial alert + recovery + post-recovery alert = 3
    const slackCalls = fetchMock.mock.calls.filter(([url]) =>
      url === 'https://hooks.slack.com/test'
    );
    expect(slackCalls).toHaveLength(3);
  });

  it('sendRecovery clears cooldown for duration-variant alert keys', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      logger: makeLogger(),
      cooldownMs: 600000,
    });

    await am.sendAlert({ reason: 'Quoting idle for 500s' });
    expect(am._lastAlertTime[normalizeAlertReason('Quoting idle for 500s')]).toBeDefined();

    await am.sendRecovery({ reason: 'Quoting idle' });
    expect(am._lastAlertTime['Quoting idle']).toBeUndefined();

    const r = await am.sendAlert({ reason: 'Quoting idle for 1s' });
    expect(r.sent).toBe(true);
  });

  it('sendRecovery with duration-suffixed reason clears the same normalized cooldown key', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      logger: makeLogger(),
      cooldownMs: 600000,
    });

    await am.sendAlert({ reason: 'Quoting idle for 500s' });
    await am.sendRecovery({ reason: 'Quoting idle for 999s' });
    expect(am._lastAlertTime[normalizeAlertReason('Quoting idle for 500s')]).toBeUndefined();

    const r = await am.sendAlert({ reason: 'Quoting idle for 3s' });
    expect(r.sent).toBe(true);
  });

  it('recovery message uses recovery icon_emoji', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      logger: makeLogger(),
      cooldownMs: 0,
    });

    await am.sendRecovery({ reason: 'quoting resumed' });

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.icon_emoji).toBe(':white_check_mark:');
    expect(body.text).toContain('quoting resumed');
  });

  it('does not call fetch and does not throw when slackWebhookUrl is null', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: null,
      logger: makeLogger(),
      cooldownMs: 0,
    });

    await expect(am.sendAlert({ reason: 'test' })).resolves.toEqual(
      expect.objectContaining({ sent: true })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------
describe('AlertManager — Email', () => {
  it('warns and does not throw when GMAIL_USER is not set', async () => {
    // Ensure env vars are absent for this test
    const origUser = process.env.GMAIL_USER;
    const origPass = process.env.GMAIL_USER_PASS;
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_USER_PASS;

    const logger = makeLogger();
    const am = new AlertManager({
      alertEmail: 'ops@example.com',
      logger,
      cooldownMs: 0,
    });

    // Should not throw; should warn about missing credentials
    await expect(am._sendEmail('Subject', 'Body')).resolves.toBeUndefined();

    // Restore env
    if (origUser !== undefined) process.env.GMAIL_USER = origUser;
    if (origPass !== undefined) process.env.GMAIL_USER_PASS = origPass;
  });

  it('skips email entirely when alertEmail is null', async () => {
    const logger = makeLogger();
    const am = new AlertManager({
      alertEmail: null,
      logger,
      cooldownMs: 0,
    });

    await expect(am._sendEmail('Subject', 'Body')).resolves.toBeUndefined();
    // no warn about credentials because we returned early
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// Cooldown edge cases
// -----------------------------------------------------------------------
describe('AlertManager — Cooldown', () => {
  it('fires immediately after cooldown expires', async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const am = new AlertManager({
      slackWebhookUrl: 'https://hooks.slack.com/test',
      logger: makeLogger(),
      cooldownMs: 100, // very short
    });

    await am.sendAlert({ reason: 'test-reason' });

    // Manually expire the cooldown by backdating the timestamp
    am._lastAlertTime['test-reason'] = Date.now() - 200;

    const r2 = await am.sendAlert({ reason: 'test-reason' });
    expect(r2.sent).toBe(true);

    const slackCalls = fetchMock.mock.calls.filter(([url]) =>
      url === 'https://hooks.slack.com/test'
    );
    expect(slackCalls).toHaveLength(2);
  });
});
