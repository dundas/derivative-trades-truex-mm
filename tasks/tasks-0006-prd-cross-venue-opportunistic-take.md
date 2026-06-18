# Tasks — PRD 0006 Cross-Venue Opportunistic Take (Phase 1: SHADOW / observe-only)

Source PRD: `tasks/0006-prd-cross-venue-opportunistic-take.md` (v2, §11 authoritative).
Scope: **Phase 1 only** — detect opportunities and LOG what we *would* take. **No real orders.**
Phase 2 (live takes) is gated on Phase 1 data and explicitly out of scope here.

## Relevant Files

- `src/core/market-maker-orchestrator.js` — add `/market/quote` poll loop (resilient), feed `truexEbbo`; add PYUSD/USD reference plumbing.
- `src/core/quote-engine.js` — add `truexEbbo` field + `updateTruexEbbo()`; basis-adjusted edge; shadow detection + would-take logging + dedup; assert no send in shadow.
- `tests/quote-engine.test.js` — unit tests: basis edge math, detection threshold, suppression (stale/low-confidence Coinbase, stale truexEbbo), dedup, **zero FIX sends in shadow**.
- `src/core/market-maker-orchestrator.test.js` — poll wiring, truexEbbo feed, pyusdUsd plumbing, poll resilience (timeout/error/backoff/in-flight guard).
- `src/exchanges/truex/TrueXRESTClient.ts` — reuse `getMarketQuote`; confirm trade-tape source (last_trade in `/market/quote`).
- `src/connectors/aggregator/PriceAggregator.ts` — source/expose PYUSD-USD (or a new lightweight feed) for basis; reuse `sources`/freshness.
- `src/data-pipeline/coinbase-ws-ingest.js` — add PYUSD-USD subscription if WS is the basis source.
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

- **1.0** (truexEbbo feed) and **2.0** (PYUSD/USD basis) are independent, both merge before **3.0**.
- **3.0** (shadow detection + logging) requires 1.0 + 2.0 on `main`.
- **4.0** (enablement + smoke + analysis) requires 3.0 on `main`.
- 1.0 and 2.0 are safe no-ops in isolation (populate fields nothing trades on).

## Tasks

> **Pairing-review amendments (2026-06-18) apply — see "Pairing-Review Revisions" at the bottom.**
> Two false assumptions were corrected (no `last_trade`/`order_count` in `/market/quote`; no
> PYUSD-USD feed exists). Task **0.0 (data-source spike) is now a hard prerequisite for 2.0 and 3.0.**

