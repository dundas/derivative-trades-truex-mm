# True Markets app-account execution module

Local implementation on `feat/truemarkets-trading-api`. This uses the app account selected by the user, not the separate institutional account or its stopped production container. No deployment or live order/funding mutation was performed.

## API choices

- Auth: ES256 API-key challenge at `/v1/auth/api-key/token`, refresh at `/v1/auth/token/refresh`. Tokens/private keys stay in memory. The live app JWT identifies the user at `uid` and the CeFi client at `tm.client_id`. Both are checked against explicit environment values before account access.
- Execution: direct `/v1/cefi/orders` REST calls, with `X-Truex-Version: v2026_01_23`, bearer token and current `x-truex-auth-timestamp`. Old `/api/v1` paths are not used by this module. List readers follow opaque cursors and reject incomplete/legacy responses.
- New Gateway APIs: stock catalog, availability, wallet balances and `/custody/allocations` / `/custody/releases`. The library has gated allocation/release primitives; these never run automatically and are not exposed by the execution CLI. Funding is an explicit separate operation, not a trading side effect.
- The existing True Markets WebSocket observer continues collecting venue data. This controller uses fresh REST book snapshots for pre-submit checks and REST status reads for authoritative reconciliation. It does not depend on the unresolved WebSocket DROPCOPY subscription.
- FIX is not the selected execution transport. Earlier logon/market-data tests succeeded, but strict TestRequest echo validation did not. No production FIX certification is claimed.

