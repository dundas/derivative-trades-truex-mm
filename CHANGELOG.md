# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
with enhanced attribution to track which AI model/CLI made each change.

## [Unreleased]

### Added
- Added observe-only Gaussian inventory-control telemetry and bounded, opt-in maker-presence recovery (Codex GPT-5, 2026-08-21)
  - **Context:** [PRD 0014](tasks/0014-prd-continuous-market-maker-control.md) | Task 4.3
- Added authoritative exchange-capital reservations, acknowledged two-sided presence, fail-soft
  execution states, and configurable degraded-mode continuity controls (Codex, 2026-08-18)
  - **Context:** [PRD 0014](tasks/0014-prd-continuous-market-maker-control.md) | Tasks 2.0 and 3.1-3.4
- Added durable, restart-safe 1/5/60-minute Coinbase reference mark-outs, bounded coverage auditing, and a default-off production rollout switch (Codex, 2026-08-17)
  - **Context:** [PRD 0014](tasks/0014-prd-continuous-market-maker-control.md) | Tasks 5.1-5.2 | PR #74 | PR #75
- Added the offline regime strategy validator, JSON CLI, conservative evidence gates, and zero-dispatch smoke (Codex, 2026-08-17)
  - **Context:** PR #72; PRD 0014 tasks 5.3-5.6

### Fixed
- Made health report acknowledged two-sided maker presence separately from pricing-loop activity and prevented degraded-state restart loops (Codex GPT-5, 2026-08-21)
  - **Context:** [PRD 0014](tasks/0014-prd-continuous-market-maker-control.md) | Task 4.3
- Added TrueX FIX self-match prevention and local self-cross quote safeguards (Codex, 2026-06-23)
  - **Context:** PR #48

### Changed

### Deprecated

### Removed

### Security
- Pinned the production Bun base image and frozen dependency graph, patched Axios/WebSocket,
  removed unused vulnerable dependencies, and replaced the accidental transitive UUID runtime
  dependency with `node:crypto` (Codex, 2026-08-17)
  - **Context:** Production release preflight for PRD 0014 tasks 2.0, 3.0, and 5.1-5.2

---

## Format Notes

Each entry includes:
- **Description** - What was changed
- **Attribution** - Which AI model/CLI made the change
- **Date** - When the change was made (YYYY-MM-DD)
- **Context** (optional) - Links to PRD, task reference, or PR number

---

*Changelog initialized 2026-06-23*
