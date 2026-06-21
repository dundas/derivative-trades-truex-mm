---
generated_at: 2026-06-20T11:00:00Z
repo: true_markets_mm
repo_remote: https://github.com/dundas/derivative-trades-truex-mm.git
git_branch: fix/fix-logon-reset-fallback
git_commit: 765432f
harness: claude-code
cli: bun 1.3.3
model: claude-opus-4-7
review_subject: PR #45 — auto-recover from counterparty FIX-gateway restart via ResetSeqNumFlag=Y after N consecutive logon timeouts
---

## PROPOSED

Ship `fix/fix-logon-reset-fallback` (PR #45) to production. Three commits on top of `main`:

- `e77f845` — Core fix: counter + threshold-triggered seq reset on reconnect
- `12a9bbb` — Roborev round 1 hardening (try/catch, post-await staleness re-check, decision extracted to `_shouldUseLogonResetFallback`, threshold validation)
- `765432f` — Roborev round 2 (drop redundant orchestrator validation)

Behavior: after `FIX_LOGON_RESET_THRESHOLD` (default 3) consecutive post-Logon timeouts on a reconnect, the next attempt calls `resetSequenceNumbers()` and sends Logon with `141=Y` / seqnum=1. Gated by `FIX_LOGON_RESET_FALLBACK` (default `true`).

**Reason**: TrueX restarted their FIX gateway twice in 26 hours (2026-06-19 and 2026-06-20). Each time our persistent seq fell behind theirs, and they GapFill but never send the Logon Ack — wedging the session-resume loop for hours. Both required manual `docker restart`. Manual restart worked because a fresh process sends `141=Y` on first Logon. This PR automates that fallback.

**Requester**: user (david) — explicit "yes proceed" after I proposed the change with a default-on env kill-switch.

## AGAINST

Steel-manning the case against shipping:

1. **FIX-protocol surgery is high-blast-radius.** This is the order-entry path. A bug here can place wrong orders, miss fills, double-cancel, or leak state. The PR makes the logon decision *more* automatic and *less* observable.

2. **The fallback is destructive on Redis state.** `resetSequenceNumbers()` wipes the persisted out/in seqnum keys. If the FIX session was actually fine and we just had a transient TCP issue, an over-eager reset throws away recovery data.

3. **Threshold of 3 is unproven.** I picked 3 because "feels right." No empirical basis. A real network blip (one missed heartbeat, two timeouts during a TCP RST window) followed by a third on a different cause could trigger an unnecessary session reset. The fact that *this* is what TrueX did twice is sample size = 2; we don't have a population of failure modes to design against.

4. **No test covers the actual fallback firing.** All 13 new tests cover building blocks: constructor defaults, threshold validation, decision matrix, sendLogon flag wiring, reset state. None drive the connect ceremony end-to-end and verify that "3 timeouts → reset → 141=Y" actually happens. Roborev flagged this initially; I argued it's hard to test without simulating the full ceremony, but "hard to test" is exactly the case where bugs hide.

5. **Race window after the await.** I added a `isCurrentAttempt()` re-check after `await resetSequenceNumbers()`, which closes the obvious race. But the Redis call inside `resetSequenceNumbers()` can take 100–500ms; during that window another reconnect can start. The re-check returns early — good — but it does NOT undo the seqnum reset. So a superseded attempt has already cleared Redis to seq=1, and the live attempt may now be using stale in-memory state. Not exploited in the simple path, but a real concern under reconnect storms.

6. **Counter resets on a successful Logon Ack — but not on a successful reset-fallback Logon.** If the reset fallback fires, sends a fresh Logon, gets an Ack: counter goes back to 0 via the existing success path. Good. But if the reset fallback fires, sends Logon, *times out again* (some unrelated reason), counter increments back from 0 — meaning the fallback will fire again at threshold. That's an infinite loop of session resets if the real cause isn't a stale session. Order state on TrueX side could churn.

7. **`CancelOnDisconnect=Y` already protects against zombie orders on disconnect**, but `ResetSeqNumFlag=Y` is heavier — it tells TrueX "forget our session entirely." If we're wrong about why logon is failing (e.g., a creds outage on their side), we've discarded recovery state for nothing.

8. **No staging environment to test this on.** UAT exists, but UAT doesn't reproduce the failure mode (we'd need TrueX to also restart UAT in a way that desyncs our seq). The first real validation will be on prod.

9. **Operational urgency creates the same compliance pressure that caused the issue we're solving.** "Twice in 26 hours, ship the fix" is a pattern that *looks* like a good safety reflex but is also the same shape as urgency-driven shortcuts.

## ASSUMPTIONS

