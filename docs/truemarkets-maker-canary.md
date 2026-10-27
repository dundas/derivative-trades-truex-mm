# Bounded NVDAC maker canary

User authorization on October 26: app account truemarkets@daviddundas.com, NVDAC-USDC only, 900 seconds, existing 10 USDC capital, 1 USDC marked-loss stop, no PYUSD conversion. Stop cancels owned orders and retains inventory. It does not guarantee a maximum realized loss. Ben's supplied message confirms this app account is enabled for equity trading; institutional wind-down work remains separate.

The runner `scripts/run-truemarkets-maker.ts` uses the existing authenticated client, durable account journal and controller. With `--live` it can submit real post-only orders. Without that flag it only observes and calculates quotes. A new output directory is required for each run. Configuration is the ignored `config/truemarkets-maker.local.json`; credentials remain in existing ignored env files. Config includes a short-lived account-eligibility confirmation and must not be silently extended into unattended future runs.

The approved canary uses 2 USDC maximum per order, 10 bps half-spread, up to 5 bps inventory skew, 0.04 maximum token inventory and 5-second cancellation/requote intervals. It polls tastytrade REST every 2 seconds, checks every loop and requires both source and receipt ages within 15 seconds. Initial cash must equal the configured capital and initial stock inventory must be zero. Fees, unsettled balances or foreign active orders cause rejection. Successful account reads do not imply permission to convert or transfer funds.

External-maker mode deliberately does not require a competing venue BBO. The venue WebSocket must stay connected and report the instrument active; REST instrument, market and account requests must succeed. Server-enforced ALO prevents crossing. Other execution callers retain the old BBO guard unless this mode is explicitly selected. User-approved share/token and USD/USDC parity is recorded as `mappingAssumption: market_parity`, not falsely marked as verified units.

Loss is marked using the external bid against the original 10 USDC. Quotes begin buy-only and add offers after actual inventory is acquired. Dust below venue minimum notional remains unquoted. All entries recheck deadline, enabled state and reference freshness after authentication immediately before dispatch. Missing/old/zero external timestamps never become fresh on receipt. Health failure stops the run instead of waiting indefinitely for recovery.

Startup allows 30 seconds to establish healthy inputs, then starts the 900-second window. If startup fails, the report says no run started. Shutdown cancels and polls journal-owned order status, including after ambiguous cancellation responses; unresolved cleanup is an explicit failure. Network failure/process death can prevent cancellation. Final balances are recorded when available, and final PnL is omitted if a fresh reference is unavailable. Nothing auto-liquidates or auto-resumes.

Example from this worktree:

```bash
TM_EXPECTED_CLIENT_ID=79059325798366905 bun \
  --env-file=/Users/kefentse/dev_env/true_markets_mm/.env.truemarkets.local \
  --env-file=/Users/kefentse/dev_env/infinitrade/.env \
  scripts/run-truemarkets-maker.ts --config config/truemarkets-maker.local.json --live
```

Local tests cover maker sizing, no shorting, capital/position/notional limits, exact loss-stop boundary, dust, ambiguous cancellation and unresolved cleanup, maker-mode book independence, stale external-reference rejection, and a token-refresh/deadline dispatch race. The runner is a local canary, not an unattended production service.

## Observed attempt

On October 27 at 01:23:31 UTC the explicitly authorized `--live` invocation attempted startup. It exited after the 30-second startup window because external NVDA pricing remained stale. The 15-minute trading window never began. Report: `logs/truemarkets-maker/2026-10-27T01-23-31-148Z/report.json`. Zero submitted/active orders; ending balance10USDC, zeroNVDAC and zeroholds. No conversion occurred and no process remains scheduled to resume. Validation:118tests/378assertions across8files; narrowTypeScriptcheck andBunbuild passed.

## Alpaca overnight reference

The runner also accepts `watch.referenceProvider: alpaca_overnight` with existing `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` environment values. It requests only `https://data.alpaca.markets/v2/stocks/NVDA/quotes/latest?feed=overnight`. Credentials are never sent to a configurable host or followed through redirects. No Alpaca account/order endpoints are used.

This requires explicit `policy.referenceTimeKind: alpaca_overnight_indicative` and a positive `policy.maxReferenceSpreadBps` no greater than25. The user approved this indicative reference for the bounded canary after its distinction from direct BOATS data was explained. It is not labelled NBBO or an executable hedge price. Quote timestamp `t` is preserved separately from receipt time; invalid, future and backward timestamps clear the quote. Stopped requests cannot restore feed state. Missing/old snapshots remain unavailable for execution.

