# Tasks for PRD 0005 - TrueX FIX Recovery and Fee-Aware Quoting

**Source PRD:** `tasks/0005-prd-truex-fix-recovery-fee-aware-quoting.md`

## Relevant Files

- `src/fix-protocol/fix-connection.js` - FIX lifecycle, reconnect, sequence validation, resend/gap recovery.
- `src/fix-protocol/fix-connection.test.js` - Existing connection lifecycle and Redis sequence tests.
- `src/fix-protocol/fix-connection.sequence.test.js` - Focused sequence gap and reset tests.
- `tests/fix-connection-resend.test.js` - Existing resend/gap-fill tests.
- `src/core/quote-engine.js` - Quote computation, replacement ordering, ALO/taker order send path, quote status.
- `tests/quote-engine.test.js` - Quote engine decisioning and order lifecycle tests.
- `src/core/market-maker-orchestrator.js` - Wires market data, fee config, fill metadata, PnL, and quote engine.
- `src/core/market-maker-orchestrator.test.js` - Orchestrator routing tests.
- `src/core/truex-market-data.js` - TrueX book source and best bid/ask provider.
- `src/core/pnl-tracker.js` - Maker/taker fee accounting; should receive correct liquidity role.
- `docs/ARCHITECTURE.md` - Config and behavior documentation if runtime knobs change.

## Task Ordering & Dependencies

The dependency graph is:

1. FIX lifecycle hardening is independent and should ship first because it reduces duplicate session risk without enabling new trading behavior.
2. Quote marketability data wiring must precede ALO final-send checks and fee-aware taking because both require a fresh TrueX best bid/ask contract.
3. Pending replacement state depends on marketability rechecks so replacement release can revalidate against the current book.
4. Fee-aware taking depends on the same book/fair-value wiring plus metadata propagation so PnL/audit cannot misclassify taker fills.
5. Documentation and workflow gates come after implementation and tests.

## Tasks

- [x] 1.0 Harden FIX lifecycle and sequence recovery
  - [x] 1.1 Confirm current branch is a feature branch and preserve existing dirty work.
  - [x] 1.2 Add connection generation/stale-callback guards for socket `data`, `error`, `close`, delayed logon setup, and timeout callbacks.
  - [x] 1.3 Add a single failed-attempt teardown path that clears timeouts/listeners/timers and destroys only the attempted socket.
  - [x] 1.4 Handle `35=3` duplicate-logon rejects with `58=Already authenticated...` as structured duplicate-logon failures.
  - [x] 1.5 Replace undefined `close()` / `_scheduleReconnect()` calls in resend-failed reset with real lifecycle behavior.
  - [x] 1.6 Clear/update Redis sequence keys during forced reset and verify next logon uses `141=Y`, `34=1`.
  - [x] 1.7 Handle inbound `35=4` SequenceReset-GapFill by advancing `expectedSeqNum` without emitting app messages or resend loops.
  - [x] 1.8 Add focused tests for logon timeout teardown, duplicate-logon reject, stale callbacks, Redis reset invalidation, inbound SequenceReset, and real resend-failed reset.
  - [x] 1.9 Run `bun test src/fix-protocol/fix-connection.test.js src/fix-protocol/fix-connection.sequence.test.js tests/fix-connection-resend.test.js`.
  - [x] 1.10 Run `/adversarial-reviewer` locally and address PAUSE/BLOCK findings.
  - [ ] 1.11 Run `/pre-push-review`.
  - [ ] 1.12 Smoke test category: `NO_SERVER_SURFACE` for this parent task.

- [ ] 2.0 Add TrueX book data contract and ALO marketability safety
  - [x] 2.1 Wire fresh TrueX best bid/ask into `QuoteEngine` through the orchestrator or an injected provider.
  - [x] 2.2 Add `truexBookStaleThresholdMs` and `marketablePostOnlyAction`.
  - [x] 2.3 Recheck every ALO order immediately before `sendMessage`, including queued actions.
  - [x] 2.4 Default marketable ALO behavior to skip and log suppression reason/timestamp.
  - [x] 2.5 Add tests for buy-at-best-ask, sell-at-best-bid, stale book, missing book, and queued-action recheck.
  - [x] 2.6 Run `bun test tests/quote-engine.test.js src/core/market-maker-orchestrator.test.js`.
  - [ ] 2.7 Run `/adversarial-reviewer`, `/pre-push-review`, and mark smoke category `NO_SERVER_SURFACE`.

- [ ] 3.0 Implement passive-safe replacement state
  - [x] 3.1 Add `replaceMode` default `passive-safe` with explicit legacy `place-before-cancel` override.
  - [x] 3.2 Add per-side/per-level pending replacement state.
  - [x] 3.3 Release pending replacements only after cancel ack and revalidate/recompute against latest mid/book.
  - [x] 3.4 Restore original order on cancel reject without placing duplicate replacement.
  - [x] 3.5 Expire pending replacements after configurable timeout and report suppression in quote status.
  - [x] 3.6 Update replacement-ordering tests and add cancel-ack/cancel-reject/timeout coverage.
  - [x] 3.7 Run `bun test tests/quote-engine.test.js`.
  - [ ] 3.8 Run `/adversarial-reviewer`, `/pre-push-review`, and mark smoke category `NO_SERVER_SURFACE`.

- [ ] 4.0 Add fee-aware optional taking and liquidity-role metadata
  - [x] 4.1 Add `allowTakerOrders=false`, `truexTakerFeeBps`, `minTakeEdgeBps`, `takeSlippageBufferBps`, `takeHedgeBufferBps`, `maxTakerOrdersPerMinute`, and `maxTakerNotionalPerMinute` to quote engine config.
  - [x] 4.2 Implement buy/sell post-fee edge formula and boundary behavior.
  - [x] 4.3 Send taker-intent limit orders by omitting `18=6`.
  - [x] 4.4 Track `orderIntent`, `liquidityRoleExpected`, and final maker/taker role in active orders, fill events, PnL, and audit/data pipeline records.
  - [x] 4.5 Keep taker path disabled by default and enforce taker order/notional budgets.
  - [x] 4.6 Add tests for disabled taker path, profitable/unprofitable/boundary opportunities, budget exhaustion, and PnL/audit maker/taker routing.
  - [x] 4.7 Run `bun test tests/quote-engine.test.js src/core/market-maker-orchestrator.test.js tests/pnl-tracker.test.js`.
  - [ ] 4.8 Run `/adversarial-reviewer`, `/pre-push-review`, and mark smoke category `NO_SERVER_SURFACE`.

- [ ] 5.0 Document, review, PR, and merge
  - [x] 5.1 Update `docs/ARCHITECTURE.md` and any runbook notes for new config and rollout behavior.
  - [x] 5.2 Run all focused tests plus any broader relevant `bun test` target that remains practical.
  - [x] 5.3 Run `/adversarial-reviewer`.
  - [ ] 5.4 Run `/pre-push-review`.
  - [ ] 5.5 Smoke test with paper/UAT mode if credentials/environment are available; otherwise record `SMOKE_MISSING` or `NO_SERVER_SURFACE` with rationale.
  - [ ] 5.6 Commit on the feature branch.
  - [ ] 5.7 Push branch and create PR with summary, tests, smoke result, and `@coderabbitai ignore` if appropriate.
  - [ ] 5.8 Run `/pr-review-loop`, address all feedback, and ensure CI is green.
  - [ ] 5.9 Run `/docs-generator` because docs are touched.
  - [ ] 5.10 Merge through PR only; do not push directly to `main`.
