PROPOSED: Add additive `pyusdUsd` state/freshness plumbing to `QuoteEngine`, wire the existing orchestrator basis poller into that state, and add tests plus a smoke proving fresh/stale surfacing with zero FIX sends.
REASON: Task `2.0b` in `tasks/tasks-0006-prd-cross-venue-opportunistic-take.md` requires engine plumbing before any shadow-take logic can depend on basis availability.
REQUESTER: User / active thread goal

AGAINST:
1. This touches `QuoteEngine`, which is maker-adjacent, so an accidental behavior change could affect live quoting.
2. Adding basis handling too aggressively could create an implicit dependency before the shadow path exists, causing maker regressions for no current benefit.
3. If the orchestrator poller started mutating quote behavior instead of only status, the blast radius would be larger than the task allows.
4. A fake or overly mocked smoke would create weak evidence for a financial-data-adjacent change.

ASSUMPTIONS:
- [VERIFIED] Task `2.0b` is explicitly scoped to additive engine plumbing only; detection logic is deferred to `3.0`.
- [VERIFIED] The orchestrator already has an additive `pyusdUsd` poller on `main`; this change only propagates that data into `QuoteEngine`.
- [VERIFIED] The implementation does not alter `QuoteEngine.onPriceUpdate()`, quote generation, or FIX send paths.
- [VERIFIED] Freshness is explicit: missing/stale basis reports `false` via `_isPyusdBasisFresh()` rather than silently assuming parity.
- [VERIFIED] Evidence covers unit, integration-adjacent orchestration, dedicated smoke, and the full default test suite.

COMPLIANCE CHECK:
- No urgency pattern detected.
- No authority shortcut detected beyond normal user request.
- No incrementalism pressure to skip tests or reviews detected.

VERDICT: PROCEED

REASONING: The change is the minimum additive step needed for later shadow detection. It preserves the current maker path, keeps missing/stale basis explicit instead of defaulting to `1`, and is backed by zero-send smoke coverage plus a green full suite.

CONDITIONS:
1. Keep the data path additive only; no taker or shadow decision logic in this commit.
2. Run pre-push review on the committed diff before any push.
3. Preserve the no-send invariant in subsequent `3.0` work with dedicated tests.
