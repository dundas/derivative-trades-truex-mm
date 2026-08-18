export async function startProductionOrchestrator(orchestrator) {
  if (!orchestrator || typeof orchestrator.start !== 'function') {
    throw new Error('production startup requires an orchestrator start contract');
  }
  return orchestrator.start();
}
