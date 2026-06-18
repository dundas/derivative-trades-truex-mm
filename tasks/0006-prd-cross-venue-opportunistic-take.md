# PRD 0006 — Cross-Venue Opportunistic Take

**Status:** Draft (adversarially reviewed)
**Author:** David (via Claude)
**Date:** 2026-06-18
**Related:** PR #32 (coinbase-mirror), #33 (partial-fill recording), #34 (venue-cancel logging); PRD 0005 (fee-aware quoting)

## 1. Introduction / Overview

The TrueX BTC-PYUSD market is illiquid and frequently dislocated from the broader market. Passive
Coinbase-mirror maker quoting is structurally blocked there: when a stale/mispriced order sits on
TrueX's book, our fair-value asks are "through the best bid," so TrueX rejects them as ALO
(post-only) — *"it would lock our market"* (Spencer, True Markets). Result: a one-sided (bid-only)
book and almost no maker spread capture.

The actual edge on a venue like this is **taking mispriced TrueX orders against a trusted
fair-value reference (Coinbase)**. True Markets' own quoter already does this — it took the same
stale order we were blocked by: `Opportunistic take: SELL 0.00004 @ 64719.5 (edge 129.3bps vs mid
63893.2)`.

This feature adds **opportunistic taking**: detect when a TrueX resting order is mispriced vs
Coinbase fair value by more than fees + a buffer, and take it with an IOC order to capture the edge.

## 2. Goals

1. Capture clear cross-venue dislocations (e.g. the 129 bps example) that passive quoting cannot.
2. Do so **without runaway risk**: bounded per-minute notional/order count, position-limit-aware,
   no take without a fresh, trusted fair value.
