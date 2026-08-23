#!/bin/bash
# Install the TrueX daily performance review LaunchAgent.
#
# One-shot, idempotent:
#   1. Ensures CODE_ROOT — a clean worktree of `main` with node_modules + .env
#      (default: <repo>-ops next to this checkout)
#   2. Creates the launchd log directory BEFORE bootstrap (launchd opens the
#      stdout/stderr files before the job script runs)
#   3. Renders the plist template ({{CODE_ROOT}}/{{DATA_ROOT}} → real paths),
#      lints it, installs to ~/Library/LaunchAgents, and bootstraps it
#
# Usage: bash ops/launchd/install-daily-perf-review.sh
# Env overrides: TRUEX_PERF_CODE_ROOT, TRUEX_PERF_DATA_ROOT,
#                DAILY_REPORT_{BUILD,DEPLOY,EMAIL}_TIMEOUT_MS
#                DRY_RUN=1 → set up roots + render/lint plist, skip bootstrap
#
set -euo pipefail

LABEL="com.dundas.truex-daily-perf-review"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/../.." && pwd)" # repo root of this checkout
DATA_ROOT="${TRUEX_PERF_DATA_ROOT:-$DATA_ROOT_DEFAULT}"
CODE_ROOT="${TRUEX_PERF_CODE_ROOT:-$DATA_ROOT-ops}"
BUN_BIN="${BUN_BIN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
BUN_DIR="$(dirname "$BUN_BIN")"
REPORT_BUILD_TIMEOUT_MS="${DAILY_REPORT_BUILD_TIMEOUT_MS:-120000}"
REPORT_DEPLOY_TIMEOUT_MS="${DAILY_REPORT_DEPLOY_TIMEOUT_MS:-120000}"
REPORT_EMAIL_TIMEOUT_MS="${DAILY_REPORT_EMAIL_TIMEOUT_MS:-30000}"
PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

validate_timeout_ms() {
  local name="$1" value="$2"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]] ||
    [ "${#value}" -gt 10 ] ||
    { [ "${#value}" -eq 10 ] && [[ "$value" > "2147483647" ]]; }; then
    echo "FATAL: $name must be a positive integer of milliseconds no greater than 2147483647"
    exit 2
  fi
}

validate_timeout_ms DAILY_REPORT_BUILD_TIMEOUT_MS "$REPORT_BUILD_TIMEOUT_MS"
validate_timeout_ms DAILY_REPORT_DEPLOY_TIMEOUT_MS "$REPORT_DEPLOY_TIMEOUT_MS"
validate_timeout_ms DAILY_REPORT_EMAIL_TIMEOUT_MS "$REPORT_EMAIL_TIMEOUT_MS"

echo "==> DATA_ROOT: $DATA_ROOT"
echo "==> CODE_ROOT: $CODE_ROOT"
echo "==> Report timeouts (build/deploy/email ms): $REPORT_BUILD_TIMEOUT_MS/$REPORT_DEPLOY_TIMEOUT_MS/$REPORT_EMAIL_TIMEOUT_MS"

# --- 1. Code root: clean worktree at main with deps + .env -------------------
if [ ! -e "$CODE_ROOT/.git" ]; then
  echo "==> Creating worktree (branch ops/daily-perf-review) at origin/main: $CODE_ROOT"
  git -C "$DATA_ROOT" fetch origin
  # -B owns a dedicated branch: works whether or not `main` is checked out
  # elsewhere; the scheduled job later advances it with pull --ff-only.
  git -C "$DATA_ROOT" worktree add -B ops/daily-perf-review "$CODE_ROOT" origin/main
fi
if ! git -C "$CODE_ROOT" pull --ff-only origin main; then
  if [ "${ALLOW_STALE:-0}" = "1" ]; then
    echo "WARN: CODE_ROOT not fast-forwardable to origin/main; proceeding (ALLOW_STALE=1)"
  else
    echo "FATAL: CODE_ROOT is not fast-forwardable to origin/main — refusing to"
    echo "       install stale/divergent code for scheduled runs. Resolve the branch"
    echo "       state, or set ALLOW_STALE=1 to proceed anyway."
    exit 1
  fi
fi

if [ ! -e "$CODE_ROOT/.env" ]; then
  echo "==> Symlinking .env from DATA_ROOT"
  ln -s "$DATA_ROOT/.env" "$CODE_ROOT/.env"
fi
# Always refresh deps after advancing CODE_ROOT (lockfile may have changed);
# --frozen-lockfile is a fast no-op when nothing moved.
(cd "$CODE_ROOT" && "$BUN_BIN" install --frozen-lockfile)
[ -f "$CODE_ROOT/scripts/daily-perf-review.ts" ] \
  || { echo "FATAL: CODE_ROOT lacks scripts/daily-perf-review.ts (is main merged?)"; exit 1; }

# --- 2. Log directory before launchd opens the files -------------------------
mkdir -p "$DATA_ROOT/logs/daily-perf-review"

# --- 3. Render, lint, install, bootstrap -------------------------------------
TMP_PLIST="$(mktemp)"
trap 'rm -f "$TMP_PLIST"' EXIT
sed -e "s|{{CODE_ROOT}}|$CODE_ROOT|g" \
    -e "s|{{DATA_ROOT}}|$DATA_ROOT|g" \
    -e "s|{{BUN_BIN}}|$BUN_BIN|g" \
    -e "s|{{BUN_DIR}}|$BUN_DIR|g" \
    -e "s|{{REPORT_BUILD_TIMEOUT_MS}}|$REPORT_BUILD_TIMEOUT_MS|g" \
    -e "s|{{REPORT_DEPLOY_TIMEOUT_MS}}|$REPORT_DEPLOY_TIMEOUT_MS|g" \
    -e "s|{{REPORT_EMAIL_TIMEOUT_MS}}|$REPORT_EMAIL_TIMEOUT_MS|g" \
  "$PLIST_SRC" > "$TMP_PLIST"
plutil -lint "$TMP_PLIST"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "==> DRY_RUN=1: rendered plist linted; skipping bootout/install/bootstrap"
  head -12 "$TMP_PLIST"
  exit 0
fi

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
mkdir -p "$HOME/Library/LaunchAgents"
cp "$TMP_PLIST" "$PLIST_DST"
launchctl bootstrap "gui/$UID" "$PLIST_DST"
launchctl print "gui/$UID/$LABEL" | head -4

echo "==> Installed. Verify with:"
echo "    launchctl kickstart -k gui/$UID/$LABEL"
echo "    cat $DATA_ROOT/logs/daily-perf-review/launchd.out.log"
