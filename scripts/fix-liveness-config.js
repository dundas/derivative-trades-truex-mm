function optionalNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  if (typeof raw === 'boolean' || !Number.isFinite(Number(raw))) {
    throw new Error(`${name} must be a finite number`);
  }
  return Number(raw);
}

export function buildFixLivenessConfig(env = process.env) {
  const heartbeatInterval = optionalNumber(env, 'FIX_HEARTBEAT_INTERVAL', 30);
  const testRequestIdleMultiplier = optionalNumber(env, 'FIX_TEST_REQUEST_IDLE_MULTIPLIER', 1.2);
  const testRequestTimeoutMultiplier = optionalNumber(env, 'FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER', 1);
  const maxLivenessDetectionSeconds = optionalNumber(env, 'FIX_LIVENESS_MAX_DETECTION_SECONDS', 120);
  if (!Number.isInteger(heartbeatInterval) || heartbeatInterval <= 0 || heartbeatInterval > 300) {
    throw new Error('FIX_HEARTBEAT_INTERVAL must be an integer in [1,300] seconds');
  }
  if (testRequestIdleMultiplier <= 1 || testRequestIdleMultiplier > 3) {
    throw new Error('FIX_TEST_REQUEST_IDLE_MULTIPLIER must be in (1,3]');
  }
  if (testRequestTimeoutMultiplier <= 0 || testRequestTimeoutMultiplier > 3) {
    throw new Error('FIX_TEST_REQUEST_TIMEOUT_MULTIPLIER must be in (0,3]');
  }
  if (heartbeatInterval * testRequestTimeoutMultiplier * 1000 < 1000) {
    throw new Error('FIX TestRequest response window must be at least 1000ms');
  }
  if (!Number.isInteger(maxLivenessDetectionSeconds) ||
      maxLivenessDetectionSeconds < 2 || maxLivenessDetectionSeconds > 120) {
    throw new Error('FIX_LIVENESS_MAX_DETECTION_SECONDS must be an integer in [2,120]');
  }
  const detectionBudget = heartbeatInterval *
    (testRequestIdleMultiplier + testRequestTimeoutMultiplier);
  if (detectionBudget > maxLivenessDetectionSeconds) {
    throw new Error(
      `FIX liveness detection budget ${detectionBudget}s exceeds ` +
      `FIX_LIVENESS_MAX_DETECTION_SECONDS=${maxLivenessDetectionSeconds}`,
    );
  }
  return {
    heartbeatInterval, testRequestIdleMultiplier, testRequestTimeoutMultiplier,
    maxLivenessDetectionSeconds,
  };
}