- [ ] **0.0 Data-source spike (no code) — prerequisite for 2.0 & 3.0** — smoke: N/A (investigation)
  - [ ] 0.1 Hit live prod `/market/quote` and dump the RAW response: confirm exact fields. (Pairing found `MarketQuoteResponse` = `{instrument_id, bid_price, bid_qty, ask_price, ask_qty, timestamp}` — **no `last_trade`, no `order_count`, fields are strings, `timestamp` is nanos**. PRD §7's field list is wrong.)
  - [ ] 0.2 Find a TrueX **public trade tape** source for the PB2 recency/outlier guard: probe for a `/market/trade`/candle endpoint, or the unused `TrueXMarketDataFeed` FIX MD path. `/order/trade` is OUR fills only — not usable. **If none exists → drop the tape-outlier guard from Phase 1 and rely on multi-poll persistence + `bid_qty` decay as the staleness proxy** (record this decision).
  - [ ] 0.3 Confirm Coinbase lists a **`PYUSD-USD`** product on `ws-feed.exchange.coinbase.com` (drives task 2.0 design: second `CoinbaseWsIngest` instance vs REST fallback).
  - [ ] 0.4 Confirm whether `/market/quote` `timestamp` is nanos (→ `nanosToDate`) or ISO, for `_isTruexEbboFresh()`.
  - [ ] 0.5 Write findings into this file's revisions section; adjust 2.0/3.0 sub-tasks to match reality before branching.

- [ ] **1.0 Real TrueX EBBO feed (`truexEbbo`), resilient `/market/quote` poll** — smoke: poll round-trip (has outbound surface, NOT skippable)
  - [ ] 1.1 Create feature branch `feat/truex-ebbo-feed` from `main`
  - [ ] 1.2 Add `truexEbbo` state + `updateTruexEbbo(book)` to QuoteEngine — **separate** from `truexBook` (maker guard untouched, FR17); store `{bestBid,bestAsk,bestBidQty,bestAskQty,lastTradePrice,lastTradeTs,timestamp}`
  - [ ] 1.3 Add `_isTruexEbboFresh()` using `truexBookStaleThresholdMs`
  - [ ] 1.4 Orchestrator: configurable poll loop calling `restClient.getMarketQuote({instrument_id})`; map response → `updateTruexEbbo`
  - [ ] 1.5 Poll resilience (FR25): bounded timeout < interval, in-flight guard (no overlap), skip-on-error, exponential backoff on 429/consecutive errors, alert on sustained failure
  - [ ] 1.6 Verify the maker marketable/slide guard still uses the original `truexBook` source (regression guard for C3/FR17)
  - [ ] 1.7 Unit tests: `updateTruexEbbo`/freshness; orchestrator poll wiring; resilience (timeout, error skip, backoff, in-flight guard); maker `truexBook` path unchanged
  - [ ] 1.8 Tests pass (`bun test`)
  - [ ] 1.9 Run `/adversarial-reviewer` locally — fix PAUSE/BLOCK before PR
  - [ ] 1.10 Run `/pre-push-review` (semgrep + roborev)
  - [ ] 1.11 Smoke: start engine, assert `truexEbbo` populates from a mock `/market/quote`; **no order send**
  - [ ] 1.12 `gh pr create` (summary + test plan; note smoke result)
  - [ ] 1.13 After each push, solicit `@coderabbitai review`; re-tag if no comments in 5 min
  - [ ] 1.14 `/pr-review-loop <PR#>` — address findings; never merge on CI-only
  - [ ] 1.15 Merge after reviewer pass + CI green (`gh pr merge --merge --delete-branch`)
  - [ ] 1.16 Pull `main`, full local validation; deploy (rebuild + recreate) and confirm poll healthy + no behavior change
  - [ ] 1.17 Mini-narrative in `memory/daily/<today>.md`

- [ ] **2.0 PYUSD/USD basis reference** — smoke: basis value populates (outbound surface, NOT skippable)
  - [ ] 2.1 Create feature branch `feat/pyusd-usd-basis` from `main`
  - [ ] 2.2 Source PYUSD-USD (Coinbase PYUSD-USD market via existing WS ingest, or a lightweight REST poll); expose `pyusdUsd` price + timestamp
  - [ ] 2.3 Plumb `pyusdUsd` into the QuoteEngine (setter + freshness gate `_isPyusdBasisFresh()`); default to `null` (not 1.0) when unavailable
  - [ ] 2.4 Decision rule: if basis unavailable/stale, basis-dependent detection MUST suppress (no silent assume=1) — wired in 3.0, asserted here via the freshness gate
  - [ ] 2.5 Unit tests: basis setter/freshness; null/stale handling; depeg value surfaced
  - [ ] 2.6 Tests pass
  - [ ] 2.7 `/adversarial-reviewer` local
  - [ ] 2.8 `/pre-push-review`
  - [ ] 2.9 Smoke: feed → `pyusdUsd` populated; stale → flagged; no order send
  - [ ] 2.10 `gh pr create`
  - [ ] 2.11 Solicit `@coderabbitai review` (re-tag at 5 min)
  - [ ] 2.12 `/pr-review-loop <PR#>`
  - [ ] 2.13 Merge after reviewer pass + CI green
  - [ ] 2.14 Pull `main`, validate; deploy + confirm basis value present in logs/status
  - [ ] 2.15 Mini-narrative

- [ ] **3.0 Shadow opportunity detection + "would-take" logging** (requires 1.0 + 2.0) — smoke: mandatory (`scripts/smoke-shadow-take.ts`)
  - [ ] 3.1 Create feature branch `feat/shadow-take-detection` from `main`
  - [ ] 3.2 Basis-adjusted edge (§11.4): `edgeBps = ((truexBid/pyusdUsd) − coinbaseBid)/coinbaseBid×10000 − fees − buffers`; reuse/extend `computeTakeEdgeBps`
  - [ ] 3.3 Detection step (on price/poll update): sell-take candidate when `truexEbbo.bestBid` adjusted-edge ≥ `minTakeEdgeBps`; size = `min(bestBidQty, balance-capped, maxPosition headroom, maxTakeNotionalPerOrder)`; inventory-reducing only (long)
  - [ ] 3.4 Corroboration guards (PB2): Coinbase-leg freshness/confidence; **multi-poll persistence** (N consecutive); **max-edge suspicion ceiling** (suppress + warn if edge > ceiling); **TrueX trade-tape recency/outlier** (best_bid not an outlier vs recent `last_trade`)
  - [ ] 3.5 Basis gate (PB1): suppress all detection if `pyusdUsd` stale/missing or `|pyusdUsd−1| > pyusdDepegThresholdBps`
  - [ ] 3.6 Dedup (FR16): key on `truexEbbo` `timestamp+bestBid+bestBidQty`; don't re-log unchanged snapshot
  - [ ] 3.7 Structured `would-take` log: side, size, truexPrice, rawEdgeBps, basisAdjEdgeBps, pyusdUsd, coinbaseFresh, truexTapeAgeS, dedupKey, suppressReason(if any)
  - [ ] 3.8 Fill/miss attribution: record whether the targeted bid disappears shortly after (TrueX's quoter likely took it) vs persists
  - [ ] 3.9 **HARD: no order dispatch** — detection returns/logs only; never calls `_sendNewOrder`/`fixConnection.sendMessage`
  - [ ] 3.10 Unit tests: edge math (basis), fires at/above threshold + not below, suppression (stale/low-conf Coinbase, stale truexEbbo, basis stale/depeg, edge>ceiling, tape-outlier), dedup, inventory-reducing-only, **assert zero sendMessage on the take path**
  - [ ] 3.11 Tests pass
  - [ ] 3.12 `/adversarial-reviewer` local (real-money-adjacent logic even though no sends — verify the no-send invariant holds on all branches)
  - [ ] 3.13 `/pre-push-review`
  - [ ] 3.14 Smoke (`scripts/smoke-shadow-take.ts`): synthetic dislocated book + fresh Coinbase + basis → asserts one would-take log with correct basis-adj edge AND zero FIX sends; second identical poll → deduped (no second log)
  - [ ] 3.15 `gh pr create`
  - [ ] 3.16 Solicit `@coderabbitai review` (re-tag at 5 min)
  - [ ] 3.17 `/pr-review-loop <PR#>`
  - [ ] 3.18 Merge after reviewer pass + CI green
  - [ ] 3.19 Pull `main`, validate; **do NOT deploy yet** (enabled in 4.0)
  - [ ] 3.20 Mini-narrative

- [ ] **4.0 Shadow enablement + smoke + analysis** (requires 3.0) — smoke: mandatory; CONFIG portion noted
  - [ ] 4.1 Create feature branch `feat/shadow-take-enable` from `main`
  - [ ] 4.2 `shadowTakeMode` config flag (default **false**); thresholds (`minTakeEdgeBps`, `maxEdgeCeilingBps`, `pyusdDepegThresholdBps`, `maxTakeNotionalPerOrder`, persistence N), poll interval — all configurable
  - [ ] 4.3 Wire flags through orchestrator → engine; when `shadowTakeMode` true, run detection+logging only
  - [ ] 4.4 Enable `shadowTakeMode: true` in `run-prod.js` (observe-only) with conservative thresholds
  - [ ] 4.5 `scripts/analyze-shadow-takes.js`: parse would-take logs → edge distribution, fill/miss rate, live PYUSD basis stats; output the Phase-2 go/no-go summary
  - [ ] 4.6 Unit tests: flag gating (off → no detection at all), config plumbing
  - [ ] 4.7 Tests pass
  - [ ] 4.8 `/adversarial-reviewer` local
  - [ ] 4.9 `/pre-push-review`
  - [ ] 4.10 Smoke: run with `shadowTakeMode` on against synthetic feed → would-take logs emitted, zero sends; off → nothing
  - [ ] 4.11 `gh pr create`
  - [ ] 4.12 Solicit `@coderabbitai review` (re-tag at 5 min)
  - [ ] 4.13 `/pr-review-loop <PR#>`
  - [ ] 4.14 `/docs-generator` (touches `scripts/` + `run-prod.js` → SO-13); docs PR through `/pr-review-loop`
  - [ ] 4.15 Merge after reviewer pass + CI green
  - [ ] 4.16 Pull `main`; deploy (rebuild + recreate); confirm shadow logs appear, **zero takes sent**, basis + edge values sane
  - [ ] 4.17 Run `analyze-shadow-takes.js` after a monitoring window; write findings + Phase-2 go/no-go recommendation into `memory/daily/<today>.md` and the PRD §11.5
  - [ ] 4.18 Mini-narrative

## Out of scope (Phase 2 — separate task list, gated on 4.17 data)
Sending real taker orders; IOC (`59=3`) execution + UAT verification + TTL guard; `_canTakeNow()` live gate; in-flight-aware sizing + never-go-short; separate taker order tracking + taker partial-fill branch; shared balance reservation; per-take + daily-loss kill-switch; STP/self-trade; buy-takes; multi-level sweeps.

## Adversarial review of this task list
- **No-send invariant** is made an explicit, tested sub-task in every parent (1.11, 2.9, 3.9/3.10/3.14, 4.10) — the executor cannot accidentally ship a live take.
- **Sequencing** enforced: 3.0 lists "requires 1.0+2.0 on main"; 4.0 requires 3.0; 3.19 explicitly says don't deploy until 4.0.
- **C3/FR17 regression** (feed-swap breaking maker guard) gets its own guard sub-task (1.6) and test.
- **Basis-never-assume-1** is structural: 2.3 defaults `pyusdUsd` to null, 3.5 suppresses on missing/stale — no silent =1.
- **Go/no-go is a deliverable** (4.5/4.17), so Phase 1 actually produces the decision data, not just logs.
- Simpler-alternative check: PYUSD basis can't be config-only (needs a live feed); detection can't be instruction-only. No parent is redundant.

---

## Pairing-Review Revisions (2026-06-18)

Two internal lenses (plan-completeness skeptic = REVISE; codebase-feasibility engineer = 2 false
assumptions). Amendments below override the task bodies above where they conflict.

### Feasibility corrections (false assumptions found)
- **R1 (task 0.0/3.4/3.7/3.8):** `/market/quote` has **no `last_trade` and no `order_count`** — the
  PB2 TrueX-tape recency/outlier guard has no data. Spike (0.0) must find a tape source or **drop
  the tape check** and rely on multi-poll persistence + `bid_qty` decay. Remove `truexTapeAgeS` from
  the log (3.7) unless 0.2 finds a source.
- **R2 (task 1.4):** add a `parseMarketQuote` helper (string→float, nanos `timestamp`); response is
  not pre-parsed. PRD §7 field list is inaccurate — trust 0.1's raw dump.
- **R3 (task 1.0/1.6):** the maker marketable/slide guard is **already inert in prod** (Coinbase
  adapter has no `getBestBidAsk`, so `truexBook` never populates). Adding `truexEbbo` is a safe
  additive field. Reword 1.6: assert the poll feeds **only** `truexEbbo` and does NOT wire into
  `truexBook`/`marketDataProvider` (guards against scope-creep, not a live regression). Engine side
  of 1.0 is small; the **poll loop + resilience (1.5) is the real work** (no existing pattern to copy).
- **R4 (task 2.0 — SPLIT):** no PYUSD-USD source exists; `PriceAggregator` is single-symbol. Split:
  **2.0a** stand up + verify a real PYUSD-USD feed (second `CoinbaseWsIngest` instance, or REST
  fallback if 0.3 shows no WS product) with its own freshness; **2.0b** plumb `pyusdUsd` setter +
  `_isPyusdBasisFresh()` into the engine (null-default). 2.0a is the hidden-size risk.
- **R5 (task 3.2):** do **not** modify `computeTakeEdgeBps` (it's on the live maker-adjacent path).
  Apply basis by passing `executionPrice = truexBid / pyusdUsd` (fairValue = coinbaseBid) — formula
  works unchanged.
- **R6 (task 3.0/3.9):** implement a **standalone `evaluateShadowTake()` method** that NEVER routes
  through `_prepareQuoteForSend`/`_sendNewOrder` (the only send sites: `_sendNewOrder:580`,
  `_sendCancel:619`). Phase 1 MUST NOT touch those functions. Detection returns a log record, not a
  dispatchable quote object.
- **R7 (task 3.0 trigger):** run `evaluateShadowTake` from the **`/market/quote` poll handler**
  (after `updateTruexEbbo`), reading a cached `this.lastAggregatedPrice` (add it in `onPriceUpdate`).
  Do NOT hang detection off `onPriceUpdate` (hot maker path, fires many times/sec).
- **R8 (task 3.6 dedup):** key on **`bestBid + bestBidQty`** (NOT `timestamp` — it changes every
  poll and would defeat dedup). Add a qty-decay tolerance so a partially-taken persisting order
  isn't re-logged each poll.

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
