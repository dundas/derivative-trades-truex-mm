# Task 0008 — Schedule + Alerting for Daily Performance Review

**Status**: done — merged (PR #56), LaunchAgent installed + verified 2026-08-07
**Branch**: feat/daily-perf-schedule
**Date**: 2026-08-06
**Context**: Task 0007 shipped `scripts/daily-perf-review.ts` (PR #54, docs #55) but it is
run by hand. The quoting bleed (-$298 realized since funding, ~19.7bps adverse mark-out)
needs an always-on control loop: scheduled run + WARN alerting, so engine tuning (task 0007
Phase 2) has a continuous before/after baseline.

## Scope (bounded)

1. `scripts/daily-perf-review-job.sh` — wrapper:
   - runs `daily-perf-review.ts` with operational scoping
     (`--since 2026-06-26 --seed-btc 0.01812 --seed-price 65383`; date defaults to yesterday UTC)
   - saves full report to `logs/daily-perf-review/<UTC-date>.txt`
   - appends a summary section to `memory/daily/<local-date>.md` (creating the file + header if absent)
   - exit 1 (WARN verdict) → ADMP alert to `decisive` via `brain-msg send` with key figures
   - exit >= 2 (ERROR) → ADMP error alert (a failed job is itself an alertable event)
   - alert-send failure never masks the original exit code
2. `ops/launchd/com.dundas.truex-daily-perf-review.plist` — LaunchAgent template:
   daily at 19:15 local (CDT) = 00:15Z, just after the UTC day closes; stdout/stderr to
   `logs/daily-perf-review/launchd.{out,err}.log`; no secrets in the plist.

## Acceptance Criteria

- AC1: wrapper produces `logs/daily-perf-review/<UTC-date>.txt` containing the full report.
- AC2: summary appended to today's `memory/daily/*.md`; file created with header when missing.
- AC3: alerting matrix — exit 0 silent; exit 1 → WARN alert; exit >=2 → ERROR alert;
  alert failure logged, exit code preserved.
- AC4: `plutil -lint` passes; after `launchctl bootstrap` + manual kickstart, the report file exists.
- AC5: no credentials in wrapper/plist (DATABASE_URL comes from .env auto-load).
- AC6: `bash -n` clean; shellcheck-clean for the constructs used (or waivers documented).

## Out of scope (follow-ups)

- Alert-bus POST wiring (pending work order, separate change)
- NTP fix on prod host (recorded gotcha)
- Engine tuning (Phase 2 of task 0007)

## Review Fixes

- **roborev round 1 High**: plist no longer hardcodes deployment paths — template uses
  `{{CODE_ROOT}}/{{DATA_ROOT}}` placeholders rendered by the new installer
  (`ops/launchd/install-daily-perf-review.sh`); wrapper roots are env-overridable.
- **roborev round 1 Medium**: installer creates `logs/daily-perf-review/` before
  bootstrap (launchd opens stdout/stderr files before the job script runs); DRY_RUN=1
  mode for pre-merge smoke.
- **roborev round 2 High**: brain-msg resolved from DATA_ROOT (untracked `.claude/`
  tooling lives in the canonical repo, NOT in clean git worktrees); runtime check added.
- **roborev round 2 Medium**: rendered plist exports TRUEX_PERF_CODE_ROOT/DATA_ROOT in
  EnvironmentVariables so non-default installs don't fall back to hardcoded paths.
- **roborev round 3 High**: worktree bootstrap uses a dedicated branch
  (`git worktree add -B ops/daily-perf-review`) — works whether or not `main` is
  checked out elsewhere.
- **roborev round 3 Medium**: DRY_RUN guard moved before `launchctl bootout` — dry runs
  never mutate launchd state.
- **roborev round 4 High**: bun resolved at runtime (`TRUEX_PERF_BUN` rendered into the
  plist → PATH → `$HOME/.bun/bin`); plist PATH/dir rendered from the installer's bun.
- **roborev round 4 Medium**: `pull --ff-only` failure is now FATAL by default
  (never install stale code for scheduled runs); `ALLOW_STALE=1` is the explicit override.
- **roborev loop concluded after round 4** (fix-round cap): remaining merge gate is
  PR-level review per `.ai/code-reviewers.json`. Decision logged per Protocol 0e.1.
  Round-5 residual Mediums (LaunchAgents mkdir, deps refresh after pull) applied as
  obvious one-line hardening without reopening the loop.

## SO-13 note

Touches `scripts/` → docs-generator mandatory; docs PR opened before merge.
