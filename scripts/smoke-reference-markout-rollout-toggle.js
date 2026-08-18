#!/usr/bin/env bun
import { MarketMakerOrchestrator } from '../src/core/market-maker-orchestrator.js';
import { buildReferenceMarkoutRolloutOptions } from './reference-markout-rollout-config.js';

const disabledOptions = buildReferenceMarkoutRolloutOptions({});
const disabled = new MarketMakerOrchestrator(disabledOptions);
if ('referenceMarkoutConfig' in disabledOptions || disabled.referenceMarkoutCollector !== null) {
  throw new Error('disabled rollout instantiated a reference collector');
}

const enabledOptions = buildReferenceMarkoutRolloutOptions({
  REFERENCE_MARKOUT_ENABLED: 'true', REFERENCE_MARKOUT_BASIS_VENUE_ALLOWLIST: 'PDSL',
});
const enabled = new MarketMakerOrchestrator(enabledOptions);
if (!enabled.referenceMarkoutCollector ||
    JSON.stringify(enabled.referenceMarkoutCollector.config) !==
      JSON.stringify(enabledOptions.referenceMarkoutConfig)) {
  throw new Error('enabled rollout did not pass the validated config unchanged');
}

console.log('PASS: reference mark-outs default off with zero collector; enabled config is validated and unchanged');
