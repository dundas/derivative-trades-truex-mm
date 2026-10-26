---
name: truemarkets-api
description: Operate the local True Markets app-account REST execution module and read-only preflight using current auth, Gateway custody and CeFi APIs.
---

Use `docs/truemarkets-trading.md` for commands and recovery. The selected account is the user's app account, not the separate institutional deployment. Reuse an ignored env file with TM_KEY_FILE, TM_EXPECTED_USER_ID and explicitly confirmed TM_EXPECTED_CLIENT_ID. Never print keys/tokens or copy them into source.

Run `scripts/truemarkets-trading.ts preflight` first. Authentication uses raw ES256 r||s base64url; wallet stamps use DER hex in a base64url Turnkey envelope over exact original payload bytes. Live JWT client identity is under `tm.client_id`. CeFi uses `/v1/cefi`, current timestamp and version v2026_01_23; fees may be a single object under data. Follow opaque list cursors. Gateway allocation paths are `/custody/allocations` and `/custody/releases`; no automatic funding.

POST /orders is not a dry run: funded CeFi orders may submit immediately. Only `/v1/cefi/markets/quote` previews, with explicit qty_unit BASE. The command-driven controller supports bounded limit submit/replace, journal-owned cancellation and status reconciliation. Default execution is disabled. Preserve its journal and never replay uncertain writes. Account eligibility, verified units, live fresh external reference, fresh venue book and risk limits are prerequisites for entry. The one-minute observer is research data, not a continuously fresh scalping reference. FIX and WebSocket dropcopy readiness are separate unresolved issues.

`TradingRuntime` bridges existing tastytrade REST/provider-record timestamps and True Markets WebSocket BBO state. Use serialized runtime operations and a regular tick to cancel owned orders on unhealthy feeds or expired eligibility; await stop before releasing journal ownership. `watch-truemarkets-trading.ts` is a bounded watcher with zero strategy submissions; it is read-only by default. Live smoke recorded stale inputs, not healthy execution coverage.
