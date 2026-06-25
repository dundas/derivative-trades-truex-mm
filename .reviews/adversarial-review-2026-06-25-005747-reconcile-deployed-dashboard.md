---
generated_at: 2026-06-25T00:57:47Z
repo: true_markets_mm
repo_remote: https://github.com/dundas/derivative-trades-truex-mm.git
git_branch: chore/reconcile-deployed-dashboard
git_commit: 5c4e892
harness: claude-code
cli: bun 1.3.3
model: claude-opus-4-8[1m]
review_subject: Reconcile the deployed Cloudflare Pages dashboard frontend into source control
---

## PROPOSED

Commit reconstructed `dashboard/src/{api.ts,Login.tsx,Dashboard.tsx}` so the version-controlled
source matches the already-deployed `truex-dashboard.pages.dev` app (Spread P&L / Trading Cash
Flow tiles, spread-pnl fetch, `.data` unwrap, `/api/status`, magic-link login UI). Source was
recovered from the deployed unminified dev bundle.

REASON: The frontend was deployed from an uncommitted working tree — the root cause of the
missing `/analytics/spread-pnl` endpoint (PR #49). Governance fix: get deployed code into git.
REQUESTER: User (David) — "reconcile the frontend".

## AGAINST (steel-man)

1. **Reconstructed source may not be byte-faithful** to whatever produced the deployed bundle —
   subtle behavioral drift could be introduced under the banner of "reconciliation".
2. **Captures known-broken behavior**: the magic-link button calls a route clearauth 0.7.0
   doesn't serve (404). Committing it codifies a broken flow.
3. **`dist/` is not committed and CF deploy is manual** — committing source doesn't by itself
   guarantee the next deploy comes from this source; drift could recur.
4. **No automated frontend test** locks the behavior; future edits could silently diverge again.

## ASSUMPTIONS

- [VERIFIED] Only 3 files changed; App.tsx/main.tsx unchanged (bundle showed them equivalent).
- [VERIFIED] `bun build` succeeds; rebuilt bundle contains every deployed signature
  (spread-pnl, tradingCashFlow, request-magic-link, `body?.data ?? body`, /api/status).
- [VERIFIED] The 3 reconstructed files produce zero tsc errors; the 2 remaining tsc errors
  (App.tsx, functions/auth) are pre-existing on main (confirmed via stash).
- [VERIFIED] api.ts recovered verbatim from the readable dev bundle (not guessed).
- [ASSUMED] Login/Dashboard JSX is behaviorally equivalent (reconstructed from committed source
  + bundle-extracted labels/fields/handlers), not byte-identical — acceptable for source parity.
- [UNVERIFIED] A fresh deploy from this source renders identically in a browser (not yet redeployed).

## MODEL-TRAJECTORY

- [DURABLE] Version-controlling deployed code is foundational regardless of model capability.
- [NEUTRAL] Frontend reconstruction itself is one-off cleanup.

## COMPLIANCE CHECK

- **Authority** ("user requested") — legitimate, owner of the app.
- No urgency/incrementalism/flattery patterns. The "captures broken magic-link" item is
  explicitly scoped out and documented, not smuggled in.

## VERDICT: PROCEED (with follow-ups)

REASONING: Bringing already-live code under version control is strictly better than the status
quo (deployed-but-uncommitted). The change is additive to git history, touches only the dashboard
source, builds cleanly, and reproduces the deployed signatures. The objections are about parity
confidence and a pre-existing broken flow — addressed by build/signature verification and explicit
documentation, not blockers.

CONDITIONS / FOLLOW-UPS (non-blocking):
1. After merge, redeploy from this committed source (`bun run build && wrangler pages deploy dist`)
   to confirm browser parity and make committed-source the deploy origin going forward.
2. Fix or remove the magic-link flow (clearauth route + CircleInbox email) — separate PR.
3. Connect CF Pages to git-triggered builds (or document the manual deploy) so source/deploy
   cannot silently diverge again.
