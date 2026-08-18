/**
 * Build the authenticated operator snapshot without introducing any execution
 * capability. Reference collector errors are data, never health inputs.
 */
export function buildApiStatusSnapshot(orchestrator) {
  const health = orchestrator?.getHealthStatus?.() ?? null;
  if (!health) {
    return { status: 'unknown', message: 'Orchestrator not connected', referenceMarkouts: null };
  }
  return health;
}
