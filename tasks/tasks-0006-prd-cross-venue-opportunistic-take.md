# Tasks — PRD 0006 Cross-Venue Opportunistic Take (Phase 1: SHADOW / observe-only)

Source PRD: `tasks/0006-prd-cross-venue-opportunistic-take.md` (v2, §11 authoritative).
Scope: **Phase 1 only** — detect opportunities and LOG what we *would* take. **No real orders.**
Phase 2 (live takes) is gated on Phase 1 data and explicitly out of scope here.

## Relevant Files

- `src/core/market-maker-orchestrator.js` — add `/market/quote` poll loop (resilient), feed `truexEbbo`; add PYUSD/USD reference plumbing.
- `src/core/quote-engine.js` — add `truexEbbo` field + `updateTruexEbbo()`; basis-adjusted edge; shadow detection + would-take logging + dedup; assert no send in shadow.
- `tests/quote-engine.test.js` — unit tests: basis edge math, detection threshold, suppression (stale/low-confidence Coinbase, stale truexEbbo), dedup, **zero FIX sends in shadow**.
- `src/core/market-maker-orchestrator.test.js` — poll wiring, truexEbbo feed, pyusdUsd plumbing, poll resilience (timeout/error/backoff/in-flight guard).
- `src/exchanges/truex/TrueXRESTClient.ts` — reuse `getMarketQuote`; probe real quote payload shape during 0.0.
- `src/connectors/kraken/KrakenRestClient.ts` — likely basis-feed source for 2.0a now that Coinbase `PYUSD-USD` is delisted on `ws-feed.exchange.coinbase.com`.
- `src/connectors/aggregator/PriceAggregator.ts` — likely unchanged for 2.0a; only touch if the basis-feed design truly needs aggregator support.
- `src/data-pipeline/coinbase-ws-ingest.js` — **not** the basis source after 0.3 unless Coinbase relists `PYUSD-USD`; keep unchanged unless design changes again.
- `scripts/run-prod.js` — `shadowTakeMode` config (off by default), thresholds, poll interval; wire into orchestrator.
- `scripts/smoke-shadow-take.ts` — shadow smoke: synthetic dislocated book → asserts would-take log + zero sends.
- `scripts/analyze-shadow-takes.js` — summarize would-take logs (edge dist, fill/miss, live PYUSD basis) for the Phase-2 go/no-go.

