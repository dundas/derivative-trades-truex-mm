#!/usr/bin/env bun
import { buildWeeklyPromotionReview } from '../src/analytics/weekly-promotion-review.js';
const review = buildWeeklyPromotionReview({ dailyReports: Array.from({ length: 7 }, (_, index) => ({ date: `2026-08-0${index + 1}`, verdict: { status: 'OK', reasons: [] } })), shadowReport: { recommendation: 'PROMOTE_CANDIDATE_FOR_HUMAN_APPROVAL', selectedCandidateId: 'synthetic' } });
if (review.productionChangeAuthorized || review.decision !== 'CANDIDATE_REQUIRES_OPERATOR_APPROVAL') throw new Error('Weekly review must not authorize a canary');
console.log('PASS: weekly review requires explicit operator approval and makes no production change');
