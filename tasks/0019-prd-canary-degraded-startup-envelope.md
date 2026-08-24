# 0019 — Canary Degraded-Startup Envelope

## Goal

Allow the existing fixed-size minimal live-maker canary to place its initial
L1 pair when the continuity controller is temporarily degraded solely because
the new process has no acknowledged quotes yet.

## Requirements

1. This change applies only while `MM_MINIMAL_LIVE_CANARY_ENABLED=true`.
2. The canary's L1 size remains its already-approved fixed 0.0005 BTC,
   including during a degraded continuity state.
3. Degraded price widening, depth reduction, maker-presence monitoring,
   capital caps, strict EBBO checks, post-only checks, and the final send
   boundary remain unchanged.
4. Disabled canary behavior and ordinary degraded quoting retain the existing
   degraded size factor.
5. Tests reproduce the startup degraded state and prove the canary produces
   exact-envelope L1 sizes on both sides without changing normal behavior.

## Non-goals

- Changing the canary fill cap, duration, level count, or pricing rule.
- Relaxing capital, inventory, continuity, or maker-safety protections.
- Retrying the failed production canary before review and deployment checks.
