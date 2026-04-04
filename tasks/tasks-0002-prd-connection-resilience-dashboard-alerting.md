# Task List: Connection Resilience, Status Dashboard & Alerting

**Source PRD:** `tasks/0002-prd-connection-resilience-dashboard-alerting.md`
**Generated:** 2026-04-03

---

## Relevant Files

### New Files to Create

**Alerts:**
- `src/alerts/alert-manager.js` — Slack/email/SMS alert service with deduplication and cooldown
- `src/alerts/alert-manager.test.js` — Unit tests (15+ assertions)

**Dashboard:**
- `src/api/dashboard.html` — Static status dashboard, auto-refreshes every 5s

### Existing Files to Modify

- `src/fix-protocol/fix-connection.js` — Sequence persistence, unlimited reconnect, backoff jitter, gap-fill, stable-reset
- `src/core/market-maker-orchestrator.js` — Watchdog loop, dual-session gate, MD staleness cancel, alert integration, `getHealthStatus()` method
- `src/api/server.js` — Enhanced `/health`, new `/api/status`, new `GET /` dashboard route, alert-manager integration
- `docker-compose.prod.yml` — Add healthcheck for market-maker service
- `.env` / `.env.example` — Document new env vars

---

## Commit & PR Strategy

### Commit Frequency
- Small commits after each logical unit (one feature + test)
- Format: `type(scope): description`

### PR Strategy
- **One PR per parent task** (6 PRs total)
- PR naming: `feat(resilience): Phase N — <name>`
- Merge: squash merge to main

### PR Dependencies
- PR 1 (Task 1.0) → can start immediately
- PR 2 (Task 2.0) → depends on PR 1
- PR 3 (Task 3.0) → depends on PR 2
- PR 4 (Task 4.0) → depends on PR 3
- PR 5 (Task 5.0) → depends on PR 3 (parallel with PR 4)
- PR 6 (Task 6.0) → depends on PR 5

---

## Tasks

### 1.0 Sequence Number Persistence
**Agent:** `reliability-engineer`
**PR:** `#1 — Phase 1: Sequence Number Persistence`
**Effort:** Small
**Depends on:** none

Persist `msgSeqNum` (outbound) and `expectedSeqNum` (inbound) to Redis on every message so process restarts resume with correct sequence numbers instead of resetting to 1 and triggering exchange rejection.

- [ ] **1.1** Add Redis sequence persistence to FIXConnection constructor
  - **File:** `src/fix-protocol/fix-connection.js` (modify)
  - **Action:** In constructor, accept optional `redisClient` parameter. Add `_seqKey = fix:seq:${sessionId}:out` and `_expectedSeqKey = fix:seq:${sessionId}:in`. Add `async loadSequenceNumbers()` method that reads from Redis and sets `this.msgSeqNum` and `this.expectedSeqNum`. Call at start of `connect()` before logon (after line 181).
  - **Test:** `src/fix-protocol/fix-connection.test.js` — 3 assertions: loads from Redis on connect, defaults to 1 when key missing, uses correct Redis key format
  - **Commit:** `feat(fix): load sequence numbers from Redis on connect`
  - **Agent:** `reliability-engineer`

- [ ] **1.2** Persist outbound sequence number on every send
  - **File:** `src/fix-protocol/fix-connection.js` (modify)
  - **Action:** In `sendMessage()`, after incrementing `msgSeqNum` (line 472), call `this.redisClient?.set(this._seqKey, this.msgSeqNum)`. Fire-and-forget (no await — must not block message sending).
  - **Test:** `src/fix-protocol/fix-connection.test.js` — 2 assertions: Redis set called after send, not called when redisClient is null (backward compat)
  - **Commit:** `feat(fix): persist outbound seqnum to Redis after each send`
  - **Agent:** `reliability-engineer`

- [ ] **1.3** Persist inbound expected sequence on every receive
  - **File:** `src/fix-protocol/fix-connection.js` (modify)
  - **Action:** In `validateSequence()` (line ~564), after updating `expectedSeqNum`, call `this.redisClient?.set(this._expectedSeqKey, this.expectedSeqNum)`. Fire-and-forget.
  - **Test:** `src/fix-protocol/fix-connection.test.js` — 2 assertions: Redis set called after sequence advance, not called on duplicate/gap detection
  - **Commit:** `feat(fix): persist inbound expected seqnum to Redis`
  - **Agent:** `reliability-engineer`