Primary references, checked October 26, 2026: [CeFi REST contract](https://docs.truemarkets.co/openapi/cefi-direct.yaml), [migration](https://docs.truemarkets.co/institutional/migrate-to-cefi-paths/), [Gateway contract](https://docs.truemarkets.co/openapi/gateway.yaml), [authentication and wallet stamps](https://docs.truemarkets.co/trading-api/requests-and-signing/).

The migration guide's HMAC example conflicts with the CeFi contract and the dedicated REST signing guide. This module uses the recommended JWT route and does not change the legacy HMAC client.

**A Gateway create-order call is not a safe dry run.** The current contract says funded CeFi orders can submit immediately, even though some narrative guides describe a sign-and-execute flow. Price previews use `/v1/cefi/markets/quote` with required `qty_unit: BASE`. Direct CeFi execution avoids smart routing and automatic bridge preparation.

## Read-only preflight

Run from this worktree. Reuse the ignored existing env file; do not copy or commit credentials. Set `TM_EXPECTED_CLIENT_ID` to the app account's confirmed CeFi client ID. That value is an identifier, not a secret.

```bash
TM_EXPECTED_CLIENT_ID=<confirmed-app-client-id> \
  bun --env-file=/Users/kefentse/dev_env/true_markets_mm/.env.truemarkets.local \
  scripts/truemarkets-trading.ts preflight \
  --config config/truemarkets-trading.example.json \
  --out logs/truemarkets-trading/preflight
```

Other required environment variables: `TM_KEY_FILE` and `TM_EXPECTED_USER_ID`. Endpoints and response schema are configured in JSON. The key file stays outside tracked source; invalid key-file errors are sanitized. Authentication, Gateway and CeFi must all use the same production/UAT environment. Redirects are refused.

Preflight makes GET account requests and auth-only POSTs. It reports country-based asset availability, clients, current fees, wallet balances, custody allocations, CeFi balances, active orders, recent trades and both instrument records. Trade history is the endpoint's bounded recent history, not lifetime accounting. Reports are private local files under ignored logs. Successful account reads are not permission to trade.

## Configuring execution

Copy the example to an ignored local config, for example `config/truemarkets-trading.local.json`. The example is disabled. Price/size increments and limits are configurable, not inferred from matching prices. The included stock increment examples follow the current 10–999.999 price bucket; a changed bucket needs a reviewed policy update.

Entry validation requires:

- `policy.enabled: true` and a future `eligibleUntil` recording confirmed account eligibility. The project has a separate US wind-down notice; a permissive country availability response alone does not resolve account eligibility through that notice.
- A verified per-instrument token/share conversion, configured `referenceSymbol`, `tokenToShareRatio` and `usdToUsdc`. The research module's user-approved 1:1 assumptions are not promoted into verified trading units automatically.
- Fresh external bid/ask source and receipt timestamps, a fresh venue book, active instrument and matching asset IDs. No timestamp is invented for tastytrade streaming quotes that returned zero bid/ask times.
- Exact decimal tick/lot alignment, minimum/maximum order notional, a price band around the converted external midpoint, maximum position and account-wide open-order caps.
- Available CeFi funds after order/transfer holds and quote fee reserves. Existing resting buys count toward the position cap. Sells require held base assets; no shorting.

The example caps each order at 2 USDC. These are initial configuration limits, not a recommendation to trade. Only limit orders are supported; default GTC uses ALO/post-only and self-trade prevention. IOC requires explicit `postOnly: false`. Market orders, perpetuals, automatic transfers and hedges are outside this execution module.

Replacement is conservative: it requires the full replacement's funds to be available, without assuming the exchange will release the existing hold. It preserves instrument, side, TIF and post-only mode. No new exposure is allowed while an owned order has an uncertain or pending state.

## Feed bridge and watchdog

`TradingRuntime` connects the existing tastytrade adapter's quotes and True Markets WebSocket state to the controller. Strategies call `runtime.submit(signal)` without supplying or inventing reference timestamps. Runtime operations are serialized. Entries require healthy source/venue BBOs, active instruments and the accepted `provider_updated_at` source timestamp kind. While enabled, watchdog ticks cancel journal-owned orders on unhealthy feeds or expired eligibility; graceful shutdown drains an in-flight operation and requests owned cancellation. Unresolved cancellation remains an error requiring reconciliation.

The bounded watcher runs this machinery without a strategy and submits zero strategy orders:

```bash
TM_EXPECTED_CLIENT_ID=<confirmed-app-client-id> \
  bun --env-file=/Users/kefentse/dev_env/true_markets_mm/.env.truemarkets.local \
  --env-file=/Users/kefentse/dev_env/infinitrade/.env \
  scripts/watch-truemarkets-trading.ts --duration-seconds 60
```

Default `policy.enabled=false` makes it read-only. It checks health once per second while preserving the configured one-minute tastytrade polling cadence. Faster polling is configurable for a future execution test; no existing observer was changed. A one-minute reference with a 15-second freshness gate will deliberately block entries through most of each minute.

A 20-second read-only live smoke completed 20 watchdog ticks with zero errors and zero orders. It recorded zero fully healthy ticks because venue quote ages, and later reference ages, exceeded the freshness limit. This verifies fail-closed plumbing, not healthy execution conditions or market-data suitability for scalping.

## Commands and strategy boundary

A strategy supplies an `OrderIntent` to `ExecutionController.submit()` or a JSON file to the CLI. The external reference is a validated input from a feed adapter; this CLI does not fetch the external stock quote itself. The existing one-minute research samples usually exceed the 15-second freshness limit between checks and cannot be treated as a continuously valid scalping reference.

Example input shape (timestamps must be actual current observations, not these placeholders):

```json
{
  "symbol": "NVDAC-USDC",
  "side": "BUY",
  "qty": "0.005",
  "price": "214.000",
  "tif": "GTC",
  "postOnly": true,
  "reference": {
    "symbol": "NVDA",
    "bid": "213.99",
    "ask": "214.01",
    "sourceAt": 0,
    "receivedAt": 0,
    "tokenToShareRatio": "1",
    "usdToUsdc": "1"
  }
}
```

After separately confirming the account, units and a live canary, commands use the same env/config prefix as preflight:

```bash
bun scripts/truemarkets-trading.ts preview --config config/truemarkets-trading.example.json --symbol NVDAC-USDC --side BUY --qty 0.005
bun scripts/truemarkets-trading.ts submit --config config/truemarkets-trading.local.json --input /path/to/fresh-intent.json
bun scripts/truemarkets-trading.ts replace --config config/truemarkets-trading.local.json --id <owned-external-id> --input /path/to/fresh-intent.json
bun scripts/truemarkets-trading.ts reconcile --config config/truemarkets-trading.local.json
bun scripts/truemarkets-trading.ts cancel --config config/truemarkets-trading.local.json --id <owned-external-id>
bun scripts/truemarkets-trading.ts cancel-owned --config config/truemarkets-trading.local.json
```

`cancel` and `cancel-owned` are explicit risk-reduction commands and remain available when entry enablement/eligibility gates are closed. They require the same account and journal, and cannot target foreign orders. Cancellation acknowledgement can be pending; reconcile until terminal and retain any intervening fills. `cancel-owned` attempts every owned open/uncertain order even if one cancellation fails. There is no account-wide cancel-all command here.

The individual submit/replace CLI commands are command-driven: GTC orders can remain resting after a command exits. A continuously running strategy must use the runtime watchdog, reconcile before resuming and await shutdown. The watchdog cancels during process operation; a process crash or network outage cannot guarantee server-side cancellation. No unattended strategy is enabled or deployed.

## Recovery

One writer per configured journal directory. Each external order ID is a UUID, with a durable intent written and fsynced before the HTTP mutation. Responses are checked for client/instrument/side identity and non-regressing cumulative execution quantity. Journal scope includes endpoint and account. Preserve the journal: it defines which orders this module owns.

A timeout, 401, conflict, malformed acknowledgement or server error never causes a mutation replay. Reconcile by the saved external ID. A 404 does not prove an uncertain submission never reached the exchange. For an uncertain replacement/cancel, an old ACTIVE snapshot is not proof that the mutation completed. Definitive rejects can require operator inspection; uncertainty deliberately blocks further entry.

A malformed/truncated journal blocks recovery. An existing `execution.lock` blocks another writer. After a crash, inspect the lock's PID and process identity and confirm there are no surviving writers before removing only the stale lock; preserve `orders.jsonl`. Never delete the journal to bypass an unresolved order. Recovery after a corrupt tape requires reconciling the recorded IDs and account orders before a reviewed repair.

## Validation and remaining work

The live read-only preflight passed all eleven account checks, including recent trades after handling the observed nested JWT client claim and single-object fee envelope. It confirmed 10 USDC on the selected CeFi account, no active orders, both stock listings active, and zero current maker/taker fee rates. The availability response was US with stock/spot allowed at the check time. A real `/markets/quote` preview for 0.005 NVDAC also succeeded, returning price, executable notional and residual without creating an order. No order/funding mutation was attempted.

The focused suite passed 101 tests/335 assertions across seven files; the new trading module accounts for 44 tests. Narrow TypeScript checking of the trading libraries and Bun builds of both CLIs passed. Offline tests exercise signing formats, refresh/account guards, schema/cursors, disabled writes, create/replace/cancel, partial fills, crash/timeout recovery and risk rejection. They use generated test keys and a simulated exchange; they do not prove live write permissions or real matching behavior. Before any live canary: resolve account eligibility and token units, connect a trustworthy streaming external reference with valid timestamps, and confirm the exact proposed order and limits. No strategy profitability or production readiness is claimed.
