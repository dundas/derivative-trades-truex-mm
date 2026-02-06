import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuditLogger } from './audit-logger.js';

function makeTmpDir() {
  const dir = path.join(
    os.tmpdir(),
    `truex-audit-tests-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readFileLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').filter(Boolean);
}

describe('AuditLogger', () => {
  let tmpDir;
  let logger;
  let audit;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    audit = new AuditLogger({ logDir: tmpDir, logger });
  });

  afterEach(() => {
    try {
      audit.close();
    } catch {}
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    jest.restoreAllMocks();
  });

  describe('ensureLogDirectory()', () => {
    it('should create log directory if missing', () => {
      const newDir = path.join(tmpDir, 'nested');
      const a2 = new AuditLogger({ logDir: newDir, logger });
      expect(fs.existsSync(newDir)).toBe(true);
      a2.close();
    });
  });

  describe('write and read', () => {
    it('should log FIX messages and update stats', () => {
      const ok = audit.logFIXMessage('8=FIXT.1.1\x019=...\x01', {
        direction: 'OUTBOUND',
        msgType: 'A',
        sessionId: 'S1',
        msgSeqNum: 1
      });
      expect(ok).toBe(true);
      expect(audit.getStats().fixMessagesLogged).toBe(1);

      const logPath = audit.getLogPath();
      const lines = readFileLines(logPath);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe('FIX_MESSAGE');
      expect(parsed.direction).toBe('OUTBOUND');
      expect(parsed.sessionId).toBe('S1');
    });

    it('should log order events and update stats', () => {
      const ok = audit.logOrderEvent('CREATED', {
        sessionId: 'S1', orderId: 'O1', symbol: 'BTC/USD', side: 'buy', size: 1, price: 100
      });
      expect(ok).toBe(true);
      expect(audit.getStats().orderEventsLogged).toBe(1);

      const lines = readFileLines(audit.getLogPath());
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe('ORDER_EVENT');
      expect(parsed.event).toBe('CREATED');
      expect(parsed.orderId).toBe('O1');
    });

    it('should log fill events and update stats', () => {
      const ok = audit.logFillEvent({
        sessionId: 'S1', fillId: 'F1', execID: 'E1', orderId: 'O1', symbol: 'BTC/USD', side: 'buy', quantity: 0.5, price: 100
      });
      expect(ok).toBe(true);
      expect(audit.getStats().fillEventsLogged).toBe(1);

      const lines = readFileLines(audit.getLogPath());
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe('FILL_EVENT');
      expect(parsed.execID).toBe('E1');
      expect(parsed.fillId).toBe('F1');
    });

    it('should log errors with stack and update stats', () => {
      const err = new Error('boom');
      const ok = audit.logError(err, { context: 'unit-test' });
      expect(ok).toBe(true);
      expect(audit.getStats().errorsLogged).toBe(1);

      const lines = readFileLines(audit.getLogPath());
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe('ERROR');
      expect(parsed.error).toBe('boom');
      expect(parsed.stack).toBeDefined();
      expect(parsed.context).toBe('unit-test');
    });
  });

  describe('rotation', () => {
    it('should rotate when date string changes', () => {
      // Force date string stub
      audit.getDateString = () => '2025-10-07';
      audit.logOrderEvent('CREATED', { sessionId: 'S1', orderId: 'O1' });
      const p1 = audit.getLogPath();
      expect(path.basename(p1)).toContain('2025-10-07');

      audit.getDateString = () => '2025-10-08';
      audit.logOrderEvent('CREATED', { sessionId: 'S1', orderId: 'O2' });
      const p2 = audit.getLogPath();
      expect(path.basename(p2)).toContain('2025-10-08');
      expect(p1).not.toBe(p2);

      // Both files exist
      expect(fs.existsSync(p1)).toBe(true);
      expect(fs.existsSync(p2)).toBe(true);
    });
  });

  describe('recovery', () => {
    it('should recover session data from log', async () => {
      const sid1 = 'S1';
      const sid2 = 'S2';
      audit.logFIXMessage('raw1', { sessionId: sid1, direction: 'INBOUND', msgType: 'A' });
      audit.logOrderEvent('CREATED', { sessionId: sid1, orderId: 'O1' });
      audit.logFillEvent({ sessionId: sid1, fillId: 'F1', execID: 'E1', orderId: 'O1' });
      audit.logError(new Error('bad'), { sessionId: sid1 });
      // Other session
      audit.logOrderEvent('CREATED', { sessionId: sid2, orderId: 'O2' });

      // Ensure file exists before recovery
      const logPath = audit.getLogPath();
      expect(fs.existsSync(logPath)).toBe(true);
      const rec = await audit.recoverSessionData(sid1);
      expect(rec.fixMessages.length).toBe(1);
      expect(rec.orders.length).toBe(1);
      expect(rec.fills.length).toBe(1);
      expect(rec.errors.length).toBe(1);
    });
  });

  describe('getLogFiles and getLogFileStats', () => {
    it('should list files and compute stats', async () => {
      audit.logOrderEvent('CREATED', { sessionId: 'S1', orderId: 'O1' });
      audit.logFIXMessage('raw', { sessionId: 'S1', direction: 'OUTBOUND', msgType: 'A' });
      audit.logError(new Error('oops'));

      const files = audit.getLogFiles();
      expect(files.length).toBe(1);
      expect(files[0].filename).toMatch(/truex-audit-.*\.jsonl/);

      // Use the file we just detected to avoid any date stubbing interference
      const stats = await audit.getLogFileStats(files[0].date);
      expect(stats.totalLines).toBe(3);
      expect(stats.orderEvents).toBe(1);
      expect(stats.fixMessages).toBe(1);
      expect(stats.errors).toBe(1);
    });
  });

  describe('critical alert on write failure', () => {
    it('should emit critical alert and increment writeFailures when append fails', () => {
      // Force appendFileSync to throw
      jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {
        throw new Error('disk full');
      });

      const ok = audit.logOrderEvent('CREATED', { sessionId: 'S1', orderId: 'O1' });
      expect(ok).toBe(false);
      const stats = audit.getStats();
      expect(stats.writeFailures).toBe(1);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('should close current stream gracefully', () => {
      audit.logOrderEvent('CREATED', { sessionId: 'S1', orderId: 'O1' });
      expect(() => audit.close()).not.toThrow();
    });
  });
});