3. Reuse the existing taker execution machinery; build only the missing book-feed + detection.
4. Record every take fill accurately (enabled by #33 partial-fill recording).

**Non-goal of v1:** maximize capture. v1 is deliberately conservative; widen later once observed.

## 3. User Stories

- *As the desk operator,* I want the MM to automatically sell into a stale bid that's well above
  fair value, so we realize the dislocation instead of just being blocked by it.
- *As the desk operator,* I want opportunistic takes to be strictly bounded (edge threshold,
  per-minute caps, position limits), so a bad print or a stale fair value can't cause large loss.
- *As the desk operator,* I want every take logged with its edge, size, and price, so I can audit
  what it did and why.

## 4. Functional Requirements

### Book feed
1. The orchestrator MUST poll TrueX's real EBBO via REST `GET /api/v1/market/quote?instrument_id=<id>`
   and feed `best_bid`/`best_ask` (price **and** qty) into the QuoteEngine via `updateTrueXBook()`.
   This REPLACES the current behavior where `updateTrueXBook` is fed Coinbase data.
2. The feed MUST carry a timestamp; the engine MUST treat the TrueX book as stale beyond
   `truexBookStaleThresholdMs` and MUST NOT take against a stale book.
3. Poll interval MUST be configurable (default ~1000 ms) and MUST NOT exceed TrueX REST rate limits.

### Opportunity detection
4. On each fair-value update with a fresh TrueX book, the engine MUST evaluate take opportunities:
   - **Sell-take:** if `TrueX.best_bid > coinbaseRef` and `edgeBps >= minTakeEdgeBps`, emit a SELL
     taker quote at `TrueX.best_bid` (we sell into the high bid).
   - **Buy-take:** OUT OF SCOPE for v1 (see Non-Goals) — buying a cheap ask increases our long with
     no hedge.
5. **Fair-value reference = side-appropriate Coinbase touch** (decision 2b): a sell-take's edge is
   measured vs Coinbase **best bid** (the price we could exit/hedge at), not the mid. Edge:
   `edgeBps = (truexBid − coinbaseBid)/coinbaseBid × 10000 − truexTakerFeeBps − takeSlippageBufferBps − takeHedgeBufferBps`
   (reuses `computeTakeEdgeBps`; `executionPrice = truexBid`, `fairValue = coinbaseBid`).
6. A take MUST only fire when `edgeBps >= minTakeEdgeBps` (default **15**).
7. Take size MUST be `min(level qty available, balance-capped size, per-take notional cap)` and MUST
   respect `maxPositionBTC` and `getAvailableForSide`.
8. **Inventory-reducing only (v1):** sell-takes are allowed only while net position is long (they
   move us toward flat). When flat/short, no takes fire.

### Execution
9. Taker orders MUST be sent **IOC (`59=3`), not GTC** — *(SPIKED: `_sendNewOrder` currently
   hardcodes `59=1` and only drops the ALO flag; this is a required code change so an unfilled take
   does not rest as a maker order.)*
10. Taker orders MUST NOT carry the ALO ExecInst (`18=6`) — they intentionally take liquidity.
11. Takes MUST pass the existing `_prepareTakerQuote` gates (`allowTakerOrders`, edge, taker budget)
    and `_hasTakerBudget` (`maxTakerOrdersPerMinute`, `maxTakerNotionalPerMinute`).
12. Take fills MUST be recorded via `onExecutionReport` (full + partial — partial recording landed
    in #33) and counted in PnL with `truexTakerFeeBps` applied.

### Safety / gating
13. Takes MUST be suppressed when: Coinbase confidence < threshold or feed stale; TrueX book stale;
    `quotingSuspended`; within reject-backoff; or kill-switch engaged.
14. The kill-switch (`scripts/kill-switch.js`) MUST cancel/stop takes the same as maker orders.
15. Every take attempt and fill MUST log: side, price, size, edgeBps, fairValue — and suppressions
    MUST log the reason (reuse `_recordSuppression`).

## 5. Non-Goals (Out of Scope for v1)

- **Buy-takes** (taking cheap asks) — they grow our long with no hedge venue. Deferred until a hedge exists.
- **Hedge venue** (Kraken/Coinbase execution) — `krakenClient` stays null; tracked separately.
- **Multi-level sweeps** — v1 takes only the best level, not walking the book.
- **Maximizing capture / aggressive thresholds** — v1 is conservative by design.
- Changing the maker mirror logic — takes **coexist** with mirror maker quoting (decision 1a).

## 6. Design Considerations

- Coexists with the mirror maker (decision 1a): maker quotes keep posting; takes act on top when a
  dislocation appears. The two share balance/position state, so sizing MUST account for committed
  maker orders (don't double-commit).
- **Self-trade (SPIKED partial):** STP is supported by the REST client but the live order path is
  FIX, which does not currently set an STP tag. For inventory-reducing sell-takes (into high bids,
  e.g. ~$64.7k) vs our low maker bids (~$64k), prices don't cross, so self-trade risk is low. Open
  question: confirm FIX STP tag support and set it on takes as defense-in-depth.

## 7. Technical Considerations

**Already exists (validated this session — reuse, don't rebuild):**
- `_prepareTakerQuote`, `computeTakeEdgeBps`, `_hasTakerBudget`, `_recordTakerOrder`, taker window
  counters, `taker_opportunity` order intent, `liquidityRoleExpected` tracking.
- Config: `allowTakerOrders`, `minTakeEdgeBps`, `truexTakerFeeBps`, `takeSlippageBufferBps`,
  `takeHedgeBufferBps`, `maxTakerOrdersPerMinute`, `maxTakerNotionalPerMinute`,
  `truexBookStaleThresholdMs`, `marketDataProvider`.
- `/market/quote` REST endpoint (`getMarketQuote`) returns best_bid/best_ask with price, qty,
  order_count, last_update (validated: ~20 ms, fresh when market active).

**Must build:**
- Orchestrator: poll `/market/quote`, feed real TrueX book into `updateTrueXBook` (replacing the
  Coinbase feed into that method) — keep Coinbase as the fair-value source.
- QuoteEngine: opportunity-detection step that emits taker quotes; wire `executionPrice`/`fairValue`.
- `_sendNewOrder`: IOC (`59=3`) for taker orders (FR9).
- Prod config (`run-prod.js`): `allowTakerOrders: true`, `minTakeEdgeBps: 15`, `truexTakerFeeBps: 4`,
  `maxTakerNotionalPerMinute: 500`, `maxTakerOrdersPerMinute: 5`, take poll interval.

**Fees:** 0 maker / 4 bps taker (VKG). Account ~$6k (0.0134 BTC + ~$5.1k PYUSD). No hedge.

## 8. Rollout & Gates

Follows `.ai/protocols/STANDARD_DEV_WORKFLOW.md`. This is real-money taker execution, so:
- TDD; feature branch off `main` (never push to main).
- **4a `/adversarial-reviewer`** (mandatory — real-money order placement; not skippable).
- **4b `/pre-push-review`** (semgrep + roborev) before every push.
- **4c smoke** — engine logic + a take-detection smoke (synthetic dislocated book → asserts a
  correctly-sized IOC sell-take is emitted; and that no take fires when stale/low-confidence/flat).
- **4d** PR + `/pr-review-loop` (CodeRabbit), reviewer pass + CI green before merge. Never CI-only.
- **Deploy:** rebuild + recreate on Hetzner (`docker compose -f docker-compose.prod.yml up -d
  --no-deps --force-recreate market-maker`), backup prior file for rollback (as in #32–#34).
- **Post-deploy validation:** watch logs for take attempts/fills, confirm edge/size/limits behave,
  confirm no GTC taker order rests, watch `maxPosition` and per-minute caps.
- `/docs-generator` if `run-prod.js`/scripts or docs change materially.
- **Heads-up to VKG** before enabling — their quoter is in the same pool (we will race it).

## 9. Success Metrics

- At least one correctly-sized take captures a real dislocation (edge ≥ 15 bps) with the fill
  recorded in PnL — without breaching any per-minute or position cap.
- Zero GTC taker orders left resting (all takes are IOC).
- No take fired on a stale/low-confidence fair value (audited from suppression logs).
- Net PnL contribution from takes ≥ 0 over a monitored window (after the 4 bps taker fee).

## 10. Open Questions

1. **Edge reference precision:** is Coinbase best-bid the right exit proxy, or should we subtract an
   explicit `takeHedgeBufferBps` to model slippage when we eventually unwind? (v1: use 2b + a small buffer.)
2. **FIX STP:** does the TrueX FIX order support a self-trade-prevention tag? If yes, set it on takes.
3. **Polling cost:** is ~1 s `/market/quote` polling acceptable vs rate limits, or should we push for
   a FIX/websocket TrueX market-data feed instead of REST polling? (v1: REST poll; revisit.)
4. **Flat/short behavior:** v1 only sell-takes while long. Once a hedge exists, enable buy-takes and
   two-sided arb (separate PRD).
5. **Competition:** how often does TrueX's own quoter beat us to the take? Measure miss rate post-deploy.

---

### Adversarial Review & Revisions (per prd-writer)

- **SPIKED — IOC gap:** `_sendNewOrder` sends `59=1` (GTC) and only drops ALO for takers → a take
  would rest if unfilled. Added FR9 (taker = IOC `59=3`) and Success Metric "zero GTC takers resting."
- **SPIKED — fair value trust:** a take acts on Coinbase-vs-TrueX; a stale/wrong Coinbase feed → bad
  take. Added FR13 (confidence + staleness gate) and Success Metric (no take on stale fair value).
- **SPIKED — self-trade (partial):** STP exists in REST client, not on the FIX path; price
  separation makes risk low for inventory-reducing sell-takes. Logged as Design Consideration + Open Q2.
- **ASSUMPTION — TrueX book freshness:** taking a stale TrueX order is *safe-fail* (IOC simply
  doesn't fill if the order is gone); we lose nothing, just miss. No mitigation needed beyond FR2.
- **Scope challenge — should this exist at all?** Yes: passive maker capture is structurally blocked
  on this venue (validated: 120 ALO venue-cancels/2min), and the venue operator's own quoter profits
  by taking. Opportunistic taking is the demonstrated edge here. Kept, but bounded hard (v1 caps).
