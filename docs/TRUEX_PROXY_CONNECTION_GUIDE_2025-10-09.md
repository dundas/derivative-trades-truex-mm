# TrueX Proxy Connection Guide
**Date:** October 9, 2025  
**Status:** ✅ WORKING  
**Last Verified:** October 9, 2025 21:06 UTC

---

## 🎯 Quick Start (Verified Working)

### Working Script
```bash
cd /Users/kefentse/dev_env/decisive_trades/src/services/market-maker/truex
node run-live-truex-mm.cjs
```

### Expected Output
```
✅ Logon accepted!
✅ TrueX FIX authentication successful
✅ TrueX fully connected and authenticated
📤 Submitting order: 8=FIXT.1.1|9=192|35=D|...
```

---

## 🔐 Critical: Correct Credentials

### Root `.env` File Location
```
/Users/kefentse/dev_env/decisive_trades/.env
```

### Required Environment Variables
```bash
# TrueX Authentication (CRITICAL: Use these exact values)
TRUEX_API_KEY=89720766-9b45-4407-93b8-1cbecb74c3d3
TRUEX_SECRET_KEY=1fba7f7a61fc5c31db51b2f2d2e540f03558f22583fb184569bd5eeeddd5d53c
TRUEX_CLIENT_ID=78923062108553234

# TrueX FIX Connection (via DigitalOcean Proxy)
TRUEX_FIX_HOST=129.212.145.83
TRUEX_FIX_PORT=19484
```

### ⚠️ WARNING: Multiple .env Files
There are TWO `.env` files in the codebase with DIFFERENT credentials:
- ✅ **Root `.env`** (CORRECT - Updated on 2025-10-09)
- ❌ **Proxy `.env`** (`src/services/market-maker/truex/proxy/.env`) - DO NOT USE for market maker

**Why this matters:**
- Heartbeat test scripts in `proxy/` directory load `proxy/.env` (works ✅)
- Market maker scripts load root `.env` (now works ✅ after fix)
- Previously root `.env` had WRONG credentials causing "Authentication failed"

---

## 🌐 Connection Architecture

### Network Path
```
Local Market Maker (localhost)
    ↓ (connects to)
DigitalOcean FIX Proxy (129.212.145.83:3004)
    ↓ (forwards to)
TrueX UAT Gateway (38.32.101.229:19484)
```

### Connection Configuration
```javascript
{
  truexHost: '129.212.145.83',  // DigitalOcean proxy IP
  truexPort: 3004,               // Proxy port (NOT 19484)
}
```

### Why Use the Proxy?
- **Direct connection to TrueX is unstable** (connection refused errors as of Oct 9)
- **Proxy provides stability** and connection management
- **Easier debugging** with proxy logs on DigitalOcean droplet

---

## 📋 Verified Working Scripts

### 1. Market Maker (Full Trading)
**Script:** `run-live-truex-mm.cjs`  
**Location:** `src/services/market-maker/truex/`  
**Purpose:** Full market maker with order placement  
**Startup:**
```bash
cd /Users/kefentse/dev_env/decisive_trades/src/services/market-maker/truex
node run-live-truex-mm.cjs
```

**Success Indicators:**
- `✅ Logon accepted!`
- `✅ TrueX FIX authentication successful`
- `📤 Submitting order:`

---

### 2. Heartbeat Test (Connection Verification)
**Script:** `truex-heartbeat-test.cjs`  
**Location:** `src/services/market-maker/truex/proxy/`  
**Purpose:** Test FIX connection and heartbeat handling  
**Startup:**
```bash
cd /Users/kefentse/dev_env/decisive_trades/src/services/market-maker/truex/proxy
node truex-heartbeat-test.cjs
```

**Success Indicators:**
- `✅ FIX Logon accepted`
- `✅ Market data subscription successful`
- `💓 Heartbeat #N sent`

**Note:** Uses `proxy/.env` credentials (different from root)

---

### 3. Market Data Observer (Read-Only)
**Script:** `truex-fix-market-data-observer.cjs`  
**Location:** `src/services/market-maker/truex/proxy/`  
**Purpose:** Subscribe to market data without trading  
**Startup:**
```bash
cd /Users/kefentse/dev_env/decisive_trades/src/services/market-maker/truex/proxy
node truex-fix-market-data-observer.cjs
```

---

## 🔍 Troubleshooting Guide

### Problem: "Authentication failed" (35=3 message)
**Symptom:**
```
📨 RESPONSE: 8=FIXT.1.1|...|35=3|...|58=Authentication failed|...
```

**Solution:**
1. Verify credentials in root `.env`:
   ```bash
   cd /Users/kefentse/dev_env/decisive_trades
   grep "^TRUEX_API_KEY\|^TRUEX_SECRET_KEY" .env
   ```
