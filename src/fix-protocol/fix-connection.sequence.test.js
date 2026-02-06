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
});
