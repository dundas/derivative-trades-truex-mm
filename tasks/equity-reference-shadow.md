# Equity reference and shadow-pricing module

Goal: provide Patrick a working, local, read-only module for observing Kraken NVDAx/USD and TSLAx/USD alongside True Markets NVDAC-USDC and TSLAC-USDC and calculating bounded shadow quotes only when normalization is verified.

Execution mode: direct (interactive fallback). Planning authority: user instructions in thread 01a15a8b-a217-7ad1-8c31-e4b925b3cd41. Implementation branch: feat/equity-reference-shadow. No changes to the existing live market maker.

## Acceptance

- Public feeds reconnect with bounded backoff, renew subscriptions, invalidate cached quotes on disconnect, and track source and receive timestamps separately. Missing, invalid, stale, or crossed prices suppress shadow proposals.
- Normalize source token units to target token units and USD to USDC with fresh, explicitly verified multiplier/contract mappings and rate inputs. Never default an unknown token multiplier to one. User steering on October26 explicitly permits USD/USDC parity as the research default; record that currency assumption and retain configurable live FX mode without silent fallback. Initial unverified mappings collect raw observations but produce suppression records.
- Configurable spreads, ticks, size, quote capital, and inventory limits. No order-entry, custody, or credential mutations. The module accepts inventory inputs but never assumes it can short.
- Durable append-only observations plus atomic status/coverage summaries. Coverage measures actual healthy sampling and gaps per symbol, not process uptime, and records market-session coverage in America/New_York.
- Tests cover disconnect/reconnect, malformed and stale data, normalization, inventory/capital caps, outward tick rounding, and persistence/restart behavior.
- Run a bounded local live smoke and publish actual results. A full 24-hour observation including open, close and overnight remains pending until collected; it is not a prerequisite to delivering the usable module and is required for a pilot recommendation.
- Run a pairing review every 15 minutes with two independent voices. Each review checks actual evidence, scope drift, overengineering, blockers and the next smallest useful action. Reviews write local artifacts, do not edit implementation or enable trading, and skip completed/user-paused work.

## Smallest implementation

Use Kraken public v2 BBO ticker (avoid implementing a second full L2 book) and True Markets public EBBO/instrument stream. Retain available size and source metadata. Build pure normalization/quote evaluation separately from socket lifecycle and recording. Reuse the existing Bun/ws environment. CLI: `bun scripts/run-equity-shadow.ts --config config/equity-shadow.example.json --duration-seconds 60 --out logs/equity-shadow/smoke`.

## Progress authority

`tasks/equity-reference-shadow.json` records task IDs, acceptance/evidence, dependencies, blockers and timestamps. Runtime status/coverage and tests provide evidence. Reviews store their recommendations separately to avoid racing the implementation ledger. A process being alive is not completion evidence.

## Exclusions and external gaps

No live orders, fund movements, borrowing, deployment, credential changes or messages to Patrick. WebSocket DROPCOPY currently rejects the documented client-ID format; FIX heartbeats omit TestReqID. Neither prevents a public, read-only collector. Token multiplier and contract equivalence must be verified before normalized shadow quotes; do not guess.

## User steering: research assumptions

The user subsequently authorized underlying-market parity as well as USD/USDC parity. Research may use explicit mapping.mode=market_parity with a1:1unit ratio; it must not claim verified equivalence. Connection, freshness, inventory and quote limits remain required. Assumed-unit proposals do not count as verified normalized evidence. Original raw observations retain their original configuration and interpretation.
