# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
with enhanced attribution to track which AI model/CLI made each change.

## [Unreleased]

### Added
- Added durable, restart-safe 1/5/60-minute Coinbase reference mark-outs, bounded coverage auditing, and a default-off production rollout switch (Codex, 2026-08-17)
  - **Context:** [PRD 0014](tasks/0014-prd-continuous-market-maker-control.md) | Tasks 5.1-5.2 | PR #74 | PR #75
- Added the offline regime strategy validator, JSON CLI, conservative evidence gates, and zero-dispatch smoke (Codex, 2026-08-17)
  - **Context:** PR #72; PRD 0014 tasks 5.3-5.6

### Fixed
- Added TrueX FIX self-match prevention and local self-cross quote safeguards (Codex, 2026-06-23)
  - **Context:** PR #48

### Changed

### Deprecated

### Removed

### Security

---

## Format Notes

Each entry includes:
- **Description** - What was changed
- **Attribution** - Which AI model/CLI made the change
- **Date** - When the change was made (YYYY-MM-DD)
- **Context** (optional) - Links to PRD, task reference, or PR number

---

*Changelog initialized 2026-06-23*