- [ ] **1.4** Pass Redis client from Orchestrator to FIXConnection
  - **File:** `src/core/market-maker-orchestrator.js` (modify)
  - **Action:** In constructor (lines 24-139), pass `redisClient: this.redis` in the FIXConnection options object when constructing `this.fixOE`. Ensure the Redis client instance is accessible on `this`.
  - **Test:** Integration test — verify `fixOE` has Redis client reference
  - **Commit:** `feat(orchestrator): wire Redis client into FIXConnection for seq persistence`
  - **Agent:** `reliability-engineer`

- [ ] **1.5** Create PR #1 and merge
  - **Action:** Create PR, run `bun test`, check 0 regressions, squash merge
  - **Agent:** Manual

---

### 2.0 Unlimited Reconnect + Backoff Improvements
**Agent:** `reliability-engineer`
**PR:** `#2 — Phase 2: Unlimited Reconnect + Backoff`
**Effort:** Small
**Depends on:** PR #1

Remove the hard 10-attempt reconnect cap. Replace with unlimited retries that emit an alert at 10 attempts. Add ±20% jitter. Reset backoff after 60s stable connection. Add GapFill for stale app message resends.

- [ ] **2.1** Remove hard reconnect cap, add alert-at-threshold
  - **File:** `src/fix-protocol/fix-connection.js` (modify)
  - **Action:** In `attemptReconnect()` (line 882), remove the `throw` on max attempts. Instead, when `reconnectAttempts >= maxReconnectAttempts`, emit `'reconnect-threshold'` event (not `'max-reconnect-attempts'`) and continue retrying. Add `MAX_RECONNECT_ALERT_THRESHOLD = 10` constant. Keep the same exponential backoff schedule but cap delay at `maxReconnectDelay` (30s).
  - **Test:** `src/fix-protocol/fix-connection.test.js` — 3 assertions: no error thrown at attempt 10, emits 'reconnect-threshold' at 10, continues attempting at 11+
  - **Commit:** `feat(fix): remove reconnect hard cap, emit alert threshold at 10 attempts`
  - **Agent:** `reliability-engineer`

- [ ] **2.2** Add ±20% jitter to reconnect delay
  - **File:** `src/fix-protocol/fix-connection.js` (modify)
  - **Action:** In `attemptReconnect()` backoff calculation (lines 897-900), after computing `delay = min(initialDelay * 2^(attempt-1), maxDelay)`, apply `jitter = delay * (0.8 + Math.random() * 0.4)` (±20%). Use `jitter` as the actual timeout value.
  - **Test:** `src/fix-protocol/fix-connection.test.js` — 2 assertions: delay is within ±20% of base, different calls produce different delays
  - **Commit:** `feat(fix): add ±20% jitter to reconnect backoff delay`
  - **Agent:** `reliability-engineer`

- [ ] **2.3** Reset backoff after 60s stable connection
  - **File:** `src/fix-protocol/fix-connection.js` (modify)
  - **Action:** In `connect()`, after successful logon ack (when `isLoggedOn` becomes true), start a `_stableTimer = setTimeout(() => { this.reconnectAttempts = 0; }, 60000)`. Clear this timer in `handleDisconnect()`. This prevents a brief drop from resetting the counter too eagerly.
  - **Test:** `src/fix-protocol/fix-connection.test.js` — 2 assertions: counter resets after 60s stable, timer cleared on disconnect
  - **Commit:** `feat(fix): reset reconnect counter after 60s stable connection`
  - **Agent:** `reliability-engineer`

- [ ] **2.4** Use GapFill for stale application message resends
  - **File:** `src/fix-protocol/fix-connection.js` (modify)
  - **Action:** In the `ResendRequest` handler (wherever `35=2` is processed), when responding to a resend request, check message type. For application-layer messages (35=D, 35=F, 35=G, 35=q), respond with `SequenceReset-GapFill (35=4, GapFillFlag=Y)` spanning those sequence numbers instead of retransmitting. Only retransmit session-layer messages (35=A, 35=5) if needed.
  - **Test:** `src/fix-protocol/fix-connection.test.js` — 3 assertions: GapFill sent for order messages, correct NewSeqNo in GapFill, session messages retransmitted normally
  - **Commit:** `feat(fix): respond to ResendRequest with GapFill for stale app messages`
  - **Agent:** `reliability-engineer`

