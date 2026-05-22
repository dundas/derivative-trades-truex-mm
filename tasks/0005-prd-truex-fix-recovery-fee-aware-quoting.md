# PRD 0005 - TrueX FIX Recovery and Fee-Aware Quoting

## 1. Introduction / Overview

Two TrueX testing incidents exposed production-risk behavior in the market maker:

1. **ALO quote churn** - TrueX rejects/cancels Add Liquidity Only (ALO / post-only) orders when they would interact with resting liquidity. The current quote engine always sends `18=6` ALO and, during reprices, intentionally places the new quote before canceling the old quote. This improves visible continuity in a generic market maker, but on TrueX it can create repeated rejects and single-sided market behavior when the new quote is marketable.

2. **FIX stale stream / duplicate logon loop** - After a disconnect/replay, TrueX rejected a duplicate logon because an existing stream for the same FIX session was still active. The current reconnect path can reject a logon attempt without definitively tearing down the socket before scheduling the next connection, which can leave the exchange seeing two concurrent streams for one sender/target session.

This PRD defines a scoped fix for session recovery and quote decisioning. It does not replace the market-making engine; it hardens the existing `FIXConnection`, `QuoteEngine`, and orchestrator wiring.

## 2. Goals

| # | Goal |
|---|------|
| G1 | Prevent duplicate FIX streams for the same TrueX session after timeout, reject, disconnect, or gap-recovery reset |
| G2 | Stop marketable ALO churn during quote replacement |
| G3 | Allow configurable fee-aware taking only when expected edge remains positive after taker fees and safety buffers |
| G4 | Preserve two-sided quoting where balances, risk limits, market data freshness, and FIX state permit it |
| G5 | Add tests that reproduce the two observed incidents without requiring live TrueX access |

## 3. User Stories

- As an operator, I want reconnect failures to close the stale socket before retrying, so TrueX does not reject us as already authenticated on an old stream.
- As a market maker, I want post-only orders to remain passive, so the engine does not repeatedly submit ALO orders that TrueX must cancel.
- As a trader, I want the engine to take only when the expected edge is still positive after taker fees, so opportunistic fills do not turn into systematic fee losses.
- As an operator, I want continuous two-sided markets when safe, so tests do not frequently observe one-sided quoting caused by avoidable order lifecycle churn.

## 4. Functional Requirements

### FR-1 - Deterministic FIX teardown before reconnect

**Files:** `src/fix-protocol/fix-connection.js`, `src/fix-protocol/fix-connection.test.js`, `src/fix-protocol/fix-connection.sequence.test.js`

1. Add a single internal teardown path for failed connection attempts that:
   - clears the logon timeout and connection timeout,
   - removes the temporary logon response listener,
   - destroys the current socket exactly once,
   - sets `isConnected=false` and `isLoggedOn=false`,
   - clears heartbeat, stable-connection, cleanup, reconnect, and delayed logon setup timers where applicable,
   - prevents stale `data`, `error`, `close`, delayed setup, and timeout callbacks from mutating state or scheduling duplicate reconnects after a newer socket exists.
2. Use this teardown path when:
   - TCP connection timeout fires,
   - logon response timeout fires,
   - logon receives FIX `35=3` reject,
   - logon receives duplicate-session text such as `58=Already authenticated...`,
   - logon receives non-zero `1409` session status,
   - sequence-gap recovery exceeds `maxResendAttempts`.
3. Replace the undefined `this.close()` / `this._scheduleReconnect()` calls in the resend-failure reset path with existing, tested connection lifecycle methods.
4. When a forced sequence reset is required, clear or update persisted Redis sequence keys (`fix:seq:<sender>:<target>:in/out`) before the next connect so stale persisted values cannot overwrite the reset.
5. Handle inbound FIX `35=4` SequenceReset from TrueX:
   - if `123=Y` GapFillFlag is present, advance `expectedSeqNum` to `36=NewSeqNo`,
   - do not emit application messages for gap-filled ranges,
   - do not issue another resend request for the range the exchange just gap-filled.
6. Preserve normal intentional disconnect behavior: `disconnect()` should still send Logout when logged on and should not schedule reconnect.
7. Ensure reconnect attempts are serialized by connection generation or equivalent stale-callback protection.

