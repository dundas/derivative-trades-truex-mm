# PRD: Connection Resilience, Status Dashboard & Alerting

## 1. Introduction / Overview

The TrueX market maker has experienced two production outages caused by FIX connection failures that the system did not recover from automatically:

1. **FIX OE session**: Sequence number mismatch caused logon rejection → max 10 reconnect attempts exhausted → system silently stopped quoting for 25+ hours
2. **Market data feed**: MD connection dropped → QuoteEngine halted → no watchdog detected it → system silently stopped quoting for 16+ hours

In both cases the container reported "healthy" while actively not trading. Recovery required manual SSH and container restart.

This PRD covers three features to prevent and detect this class of failure:
- **[F1] Connection resilience** — self-healing FIX OE and MD connections
- **[F2] Quoting watchdog** — application-level detection of "connected but not quoting"
- **[F3] Status dashboard + alerting** — real-time visibility and proactive notification

---

## 2. Goals

1. The market maker self-recovers from FIX OE and MD connection failures without operator intervention
2. The system detects "connected but not quoting" within 2 minutes and triggers recovery
3. Operators are alerted via Slack, email, and SMS within 2 minutes of a quoting halt
4. A live status dashboard shows quoting health, connection state, balances, position, and fills
5. The Docker healthcheck reflects true quoting health, not just process liveness

---

## 3. User Stories

**As an operator**, I want the market maker to automatically recover from FIX connection drops so I don't need to manually SSH and restart containers.

**As an operator**, I want to receive a Slack, email, and SMS alert within 2 minutes when quoting stops so I can investigate immediately.

**As an operator**, I want a web dashboard where I can see at a glance whether the system is actively quoting, how many orders are live, what the current position is, and when the last fill occurred.

**As an operator**, I want the Docker healthcheck to accurately report "unhealthy" when the system is connected but not quoting, so container orchestration can take action.

**As a market maker system**, I want to cancel all open orders immediately when the MD feed goes stale so I am not adversely selected on stale quotes.

---

## 4. Functional Requirements

### F1 — Connection Resilience

**FR-1.1** — Sequence number persistence  
The FIX connection MUST persist `nextSeqNumOut` and `nextSeqNumIn` to Redis on every message sent/received. On process restart, these values MUST be read from Redis and used in the Logon message (not reset to 1).

**FR-1.2** — Unlimited reconnect attempts with exponential backoff  
The FIX connection MUST NOT have a hard cap on reconnect attempts. After 10 attempts, it MUST continue retrying indefinitely while firing an alert. Backoff parameters:
- Initial delay: 1s
- Multiplier: 2x
- Max delay: 30s
- Jitter: ±20% of computed delay

**FR-1.3** — Backoff reset after stable connection  
After a successful connection that remains stable for ≥60s, the reconnect attempt counter and delay MUST reset to initial values.

**FR-1.4** — Gap-fill for stale application messages  
On reconnect with a sequence gap, the system MUST respond to `ResendRequest(35=2)` for old quote/order messages using `SequenceReset-GapFill(35=4, GapFillFlag=Y)` rather than retransmitting stale market data or old quotes.

**FR-1.5** — Dual-session gate  
The QuoteEngine MUST NOT place orders unless both OE (`LOGGEDON`) and MD (`LOGGEDON`) sessions are active. If either session drops, all open quotes MUST be cancelled via REST before attempting reconnect.

**FR-1.6** — Cancel-on-MD-stale  
If no MD update is received for >10s (configurable via `MD_STALE_THRESHOLD_MS` env var, default 10000), the system MUST:
1. Cancel all open orders via REST
2. Set `quotingEnabled = false`
3. Attempt MD reconnect
4. Only re-enable quoting after receiving a fresh MD snapshot

### F2 — Quoting Watchdog

**FR-2.1** — Watchdog timer  
The Orchestrator MUST run a watchdog loop every 30s that checks:
1. OE FIX session state is `LOGGEDON`
2. MD FIX session state is `LOGGEDON`
3. Last MD update timestamp is within `MD_STALE_THRESHOLD_MS`
4. Last reprice timestamp is within `QUOTING_IDLE_THRESHOLD_MS` (default: 120000ms / 2 minutes)

**FR-2.2** — Watchdog remediation  
If any watchdog check fails:
1. Log `[WATCHDOG] Check failed: <reason>` at ERROR level
2. Fire alert (Slack + email + SMS) — see F3
3. Cancel all open orders via REST
4. Force-reconnect the failed session(s)

**FR-2.3** — Watchdog suppression during intentional halt  
The watchdog MUST NOT fire alerts when the system is in a user-initiated shutdown or when balances are zero (no quoting expected).

**FR-2.4** — Healthcheck endpoint update  
`GET /health` on the analytics API (port 3100) MUST return:
```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "quoting": true | false,
  "lastRepriceAge": 45000,
  "oeConnected": true,
  "mdConnected": true,
  "lastMdAge": 3000
}
```
Status logic:
- `healthy`: quoting=true, both sessions connected, lastRepriceAge < 120s
- `degraded`: quoting=false but reconnecting (within last 2 min)
- `unhealthy`: quoting=false for >2 min OR either session disconnected >2 min