- [ ] **2.5** Create PR #2 and merge
  - **Action:** Create PR, run `bun test`, squash merge
  - **Agent:** Manual

---

### 3.0 Quoting Watchdog + Dual-Session Gate + MD Staleness Cancel
**Agent:** `reliability-engineer`
**PR:** `#3 — Phase 3: Watchdog + Session Gate + MD Staleness`
**Effort:** Large
**Depends on:** PR #2

This is the core safety feature. Gate quoting on both sessions logged on. Cancel all orders on MD staleness. Watchdog loop detects "connected but not quoting" and triggers recovery.

- [ ] **3.1** Add dual-session gate — block quoting unless both OE + MD logged on
  - **File:** `src/core/market-maker-orchestrator.js` (modify)
  - **Action:** Add `_quotingGateEnabled` boolean (default false). Add `_checkQuotingGate()` method: returns true only if `this.fixOE.isLoggedOn && this.marketDataFeed?.isLoggedOn !== false`. In `_onPriceUpdate()`, call `_checkQuotingGate()` before dispatching to QuoteEngine — if false, skip and log `[WATCHDOG] Quoting gate closed: <reason>`. Listen for `fixOE 'connect'`/`'disconnect'` and MD equivalent events to update gate state and call `_onGateChange()`.
  - **Test:** `src/core/market-maker-orchestrator.test.js` — 4 assertions: quotes blocked when OE disconnected, quotes blocked when MD disconnected, quotes unblocked when both connected, gate change logged
  - **Commit:** `feat(orchestrator): dual-session gate blocks quoting until both FIX sessions logged on`
  - **Agent:** `reliability-engineer`

- [ ] **3.2** Cancel all orders on MD feed staleness
  - **File:** `src/core/market-maker-orchestrator.js` (modify)
  - **Action:** Track `_lastMdUpdateTime = 0`. Update in `_onPriceUpdate()`. Add `_checkMdStaleness()` that compares `Date.now() - _lastMdUpdateTime` against `MD_STALE_THRESHOLD_MS` (env var, default 10000). On stale: (1) cancel all orders via REST (`this.restClient.cancelAllOrders()` or `cancelOrphanedOrders()`), (2) set `_quotingGateEnabled = false`, (3) log `[WATCHDOG] MD feed stale — cancelled all orders`. Read `MD_STALE_THRESHOLD_MS` from env with 10000ms default.
  - **Test:** `src/core/market-maker-orchestrator.test.js` — 4 assertions: cancel called when MD stale, gate closed on stale, gate reopens after fresh MD, threshold configurable via env
  - **Commit:** `feat(orchestrator): cancel all orders and gate quoting on MD staleness`
  - **Agent:** `reliability-engineer`

- [ ] **3.3** Add 30s watchdog loop
  - **File:** `src/core/market-maker-orchestrator.js` (modify)
  - **Action:** In `start()` after existing timers (around line 210), add `this._watchdogTimer = setInterval(() => this._runWatchdog(), 30000)`. Implement `_runWatchdog()`:
    1. Check OE FIX: `this.fixOE.getState().isLoggedOn` → if false >2min, emit alert
    2. Check MD FIX: `this.marketDataFeed?.getState()?.isLoggedOn` → if false >2min, emit alert
    3. Check MD freshness: call `_checkMdStaleness()`
    4. Check quoting idle: if `Date.now() - this._lastRepriceTime > QUOTING_IDLE_THRESHOLD_MS` (env, default 120000) AND `isRunning` AND balances are non-zero → emit alert
    Clear timer in `stop()`. Add `_lastRepriceTime` tracking in `_onPriceUpdate()`.
  - **Test:** `src/core/market-maker-orchestrator.test.js` — 5 assertions: watchdog fires on 30s interval, alert emitted on OE disconnect, alert emitted on MD stale, alert emitted on quoting idle, no alert when balances zero
  - **Commit:** `feat(orchestrator): 30s watchdog loop for connection and quoting health`
  - **Agent:** `reliability-engineer`

