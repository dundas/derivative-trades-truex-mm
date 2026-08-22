// Public health intentionally excludes inventory-recovery decisions: direction
// and adjustment reveal strategy intent. Those remain available to authorized
// operators through the admin-token-protected /api/status snapshot.
export function buildPublicHealthSnapshot(orchHealth, dbInfo, runtime = process) {
  const status = orchHealth?.status ?? (dbInfo.connected ? 'healthy' : 'degraded');
  return {
    status,
    // Orchestrator health fields at top level (per FR-2.4)
    quoting: orchHealth?.quoting ?? null,
    quoteLoopActive: orchHealth?.quoteLoopActive ?? null,
    quoteDispatchMode: orchHealth?.quoteDispatchMode ?? null,
    lastRepriceAge: orchHealth?.lastRepriceAge ?? null,
    oeConnected: orchHealth?.oeConnected ?? null,
    mdConnected: orchHealth?.mdConnected ?? null,
    lastMdAge: orchHealth?.lastMdAge ?? null,
    feedHealth: orchHealth?.feedHealth ?? null,
    makerPresence: orchHealth?.makerPresence ?? null,
    makerPresenceRecovery: orchHealth?.makerPresenceRecovery ?? null,
    inventoryRebalanceShadow: orchHealth?.inventoryRebalanceShadow ?? null,
    // Other fields
    database: dbInfo,
    uptime: runtime.uptime(),
    timestamp: Date.now(),
  };
}