**FR-2.5** — Docker healthcheck update  
`docker-compose.prod.yml` healthcheck MUST call `GET /health` and fail if `status != "healthy"`.

### F3 — Status Dashboard & Alerting

**FR-3.1** — Alert on quoting halt  
When the watchdog detects a quoting halt (FR-2.1 check #4 fails), send alerts to:
- **Slack**: webhook POST to `DEFAULT_SLACK_WEBHOOK_URL` env var
- **Email**: send via SMTP or SendGrid to operator email (`ALERT_EMAIL` env var)
- **SMS**: send via Telnyx to operator phone (`ALERT_PHONE` env var, `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`)

Alert message MUST include: reason, last reprice time, current position, current balances.

**FR-3.2** — Alert on recovery  
When the system resumes quoting after a halt, send a recovery notification to all three channels.

**FR-3.3** — Alert deduplication  
Alerts MUST NOT fire more than once per 10 minutes for the same condition (`ALERT_COOLDOWN_MS` env var, default 600000).

**FR-3.4** — Status dashboard page  
A static HTML page served at `GET /` (or `GET /dashboard`) on the analytics API (port 3100) MUST display:

| Section | Data |
|---------|------|
| **System Status** | Quoting: active/halted, uptime, last reprice time |
| **Connections** | OE FIX: connected/disconnected, MD FIX: connected/disconnected |
| **Position** | BTC position, PYUSD position, side (long/short/flat) |
| **Balances** | BTC available/total, PYUSD available/total |
| **Active Orders** | Count, list of open orders (price, side, qty) |
| **Last Fill** | Time, side, price, quantity |
| **PnL** | Realized, unrealized, fees, net |
| **Alerts** | Last 5 alert events with timestamp and reason |

**FR-3.5** — Dashboard auto-refresh  
The dashboard MUST auto-refresh every 5 seconds without a full page reload (polling `/api/status` endpoint).

**FR-3.6** — Status API endpoint  
`GET /api/status` MUST return a JSON snapshot of all dashboard data (used by both the dashboard and external monitors).

---

## 5. Non-Goals (Out of Scope)

- Multi-venue support (TrueX only)
- Historical PnL charting / time-series graphs (show current session only)
- User authentication on the dashboard (internal tool, rely on network-level access control)
- Mobile app
- Automated position unwinding on halt (cancel only, no market orders)
- `ResetSeqNumFlag=Y` automation — sequence resets require out-of-band coordination with TrueX and remain a manual operation

---

## 6. Design Considerations

- Dashboard uses plain HTML + vanilla JS (no React/build step) — served directly from the analytics API with `Bun.file()`
- Dark theme, monospace font — operator tooling aesthetic
- Status indicator: green dot (healthy) / yellow dot (degraded) / red dot (unhealthy) at top of page
- All thresholds configurable via env vars — no hardcoded values
- Dashboard port 3100 is not publicly exposed (internal Docker network + SSH tunnel for access)

---

## 7. Technical Considerations

- **Sequence persistence**: Use existing Redis connection. Key: `fix:seq:{sessionId}:out` and `fix:seq:{sessionId}:in`
- **Watchdog**: Add to `market-maker-orchestrator.js` as a `setInterval` loop
- **Alert service**: New `src/alerts/alert-manager.js` — wraps Slack, email (nodemailer or fetch to SendGrid), Twilio SMS
- **Dashboard**: New `src/api/dashboard.html` + extend `src/api/server.js` with `/api/status` and `/` routes
- **Healthcheck**: Extend existing `/health` route in `src/api/server.js`
- **SMS**: Telnyx REST API via `fetch` — no SDK needed (`TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`)
- **Email**: derivative.email address provisioned via circleinbox — awaiting credentials. Fallback: Gmail SMTP (`GMAIL_USER` / `GMAIL_USER_PASS` already in env)

---

## 8. Success Metrics

- Zero manual restarts required after a FIX session drop (system self-recovers within 60s)
- Quoting halt detected and alerted within 2 minutes
- Dashboard loads and shows live data at port 3100
- All 3 alert channels receive notification within 2 minutes of a halt
- Docker `docker ps` shows `(healthy)` only when system is actively quoting

---

## 9. Open Questions

1. **Telnyx credentials**: `TELNYX_API_KEY` and `TELNYX_FROM_NUMBER` needed — do you have these or should we provision a Telnyx account?
2. **Email address**: Awaiting response from circleinbox for derivative.email provisioning (msg-1775251270504-k2nfxn). Gmail SMTP fallback available in the meantime.
3. **TrueX Cancel-on-Disconnect**: Does TrueX support the FIX "Cancel on Disconnect" feature (tag `10001=Y` in Logon)? If yes, this is a free server-side safety net.
4. **MD staleness threshold**: 10s default for BTC/PYUSD — is this appropriate given TrueX's normal tick frequency?
5. **Dashboard access**: Should the dashboard be accessible publicly (with auth) or only via SSH tunnel?