- [ ] **3.4** Add `getHealthStatus()` method to Orchestrator
  - **File:** `src/core/market-maker-orchestrator.js` (modify)
  - **Action:** Add `getHealthStatus()` method returning:
    ```js
    {
      status: 'healthy' | 'degraded' | 'unhealthy',
      quoting: boolean,
      lastRepriceAge: number,  // ms since last reprice
      oeConnected: boolean,
      mdConnected: boolean,
      lastMdAge: number,       // ms since last MD update
      activeOrders: number,
      position: object,
      balances: object,
      lastFill: object | null,
      pnl: object,
      uptime: number,
      sessionId: string
    }
    ```
    Status logic: `healthy` = quoting + both connected + lastRepriceAge < 120s. `degraded` = not quoting but reconnecting (<2min down). `unhealthy` = not quoting >2min OR either session down >2min.
  - **Test:** `src/core/market-maker-orchestrator.test.js` — 5 assertions: healthy when all good, degraded within 2min, unhealthy after 2min, correct field shapes, handles null marketDataFeed
  - **Commit:** `feat(orchestrator): add getHealthStatus() for API and Docker healthcheck`
  - **Agent:** `reliability-engineer`

- [ ] **3.5** Expose Orchestrator instance to API server
  - **File:** `src/api/server.js` (modify)
  - **Action:** The API server currently has no reference to the live Orchestrator. Add an `orchestrator` parameter to `startApiServer(db, options)` (already called from `scripts/run-prod.js`). Store as module-level `let orchestratorRef = null` set on startup. `getHealthStatus()` calls fall back gracefully to `{ status: 'unknown' }` when `orchestratorRef` is null.
  - **Test:** `src/api/server.test.js` — 2 assertions: orchestratorRef set correctly, graceful null fallback
  - **Commit:** `feat(api): accept orchestrator reference for live health status`
  - **Agent:** `tdd-developer`

- [ ] **3.6** Create PR #3 and merge
  - **Action:** Create PR, run full `bun test` suite, squash merge
  - **Agent:** Manual

---

### 4.0 Alert Manager (Slack + Email + SMS)
**Agent:** `tdd-developer`
**PR:** `#4 — Phase 4: Alert Manager`
**Effort:** Medium
**Depends on:** PR #3

New `src/alerts/alert-manager.js` — fire-and-forget alerts to Slack, Gmail SMTP, and Telnyx SMS. Deduplication/cooldown. Wire into Orchestrator watchdog.

- [ ] **4.1** Create AlertManager class with Slack support
  - **File:** `src/alerts/alert-manager.js` (create)
  - **Action:** `AlertManager` class with constructor accepting `{ slackWebhookUrl, alertEmail, alertPhone, telnyxApiKey, telnyxFromNumber, cooldownMs }`. Implement `async sendAlert({ reason, level, details })` and `async sendRecovery({ reason })`. Implement Slack via `fetch` POST to webhook. Include reason, level, position, balances in message. Store `_lastAlertTime` per reason key for deduplication. Skip if `Date.now() - _lastAlertTime[key] < cooldownMs` (default 600000ms).
  - **Test:** `src/alerts/alert-manager.test.js` — 5 assertions: Slack POST called with correct payload, deduplication skips second alert within cooldown, different reasons not deduplicated, recovery sends correctly, graceful on missing webhook URL
  - **Commit:** `feat(alerts): AlertManager with Slack support and cooldown deduplication`
  - **Agent:** `tdd-developer`

- [ ] **4.2** Add Gmail SMTP email support
  - **File:** `src/alerts/alert-manager.js` (modify)
  - **Action:** Add `_sendEmail(subject, body)` using `nodemailer` (already available or add via `bun install nodemailer`). Configure transporter with `GMAIL_USER` / `GMAIL_USER_PASS`. Send to `ALERT_EMAIL` env var. Fall back gracefully if creds missing. When derivative.email is provisioned by circleinbox, swap `ALERT_EMAIL` to that address — no code change needed.
  - **Test:** `src/alerts/alert-manager.test.js` — 3 assertions: nodemailer sendMail called with correct args, graceful skip when GMAIL_USER missing, subject includes alert reason
  - **Commit:** `feat(alerts): add Gmail SMTP email alerting`
  - **Agent:** `tdd-developer`

- [ ] **4.3** Add Telnyx SMS support
  - **File:** `src/alerts/alert-manager.js` (modify)
  - **Action:** Add `_sendSms(message)` using Telnyx REST API via `fetch`. POST to `https://api.telnyx.com/v2/messages` with `Authorization: Bearer ${TELNYX_API_KEY}`, body `{ from: TELNYX_FROM_NUMBER, to: ALERT_PHONE, text: message }`. SMS message should be concise: `[TrueX MM] ALERT: ${reason} | pos=${position} | ${timestamp}`. Graceful skip if env vars missing.
  - **Test:** `src/alerts/alert-manager.test.js` — 4 assertions: fetch called with correct Telnyx endpoint, Authorization header set, SMS text is concise (<160 chars), graceful skip when TELNYX_API_KEY missing
  - **Commit:** `feat(alerts): add Telnyx SMS alerting`
  - **Agent:** `tdd-developer`