**Acceptance criteria:**
- A simulated logon timeout destroys the socket before reconnect scheduling.
- A simulated `35=3` reject destroys the socket before reconnect scheduling.
- A logon reject with `58=Already authenticated...` destroys only the attempted socket, emits a structured duplicate-logon event/metric, and schedules exactly one reconnect with backoff.
- A simulated `1409=9` resets sequence state and destroys the stale stream before retry.
- A stale `close` event from an old socket cannot schedule a second reconnect timer.
- A delayed setup/logon timer from socket A cannot send Logon on socket B or mutate socket B's state after socket A has been superseded.
- Forced sequence reset updates or deletes persisted Redis sequence keys before the next connect, and the next logon sends `141=Y` with `34=1`.
- Inbound `35=4` SequenceReset-GapFill advances `expectedSeqNum` to `36=NewSeqNo` without emitting an application message or requesting another resend for the filled range.
- The resend-failure reset branch does not call undefined methods, and its test exercises real lifecycle methods rather than stubbing nonexistent APIs.

### FR-2 - Venue-aware replacement ordering for ALO quotes

**Files:** `src/core/quote-engine.js`, `tests/quote-engine.test.js`, `src/core/market-maker-orchestrator.js`

1. Add a configurable replacement policy, defaulting to a TrueX-safe mode:
   - `replaceMode: 'passive-safe'`
   - For ALO/post-only quotes, cancel the old order before placing a replacement when the replacement may be marketable.
   - Wait for cancel acknowledgement before placing the replacement when possible.
   - If cancel acknowledgement is delayed beyond a configurable timeout, either hold the level empty or place only a confirmed passive quote, depending on marketability checks.
2. Add per-side/per-level pending replacement state:
   - store the replacement intent while the old order is cancelling,
   - release it only after cancel acknowledgement,
   - revalidate or recompute the replacement against the latest mid/book before sending,
   - restore the old order state on cancel reject without placing a duplicate replacement,
   - expire pending replacements after a configurable timeout.
3. Keep the current place-before-cancel behavior available only as an explicit config option, e.g. `replaceMode: 'place-before-cancel'`, for controlled testing.
4. Avoid indefinite one-sided gaps:
   - continue quoting the opposite side if safe,
   - emit/log side-level state when a side is suppressed due to cancel wait, balance, stale MD, or reject backoff.
5. Update existing tests that currently require place-before-cancel to assert the new TrueX default and the explicit legacy override.

**Acceptance criteria:**
- Default replacement behavior no longer places a new ALO replacement before canceling the old order when the quote is marketable.
- The legacy behavior remains testable via explicit config.
- A delayed cancel acknowledgement does not trigger duplicate replacement orders at the same side/level.
- A replacement released after cancel acknowledgement is revalidated against the latest book/mid rather than blindly sent from stale desired state.
- A cancel reject restores the original order to active tracking and does not place the pending replacement.
- Quote status exposes why a side or level is missing.

### FR-3 - Marketability checks before sending ALO orders

**Files:** `src/core/quote-engine.js`, `src/core/truex-market-data.js`, `src/core/market-maker-orchestrator.js`, tests

1. Define a marketability data contract:
   - `QuoteEngine` receives TrueX best bid/ask from `TrueXMarketDataFeed.getBestBidAsk()` or an equivalent injected provider,
   - the orchestrator wires book updates or refreshed best bid/ask into `QuoteEngine`,
   - source precedence is TrueX book first, then no marketability decision; external midpoint alone is not enough to declare a TrueX order passive,
   - `truexBookStaleThresholdMs` controls freshness.
2. Before sending an ALO order, including actions delayed in the rate-limit queue:
   - reject or adjust a buy quote with price `>= bestAsk`,
   - reject or adjust a sell quote with price `<= bestBid`.
3. Make behavior configurable:
   - `marketablePostOnlyAction: 'skip' | 'slide'`
   - Default: `skip` until live testing confirms TrueX-compatible sliding behavior.
4. If TrueX market data is unavailable or stale, treat marketability as unknown and use conservative post-only behavior.

**Acceptance criteria:**
- A buy ALO quote at or above best ask is not sent by default.
- A sell ALO quote at or below best bid is not sent by default.
- A quote that was passive when enqueued but becomes marketable before `_sendNewOrder()` is rechecked and skipped or slid before `sendMessage`.
- Missing or stale TrueX book data does not cause the engine to cross unintentionally.
- Logs distinguish "skipped marketable ALO" from exchange rejection.

### FR-4 - Fee-aware optional taking

**Files:** `src/core/quote-engine.js`, `src/core/market-maker-orchestrator.js`, `src/core/pnl-tracker.js`, tests

1. Add quote-engine config for fee-aware taking:
   - `allowTakerOrders` default `false`.
   - `truexTakerFeeBps` from existing config/env.
   - `minTakeEdgeBps` default greater than taker fee plus a safety buffer.
   - `takeSlippageBufferBps` default configurable.
   - `takeHedgeBufferBps` default configurable.
   - `maxTakerOrdersPerMinute` default low and configurable.
   - `maxTakerNotionalPerMinute` configurable.
