# Task 0012 — Kill Switch CLI (the missing emergency stop tool)

**Status**: ready for review
**Branch**: feat/kill-switch
**Date**: 2026-08-07
**Context**: `scripts/kill-switch.js` is referenced by `deploy-hetzner.sh` (graceful stop
cancels orders first), `llms.txt`, and `docs/STRATEGY.md` risk posture — but the file has
never existed (flagged in the strategy doc review). Existing pieces: `rest-cancel-all.js`
(UAT-only, no verify, no prod), `rest-reconcile.js` (list/--cancel), MM API
`/api/v1/emergency-stop` (cancel + SIGTERM self-kill, in-container). Missing: a single
safe CLI usable from the container or any host with REST access, for both venues, with
dry-run and verification.

## Design

`scripts/kill-switch.js`:
- `--prod | --uat` — venue selection; **default `--uat`** (fail-safe: a bare invocation
  never touches prod)
- `--dry-run` — list active orders, cancel nothing
- `--json` — machine-readable output
- Flow: resolve config → list active orders → (dry-run stops here) → `cancelAllOrders()`
  → **verification pass** (re-list; report residuals)
- Exit codes: 0 = no orders remain; 1 = cancel failures or residuals;
  2 = configuration/pre-flight error; 3 = sweep ran but verification failed
- No process-kill side effects — that is the `emergency-stop` endpoint's job; deploy
  tooling stops the container separately. Documented in the header.

Config resolution (env-driven, no hardcoded secrets):
- prod: `TRUEX_PROD_API_KEY/SECRET_KEY`, `TRUEX_CLIENT_ID`, url `TRUEX_REST_URL` || proxy `http://178.156.230.110:3006`
- uat: `TRUEX_API_KEY/SECRET_KEY`, `TRUEX_CLIENT_ID_UAT` || legacy default, url `TRUEX_UAT_REST_URL` || `http://38.32.101.229:9742`

Testable structure: `resolveConfig(env, mode)`, `runKillSwitch(client, opts)` (client
injected), `decideExit(result)` are pure/injectable; the CLI main wires env + real client.

## Acceptance Criteria

- AC1: bare invocation targets UAT, never prod (unit: resolveConfig default).
- AC2: dry-run performs zero cancel calls (unit with mock client).
- AC3: cancel failures/residuals → exit 1; clean sweep → exit 0; missing keys → exit 2;
  verification failure after a successful sweep → exit 3 (unit).
- AC4: verification pass re-lists and reports residuals (unit).
- AC5: smoke — `--dry-run --prod` against live prod REST via the proxy (read-only).
  **PASS 2026-08-07**: listed 3 live buy quotes via the socat proxy, exit 0.
- AC6: full suite green.

## SO-13 note

Touches `scripts/` → docs PR required (llms.txt kill-switch entry + STRATEGY.md gap
line resolved).