- [ ] **4.4** Wire AlertManager into Orchestrator watchdog
  - **File:** `src/core/market-maker-orchestrator.js` (modify)
  - **Action:** In constructor, instantiate `this.alertManager = new AlertManager({ slackWebhookUrl: process.env.DEFAULT_SLACK_WEBHOOK_URL, alertEmail: process.env.ALERT_EMAIL, alertPhone: process.env.ALERT_PHONE, telnyxApiKey: process.env.TELNYX_API_KEY, telnyxFromNumber: process.env.TELNYX_FROM_NUMBER })`. In `_runWatchdog()`, when a check fails call `this.alertManager.sendAlert(...)`. When quoting resumes after a halt, call `this.alertManager.sendRecovery(...)`.
  - **Test:** `src/core/market-maker-orchestrator.test.js` — 3 assertions: alertManager.sendAlert called on watchdog failure, sendRecovery called on resume, alert not sent when suppressed (zero balances)
  - **Commit:** `feat(orchestrator): wire AlertManager into watchdog for Slack/email/SMS`
  - **Agent:** `tdd-developer`

- [ ] **4.5** Create PR #4 and merge
  - **Action:** Create PR, run `bun test`, squash merge
  - **Agent:** Manual

---

### 5.0 Status API Endpoint + Dashboard HTML
**Agent:** `tdd-developer`
**PR:** `#5 — Phase 5: Status Dashboard`
**Effort:** Medium
**Depends on:** PR #3

New `/api/status` JSON endpoint + static `dashboard.html` served at `GET /`. Auto-refreshes every 5s.

- [ ] **5.1** Add `/api/status` endpoint
  - **File:** `src/api/server.js` (modify)
  - **Action:** Add `GET /api/status` route (no auth required — internal tool). Calls `orchestratorRef?.getHealthStatus()`, merges with DB stats from `handleStats()`. Returns full JSON snapshot matching FR-3.6 shape. Add to router in the GET block (after line 884). Return `{ status: 'unknown', message: 'Orchestrator not connected' }` when `orchestratorRef` is null.
  - **Test:** `src/api/server.test.js` — 4 assertions: returns 200 with correct shape, status field is healthy/degraded/unhealthy, graceful when orchestrator null, includes all required fields
  - **Commit:** `feat(api): add /api/status endpoint with live orchestrator health`
  - **Agent:** `tdd-developer`

- [ ] **5.2** Enhance `/api/v1/health` to include quoting status
  - **File:** `src/api/server.js` (modify)
  - **Action:** Update `handleHealth()` to call `orchestratorRef?.getHealthStatus()` and merge the result. Return shape per FR-2.4: `{ status, quoting, lastRepriceAge, oeConnected, mdConnected, lastMdAge, database: { connected, latencyMs } }`. HTTP status 200 for healthy/degraded, 503 for unhealthy.
  - **Test:** `src/api/server.test.js` — 3 assertions: 200 when healthy, 503 when unhealthy, correct quoting fields present
  - **Commit:** `feat(api): enhance /health to include quoting and connection status`
  - **Agent:** `tdd-developer`

- [ ] **5.3** Create dashboard HTML
  - **File:** `src/api/dashboard.html` (create)
  - **Action:** Single-file HTML dashboard. Dark theme (`#0d1117` bg, `#58a6ff` accent, monospace). Sections: System Status (large status indicator dot + quoting active/halted badge), Connections (OE FIX / MD FIX state), Position & Balances, Active Orders table, Last Fill, PnL summary, Recent Alerts (last 5). Auto-refresh via `setInterval(() => fetch('/api/status').then(r => r.json()).then(updateUI), 5000)`. No external dependencies — vanilla JS + inline CSS only. Show `Last updated: <timestamp>` footer.
  - **Test:** Manual visual verification
  - **Commit:** `feat(api): add status dashboard HTML`
  - **Agent:** `tdd-developer`

