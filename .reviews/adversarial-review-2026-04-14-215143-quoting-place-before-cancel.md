---
generated_at: "2026-04-14T21:51:43Z"
repo: true_markets_mm
repo_remote: https://github.com/dundas/derivative-trades-truex-mm.git
git_branch: fix/mm-coinbase-md-recovery
git_commit: 7ee2a18
harness: claude-code
cli: bun 1.3.3
model: claude-sonnet-4-6
review_subject: Deploy quoting fix — place-before-cancel on reprice + levels:2 to production market maker
---

## PROPOSED

Merge and deploy two quoting changes to the live TrueX production market maker on Hetzner:

1. `executeActions()` in `quote-engine.js` now places new replacement orders BEFORE cancelling old ones, eliminating the single-sided market gap during reprices.
2. `run-prod.js` reduced from `levels: 3` to `levels: 2` per TrueX exchange request.

REASON: Exchange feedback from Patrick at TrueX flagging single-sided market gaps and requesting 2 levels per side.
REQUESTER: User (Kefentse), relaying Patrick's request.

---

## AGAINST

### 1. Double-fill window on every reprice

With place-before-cancel, there is a window (duration = RTT to TrueX + queue drain time) where both the OLD order (stale price) and the NEW order (current price) are simultaneously live. If the market takes both during this window, we commit **2× the intended size** at that level.

At the current rate limit of `maxOrdersPerSecond: 4`, a full reprice of 4 orders generates 8 FIX messages (4 places + 4 cancels). The first 4 dispatch immediately; the remaining 4 queue. The queue drains on the next rate-limit tick (~1s). So old orders can remain live for up to **1–2 seconds** while the new orders are also live.

During that 1–2s window, at `repriceThresholdTicks: 3` ($1.50 per tick), the stale order is at most $1.50 off mid. A fast taker could lift both the new ask AND the stale ask, selling 0.02 BTC instead of 0.01 BTC. At current inventory (0.02676 BTC total) and `maxPosition: 0.05`, selling 0.02 BTC in one cycle is 40% of remaining inventory.

### 2. Rate-limit interaction amplifies the window

`maxOrdersPerSecond: 4` was set conservatively for the cancel-first pattern where order count stays bounded. Under the new pattern, the peak in-flight count doubles transiently. At 4 msg/s the cancel half of each replacement takes ~1s extra to drain. This is a structural change to the order flow timing — it has not been tested against the live FIX session under prod rate limits.

### 3. Change is already pushed to remote, not yet deployed

The code is on the feature branch and has not reached Hetzner. The adversarial review is running after the pre-push gate (protocol ordering was reversed for this change). The code is reviewable but the deployment decision is what's being evaluated now.

### 4. No live smoke test of the new order sequence

Unit tests confirm dispatch ordering. They do not confirm that TrueX's FIX engine handles receiving a New Order Single (D) at the same side+level as an existing order, then a Cancel Request (F) for the old one, gracefully. TrueX's session could in principle reject the new order as a duplicate or cross it against the cancel before the cancel is processed.

### 5. levels:2 cannot be changed without a redeploy

If 2 levels proves insufficient (Patrick said "ideal" but may expect flexibility as inventory grows), reverting requires another full deploy + restart cycle, which creates another ~30s gap in quoting.

---

## ASSUMPTIONS

- **[VERIFIED]** Unit tests pass: 886 pass, 3 pre-existing Kraken failures
- **[VERIFIED]** Dispatch ordering is correct: 'D' before 'F' for replacements
- **[VERIFIED]** Pure cancels still go first; pure places still go last
- **[VERIFIED]** levels: 2 set and commented correctly in run-prod.js
- **[ASSUMED]** TrueX FIX handles simultaneous orders at same side+level without rejecting the new one as a duplicate
- **[ASSUMED]** Double-fill window (≤2s) is acceptable given small order size (0.01 BTC ~$740)
- **[ASSUMED]** maxOrdersPerSecond: 4 is sufficient to drain the cancel queue without leaving stale orders live for dangerous durations
- **[UNVERIFIED]** No TrueX-side position check would be breached if two orders at the same level are simultaneously live

---

## COMPLIANCE CHECK

| Pattern | Present? | Notes |
|---------|----------|-------|
| Urgency | No | No time pressure applied |
| Authority | **Mild** | "Patrick at TrueX said so" — genuine exchange feedback, not pressure tactic. Legitimate. |
| Flattery | No | — |
| Incrementalism | No | Change is well-scoped and bounded |
| Anchoring | **Mild** | Only place-before-cancel was considered; cancel-after-threshold (only cancel old once new is confirmed) was not evaluated |

The Authority signal is legitimate — exchange feedback carries real operational weight. The mild Anchoring observation (no evaluation of a "confirm-then-cancel" approach) is worth noting but does not block.

---

## VERDICT: PROCEED

**REASONING:**

The double-fill risk (§1) is real but bounded. At 0.01 BTC per level and a maximum 2-level exposure, the worst case is 0.02 BTC of unexpected extra sells — worth ~$1,480 at current prices, within the current inventory of 0.02676 BTC and well within the `maxPosition: 0.05` limit. The window is also short (≤2s at current rates). This is an acceptable operational risk for a market maker at this scale, and the alternative (cancel-first gaps) is actively breaking the exchange relationship.

The TrueX FIX compatibility assumption (§4) is reasonable: place-before-cancel is standard market making practice and TrueX is a FIX-compliant venue. No evidence of TrueX rejecting this pattern.

The levels:2 change directly addresses Patrick's explicit request and is reversible via deploy.

**CONDITIONS:**

1. Monitor the first 10 minutes after deployment for any TrueX FIX reject messages (35=8 with OrdStatus=8) on newly placed orders. If TrueX rejects the new order while old is still live, revert to cancel-first.
2. Watch for unexpected double-fills in the fills log immediately post-deploy. If fill count spikes or position drops faster than expected in the first reprice cycle, halt and investigate.
3. These conditions should be checked manually by the operator within the first 5 minutes of live operation, not deferred.
