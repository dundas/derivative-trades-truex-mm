#!/bin/bash
# Daily performance review job — scheduled wrapper around scripts/daily-perf-review.ts.
#
# Runs the read-only review for yesterday (UTC) with operational era scoping,
# archives the report, appends a summary to the daily memory log, and alerts
# `decisive` via ADMP on WARN (exit 1) or ERROR (exit >= 2) outcomes.
#
# Layout (two roots, kept separate on purpose):
#   CODE_ROOT — clean checkout of `main` with node_modules + .env (runs the script)
#   DATA_ROOT — canonical repo holding memory/ and logs/ (where results land)
#
# Credentials: none here — DATABASE_URL is auto-loaded from CODE_ROOT/.env by Bun.
#
set -uo pipefail

CODE_ROOT="/Users/kefentse/dev_env/true_markets_mm-ops"
DATA_ROOT="/Users/kefentse/dev_env/true_markets_mm"
BUN="/Users/kefentse/.bun/bin/bun"
BRAIN_MSG="$CODE_ROOT/.claude/skills/cross-brain-message/brain-msg.ts"

# Operational scoping for the funded prod account (see docs/DAILY_PERF_REVIEW.md)
ERA_SINCE="2026-06-26"
SEED_BTC="0.01812"
SEED_PRICE="65383"

[ -d "$CODE_ROOT" ] || { echo "FATAL: code root missing: $CODE_ROOT"; exit 2; }
[ -d "$DATA_ROOT" ] || { echo "FATAL: data root missing: $DATA_ROOT"; exit 2; }
[ -x "$BUN" ] || { echo "FATAL: bun not found at $BUN"; exit 2; }
cd "$CODE_ROOT" || { echo "FATAL: cannot cd to $CODE_ROOT"; exit 2; }

DATE_UTC=$(TZ=UTC date -v-1d +%Y-%m-%d) # yesterday UTC (BSD date)
LOG_DIR="$DATA_ROOT/logs/daily-perf-review"
mkdir -p "$LOG_DIR"
REPORT="$LOG_DIR/$DATE_UTC.txt"

"$BUN" scripts/daily-perf-review.ts \
  --since "$ERA_SINCE" --seed-btc "$SEED_BTC" --seed-price "$SEED_PRICE" \
  > "$REPORT" 2>&1
RC=$?

VERDICT_LINE=$(grep -m1 '^VERDICT:' "$REPORT" || echo "VERDICT: UNKNOWN (exit $RC)")
PNL_LINE=$(grep -m1 '  day:' "$REPORT" || echo "  day: n/a")
MARKOUT_LINE=$(grep -m1 '^Mark-out' "$REPORT" || echo "Mark-out: n/a")
ROUNDTRIP_LINE=$(grep -m1 '  round-trip:' "$REPORT" || true)

# --- Append summary to daily memory log -------------------------------------
LOCAL_DATE=$(date +%Y-%m-%d)
DAILY="$DATA_ROOT/memory/daily/$LOCAL_DATE.md"
mkdir -p "$DATA_ROOT/memory/daily"
if [ ! -f "$DAILY" ]; then
  printf '# Session Log - %s\n' "$LOCAL_DATE" > "$DAILY"
fi
{
  printf '\n## Daily Perf Review — %s (automated)\n\n' "$DATE_UTC"
  printf -- '- %s\n' "$VERDICT_LINE"
  printf -- '- Realized PnL:%s\n' "${PNL_LINE#  day:}"
  printf -- '- %s\n' "$MARKOUT_LINE"
  if [ -n "${ROUNDTRIP_LINE:-}" ]; then printf -- '- %s\n' "${ROUNDTRIP_LINE#  }"; fi
  printf -- '- Full report: `logs/daily-perf-review/%s.txt` (exit %s)\n' "$DATE_UTC" "$RC"
} >> "$DAILY"

# --- Alerting ----------------------------------------------------------------
send_alert() {
  local subject="$1" body="$2"
  "$BUN" "$BRAIN_MSG" send --to decisive --body "$body" >/dev/null 2>&1 \
    || echo "WARN: alert send failed (subject: $subject)"
}

if [ "$RC" -eq 1 ]; then
  send_alert "daily-perf WARN $DATE_UTC" \
    "TrueX MM daily perf review $DATE_UTC: WARN — $VERDICT_LINE; realized PnL:${PNL_LINE#  day:}; $MARKOUT_LINE. Report: $REPORT"
elif [ "$RC" -ge 2 ]; then
  send_alert "daily-perf ERROR $DATE_UTC" \
    "TrueX MM daily perf review job FAILED (exit $RC) for $DATE_UTC. Last output: $(tail -c 300 "$REPORT" | tr '\n' ' ')"
fi

exit "$RC"