- [ ] **5.4** Serve dashboard at `GET /`
  - **File:** `src/api/server.js` (modify)
  - **Action:** Add `GET /` route that returns `Bun.file('./src/api/dashboard.html')` with `Content-Type: text/html`. Add before the existing route fallback. Also serve at `GET /dashboard` as an alias.
  - **Test:** `src/api/server.test.js` — 2 assertions: GET / returns HTML, Content-Type is text/html
  - **Commit:** `feat(api): serve dashboard HTML at GET /`
  - **Agent:** `tdd-developer`

- [ ] **5.5** Create PR #5 and merge
  - **Action:** Create PR, run `bun test`, verify dashboard loads in browser via SSH tunnel, squash merge
  - **Agent:** Manual

---

### 6.0 Docker Healthcheck Update + Env Vars
**Agent:** `tdd-developer`
**PR:** `#6 — Phase 6: Docker Healthcheck + Env Docs`
**Effort:** Small
**Depends on:** PR #5

Update the market-maker Docker healthcheck to probe `/health` and fail on unhealthy status. Document new env vars in `.env.example`.

- [ ] **6.1** Add market-maker healthcheck to docker-compose.prod.yml
  - **File:** `docker-compose.prod.yml` (modify)
  - **Action:** Add healthcheck to the `market-maker` service:
    ```yaml
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:3100/api/v1/health | grep -q '\"status\":\"healthy\"' || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    ```
    The `start_period: 60s` gives the MM time to establish FIX sessions before health checks run.
  - **Test:** Deploy to Hetzner, run `docker ps` and verify `(healthy)` appears after 60s
  - **Commit:** `feat(docker): add market-maker healthcheck probing /health endpoint`
  - **Agent:** `tdd-developer`

- [ ] **6.2** Document new env vars in .env.example
  - **File:** `.env.example` (modify)
  - **Action:** Add documented entries for all new env vars:
    ```
    # Alerting
    ALERT_EMAIL=           # Email address for operational alerts
    ALERT_PHONE=           # Phone number for SMS alerts (E.164 format, e.g. +16179536366)
    TELNYX_API_KEY=        # Telnyx API key for SMS
    TELNYX_FROM_NUMBER=    # Telnyx sender number (E.164 format)

    # Watchdog thresholds
    MD_STALE_THRESHOLD_MS=10000        # MS before MD feed considered stale (default 10s)
    QUOTING_IDLE_THRESHOLD_MS=120000   # MS before idle quoting triggers alert (default 2min)
    ALERT_COOLDOWN_MS=600000           # MS between repeated alerts for same condition (default 10min)
    ```
  - **Test:** n/a (docs only)
  - **Commit:** `docs(env): document alerting and watchdog env vars`
  - **Agent:** `tdd-developer`

- [ ] **6.3** Sync new env vars to Hetzner production .env
  - **File:** `/opt/truex-mm/.env` on Hetzner (modify via SSH)
  - **Action:** Add `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`, `ALERT_PHONE`, `ALERT_EMAIL` (placeholder until circleinbox responds), `MD_STALE_THRESHOLD_MS=10000`, `QUOTING_IDLE_THRESHOLD_MS=120000`, `ALERT_COOLDOWN_MS=600000`.
  - **Test:** `docker exec truex-market-maker env | grep TELNYX` confirms vars present
  - **Commit:** n/a (server-side only, not committed)
  - **Agent:** Manual

- [ ] **6.4** Create PR #6 and merge, then deploy
  - **Action:** Create PR, squash merge, rsync to Hetzner, docker compose build + up
  - **Agent:** Manual

---

## Summary

**Total Tasks:** 24 sub-tasks across 6 parent tasks
**Total PRs:** 6 PRs

**Agent Assignments:**
- `reliability-engineer`: Tasks 1.0, 2.0, 3.0 (safety-critical: sequence numbers, reconnect, watchdog)
- `tdd-developer`: Tasks 4.0, 5.0, 6.0 (feature: alerts, dashboard, config)
- Manual: PR reviews, deploy, visual dashboard verification

**Critical Path:**
PR #1 → PR #2 → PR #3 → PR #4 → PR #5 → PR #6

**Parallel Work:**
- PR #4 and PR #5 can be developed in parallel after PR #3 merges
- PR #6 depends only on PR #5 (healthcheck endpoint must exist)

**New Files:**
- `src/alerts/alert-manager.js`
- `src/alerts/alert-manager.test.js`
- `src/api/dashboard.html`

---

*Task list generated 2026-04-03 by tasklist-generator skill*
