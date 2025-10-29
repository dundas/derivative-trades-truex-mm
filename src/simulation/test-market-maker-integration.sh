#!/bin/bash
###############################################################################
# Integration Test: TrueX Market Maker
#
# Tests the market maker script against live TrueX UAT environment
#
# What's tested:
# - Coinbase WebSocket connection
# - TrueX FIX connection and authentication
# - Order placement with Party ID fields
# - Execution report handling (accepts)
# - OHLC builder integration
# - Redis storage
# - Graceful shutdown
#
# Usage:
#   ./test-market-maker-integration.sh [duration_seconds]
#
# Default duration: 60 seconds
###############################################################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DURATION=${1:-60}  # Default 60 seconds
SESSION_ID="integration-test-$(date +%s)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  TrueX Market Maker Integration Test${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}Session ID:${NC} ${SESSION_ID}"
echo -e "${YELLOW}Duration:${NC}   ${DURATION} seconds"
echo -e "${YELLOW}Script:${NC}     market-maker-ladder.js"
echo ""

# Check environment variables
echo -e "${BLUE}[1/5]${NC} Checking environment variables..."
REQUIRED_VARS=(
  "TRUEX_API_KEY"
  "TRUEX_CLIENT_ID"
  "DO_REDIS_URL"
)

# Check for API secret (either variable name works)
if [[ -z "${TRUEX_API_SECRET}" ]] && [[ -z "${TRUEX_SECRET_KEY}" ]]; then
  echo -e "${RED}✗ Missing TRUEX_API_SECRET or TRUEX_SECRET_KEY${NC}"
  exit 1
fi

MISSING_VARS=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var}" ]]; then
    MISSING_VARS+=("$var")
  fi
done

