#!/usr/bin/env bun

import { existsSync, readFileSync } from 'fs';

const DEFAULT_LOG_FILE = process.env.LOG_FILE || '/app/logs/market-maker.log';

const DEFAULT_CRITERIA = {
  minObservationDays: 3,
  minWouldTakeCount: 50,
  minAttributedCount: 40,
  minMedianBasisAdjEdgeBps: 20,
  minP25BasisAdjEdgeBps: 15,
  maxDisappearedRatePct: 35,
  maxAbsPyusdBasisBps: 100,
  maxP95AbsPyusdBasisBps: 80,
};

function parseArgs(argv) {
  const options = {
    file: DEFAULT_LOG_FILE,
    iocUatResult: 'pending',
    criteria: { ...DEFAULT_CRITERIA },
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--file' && next) {
      options.file = next;
      i++;
    } else if (arg === '--ioc-uat-result' && next) {
      options.iocUatResult = String(next).toLowerCase();
      i++;
    } else if (arg === '--min-observation-days' && next) {
      options.criteria.minObservationDays = Number(next);
      i++;
    } else if (arg === '--min-would-takes' && next) {
      options.criteria.minWouldTakeCount = Number(next);
      i++;
    } else if (arg === '--min-attributed' && next) {
      options.criteria.minAttributedCount = Number(next);
      i++;
    } else if (arg === '--min-median-edge-bps' && next) {
      options.criteria.minMedianBasisAdjEdgeBps = Number(next);
      i++;
    } else if (arg === '--min-p25-edge-bps' && next) {
      options.criteria.minP25BasisAdjEdgeBps = Number(next);
      i++;
    } else if (arg === '--max-disappeared-rate-pct' && next) {
      options.criteria.maxDisappearedRatePct = Number(next);
      i++;
    } else if (arg === '--max-abs-basis-bps' && next) {
      options.criteria.maxAbsPyusdBasisBps = Number(next);
      i++;
    } else if (arg === '--max-p95-abs-basis-bps' && next) {
      options.criteria.maxP95AbsPyusdBasisBps = Number(next);
      i++;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: bun scripts/analyze-shadow-takes.js [options]

Options:
  --file <path>                      Log file to read (default: ${DEFAULT_LOG_FILE})
  --ioc-uat-result <pass|fail|pending>
  --min-observation-days <n>
  --min-would-takes <n>
  --min-attributed <n>
  --min-median-edge-bps <n>
  --min-p25-edge-bps <n>
  --max-disappeared-rate-pct <n>
  --max-abs-basis-bps <n>
  --max-p95-abs-basis-bps <n>
`);
}

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * pct;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatNumber(value, digits = 2) {
  return value === null || value === undefined || Number.isNaN(value) ? 'n/a' : value.toFixed(digits);
}

function parseShadowLogs(file) {
  if (!existsSync(file)) {
    throw new Error(`Log file not found: ${file}`);
  }

  const content = readFileSync(file, 'utf8');
  const wouldTakes = [];
  const attributions = [];
  const basisSamples = [];
  const suppressions = new Map();

  for (const line of content.split('\n')) {
    const marker = '[SHADOW] ';
    const idx = line.indexOf(marker);
    if (idx === -1) continue;
    const payloadText = line.slice(idx + marker.length).trim();
    if (!payloadText) continue;

    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      continue;
    }

    if (payload.type === 'would-take') {
      wouldTakes.push(payload);
    } else if (payload.type === 'shadow-take-attribution') {
      attributions.push(payload);
    } else if (payload.type === 'shadow-basis-sample') {
      basisSamples.push(payload);
    } else if (payload.suppressReason) {
      suppressions.set(
        payload.suppressReason,
        (suppressions.get(payload.suppressReason) || 0) + 1,
      );
    }
  }

  return { wouldTakes, attributions, basisSamples, suppressions };
}

function buildSummary({ wouldTakes, attributions, basisSamples, suppressions }, criteria, iocUatResult) {
  const nonEvaluableSuppressReasons = new Set([
    'basis-stale',
    'coinbase-stale',
    'coinbase-low-confidence',
    'truex-ebbo-stale',
    'truex-tape-stale',
  ]);
  const timestamps = wouldTakes.map((entry) => Number(entry.timestamp)).filter(Number.isFinite);
  const basisAdjEdges = wouldTakes.map((entry) => Number(entry.basisAdjEdgeBps)).filter(Number.isFinite);
  const rawEdges = wouldTakes.map((entry) => Number(entry.rawEdgeBps)).filter(Number.isFinite);
  const sizes = wouldTakes.map((entry) => Number(entry.size)).filter(Number.isFinite);
  const evaluableBasisSamples = basisSamples.filter((entry) =>
    entry.pyusdUsd !== null &&
    entry.pyusdUsd !== undefined &&
    Number.isFinite(Number(entry.pyusdUsd)) &&
    !nonEvaluableSuppressReasons.has(entry.suppressReason)
  );
  const basisValues = evaluableBasisSamples.map((entry) => Number(entry.pyusdUsd)).filter(Number.isFinite);
  const absBasisBps = basisValues.map((value) => Math.abs(value - 1) * 10000);

  const attributedCount = attributions.length;
  const disappearedCount = attributions.filter((entry) => entry.outcome === 'disappeared').length;
  const persistedCount = attributions.filter((entry) => entry.outcome === 'persisted').length;
  const disappearedRatePct = attributedCount > 0 ? (disappearedCount / attributedCount) * 100 : null;

  const allTimestamps = [
    ...timestamps,
    ...evaluableBasisSamples.map((entry) => Number(entry.timestamp)).filter(Number.isFinite),
  ];
  const firstTs = allTimestamps.length ? Math.min(...allTimestamps) : null;
  const lastTs = allTimestamps.length ? Math.max(...allTimestamps) : null;
  const calendarDaysObserved = new Set(
    allTimestamps.map((ts) => new Date(ts).toISOString().slice(0, 10)),
  ).size;
  const observationWindowPass =
    wouldTakes.length >= criteria.minWouldTakeCount &&
    attributedCount >= criteria.minAttributedCount &&
    calendarDaysObserved >= criteria.minObservationDays;
  const enoughEdgeData = wouldTakes.length >= criteria.minWouldTakeCount;
  const enoughBasisData = evaluableBasisSamples.length > 0;
  const medianEdge = percentile(basisAdjEdges, 0.5);
  const p25Edge = percentile(basisAdjEdges, 0.25);
  const maxAbsBasis = absBasisBps.length ? Math.max(...absBasisBps) : null;
  const p95AbsBasis = percentile(absBasisBps, 0.95);

  const findings = [
    {
      name: 'IOC UAT',
      status: iocUatResult === 'pass' ? 'pass' : iocUatResult === 'fail' ? 'fail' : 'pending',
      detail: `IOC UAT result = ${iocUatResult}`,
    },
    {
      name: 'Observation window',
      status: observationWindowPass ? 'pass' : 'pending',
      detail:
        `${wouldTakes.length} would-takes, ${attributedCount} attributions, ${calendarDaysObserved} calendar day(s) observed`,
    },
    {
      name: 'Edge quality',
      status: !enoughEdgeData
        ? 'pending'
        : medianEdge >= criteria.minMedianBasisAdjEdgeBps &&
            p25Edge >= criteria.minP25BasisAdjEdgeBps
          ? 'pass'
          : 'fail',
      detail:
        `median=${formatNumber(medianEdge)}bps, p25=${formatNumber(p25Edge)}bps`,
    },
    {
      name: 'Basis health',
      status: !enoughBasisData
        ? 'pending'
        : maxAbsBasis > criteria.maxAbsPyusdBasisBps ||
            (p95AbsBasis !== null && p95AbsBasis > criteria.maxP95AbsPyusdBasisBps)
          ? 'fail'
          : 'pass',
      detail:
        `max=${formatNumber(maxAbsBasis)}bps, p95=${formatNumber(p95AbsBasis)}bps`,
    },
    {
      name: 'Adverse-selection proxy',
      status:
        disappearedRatePct !== null && disappearedRatePct <= criteria.maxDisappearedRatePct
          ? 'pass'
          : attributedCount === 0
            ? 'pending'
            : 'fail',
      detail:
        `disappeared=${disappearedCount}, persisted=${persistedCount}, disappearedRate=${formatNumber(disappearedRatePct)}%`,
    },
  ];

  let recommendation = 'HOLD';
  if (findings.some((item) => item.status === 'fail')) {
    recommendation = 'ABORT';
  } else if (findings.every((item) => item.status === 'pass')) {
    recommendation = 'GO';
  }

  return {
    criteria,
    findingSummary: findings,
    recommendation,
    metrics: {
      wouldTakeCount: wouldTakes.length,
      basisSampleCount: basisSamples.length,
      evaluableBasisSampleCount: evaluableBasisSamples.length,
      attributedCount,
      disappearedCount,
      persistedCount,
      calendarDaysObserved,
      firstSeenAt: firstTs ? new Date(firstTs).toISOString() : null,
      lastSeenAt: lastTs ? new Date(lastTs).toISOString() : null,
      basisAdjEdgeBps: {
        min: basisAdjEdges.length ? Math.min(...basisAdjEdges) : null,
        p25: percentile(basisAdjEdges, 0.25),
        median: percentile(basisAdjEdges, 0.5),
        p75: percentile(basisAdjEdges, 0.75),
        max: basisAdjEdges.length ? Math.max(...basisAdjEdges) : null,
        average: average(basisAdjEdges),
      },
      rawEdgeBps: {
        min: rawEdges.length ? Math.min(...rawEdges) : null,
        median: percentile(rawEdges, 0.5),
        max: rawEdges.length ? Math.max(...rawEdges) : null,
        average: average(rawEdges),
      },
      sizeBtc: {
        min: sizes.length ? Math.min(...sizes) : null,
        median: percentile(sizes, 0.5),
        max: sizes.length ? Math.max(...sizes) : null,
        average: average(sizes),
      },
      pyusdBasisBpsAbs: {
        max: maxAbsBasis,
        p95: p95AbsBasis,
        average: average(absBasisBps),
      },
      suppressions: Object.fromEntries([...suppressions.entries()].sort((a, b) => b[1] - a[1])),
    },
  };
}

function main() {
  const { file, iocUatResult, criteria } = parseArgs(process.argv.slice(2));
  const parsed = parseShadowLogs(file);
  const summary = buildSummary(parsed, criteria, iocUatResult);

  console.log(JSON.stringify(summary, null, 2));
}

main();
