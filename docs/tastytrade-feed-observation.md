# tastytrade read-only feed verification

The user authorized credentials from the sibling infinitrade .env file. The probe reads that file through Bun environment loading; it does not copy, display or alter credentials, and calls only OAuth and market-data/instrument endpoints.

A60second live DXLink observation on October26 authenticated, opened a feed channel and delivered198Quote events and247Trade last-state events acrossNVDA/TSLA. REST snapshots carried current updated-at timestamps and narrow bid/ask values. Streaming final quotes wereNVDA215.57/215.60 andTSLA394.73/394.78. Trade messages represent last-trade state, not independently deduplicated executions.

The authenticated token endpoint returned tasty-openapi-dxlink-md-ws.dxfeed.com, different from the documentation example. The probe initially rejected it; after inspecting that public hostname it was added as an explicit allowed TLS host. OAuth credentials remain limited to the official REST API; only the returned short-lived streamer token goes to dxFeed.

All received streaming Quote bidTime/askTime values were0. Receipt timestamps are retained separately. Connectivity and observed pricing are verified; exchange-side quote age, exact NBBO entitlement, quote-size unit conversion and fee applicability are not established by this test. Do not fabricate exchange timestamps or represent the stream as consolidatedSIP without supporting evidence.

Recommendation: use this existing account as the next source candidate, ahead of buying another subscription. Integration should preserve receipt-time provenance and handle missing exchange timestamps explicitly, or use the separately timestamped REST data as appropriate. No maincollector source switch was made by this probe.

Run from the feature worktree:

```bash
bun --env-file=/Users/kefentse/dev_env/infinitrade/.env scripts/smoke-tastytrade-market-data.ts --duration-seconds 60 --out logs/tastytrade-feed-check-next
```

Use a fresh output directory each run. Keep credentials out of command arguments, logs and tracked config. Raw market events and sanitized summary: logs/tastytrade-feed-check-2026-10-26. TypeScript check and Bunbuild passed. The probe is bounded and does not reconnect indefinitely.

Primary docs: [OAuth](https://developer.tastytrade.com/docs/authentication/oauth2/), [streaming](https://developer.tastytrade.com/docs/guides/stream-market-data/), [dxFeed Quote](https://docs.dxfeed.com/dxfeed/api/com/dxfeed/event/market/Quote.html).

A subsequent confirmation initially timed out after a probe change waited for field definitions before subscribing. Field definitions actually arrived after subscription. The ordering was corrected: subscribe once after initial FEED_CONFIG, then decode using subsequent field definitions. A fresh20second confirmation passed with71Quote/80Tradelaststate events and the same zeroquote timestamps. All outcomes are retained separately; failedattempt is not counted as successful observation.