2. When `allowTakerOrders=true`, allow a non-ALO limit order only if:
   - expected edge after taker fee and configured buffers is greater than or equal to `minTakeEdgeBps`,
   - position limits and balance checks pass,
   - market data freshness checks pass,
   - rate and notional taker budgets have capacity.
3. Define the edge formula in implementation docs/tests:
   - for a buy: `edgeBps = ((fairValue - executionPrice) / fairValue) * 10000 - truexTakerFeeBps - takeSlippageBufferBps - takeHedgeBufferBps`,
   - for a sell: `edgeBps = ((executionPrice - fairValue) / fairValue) * 10000 - truexTakerFeeBps - takeSlippageBufferBps - takeHedgeBufferBps`,
   - `fairValue` must come from fresh aggregated market data with confidence above threshold,
   - `executionPrice` must come from the current TrueX book or the exact limit price expected to take.
4. Encode taker-intent FIX orders by omitting `18=6` rather than overloading the current post-only path.
5. Tag/log taker-intent orders distinctly so PnL and audits can distinguish intentional taking from accidental taker fills.
6. Do not infer profitability from external midpoint alone when TrueX book data is stale.

**Acceptance criteria:**
- With `allowTakerOrders=false`, all quote-engine order sends remain post-only or are skipped.
- With `allowTakerOrders=true`, a profitable opportunity after taker fees sends a non-ALO order.
- An opportunity that is profitable before fees but unprofitable after fees is skipped.
- Boundary tests cover edge below, exactly at, and above `minTakeEdgeBps`.
- Taker rate and notional limits prevent repeated aggressive orders.

### FR-5 - Two-sided market health instrumentation

**Files:** `src/core/quote-engine.js`, `src/core/market-maker-orchestrator.js`, API/dashboard tests as needed

1. Extend quote status to report:
   - bid levels active/pending/cancelling/suppressed,
   - ask levels active/pending/cancelling/suppressed,
   - suppression reasons,
   - last suppression reason and timestamp per side/level,
   - last marketable ALO skip timestamp/count,
   - recent reject count by reason.
2. Carry order-intent and liquidity-role metadata end-to-end:
   - active order state includes `orderIntent` (`maker_quote` or `taker_opportunity`) and `liquidityRoleExpected`,
   - fill events include expected and final liquidity role when available,
   - orchestrator routes intentional taker fills to `PnLTracker` with `isMaker=false`,
   - data pipeline/audit fill records include order intent and liquidity role fields.
3. Add watchdog logging or alert normalization for sustained one-sided quoting:
   - Default threshold should be configurable.
   - Alerts should not fire when one side is intentionally disabled by balance/risk limits.

**Acceptance criteria:**
- Operators can tell whether one-sided quoting is caused by balance, risk, cancel wait, stale MD, post-only marketability, or rejects.
- One-sided market alerts are deduplicated and recover when two-sided quoting resumes.
- Taker-intent fills are accounted as taker fills in PnL and are visible in audit/data pipeline records.

## 5. Non-Goals

- Replacing the current market-making architecture.
- Changing TrueX credentials, sender IDs, or committed environment files.
- Persisting sensitive secrets in repo files.
- Implementing a new hedge strategy.
- Changing PnL accounting beyond tagging intentional taker fills and reusing existing fee config.
- Live production deployment as part of this PRD.

## 6. Technical Considerations

Existing code to build on:

- `src/fix-protocol/fix-connection.js` already owns TCP/FIX state, resend handling, heartbeat, and reconnect backoff.
- `src/core/quote-engine.js` already computes desired quotes, reconciles active orders, sends ALO orders, and tracks pending/cancelling state.
- `src/core/market-maker-orchestrator.js` already wires fee config into `PnLTracker`, but not into `QuoteEngine`.
- `src/core/pnl-tracker.js` already supports maker/taker fee accounting.
- `src/core/truex-market-data.js` already parses TrueX market data and should be the preferred source for marketability checks when available.

Known code risks confirmed by spike:

- **SPIKED:** `QuoteEngine._sendNewOrder()` always sets FIX tag `18=6`, so it cannot intentionally take today.
- **SPIKED:** `executeActions()` defaults to place-before-cancel replacement ordering.
- **SPIKED:** Fee config reaches `PnLTracker`, but `QuoteEngine` does not receive `truexTakerFeeBps`.
- **SPIKED:** The resend-failure reset branch calls undefined lifecycle methods.
- **SPIKED:** The reconnect path can reject a logon attempt without a single explicit teardown path for the active socket.
- **SPIKED:** `TrueXMarketDataFeed.getBestBidAsk()` exists, but `QuoteEngine` is not currently wired to receive current TrueX best bid/ask.
- **SPIKED:** `_onQuoteFill()` hardcodes TrueX fills as maker fills, so intentional taker orders need metadata routing before enabling taking.

