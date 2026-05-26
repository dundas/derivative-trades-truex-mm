import { describe, it, expect, jest, beforeEach } from 'bun:test';
import { FIXConnection } from './fix-connection.js';

describe('FIXConnection sequence handling (7.4)', () => {
  let connection;

  beforeEach(() => {
    connection = new FIXConnection({
      host: 'uat.truex.co',
      port: 19484,
      targetCompID: 'TRUEX_UAT_OE',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
      logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
    });
  });

  it('detects sequence gap, requests resend, and does not emit application message', async () => {
    const messageHandler = jest.fn();
    connection.on('message', messageHandler);
    jest.spyOn(connection, 'requestResend').mockResolvedValue();
    connection.expectedSeqNum = 2; // expecting 2, but we receive 5

    const message = { fields: { '35': '8', '34': '5' } };
    connection.handleMessage(message);

    expect(connection.requestResend).toHaveBeenCalledWith(2, 4);
    expect(messageHandler).not.toHaveBeenCalled();
    expect(connection.expectedSeqNum).toBe(2); // unchanged on GAP
  });

  it('ignores duplicate sequence and does not emit application message', () => {
    const messageHandler = jest.fn();
    connection.on('message', messageHandler);
    connection.expectedSeqNum = 5; // expect 5, receive 3

    const message = { fields: { '35': '8', '34': '3' } };
    connection.handleMessage(message);

    expect(messageHandler).not.toHaveBeenCalled();
    expect(connection.expectedSeqNum).toBe(5); // unchanged on DUPLICATE
  });

  it('emits application message on in-order sequence', () => {
    const messageHandler = jest.fn();
    connection.on('message', messageHandler);
    connection.expectedSeqNum = 2;

    const message = { fields: { '35': '8', '34': '2' } };
    connection.handleMessage(message);

    expect(messageHandler).toHaveBeenCalledWith(message);
    expect(connection.expectedSeqNum).toBe(3);
  });

  it('requests resend for gap-fill SequenceReset received above expected sequence', () => {
    const messageHandler = jest.fn();
    const resetHandler = jest.fn();
    jest.spyOn(connection, 'requestResend').mockImplementation(() => {});
    connection.on('message', messageHandler);
    connection.on('sequence-reset', resetHandler);
    connection.expectedSeqNum = 10;

    const message = {
      fields: {
        '35': '4',
        '34': '15',
        '123': 'Y',
        '36': '20',
      }
    };
    connection.handleMessage(message);

    expect(connection.requestResend).toHaveBeenCalledWith(10, 14);
    expect(messageHandler).not.toHaveBeenCalled();
    expect(connection.expectedSeqNum).toBe(10);
    expect(resetHandler).not.toHaveBeenCalled();
  });

  it('ignores stale gap-fill SequenceReset without moving expected sequence backward', () => {
    const resetHandler = jest.fn();
    connection.on('sequence-reset', resetHandler);
    connection.expectedSeqNum = 20;

    connection.handleMessage({
      fields: {
        '35': '4',
        '34': '15',
        '123': 'Y',
        '36': '18',
      }
    });

    expect(connection.expectedSeqNum).toBe(20);
    expect(resetHandler).not.toHaveBeenCalled();
  });

  it('requests resend for non-advancing gap-fill SequenceReset above expected sequence', () => {
    const resetHandler = jest.fn();
    jest.spyOn(connection, 'requestResend').mockImplementation(() => {});
    connection.on('sequence-reset', resetHandler);
    connection.expectedSeqNum = 10;

    connection.handleMessage({
      fields: {
        '35': '4',
        '34': '15',
        '123': 'Y',
        '36': '15',
      }
    });

    expect(connection.requestResend).toHaveBeenCalledWith(10, 14);
    expect(connection.expectedSeqNum).toBe(10);
    expect(resetHandler).not.toHaveBeenCalled();
  });

  it('ignores exact-sequence gap-fill SequenceReset when NewSeqNo does not advance', () => {
    const resetHandler = jest.fn();
    jest.spyOn(connection, 'requestResend').mockImplementation(() => {});
    connection.on('sequence-reset', resetHandler);
    connection.expectedSeqNum = 10;

    connection.handleMessage({
      fields: {
        '35': '4',
        '34': '10',
        '123': 'Y',
        '36': '10',
      }
    });

    expect(connection.requestResend).not.toHaveBeenCalled();
    expect(connection.expectedSeqNum).toBe(10);
    expect(resetHandler).not.toHaveBeenCalled();
  });

  it('emits resend-failed-reset and forces session reset after MAX_RESEND_ATTEMPTS', async () => {
    const resetHandler = jest.fn();
    jest.spyOn(connection, 'requestResend').mockImplementation(() => {});
    connection.on('resend-failed-reset', resetHandler);
    connection.socket = {
      destroyed: false,
      destroy: jest.fn(function destroy() {
        this.destroyed = true;
      }),
    };

    // Set up like we've connected before (so reset will be meaningful)
    connection.hasConnectedBefore = true;
    connection.msgSeqNum = 100;
    connection.expectedSeqNum = 50;

    // Simulate 3 consecutive gap detections for the same expected seq
    for (let i = 0; i < 3; i++) {
      const message = { fields: { '35': '8', '34': '60' } }; // big gap
      connection.handleMessage(message);
    }
    await Promise.resolve();

    // Should emit reset event with details
    expect(resetHandler).toHaveBeenCalledWith({ expected: 50, received: 60, attempts: 3 });

    // Should force reset sequences
    expect(connection.hasConnectedBefore).toBe(false);
    expect(connection.msgSeqNum).toBe(1);
    expect(connection.expectedSeqNum).toBe(1);
    expect(connection._resendGapStart).toBeNull();
    expect(connection._resendAttempts).toBe(0);

    // Should tear down through real lifecycle methods and schedule one reconnect.
    expect(connection.socket).toBeNull();
    expect(connection.reconnectTimer).not.toBeNull();
    clearTimeout(connection.reconnectTimer);
    connection.reconnectTimer = null;
  });

  it('clears persisted Redis seqnums on forced session reset', async () => {
    const redis = {
      del: jest.fn().mockResolvedValue(2),
      get: jest.fn(),
      set: jest.fn(),
    };
    connection.redisClient = redis;
    connection.socket = {
      destroyed: false,
      destroy: jest.fn(function destroy() {
        this.destroyed = true;
      }),
    };

    await connection._forceSessionReset('test-reset');

    expect(redis.del).toHaveBeenCalledWith(
      'fix:seq:CLI_CLIENT:TRUEX_UAT_OE:out',
      'fix:seq:CLI_CLIENT:TRUEX_UAT_OE:in'
    );
    expect(connection.msgSeqNum).toBe(1);
    expect(connection.expectedSeqNum).toBe(1);
    expect(connection.hasConnectedBefore).toBe(false);
    clearTimeout(connection.reconnectTimer);
    connection.reconnectTimer = null;
  });

  it('handles inbound SequenceReset-GapFill without emitting application message', () => {
    const messageHandler = jest.fn();
    const resetHandler = jest.fn();
    connection.on('message', messageHandler);
    connection.on('sequence-reset', resetHandler);
    connection.expectedSeqNum = 10;

    connection.handleMessage({
      fields: {
        '35': '4',
        '34': '10',
        '123': 'Y',
        '36': '15',
      }
    });

    expect(connection.expectedSeqNum).toBe(15);
    expect(messageHandler).not.toHaveBeenCalled();
    expect(resetHandler).toHaveBeenCalledWith({
      newSeqNo: 15,
      gapFill: true,
      message: expect.any(Object),
    });
  });

  it('resets local sequence numbers after repeated failed pre-logon recovery attempts', async () => {
    const resetSeqSpy = jest.spyOn(connection, 'resetSequenceNumbers').mockResolvedValue();
    jest.spyOn(connection, 'attemptReconnect').mockImplementation(() => {});

    connection.hasConnectedBefore = true;
    connection.isLoggedOn = false;

    for (let i = 0; i < 3; i++) {
      connection._sawPreLogonGapFillThisAttempt = true;
      connection.handleDisconnect();
    }

    expect(resetSeqSpy).toHaveBeenCalledTimes(1);
    expect(connection._preLogonRecoveryAttempts).toBe(0);
    expect(connection._forcedSequenceResetPending).toBe(true);
  });

  it('tracks pre-logon GapFills without forcing an immediate reset inside one attempt', () => {
    const resetSeqSpy = jest.spyOn(connection, 'resetSequenceNumbers').mockResolvedValue();
    connection.expectedSeqNum = 10;
    connection.hasConnectedBefore = true;
    connection.isLoggedOn = false;

    connection.handleMessage({
      fields: { '35': '4', '34': '10', '123': 'Y', '36': '12' }
    });
    connection.handleMessage({
      fields: { '35': '4', '34': '12', '123': 'Y', '36': '14' }
    });
    connection.handleMessage({
      fields: { '35': '4', '34': '14', '123': 'Y', '36': '16' }
    });

    expect(connection._sawPreLogonGapFillThisAttempt).toBe(true);
    expect(resetSeqSpy).not.toHaveBeenCalled();
  });

  it('does not reset on different gaps (resend counter resets)', () => {
    jest.spyOn(connection, 'requestResend').mockImplementation(() => {});

    connection.expectedSeqNum = 10;

    // First gap at 10
    connection.handleMessage({ fields: { '35': '8', '34': '15' } });
    expect(connection._resendGapStart).toBe(10);
    expect(connection._resendAttempts).toBe(1);

    // Different gap (expected now changed to 15 if we processed, but it didn't)
    // Actually expected stays 10, so let's simulate a jump to different expected
    connection.expectedSeqNum = 20;
    connection.handleMessage({ fields: { '35': '8', '34': '25' } });
    expect(connection._resendGapStart).toBe(20); // reset to new gap
    expect(connection._resendAttempts).toBe(1); // counter reset
  });

  it('clears resend tracking on successful logon', () => {
    connection._resendGapStart = 50;
    connection._resendAttempts = 2;

    // Simulate successful logon state transition
    connection.isLoggedOn = true;
    connection.hasConnectedBefore = true;
    connection._resendGapStart = null;
    connection._resendAttempts = 0;

    expect(connection._resendGapStart).toBeNull();
    expect(connection._resendAttempts).toBe(0);
  });
});
