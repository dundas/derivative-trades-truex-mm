#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { validateRegimeStrategy } from '../src/analytics/regime-strategy-validator.js';

function usage() {
  return 'Usage: bun scripts/validate-regime-strategy.js <evidence.json|-> [--pretty]';
}

const args = process.argv.slice(2);
const pretty = args.includes('--pretty');
const unknownFlags = args.filter(arg => arg.startsWith('-') && arg !== '-' && arg !== '--pretty');
const inputPaths = args.filter(arg => !arg.startsWith('-') || arg === '-');
const prettyCount = args.filter(arg => arg === '--pretty').length;
const validArguments = unknownFlags.length === 0 && inputPaths.length === 1 && prettyCount <= 1;
const inputPath = inputPaths[0];

if (!validArguments) {
  console.error(usage());
  process.exitCode = 2;
} else {
  try {
    const input = JSON.parse(readFileSync(inputPath === '-' ? 0 : inputPath, 'utf8'));
    const report = validateRegimeStrategy(input);
    process.stdout.write(`${JSON.stringify(report, null, pretty ? 2 : 0)}\n`);
  } catch (error) {
    console.error(`Regime validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