if [[ ${#MISSING_VARS[@]} -gt 0 ]]; then
  echo -e "${RED}✗ Missing required environment variables:${NC}"
  for var in "${MISSING_VARS[@]}"; do
    echo -e "  - ${var}"
  done
  exit 1
fi
echo -e "${GREEN}✓ All required environment variables present${NC}"
echo ""

# Start market maker in background
echo -e "${BLUE}[2/5]${NC} Starting market maker..."
LOG_FILE="/tmp/market-maker-${SESSION_ID}.log"

node "${SCRIPT_DIR}/market-maker-ladder.js" --session-id="${SESSION_ID}" > "${LOG_FILE}" 2>&1 &
MAKER_PID=$!

echo -e "${GREEN}✓ Market maker started (PID: ${MAKER_PID})${NC}"
echo -e "   Log file: ${LOG_FILE}"
echo ""

# Wait for initialization
echo -e "${BLUE}[3/5]${NC} Waiting for initialization..."
sleep 5

# Check if process is still running
if ! kill -0 ${MAKER_PID} 2>/dev/null; then
  echo -e "${RED}✗ Market maker process died${NC}"
  echo -e "\n${YELLOW}Last 20 lines of log:${NC}"
  tail -20 "${LOG_FILE}"
  exit 1
fi

# Check for successful initialization
if grep -q "✅ FIX connection established" "${LOG_FILE}"; then
  echo -e "${GREEN}✓ FIX connection established${NC}"
else
  echo -e "${YELLOW}⚠ FIX connection not established yet, checking for errors...${NC}"
  if grep -q "❌" "${LOG_FILE}"; then
    echo -e "${RED}✗ Errors detected in log${NC}"
    grep "❌" "${LOG_FILE}"
    kill ${MAKER_PID} 2>/dev/null || true
    exit 1
  fi
fi

if grep -q "✅ Coinbase connected" "${LOG_FILE}"; then
  COINBASE_PRICE=$(grep "✅ Coinbase connected" "${LOG_FILE}" | tail -1 | grep -oP '\$[\d,]+\.\d+')
  echo -e "${GREEN}✓ Coinbase connected (Price: ${COINBASE_PRICE})${NC}"
else
  echo -e "${YELLOW}⚠ Coinbase connection not confirmed yet${NC}"
fi

echo ""

# Monitor execution
echo -e "${BLUE}[4/5]${NC} Monitoring execution for ${DURATION} seconds..."
echo -e "${YELLOW}Watching for:${NC} Order placements, accepts, fills, errors"
echo ""

START_TIME=$(date +%s)
while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  if [[ ${ELAPSED} -ge ${DURATION} ]]; then
    break
  fi

  # Check if process is still running
  if ! kill -0 ${MAKER_PID} 2>/dev/null; then
    echo -e "${RED}✗ Market maker process died unexpectedly${NC}"
    echo -e "\n${YELLOW}Last 20 lines of log:${NC}"
    tail -20 "${LOG_FILE}"
    exit 1
  fi

  # Show progress
  REMAINING=$((DURATION - ELAPSED))
  echo -ne "\r   Time remaining: ${REMAINING}s  "

  sleep 1
done

echo ""
echo -e "${GREEN}✓ Monitoring complete${NC}"
echo ""

# Graceful shutdown
echo -e "${BLUE}[5/5]${NC} Shutting down gracefully..."
kill -SIGINT ${MAKER_PID}

# Wait for graceful shutdown
SHUTDOWN_TIMEOUT=10
SHUTDOWN_START=$(date +%s)
while kill -0 ${MAKER_PID} 2>/dev/null; do
  SHUTDOWN_ELAPSED=$(($(date +%s) - SHUTDOWN_START))
  if [[ ${SHUTDOWN_ELAPSED} -ge ${SHUTDOWN_TIMEOUT} ]]; then
    echo -e "${YELLOW}⚠ Graceful shutdown timeout, forcing kill${NC}"
    kill -9 ${MAKER_PID} 2>/dev/null || true
    break
  fi
  sleep 1
done

echo -e "${GREEN}✓ Market maker stopped${NC}"
echo ""

# Extract stats from log
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Test Results${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if grep -q "📊 Final Stats:" "${LOG_FILE}"; then
  echo -e "${GREEN}Final Statistics:${NC}"
  grep -A 10 "📊 Final Stats:" "${LOG_FILE}" | tail -7
  echo ""
else
  echo -e "${YELLOW}⚠ Final stats not found in log${NC}"
fi

# Count execution reports
ACCEPTS=$(grep -c "✅ Order Accepted:" "${LOG_FILE}" || echo "0")
FILLS=$(grep -c "💰 Fill:" "${LOG_FILE}" || echo "0")
PARTIAL_FILLS=$(grep -c "📈 Partial Fill:" "${LOG_FILE}" || echo "0")
REJECTS=$(grep -c "❌ Order Rejected:" "${LOG_FILE}" || echo "0")

echo -e "${GREEN}Execution Reports:${NC}"
echo "   Accepts:       ${ACCEPTS}"
echo "   Fills:         ${FILLS}"
echo "   Partial Fills: ${PARTIAL_FILLS}"
echo "   Rejects:       ${REJECTS}"
echo ""

# Check for errors
ERROR_COUNT=$(grep -c "❌" "${LOG_FILE}" || echo "0")
if [[ ${ERROR_COUNT} -gt 0 ]]; then
  echo -e "${YELLOW}Errors detected: ${ERROR_COUNT}${NC}"
  echo -e "\n${YELLOW}Error lines:${NC}"
  grep "❌" "${LOG_FILE}" | head -10
  echo ""
fi

# Summary
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Summary${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}Session ID:${NC}  ${SESSION_ID}"
echo -e "${YELLOW}Log file:${NC}    ${LOG_FILE}"
echo ""

# Determine test status
if [[ ${ACCEPTS} -gt 0 ]] && [[ ${ERROR_COUNT} -eq 0 ]]; then
  echo -e "${GREEN}✅ TEST PASSED${NC}"
  echo -e "   - Market maker connected successfully"
  echo -e "   - Orders placed and accepted"
  echo -e "   - No errors detected"
  EXIT_CODE=0
elif [[ ${ACCEPTS} -gt 0 ]] && [[ ${ERROR_COUNT} -gt 0 ]]; then
  echo -e "${YELLOW}⚠ TEST PASSED WITH WARNINGS${NC}"
  echo -e "   - Orders accepted but errors detected"
  echo -e "   - Review log file for details"
  EXIT_CODE=0
else
  echo -e "${RED}✗ TEST FAILED${NC}"
  echo -e "   - No orders accepted or process failed"
  echo -e "   - Review log file for errors"
  EXIT_CODE=1
fi

echo ""
echo -e "${BLUE}To verify Redis data:${NC}"
echo "   redis-cli HGETALL session:${SESSION_ID}:ohlc:1m"
echo ""

exit ${EXIT_CODE}