The live integration exposed a separate contract correction: public CeFi GET `/v1/cefi/market/quote` returns a bare array, as its OpenAPI spec documents, rather than the paginated envelope used by account endpoints. The client and fixture now follow that endpoint-specific contract. No account-endpoint envelope checks were relaxed.

## Live execution and cancellation evidence

With Alpaca overnight selected, the first integration attempt stopped before dispatch on the market-array parsing issue. After that correction, a live bid0.009NVDAC@216.118 was accepted and canceled with zero fills. Cancellation changed the order response's `external_id` to`0` and placed the original UUID in`ref_external_id`; querying by clientUUID then returned404, while the known exchangeID returned the terminal canceled row. Reconciliation now falls back on404 to a previously observed numeric exchangeID, accepts the referenceUUID only with that same known exchangeID, and retains account/instrument/side/fill checks. Missing/mismatched IDs remain errors. Read-only reconciliation recovered the original journal without deleting it.

A second live attempt posted and canceled one further bid, then blocked a replacement before HTTP dispatch when entry health changed. Both accepted orders ended CANCELED with zero fills; account10USDC/0NVDAC/noholds/noactiveorders. The initial run's unresolved report is preserved as historical evidence; later successful reconciliation supersedes its unknown order status.

A follow-up read-only run at01:37:29–01:37:39UTC identified `external_spread_excessive`: indicative NVDA216.36/216.97, approximately28.2bps versus25bps configured maximum. No continuous15minute run completed. No restart scheduled and no spread/freshness limit relaxed. Evidence directories are under `logs/truemarkets-maker/2026-10-27T01-*`.

## Spread-aware quoting (supersedes the earlier 25 bps cutoff)

The user corrected the premise: this strategy supplies liquidity on a quiet venue. Reference spread is now a quote-width and size input, not an arbitrary hard stop. The canary rejects any configuration retaining `maxReferenceSpreadBps`. Its indicative-feed label and timestamp checks remain mandatory.

Bid = external bid minus configurable margin minus long-inventory skew. Ask = external ask plus margin minus skew, floored at the external ask. Current margin is10bps of reference midpoint, inventory skew up to5bps. Quotes round outward to venue ticks. Notional scales down with reference width, bounded by configured2USDCmaximum and the smallest tradable lot/minimum-notional combination. No short sales are introduced.

External-maker price validation now permits the full external bid/ask interval plus the configured deviation allowance on either side. This retains a fat-finger check without making wide references fail an implicit midpoint-spread cutoff. Legacy mode retains its midpoint band. Capital10USDC, lossstop1USDC,900seconds, source/receipt15sfreshness, healthytransport, account/order identity and terminal cancellation remain unchanged.

### Transient feed gaps within the bounded session

A spread-aware attempt submitted and canceled3bids with nofills, then stopped when the source timestamp aged past15seconds. The runner now cancels and confirms all owned quotes during transient feed-health failures, records `quotes_paused`, and resumes only when the same freshness checks pass. The original900second deadline keeps running while paused. Loss-stop, balance/settlement faults, uncertain order outcomes and failed cleanup still end the run. A typed pre-dispatch rejection proves no HTTP mutation occurred and may pause/resume; an unknown network outcome never does. This supersedes the earlier exit-on-any-feed-gap behavior, without changing freshness or money limits.

## Completed 15-minute live session

The revised runner completed its900-second session on October27,01:44:03.833–01:59:04.668UTC (including final cancellation). It submitted151post-only bids; all151ended CANCELED with zero executed quantity. Final marked PnL0USDC; cash10USDC, inventory0NVDAC, holds0, activeorders0. Ten feed-health pause/resume cycles preserved the original deadline. Observed reference spreads ranged0.461–26.307bps, including two quote plans above the removed25bps cutoff.

Evidence: `logs/truemarkets-maker/2026-10-27T01-44-02-746Z/report.json`, `summary.json`, `events.jsonl`, and the retained account order journal. This establishes bounded live bid placement, cancellation, repricing and cleanup. It does not establish customer demand, profit, or live two-sided fill handling. No restart is scheduled. Validation:131tests/421assertions, narrow TypeScript check and Bun build passed.
