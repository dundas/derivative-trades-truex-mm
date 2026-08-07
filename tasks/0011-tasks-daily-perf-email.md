# Task 0011 — Daily Email Digest with Reviewable Report Page

**Status**: in-progress
**Branch**: feat/daily-perf-email
**Date**: 2026-08-08
**Context**: Tasks 0007/0008 built the daily perf review + scheduled run, but outputs land
in local files and a brain inbox — no human-facing channel. Request: email a daily summary
with a link to a reviewable page.

## Infrastructure (verified present)

- **Email**: CircleInbox CLI installed + logged in; domains `liveport.dev` +
  `derivative.email` active (MX/SPF/DKIM/DMARC ✓). Sender mailbox created:
  `truex-mm@derivative.email`. Send: `circleinbox send --from --to --subject --text`.
- **Page**: Cloudflare Pages via wrangler (auth working). Dedicated project
  `truex-mm-reports` → `https://truex-mm-reports.pages.dev/`. Cumulative site archive in
  `logs/reports-site/` (gitignored) — each deploy publishes all archived reports.

## Design

`scripts/daily-perf-email.ts`:
1. Build yesterday's report (default) via the exported task-0007 functions
   (`fetchReportData` + `buildReport`) with operational era scoping
   (`since 2026-06-26`, seed `0.01812 @ 65383` — same constants as the job wrapper).
2. Build a 7-day trend (dayRealized, adverse bps, round-trip $/BTC, fills).
3. Render standalone HTML (inline CSS, verdict badge, metrics, trend table).
4. Write `logs/reports-site/<date>.html` + regenerate `index.html` (last 14 reports).
5. `wrangler pages deploy logs/reports-site --project-name truex-mm-reports`.
6. Email (only with `--send`): plain-text summary + page link from
   `truex-mm@derivative.email` to `--to`/`DAILY_REPORT_EMAIL`. Subject carries verdict +
   headline numbers.
Flags: `--date`, `--to`, `--send`, `--skip-deploy`, `--dry-run` (build only). Exit 0/2.

`scripts/daily-perf-review-job.sh`: chain the email step after the review; skip email
(noise-free) when `DAILY_REPORT_EMAIL` unset.

## Privacy note

Pages URLs are public-but-unguessable only by convention; report content (daily PnL of a
small account) is low-sensitivity. No index beyond the last-14 list. Documented here so
it's a decision, not an accident.

## Acceptance Criteria

- AC1: HTML renderer produces a standalone page with verdict, key metrics, 7-day trend (unit).
- AC2: subject line format carries verdict + headline numbers (unit).
- AC3: dry-run end-to-end produces the HTML file without deploy/send (smoke).
- AC4: full end-to-end: page reachable at pages.dev URL + email received (smoke, needs recipient).
- AC5: wrapper chains email step; absent DAILY_REPORT_EMAIL → skip with log line (smoke).
- AC6: full suite green.

## SO-13 note

Touches `scripts/` → docs PR required before merge.