- [VERIFIED] `resetSequenceNumbers()` exists and clears in-memory + Redis state (read at `src/fix-protocol/fix-connection.js:212–230`).
- [VERIFIED] `sendLogon(false)` includes `141=Y` (covered by new test at fix-connection.test.js).
- [VERIFIED] All 121 unit tests pass on the final commit (`bun test`).
- [VERIFIED] Pre-push gate clean on `765432f` (semgrep 0, roborev "No issues found").
- [UNVERIFIED] Threshold of 3 is the right value. Could be 2 (faster recovery, more reset risk) or 5 (more confidence, longer outage).
- [UNVERIFIED] No test exercises the actual fallback fire path end-to-end. Coverage is at primitives, not the integrated behavior.
- [UNVERIFIED] Behavior under reconnect-storm (multiple superseded attempts during the Redis `await`).
- [UNVERIFIED] Behavior if TrueX rejects `141=Y` Logon for some reason (e.g., new rate limit on session resets). Code reverts to normal reconnect loop, but that's the *current* failing behavior.
- [ASSUMED] The two outages had the same root cause. Symptoms match (heartbeat loss → gap detected → GapFill → no Ack), but we never got TrueX to confirm a restart on their side.
- [ASSUMED] Default-on is the right call. Could ship default-off and flip the env var once we've watched it once in the wild.

## MODEL-TRAJECTORY (SO-23)

- [DURABLE] FIX-protocol auto-recovery — this is venue-specific knowledge that doesn't get subsumed by model capability. The next model still has to *do* this in real time on a live session; it can't post-hoc reason its way out of a session wedge.
- [NEUTRAL] The env-var indirection (`FIX_LOGON_RESET_FALLBACK`, `FIX_LOGON_RESET_THRESHOLD`) is pure operations plumbing.

Not a yellow flag on this dimension.

## COMPLIANCE PATTERN CHECK

- **Urgency** — present but legitimate: the system has demonstrably failed twice in 26h. Distinguish: I am not skipping verification because of urgency; I ran the full pre-push gate, two rounds of roborev fixes, and the unit-test suite. Urgency is informing the timing, not the rigor.
- **Authority** — not present. User said "yes proceed" after I laid out the design.
- **Flattery** — not present.
- **Incrementalism** — borderline. Each roborev round added a fix, and "just one more roborev pass" could go on indefinitely. I stopped at "No issues found." Defensible.
- **Reciprocity** — not present.
- **Social proof** — not present.
- **Anchoring** — present and worth naming: I anchored on the "manual restart works → automate manual restart" framing. Alternative framings I didn't deeply explore: (a) contact TrueX to confirm root cause and ask for a different recovery path on their side; (b) detect the symptom from outside (watchdog) and trigger container restart instead of in-process reset; (c) ship default-off and study one occurrence in prod first.

## VERDICT

**PAUSE.**

The change is well-implemented, well-tested at the unit level, and clearly addresses a real failure mode. **But three concerns warrant resolution before this lands in prod**:

1. **The fallback-fire path is untested end-to-end.** Add one integration-style test that drives the connect ceremony with fake timers and asserts the chain: counter increments on timeout → at threshold, `resetSequenceNumbers()` is called → next Logon goes out with `141=Y` → counter resets to 0 on Logon Ack. This is the *only* path the PR exists to enable; not testing it is a real coverage gap.
2. **Loop guard.** If reset-fallback fires, then the post-reset Logon also times out (for any reason), counter rebuilds and we'll fire another reset. After 2–3 reset-fallback fires in a row, we should stop trying resets and escalate (alert + back off), not keep churning TrueX-side session state. ~10 lines.
3. **Decide default-on vs default-off explicitly.** Default-on means the first real validation is on prod. Default-off means we have to remember to flip it (and someone may forget during the next 8h outage at 02:00 UTC). My recommendation: **ship default-on** — the operational risk of the bug recurring is concrete and recent; the risk of the fallback misfiring is theoretical. But state that choice explicitly in the PR description and add a one-line CHANGELOG note so the change isn't silent.

These are not blockers — they're conditions to satisfy before merge. CONDITIONS section below.

## CONDITIONS

To upgrade verdict to PROCEED, one of:

- **A (preferred)**: Add (1) integration-style test for the fallback fire path, AND (2) escalate-after-N-resets loop guard. Re-run pre-push gate. Then PROCEED with default-on.
- **B (minimum)**: Add (2) loop guard only. Ship default-on. Plan a follow-up PR for (1) within the week. Accept that the first real validation may surface a bug that the integration test would have caught.
- **C (most conservative)**: Ship default-off, flip the env var on Hetzner only, watch one TrueX-side restart in the wild, then merge a follow-up that flips the default. Highest assurance, lowest urgency.

User is the operator and trades the exposure. Recommend **A** unless time-to-fix matters more than test depth.

## REASONING

The PR is operationally important and technically sound. The reason for PAUSE is not "this might be wrong" — it's "the change is exactly the kind of high-blast-radius safety-recovery code where the path that fixes the bug must be the path we test." The current test suite verifies the *building blocks* of the fix, not the *fix*. Adding the missing test is small. Adding the loop guard is small. The combined cost is well under an hour, and dramatically reduces the chance that the next prod incident finds a bug in the recovery code itself.
