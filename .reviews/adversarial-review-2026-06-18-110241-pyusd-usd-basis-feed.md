PROPOSED: Merge task 2.0a as an additive PYUSD/USD reference feed on `feat/pyusd-usd-basis-feed`.
REASON: Task `2.0a` requires a real live basis source before engine plumbing; Coinbase `PYUSD-USD` is delisted, and Kraken public ticker `PYUSDUSD` revalidated live on 2026-06-18.
REQUESTER: User

AGAINST:
1. Any change in `market-maker-orchestrator.js` has broad blast radius because it sits on the live maker lifecycle.
2. A basis feed can silently contaminate the BTC-USD fair-value path if it is routed through `PriceAggregator` or `QuoteEngine` too early.
3. A failing poller can create noisy alerts, timer leaks, or startup regressions even if it never reaches execution logic.
4. Kraken pair naming is inconsistent enough that a single hardcoded symbol could fail later and leave the system with a dead reference feed.
5. Surfacing a basis value in prod logs without freshness could encourage later consumers to treat stale data as valid.

ASSUMPTIONS:
- [VERIFIED] Kraken public ticker `PYUSDUSD` is live as of 2026-06-18 via direct REST check.
- [VERIFIED] The implementation keeps `PriceAggregator` unchanged, so BTC-USD confidence/freshness math is untouched.
- [VERIFIED] The new feed is stored separately as `orchestrator.pyusdUsd` with explicit freshness and poll health in `getStatus()`.
- [VERIFIED] Full local validation passed: targeted tests, new smoke, and full `bun test` (`972 pass / 8 skip / 0 fail`).
- [ASSUMED] Kraken public ticker availability remains stable enough for a 5s poll cadence in prod.
- [UNVERIFIED] Prod alert noise from the new poller is acceptable under real network conditions before deployment.

COMPLIANCE CHECK:
- No urgency pattern detected.
- No authority-only pattern detected; the task explicitly called for a live-source revalidation and additive isolation.
- Incrementalism risk is present in principle because this is phase 1 of a larger shadow-take system, but the current branch keeps the execution path isolated and observable.

VERDICT: PROCEED

REASONING: The strongest objection was accidental coupling into the live maker path. The implementation addressed that directly by leaving `PriceAggregator` unchanged, keeping `pyusdUsd` off the `QuoteEngine`, and proving with tests/smoke that maker price updates still flow unchanged and no FIX messages are sent. The remaining risk is operational rather than architectural and is acceptable for this phase because the feed is additive, freshness-aware, and fallback-capable.

CONDITIONS:
1. Keep deployment gated until pre-push review and PR review loop complete.
2. Treat any future consumer of `pyusdUsd` as blocked unless it checks `pyusdUsdFresh`.
3. If prod shows sustained poll failure or alert spam, roll back the basis poller before attempting 2.0b.