Implementation should prefer small config additions over a broad strategy rewrite. Defaults must preserve conservative behavior: post-only by default, no taking by default, and no secret-bearing config committed.

## 7. Rollout & Gates

This work follows `.ai/protocols/STANDARD_DEV_WORKFLOW.md`.

Required workflow:

1. Implement on a feature branch, not `main`.
2. Use adversarial review before code review because this changes financial behavior.
3. Run focused unit tests for FIX recovery and quote-engine decisioning.
4. Run `/pre-push-review` before push.
5. Run smoke testing in paper/UAT mode only; no live production taking during the implementation PR.
6. Open a PR and run `/pr-review-loop`.
7. Update `docs/ARCHITECTURE.md` or the relevant TrueX runbook if config/operational behavior changes.

Minimum local validation:

- `bun test src/fix-protocol/fix-connection.test.js`
- `bun test src/fix-protocol/fix-connection.sequence.test.js`
- `bun test tests/quote-engine.test.js`
- New focused tests for inbound SequenceReset, Redis reset invalidation, stale socket callbacks, queued-action marketability recheck, pending replacement release/cancel reject, fee-aware take-edge boundaries, taker budget limits, and PnL/audit intent tagging.

Rollout phases:

1. Ship FIX teardown/reconnect hardening with taking disabled.
2. Ship ALO marketability skips and TrueX-safe replacement default with taking disabled.
3. Enable fee-aware taking only in paper/UAT with strict low taker budgets.
4. Consider production enablement only after UAT logs show no duplicate-session loops, no repeated marketable ALO skips, and expected two-sided quote health.

Rollback:

- Revert to `allowTakerOrders=false`.
- Set `replaceMode='place-before-cancel'` only if needed for emergency behavioral rollback and after confirming it will not recreate ALO churn.
- Disable quote engine if FIX reconnect still produces duplicate session rejects.

## 8. Success Metrics

| Metric | Target |
|--------|--------|
| Duplicate logon / "already authenticated" loops after reconnect | 0 in UAT replay tests |
| Undefined-method failures in sequence-gap reset path | 0 |
| Marketable ALO orders sent by default | 0 |
| Taker orders sent when `allowTakerOrders=false` | 0 |
| Taker orders with expected edge below configured post-fee threshold | 0 |
| Intentional taker fills recorded as maker fills | 0 |
| Sustained unexplained one-sided quoting events | 0 |

## 9. Open Questions

1. What exact TrueX taker fee bps should be used for production? Current repo defaults are often `0`, while older PRD examples mention `10`.
2. Should post-only marketable quotes be skipped or slid one tick away from the touch after TrueX confirms expected behavior?
3. What is the acceptable maximum one-sided quote duration during cancel-wait replacement?
4. Should intentional taker fills be persisted with a new audit field, or is structured logging sufficient for the first release?

## 10. Adversarial Review Notes

**Proposed action:** Add requirements for FIX recovery hardening, ALO-safe replacement, marketability checks, and optional fee-aware taking.

**Against doing this:** Allowing intentional taking increases financial risk and can convert a passive market maker into an aggressive strategy. Changing replacement order can reduce visible continuity and may increase short gaps. FIX recovery changes can destabilize reconnect behavior if stale socket handling is wrong.

**Assumption review:**

| Assumption | Status | Disposition |
|------------|--------|-------------|
| Current code always sends ALO from `QuoteEngine` | SPIKED | Confirmed in `_sendNewOrder()` |
| Current replacement default is place-before-cancel | SPIKED | Confirmed in `executeActions()` and tests |
| Fee config does not currently influence quote decisions | SPIKED | Confirmed in orchestrator and quote engine |
| Duplicate streams can be mitigated by explicit stale socket teardown | ASSUMPTION | Reasonable from logs and code path, must be proven by tests/UAT |
| Fee-aware taking should be enabled by default | REJECTED | PRD requires default disabled |
| Marketability can be decided at quote-compute time only | REJECTED | PRD requires final-send recheck because actions can queue |
| Taker PnL can reuse current maker-fill route unchanged | REJECTED | PRD requires intent/liquidity metadata through fill and PnL paths |

**Verdict:** PROCEED with the PRD. The implementation must preserve conservative defaults and phase rollout so session recovery and post-only safety can ship before any aggressive taking is enabled.
