<!-- Generated manually from source on 2026-08-17 because this repository has no docs-generator.json. -->
# Regime Strategy Validator

The regime strategy validator is a read-only, offline gate for historical market-making evidence. It can recommend a candidate for human review, but it cannot authorize production, write configuration, contact an exchange, or dispatch an order.

Source of truth:

- `src/analytics/regime-strategy-validator.js` — validation and reporting
- `scripts/validate-regime-strategy.js` — JSON CLI
- `scripts/smoke-regime-strategy.js` — deterministic no-dispatch smoke

## Run

```bash
bun scripts/validate-regime-strategy.js evidence.json --pretty
cat evidence.json | bun scripts/validate-regime-strategy.js - --pretty
npm run test:regime
bun scripts/smoke-regime-strategy.js
```

Durable production reference rows can be exported without schema initialization or writes:

```bash
bun scripts/export-regime-validator-evidence.js \
  --from 1786924800000 --to 1787011199999 > evidence.json
bun scripts/validate-regime-strategy.js evidence.json --pretty
```

The exporter opens a PostgreSQL `READ ONLY` transaction, uses the same verified TLS and validated
reference-source configuration as production, and fails rather than silently truncating its bounded
fill/reference row limits. It includes pending/incomplete natural fills so missing horizons reduce
coverage honestly. Candidate identity, candidate buffer sensitivity, and shadow survival remain
unset; database export cannot self-attest them. Consequently, the direct export remains `HOLD`
until separately observed candidate-bound shadow evidence is reviewed and supplied through a
versioned evidence artifact.

The CLI writes one JSON report to stdout. Invalid arguments exit `2`; invalid JSON or invalid evidence/configuration exits `1`; a valid report exits `0` even when its recommendation is `HOLD`. Callers must inspect `recommendation` and `blockers` rather than treating exit `0` as strategy approval.

## Evidence shape

```json
{
  "candidateId": "regime-buffer-v1",
  "fills": [
    {
      "fillId": "fill-1",
      "timestamp": 1785546000000,
      "decisionTimestamp": 1785545999000,
      "side": "buy",
      "price": 100,
      "quantity": 0.01
    }
  ],
  "references": [
    {
      "timestamp": 1785545999000,
      "bid": 99.5,
      "ask": 100.5,
      "sourceType": "top-of-book",
      "product": "BTC-USD",
      "quoteCurrency": "USD",
      "basisAdjustmentBps": 0
    }
  ],
  "candidateBuffersBps": [3, 12, 25],
  "shadowEvidence": {
    "observed": true,
    "candidateId": "regime-buffer-v1",
    "fillSurvivalRate": 0.7,
    "clusterCount": 100
  }
}
```

Promotion-grade references must use one of `top-of-book`, `point-in-time-book`, or `equivalent-point-in-time`; every type requires positive, non-crossed `bid` and `ask`, exact configured product/quote currency, a numeric timestamp, and a basis adjustment inside the configured bound. Candle ranges can diagnose definite staleness for the configured instrument but never enter promotion scoring.

## Methodology

- Fill fragments within the configured time/price burst are collapsed before coverage, confidence intervals, or gates are calculated. Price tolerance is anchored to the first fragment so transitive drift cannot inflate cluster independence.
- Decision context joins strictly backward; 1/5/60-minute mark-outs join at or after each requested horizon within the configured age.
- Duplicate, out-of-order, malformed, missing, and stale evidence is classified and excluded from favorable scoring.
- Evaluation uses chronological UTC held-out days and a deterministic cluster bootstrap. There is no random split.
- Observed edge is reported separately from same-fill buffer sensitivity. The sensitivity result does not assume wider historical quotes would have filled and is never used for promotion.

## Default gates

A report remains `HOLD` unless all defaults pass:

- at least 95% promotion-grade reference coverage;
- at least 100 independent held-out fill clusters;
- at least five UTC days containing scored held-out clusters;
- a 95% cluster-bootstrap lower bound above +2 bps at the primary five-minute horizon;
- at least 100 observed shadow clusters bound to the exact candidate ID;
- at least 50% observed shadow fill survival.

Passing those gates produces only `CANDIDATE_FOR_HUMAN_REVIEW`. Every report retains:

```json
{
  "operatorApprovalRequired": true,
  "productionChangeAuthorized": false,
  "dispatches": 0
}
```

## August 10–16 replay

The retained production replay contains 86 valid fills and 68 held-out independent clusters. Historical promotion-grade point-in-time references and candidate-bound shadow survival evidence are unavailable, so the validator returns `HOLD` with zero scored clusters and zero dispatch. Coinbase one-minute candles used in the exploratory diagnosis remain diagnostic-only evidence.