### Notes
- Tests run with `bun test`. Co-locate where the repo already does (`tests/` + `src/core/*.test.js`).
- **Workflow protocol:** `.ai/protocols/STANDARD_DEV_WORKFLOW.md`. Each parent task carries the full gate chain.
- **Hard invariant for ALL Phase-1 tasks:** the code path MUST NOT dispatch any FIX order. Shadow = log only. Every parent's tests assert zero `fixConnection.sendMessage` calls on the take path.
- Smoke categories per parent noted inline.
- Deploy = rebuild + recreate on Hetzner: `docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate market-maker` (backup the changed file first, as in #32–#34).

## Task Ordering & Dependencies

- **0.0** (data-source spike) is a hard prerequisite for **1.0**, **2.0a**, and **3.0**.
- **1.0** (truexEbbo feed) should start only after 0.0 findings are applied, then merge before **3.0**.
- **2.0a** (real PYUSD/USD feed) must merge before **2.0b** (engine plumbing).
- **3.0** (shadow detection + logging) requires 0.0 + 1.0 + 2.0b on `main`.
- **4.0** (enablement + smoke + analysis) requires 3.0 on `main`.
- **1.0** is a safe no-op in isolation once the 0.0 quote-shape findings are reflected. **2.0a** is not assumed to be one until the basis-feed design is confirmed in 0.0.

## Tasks

> **Pairing-review amendments (2026-06-18) apply — see "Pairing-Review Revisions" at the bottom.**
> Live prod / live public checks on **2026-06-18** superseded several of those assumptions:
> `/market/quote` **does** expose nested `last_trade` / `order_count`, `/market/trade` exists as a
> public REST tape, and Coinbase `PYUSD-USD` is **delisted** on `ws-feed.exchange.coinbase.com`.

- [x] **0.0 Data-source spike (no code) — prerequisite for 1.0, 2.0a, and 3.0** — smoke: N/A (investigation)
  - [x] 0.1 Hit live prod `/market/quote` and dump the RAW response: confirm exact fields. **Finding (2026-06-18):** response is an **array** of instrument objects shaped like `{id, symbol, info}` where `info` contains nested `last_trade {price, qty, timestamp}`, `best_bid {price, qty, order_count, last_update}`, `best_ask {price, qty, order_count, last_update}`, and `last_update`. PRD §7's earlier flat field list is wrong.
  - [x] 0.2 Find a TrueX **public trade tape** source for the PB2 recency/outlier guard. **Finding (2026-06-18):** prod REST `GET /market/trade?instrument_id=<BTC-PYUSD instrument>` returns public trade prints; `/market/candle` and `/market/candles` return 404; `/order/trade` is the authenticated account-trades endpoint and is not a public tape substitute.
  - [x] 0.3 Confirm Coinbase lists a **`PYUSD-USD`** product on `ws-feed.exchange.coinbase.com`. **Finding (2026-06-18):** Coinbase Exchange still exposes `PYUSD-USD` in the product catalog, but it is **status=delisted** / `trading_disabled=true`; `ws-feed.exchange.coinbase.com` rejects subscription with `reason: \"PYUSD-USD is delisted\"`. This rules out a second `CoinbaseWsIngest` instance. For 2.0a, pivot to a live public alternative (currently Kraken public ticker `PYUSDUSD` is available).
  - [x] 0.4 Confirm whether `/market/quote` timestamps are nanos (→ `nanosToDate`) or ISO, for `_isTruexEbboFresh()`. **Finding (2026-06-18):** `last_trade.timestamp`, `best_bid.last_update`, `best_ask.last_update`, and `info.last_update` are all 19-digit nanosecond timestamps.
  - [x] 0.5 Write findings into this file's revisions section; adjust 2.0/3.0 sub-tasks to match reality before branching.

- [x] **1.0 Real TrueX EBBO feed (`truexEbbo`), resilient `/market/quote` poll** — smoke: poll round-trip (has outbound surface, NOT skippable)
  - [x] 1.1 Create feature branch `feat/truex-ebbo-feed` from `main`
  - [x] 1.2 Add `truexEbbo` state + `updateTruexEbbo(book)` to QuoteEngine — **separate** from `truexBook`; store `{bestBid,bestAsk,bestBidQty,bestAskQty,bestBidOrderCount,bestAskOrderCount,lastTradePrice,lastTradeQty,lastTradeTs,timestamp}`
  - [x] 1.3 Add `_isTruexEbboFresh()` using `truexBookStaleThresholdMs`
  - [x] 1.4 Orchestrator: configurable poll loop calling `restClient.getMarketQuote({instrument_id})`; add `parseMarketQuote` helper for the **array + nested `info.best_bid` / `info.best_ask` / `info.last_trade` shape** (string→number, nanos timestamps) and map response → `updateTruexEbbo`
  - [x] 1.5 Poll resilience (FR25): bounded timeout < interval, in-flight guard (no overlap), skip-on-error, exponential backoff on 429/consecutive errors, alert on sustained failure
  - [x] 1.6 Assert the new poll feeds **only** `truexEbbo` and does NOT wire into `truexBook` / `marketDataProvider` / maker guard behavior
  - [x] 1.7 Unit tests: `updateTruexEbbo`/freshness; orchestrator poll wiring; resilience (timeout, error skip, backoff, in-flight guard); **orchestrator-layer zero send path**; maker path unchanged
  - [x] 1.8 Tests pass (`bun test`)
  - [x] 1.9 Run `/adversarial-reviewer` locally — fix PAUSE/BLOCK before PR
  - [x] 1.10 Run `/pre-push-review` (semgrep + roborev)
  - [x] 1.11 Smoke: start engine, assert `truexEbbo` populates from a mock `/market/quote`; **no order send**
  - [x] 1.12 `gh pr create` (summary + test plan; note smoke result)
  - [x] 1.13 After each push, solicit `@coderabbitai review`; re-tag if no comments in 5 min
  - [x] 1.14 `/pr-review-loop <PR#>` — address findings; never merge on CI-only
  - [x] 1.15 Merge after reviewer pass + CI green (`gh pr merge --merge --delete-branch`)
  - [x] 1.16 Pull `main`, full local validation; deploy (rebuild + recreate) and confirm poll healthy + no behavior change
  - [x] 1.17 Mini-narrative in `memory/daily/<today>.md`
  - [x] 1.18 Rollback plan: define abort triggers (sustained poll failure / 429 storm), recreate-from-backup command, and post-rollback verification that maker behavior is unaffected

- [x] **2.0a PYUSD/USD basis feed** — smoke: basis value populates (outbound surface, NOT skippable)
  - [x] 2.1 Create feature branch `feat/pyusd-usd-basis-feed` from `main`
  - [x] 2.2 Use 0.3 findings to stand up a real PYUSD-USD source: **revalidate the live public candidates at implementation time**, then prefer Kraken public REST ticker `PYUSDUSD` if it is still available; keep the basis source configurable and fallback-capable, and do **not** use a second `CoinbaseWsIngest` instance unless Coinbase relists `PYUSD-USD`
  - [x] 2.3 Expose `pyusdUsd` price + timestamp without altering the existing BTC-USD fair-value path used by the live maker
  - [x] 2.4 Unit tests: feed wiring/freshness; null/stale handling; **maker regression guard** that adding the basis feed does NOT change BTC-USD confidence/freshness
  - [x] 2.5 Tests pass
  - [x] 2.6 `/adversarial-reviewer` local
  - [x] 2.7 `/pre-push-review`
  - [x] 2.8 Smoke: feed → `pyusdUsd` populated; stale → flagged; no order send
  - [x] 2.9 `gh pr create`
  - [x] 2.10 Solicit `@coderabbitai review` (re-tag at 5 min)
  - [x] 2.11 `/pr-review-loop <PR#>`
  - [x] 2.12 Merge after reviewer pass + CI green
  - [x] 2.13 Pull `main`, validate; deploy + confirm basis value present in logs/status
  - [x] 2.14 Mini-narrative

- [x] **2.0b PYUSD/USD engine plumbing** — smoke: engine sees basis and suppresses on stale/missing
  - [x] 2.15 Create feature branch `feat/pyusd-usd-engine-plumbing` from `main`
  - [x] 2.16 Plumb `pyusdUsd` into the QuoteEngine (setter + freshness gate `_isPyusdBasisFresh()`); default to `null` when unavailable
  - [x] 2.17 Decision rule: if basis unavailable/stale, basis-dependent detection MUST suppress (no silent assume=1) — wired in 3.0, asserted here via the freshness gate
  - [x] 2.18 Unit tests: basis setter/freshness; null/stale handling; depeg value surfaced
  - [x] 2.19 Tests pass
  - [x] 2.20 `/adversarial-reviewer` local
  - [x] 2.21 `/pre-push-review`
  - [x] 2.22 Smoke: engine receives basis, stale basis is flagged/suppressed, no order send
  - [x] 2.23 `gh pr create`
  - [x] 2.24 Solicit `@coderabbitai review` (re-tag at 5 min)
  - [x] 2.25 `/pr-review-loop <PR#>`
  - [x] 2.26 Merge after reviewer pass + CI green
  - [x] 2.27 Pull `main`, validate
  - [x] 2.28 Mini-narrative

- [x] **3.0 Shadow opportunity detection + "would-take" logging** (requires 0.0 + 1.0 + 2.0b) — smoke: mandatory (`scripts/smoke-shadow-take.ts`)
  - [x] 3.1 Create feature branch `feat/shadow-take-detection` from `main`
  - [x] 3.2 Implement standalone `evaluateShadowTake()` that returns a loggable record only; it MUST NOT route through `_prepareQuoteForSend`, `_sendNewOrder`, or `_sendCancel`
  - [x] 3.3 Basis-adjusted edge (§11.4): apply basis by calling `computeTakeEdgeBps` with `executionPrice = truexBid / pyusdUsd` and `fairValue = coinbaseBid`; do **not** modify `computeTakeEdgeBps`
  - [x] 3.4 Trigger `evaluateShadowTake()` from the `/market/quote` poll handler after `updateTruexEbbo`, and also on **coalesced Coinbase fair-value changes** using cached `lastAggregatedPrice` when the detection input (`coinbaseBid`) moves by at least 1 TrueX tick or freshness/confidence flips; rate-limit these Coinbase-side reevaluations to no more than once per poll interval, and do NOT run on every raw `onPriceUpdate` tick in the hot maker path
  - [x] 3.5 Detection step: sell-take candidate when `truexEbbo.bestBid` adjusted-edge ≥ `minTakeEdgeBps`; size = `min(bestBidQty, balance-capped, maxPosition headroom, maxTakeNotionalPerOrder)`; inventory-reducing only (long); suppress dust via `minTakeSizeBTC`
  - [x] 3.6 Corroboration guards (PB2): Coinbase-leg freshness/confidence; **multi-poll persistence** (pinned N, reset on disappearance); **max-edge suspicion ceiling** (suppress + warn if edge > ceiling); **TrueX `/market/trade` tape recency/outlier guard** using the public REST trade prints confirmed in 0.2
  - [x] 3.7 Tape ingestion strategy for the PB2 guard: define polling cadence, cache lifetime, timeout/backoff behavior, stale-data handling, and tests proving the tape check does **not** turn every `/market/quote` poll into a second hot-path REST loop
  - [x] 3.8 Basis gate (PB1): suppress all detection if `pyusdUsd` stale/missing or `|pyusdUsd−1| > pyusdDepegThresholdBps`
  - [x] 3.9 Dedup (FR16): key on `bestBid + bestBidQty` (not timestamp); add qty-decay tolerance (recommend treating reductions within 10% as the same persisting order) so a partially-taken bid is not re-logged every poll
  - [x] 3.10 Structured `would-take` log: side, size, truexPrice, rawEdgeBps, basisAdjEdgeBps, pyusdUsd, coinbaseFresh, truexTapeAgeS, dedupKey, suppressReason(if any)
  - [x] 3.11 Fill/miss attribution: record whether the targeted bid disappears shortly after (TrueX's quoter likely took it) vs persists
  - [x] 3.12 Shadow-path alerting (FR26): rate-thresholded alerts for sustained zero-detection while market is active, basis/depeg suppression spikes, and edge-ceiling trips
  - [x] 3.13 **HARD: no order dispatch** — detection returns/logs only; Phase 1 must not touch `_sendNewOrder` / `_sendCancel`; output type is non-dispatchable
  - [x] 3.14 Unit tests: edge math (basis), fires at/above threshold + not below, suppression (stale/low-conf Coinbase, stale truexEbbo, basis stale/depeg, edge>ceiling, tape-outlier if applicable), dedup, inventory-reducing-only, minTakeSize floor, **assert zero sendMessage on the take path**
  - [x] 3.15 Orchestrator-layer tests: new poll loop has zero call edges to FIX and invokes a non-dispatchable shadow-evaluation path only
  - [x] 3.16 Tests pass
  - [x] 3.17 `/adversarial-reviewer` local (real-money-adjacent logic even though no sends — verify the no-send invariant holds on all branches)
  - [x] 3.18 `/pre-push-review`
  - [x] 3.19 Smoke (`scripts/smoke-shadow-take.ts`): synthetic dislocated book + fresh Coinbase + basis → asserts one would-take log with correct basis-adj edge AND zero FIX sends; second identical poll → deduped (no second log)
  - [x] 3.20 `gh pr create`
  - [x] 3.21 Solicit `@coderabbitai review` (re-tag at 5 min)
  - [x] 3.22 `/pr-review-loop <PR#>`
  - [x] 3.23 Merge after reviewer pass + CI green
  - [x] 3.24 Pull `main`, validate; **do NOT deploy yet** (enabled in 4.0)
  - [x] 3.25 Mini-narrative

- [ ] **4.0 Shadow enablement + smoke + analysis** (requires 3.0) — smoke: mandatory; CONFIG portion noted
  - [x] 4.1 Create feature branch `feat/shadow-take-enable` from `main`
  - [x] 4.2 `shadowTakeMode` config flag (default **false**); thresholds (`minTakeEdgeBps`, `maxEdgeCeilingBps`, `pyusdDepegThresholdBps`, `maxTakeNotionalPerOrder`, `minTakeSizeBTC`, persistence N), poll interval — all configurable and pinned before enable. Start `pyusdDepegThresholdBps` at **100 bps** for Phase 1 (above the 20–80 bps routine wobble) and recalibrate from observed live basis data before any Phase-2 enablement
  - [x] 4.3 Wire flags through orchestrator → engine; when `shadowTakeMode` true, run detection+logging only and make the send path unreachable regardless of `allowTakerOrders`
  - [ ] 4.4 In UAT, verify TrueX FIX honors IOC (`59=3`) with an observe-only fill+cancel flow; record the outcome as an explicit input to the Phase-2 go/no-go decision
  - [x] 4.5 Before enablement, pre-commit explicit GO/ABORT criteria: minimum observation window, fill-rate red-flag line, depeg/basis-vol thresholds, and required post-basis edge
  - [x] 4.6 Enable `shadowTakeMode: true` in `run-prod.js` (observe-only) with conservative thresholds that match the pre-committed criteria
  - [x] 4.7 `scripts/analyze-shadow-takes.js`: parse would-take logs → edge distribution, fill/miss rate, live PYUSD basis stats; output the Phase-2 go/no-go summary against the pre-committed criteria and UAT IOC result
  - [x] 4.8 Unit tests: flag gating (off → no detection at all), config plumbing, and `shadowTakeMode=true && allowTakerOrders=true` still yields **zero `fixConnection.sendMessage`**
  - [x] 4.9 Tests pass
  - [x] 4.10 `/adversarial-reviewer` local
  - [x] 4.11 `/pre-push-review`
  - [x] 4.12 Smoke: run with `shadowTakeMode` on against synthetic feed → would-take logs emitted, zero sends; off → nothing
  - [ ] 4.13 `gh pr create`
  - [ ] 4.14 Solicit `@coderabbitai review` (re-tag at 5 min)
  - [ ] 4.15 `/pr-review-loop <PR#>`
  - [ ] 4.16 `/docs-generator` (touches `scripts/` + `run-prod.js` → SO-13); docs PR through `/pr-review-loop`
  - [ ] 4.17 Merge after reviewer pass + CI green
  - [ ] 4.18 Pull `main`; deploy (rebuild + recreate); confirm shadow logs appear, **zero takes sent**, basis + edge values sane
  - [ ] 4.19 Run `analyze-shadow-takes.js` after a monitoring window; write findings + Phase-2 go/no-go recommendation into `memory/daily/<today>.md` and the PRD §11.5
  - [ ] 4.20 Rollback plan: explicit abort triggers (anomalous log volume / basis-feed misbehavior / sustained poll failure), recreate-from-backup command, and post-rollback verification
  - [ ] 4.21 Mini-narrative

## Out of scope (Phase 2 — separate task list, gated on 4.19 data)
Sending real taker orders; `_canTakeNow()` live gate; in-flight-aware sizing + never-go-short; separate taker order tracking + taker partial-fill branch; shared balance reservation; per-take + daily-loss kill-switch; STP/self-trade; buy-takes; multi-level sweeps.

## Adversarial review of this task list
- **No-send invariant** is made an explicit, tested sub-task in every parent (1.11, 2.8/2.22, 3.12/3.13/3.18, 4.8/4.12) — the executor cannot accidentally ship a live take.
- **Sequencing** enforced: 3.0 lists "requires 0.0+1.0+2.0b on main"; 4.0 requires 3.0; 3.23 explicitly says don't deploy until 4.0.
- **C3/FR17 regression** (feed-swap breaking maker guard) gets its own guard sub-task (1.6) and test.
- **Basis-never-assume-1** is structural: 2.16 defaults `pyusdUsd` to null, 3.7 suppresses on missing/stale — no silent =1.
- **Go/no-go is a deliverable** (4.6/4.19), so Phase 1 actually produces the decision data, not just logs.
- Simpler-alternative check: PYUSD basis can't be config-only (needs a live feed); detection can't be instruction-only. No parent is redundant.

---

## Pairing-Review Revisions (2026-06-18)

Two internal lenses (plan-completeness skeptic = REVISE; codebase-feasibility engineer = 2 false
assumptions). Amendments below override the task bodies above where they conflict.

### Feasibility corrections (updated by live 0.0 findings)
- **R1 (task 0.0/1.0/3.0):** live prod `/market/quote` on **2026-06-18** returns an **array** with
  nested `info.last_trade`, `info.best_bid.order_count`, `info.best_ask.order_count`, and nanos
  `last_update` fields. The earlier flat `MarketQuoteResponse` assumption was wrong; Phase 1 should
  use the nested live payload rather than the stale pairing assumption.
- **R2 (task 1.4):** add a `parseMarketQuote` helper for the real **array + nested info** response
  shape (string→float, nanos timestamps). PRD §7's earlier field list is inaccurate — trust 0.1's
  raw prod dump.
- **R3 (task 1.0/1.6):** the maker marketable/slide guard is **already inert in prod** (Coinbase
  adapter has no `getBestBidAsk`, so `truexBook` never populates). Adding `truexEbbo` is a safe
  additive field. Reword 1.6: assert the poll feeds **only** `truexEbbo` and does NOT wire into
  `truexBook`/`marketDataProvider` (guards against scope-creep, not a live regression). Engine side
  of 1.0 is small; the **poll loop + resilience (1.5) is the real work** (no existing pattern to copy).
- **R4 (task 2.0 — SPLIT):** Coinbase `PYUSD-USD` is **delisted** on `ws-feed.exchange.coinbase.com`,
  so a second `CoinbaseWsIngest` instance is off the table. Use a live public alternative for
  **2.0a** (currently Kraken REST ticker `PYUSDUSD` is confirmed live), then plumb `pyusdUsd` into
  the engine in **2.0b**.
- **R5 (task 3.2):** do **not** modify `computeTakeEdgeBps` (it's on the live maker-adjacent path).
  Apply basis by passing `executionPrice = truexBid / pyusdUsd` (fairValue = coinbaseBid) — formula
  works unchanged.
- **R6 (task 3.0/3.9):** implement a **standalone `evaluateShadowTake()` method** that NEVER routes
  through `_prepareQuoteForSend`/`_sendNewOrder` (the only send sites: `_sendNewOrder:580`,
  `_sendCancel:619`). Phase 1 MUST NOT touch those functions. Detection returns a log record, not a
  dispatchable quote object.
- **R7 (task 3.0 trigger):** run `evaluateShadowTake` from the **`/market/quote` poll handler**
  (after `updateTruexEbbo`), reading a cached `this.lastAggregatedPrice` (add it in `onPriceUpdate`).
  Also allow **coalesced Coinbase-side reevaluations** when the detection input (`coinbaseBid`)
  moves by at least 1 TrueX tick or freshness/confidence flips, but rate-limit them to no more
  than once per poll interval. Do **not** run detection on every raw `onPriceUpdate` tick in the
  hot maker path.
- **R8 (task 3.6 dedup):** key on **`bestBid + bestBidQty`** (NOT `timestamp` — it changes every
  poll and would defeat dedup). Add a qty-decay tolerance so a partially-taken persisting order
  isn't re-logged each poll.
- **R17 (task 0.2/3.6/3.9):** a public REST tape **does** exist at `GET /market/trade?instrument_id=<id>`.
  The endpoint returns recent public prints for `BTC-PYUSD`; unknown pagination params like `limit`,
  `page_size`, and `start` are rejected. Use this as the initial PB2 tape source and restore
  `truexTapeAgeS` to the shadow log.

### Plan/safety gaps (added requirements)
- **R9 — `shadowTakeMode` precedence (task 4.3 + new test):** when `shadowTakeMode === true`, the
  send path is **unreachable regardless of `allowTakerOrders`**. Add test (4.6): `shadowTakeMode=true
  && allowTakerOrders=true` → **zero `fixConnection.sendMessage`**. Highest-value missing test.
- **R10 — orchestrator-layer no-send test (task 1.0 + 3.0):** assert the new poll loop has zero call
  edges to the FIX connection and the detection output type is non-dispatchable.
- **R11 — rollback (new 1.18, 4.19):** explicit abort triggers (sustained poll failure / 429 storm /
  anomalous log volume / basis-feed misbehavior) + recreate-from-backup command + post-rollback
  verification that the maker path is unaffected.
- **R12 — PB3 IOC-UAT in Phase 1 (new task):** verify TrueX FIX honors `59=3` (observe an IOC
  fill+cancel) in **UAT** — observe-only, no prod capital — and make its result an explicit input to
  the 4.17 go/no-go (don't defer the whole premise-breaker to Phase 2).
- **R13 — pre-committed go/no-go criteria (task 4.5, before 4.17):** pin GO/ABORT thresholds up
  front: min observation window (≥N opportunities / ≥M days); GO requires post-basis edge
  consistently ≥ `minTakeEdgeBps` AND fill-rate on flagged ops **below** the adverse-selection
  red-flag line AND PYUSD basis within depeg threshold; ABORT if basis vol > buffer or fill-rate
  suggests we're the adversely-selected side. Numbers set before enabling, not after.
- **R14 — shadow-path alerting (FR26) (task 3.0/4.0):** wire into `alertManager` (rate-thresholded):
  sustained zero-detection while market active, suppression-rate spikes (esp. basis/depeg), edge-
  ceiling trips. Else a dead basis feed silently empties the Phase-2 dataset.
- **R15 — basis-feed maker regression guard (task 2.0a):** test that adding the PYUSD-USD
  subscription does NOT alter BTC-USD fair-value freshness/confidence used by the live maker.
- **R16 — concrete guard thresholds (task 3.4):** give each corroboration guard a tested rule:
  persistence N≥3 polls (reset on disappearance, not minor price change — resolve vs R8 dedup);
  `maxEdgeCeilingBps` value (set before enable); Coinbase freshness threshold pinned; tape guard per
  R1. Also add `minTakeSizeBTC` floor to shadow **detection** (3.3) so dust (0.00004 BTC) doesn't
  pollute the Phase-2 dataset.

### Verdicts
- Sequencing 1.0/2.0 → 3.0 → 4.0 confirmed correct; **0.0 spike inserted as prereq**; **2.0 split**.
- No-send invariant is structurally achievable via R6 (standalone method); R9/R10 close the leak paths.
- Pairing artifact: `memory/pairing/` (task-list session synthesized by the brain; external mech-run
  voices unavailable — no API keys — substituted two internal agent lenses).
