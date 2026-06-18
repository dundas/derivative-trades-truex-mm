---
generated_at: "2026-06-18T10:07:36-05:00"
repo: "true_markets_mm"
repo_remote: "https://github.com/dundas/derivative-trades-truex-mm.git"
git_branch: "docs/0006-data-source-spike"
git_commit: "f2b6913"
harness: "codex"
cli: "bun 1.3.3; bash"
model: "unknown"
review_subject: "Commit live 0.0 data-source spike findings into tasks/tasks-0006-prd-cross-venue-opportunistic-take.md"
---

PROPOSED: Commit the live 2026-06-18 data-source findings into the 0006 task list, then open a docs-only PR before starting implementation branches.

REASON: The current task list still encodes disproven assumptions about TrueX `/market/quote`, the existence of a public trade tape, and Coinbase `PYUSD-USD`. Standard workflow requires planning artifacts to be durable before moving to implementation.

REQUESTER: User (Kefentse)

AGAINST:
1. The findings could be incomplete or overfit to a single prod sample, causing the task list to lock in a bad design.
2. Updating the task list before implementation adds process overhead if the team already understands the findings informally.
3. A docs PR could distract from shipping `1.0` if the repo treats planning updates as bureaucracy.
4. Marking `0.0` complete is only valid if the evidence is already captured well enough for another engineer to proceed without rerunning discovery.

ASSUMPTIONS:
- [VERIFIED] Live prod `/market/quote` returned the nested array payload described in the task update.
- [VERIFIED] Live prod `/market/trade` returned public recent prints for `BTC-PYUSD`.
- [VERIFIED] Coinbase Exchange reports `PYUSD-USD` as delisted and its websocket rejects the subscription.
- [VERIFIED] Kraken public ticker `PYUSDUSD` was live during the spike.
- [VERIFIED] The task document now records those findings and updates the downstream task design.
- [ASSUMED] No stronger or newer contradictory evidence exists elsewhere in the repo.

COMPLIANCE PATTERNS:
- Authority: present but acceptable. The user asked to proceed, but the change is independently justified by the protocol and the evidence gap.
- Incrementalism: mitigated. This PR does not smuggle implementation into a docs branch; it only reconciles planning artifacts.

VERDICT: PROCEED

REASONING: The main risk is starting `1.0` and `2.0a` from false premises. Committing the spike findings reduces that risk and satisfies the durable-planning checkpoint in the standard workflow. The scope stays appropriately narrow because no runtime code changes are introduced here.

CONDITIONS:
1. Keep this PR docs-only.
2. Do not claim the findings are generic beyond the observed 2026-06-18 probes.
3. Start implementation from a fresh feature branch after this PR lands, not from the docs branch.