2. Should show:
   ```
   TRUEX_API_KEY=89720766-9b45-4407-93b8-1cbecb74c3d3
   TRUEX_SECRET_KEY=1fba7f7a61fc5c31db51b2f2d2e540f03558f22583fb184569bd5eeeddd5d53c
   ```
3. If different, restore from `proxy/.env` or this guide

---

### Problem: Connection Timeout
**Symptom:**
```
❌ Failed to start market maker: Error: TrueX FIX authentication timeout
```

**Solutions:**

**1. Check if DigitalOcean proxy is reachable:**
```bash
nc -zv 129.212.145.83 3004
# Should show: Connection to 129.212.145.83 port 3004 [tcp/*] succeeded!
```

**2. Check if TrueX is reachable FROM the proxy:**
```bash
ssh root@129.212.145.83
nc -zv 38.32.101.229 19484
# Should show: Connection to 38.32.101.229 port 19484 [tcp/*] succeeded!
```

**3. Check DigitalOcean proxy logs:**
```bash
ssh root@129.212.145.83
pm2 logs fix-proxy --lines 50
```

---

### Problem: "Invalid session ID" for Market Data
**Symptom:**
```
📨 RAW: 8=FIXT.1.1|...|35=j|...|58=Invalid session ID|...
```

**Status:** Known issue - does NOT prevent order placement  
**Impact:** Market data subscription fails, but orders can still be placed  
**Action:** No action required if authentication succeeds

---

## 📊 Verification Commands

### Test Full Connection Flow
```bash
cd /Users/kefentse/dev_env/decisive_trades/src/services/market-maker/truex
perl -e 'alarm 30; exec @ARGV' node run-live-truex-mm.cjs 2>&1 | grep -E "✅|❌|Authentication|Logon"
```

**Expected Output:**
```
✅ Connected to Coinbase WebSocket
✅ Connected to TrueX proxy server
✅ Connected to TrueX FIX services
✅ TrueX FIX client connected
✅ Logon accepted!
✅ TrueX FIX authentication successful
✅ TrueX fully connected and authenticated
```

---

### Quick Authentication Test
```bash
cd /Users/kefentse/dev_env/decisive_trades/src/services/market-maker/truex/proxy
perl -e 'alarm 20; exec @ARGV' node truex-heartbeat-test.cjs 2>&1 | head -20
```

**Expected Output:**
```
✅ Connected to TrueX FIX Gateway
📤 Logon message sent
✅ FIX Logon accepted
```

---

## 📝 Change Log

### 2025-10-09 - Authentication Fix
**Problem:** Market maker failing with "Authentication failed"  
**Root Cause:** Root `.env` had wrong credentials (API Key: 7d255825-...)  
**Solution:** Updated root `.env` to use correct credentials from `proxy/.env`  
**Result:** ✅ Authentication now works

**Files Modified:**
- `/Users/kefentse/dev_env/decisive_trades/.env` (updated credentials)
- Backup created: `.env.backup-before-truex-credentials-fix`

**Credentials Changed:**
- OLD: `TRUEX_API_KEY=7d255825-e856-4b51-a17d-f7cdda4cb911`
- NEW: `TRUEX_API_KEY=89720766-9b45-4407-93b8-1cbecb74c3d3`

---

## 🔒 Security Notes

1. **Credential Obfuscation:** All FIX logon messages obfuscate credentials in logs
2. **Localhost Binding:** Local FIX proxy binds to 127.0.0.1 only
3. **Environment Variables:** Never commit actual credentials to git
4. **Backup:** Original credentials backed up in `.env.backup-before-truex-credentials-fix`

---

## 📚 Related Documentation

- **Deployment Guide:** `PRODUCTION_DEPLOYMENT.md`
- **Monitoring Guide:** `MONITORING_GUIDE.md`
- **FIX Protocol Docs:** `docs/fix-protocol/`
- **Connection Test Results:** `TRUEX_CONNECTION_TEST_FINAL_ANALYSIS.md`
- **DigitalOcean Proxy Diagnosis:** `DIGITAL_OCEAN_PROXY_DIAGNOSIS.md`

---

## 🚀 Production Deployment Notes

**Current Status:** UAT environment only  
**Production Readiness:** Pending TrueX production credentials

**Before Production:**
1. Update `TRUEX_API_KEY` and `TRUEX_SECRET_KEY` with production values
2. Update `TRUEX_FIX_HOST` and `TRUEX_FIX_PORT` to production endpoints
3. Test authentication with production credentials in UAT first
4. Update this guide with production configuration

---

## 📞 Support Contacts

**TrueX UAT Issues:**
- Check TrueX status/documentation
- Verify UAT endpoint availability

**DigitalOcean Proxy Issues:**
- SSH: `ssh root@129.212.145.83`
- Check proxy: `pm2 status`
- View logs: `pm2 logs fix-proxy`

---

**Last Updated:** October 9, 2025 21:06 UTC  
**Verified By:** AI Assistant (Cursor)  
**Status:** ✅ WORKING - Authentication successful, orders being placed



