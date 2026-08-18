import { describe, expect, test } from 'bun:test';
import { buildFixLivenessConfig } from './fix-liveness-config.js';

describe('production FIX liveness config', () => {
  test('provides protocol-derived conservative defaults', () => {
    expect(buildFixLivenessConfig({})).toEqual({
      heartbeatInterval: 30,
      testRequestIdleMultiplier: 1.2,
      testRequestTimeoutMultiplier: 1,
      maxLivenessDetectionSeconds: 120,
    });
  });

  test('accepts explicitly bounded operator values', () => {
    expect(buildFixLivenessConfig({
      FIX_HEARTBEAT_INTERVAL: '20',
      FIX_TEST_REQUEST_IDLE_MULTIPLIER: '1.5',
      FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER: '0.75',
      FIX_LIVENESS_MAX_DETECTION_SECONDS: '90',
    })).toEqual({
      heartbeatInterval: 20,
      testRequestIdleMultiplier: 1.5,
      testRequestTimeoutMultiplier: 0.75,
      maxLivenessDetectionSeconds: 90,
    });
  });

  test.each([
    ['FIX_HEARTBEAT_INTERVAL', '0'],
    ['FIX_HEARTBEAT_INTERVAL', '1.5'],
    ['FIX_TEST_REQUEST_IDLE_MULTIPLIER', '1'],
    ['FIX_TEST_REQUEST_IDLE_MULTIPLIER', '3.1'],
    ['FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER', '0'],
    ['FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER', 'false'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() => buildFixLivenessConfig({ [name]: value })).toThrow(name);
  });

  test('accepts the absolute detection-budget boundary and rejects one second over', () => {
    expect(buildFixLivenessConfig({
      FIX_HEARTBEAT_INTERVAL: '50',
      FIX_TEST_REQUEST_IDLE_MULTIPLIER: '1.4',
      FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER: '1',
      FIX_LIVENESS_MAX_DETECTION_SECONDS: '120',
    }).heartbeatInterval).toBe(50);
    expect(() => buildFixLivenessConfig({
      FIX_HEARTBEAT_INTERVAL: '50',
      FIX_TEST_REQUEST_IDLE_MULTIPLIER: '1.4',
      FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER: '1.02',
      FIX_LIVENESS_MAX_DETECTION_SECONDS: '120',
    })).toThrow('detection budget');
  });

  test('accepts a 1000ms response window boundary and rejects anything shorter', () => {
    expect(buildFixLivenessConfig({
      FIX_HEARTBEAT_INTERVAL: '20',
      FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER: '0.05',
    }).testRequestTimeoutMultiplier).toBe(0.05);
    expect(() => buildFixLivenessConfig({
      FIX_HEARTBEAT_INTERVAL: '20',
      FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER: '0.049',
    })).toThrow('at least 1000ms');
  });
});
