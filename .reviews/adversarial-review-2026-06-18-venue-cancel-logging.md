---
generated_at: 2026-06-18T11:40:00Z
repo: true_markets_mm
git_branch: feat/venue-cancel-logging
git_commit: HEAD
harness: claude-code
cli: bun 1.3.3
model: claude-opus-4-8[1m]
review_subject: Surface unsolicited venue cancels (OrdStatus=4) in onExecutionReport
---

# Adversarial Review — venue-cancel logging

## PROPOSED
Add a warn + counter in onExecutionReport case '4' to distinguish unsolicited venue cancels
from self-initiated cancels. Diagnostic for the live bid-only book; user explicitly requested.

## AGAINST
1. Log noise — if venue-cancels are frequent (they are, for the marketable asks), this warns a
   lot. Mitigant: that's the POINT (surfacing a previously-silent failure); volume itself is the
   signal. If it floods, we raise reprice threshold / fix anchoring next.
2. Mis-classification — could a self-cancel be mislabeled as venue? Guard checks both
   cancelToOrigMap (cancel acks) AND 'cancelling' status; covered by 2 negative tests.

## ASSUMPTIONS
- [VERIFIED] Behavior-neutral: only adds a log + a Map counter; no order/trade/state change.
- [VERIFIED] Tests: venue cancel warns; self-cancel + cancel-ack do not. 190/190.
- [VERIFIED] User explicitly requested this diagnostic.

## COMPLIANCE CHECK
- No manipulation patterns. Behavior-neutral, reversible, user-requested.

## VERDICT: PROCEED
Logging-only, well-tested, directly answers the diagnostic need. The only "risk" (log volume)
is the intended signal. Proceed to pre-push → PR → merge → deploy, then read the logs.
