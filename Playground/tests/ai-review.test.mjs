import test from "node:test";
import assert from "node:assert/strict";

import { getEvaluationNow } from "../src/clock.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import {
  createAiVerificationContextFingerprint,
  getAiReviewState,
  normalizeAiRun,
  upsertScopedAiReview
} from "../src/domain/ai-review.js";

function createRuntime() {
  return structuredClone(DEFAULT_RUNTIME);
}

function createFixtureContext() {
  const state = createDemoState();
  const company = structuredClone(state.companyProfiles[0]);
  const opportunity = state.opportunities.find((item) => item.id === "opp-efficiency-grant");
  const secondOpportunity = state.opportunities.find((item) => item.id === "opp-multi-lot-framework");
  const portfolio = analyzePortfolio(company, state.opportunities, createRuntime(), getEvaluationNow());
  const analysis = portfolio.analysed.find((item) => item.opportunityId === opportunity.id);
  const secondAnalysis = portfolio.analysed.find((item) => item.opportunityId === secondOpportunity.id);

  return {
    company,
    opportunity,
    secondOpportunity,
    analysis,
    secondAnalysis
  };
}

function createScopedReview(company, opportunity, analysis, overrides = {}) {
  return upsertScopedAiReview([], {
    id: overrides.id ?? "ai-run-1",
    companyId: overrides.companyId ?? company.id,
    opportunityId: overrides.opportunityId ?? opportunity.id,
    completedAt: overrides.completedAt ?? "2026-08-12T08:30:00.000Z",
    result: {
      review_status: "accepted",
      confidence: "medium",
      notes: "Stored scoped review.",
      ...(overrides.result ?? {})
    },
    contextFingerprint:
      overrides.contextFingerprint ?? createAiVerificationContextFingerprint(company, opportunity, analysis),
    sourceNoticeVersionId: overrides.sourceNoticeVersionId ?? opportunity.sourceNoticeVersionId ?? null
  })[0];
}

test("upsertScopedAiReview replaces an existing company-opportunity pair instead of growing duplicates", () => {
  const { company, opportunity, secondOpportunity, analysis, secondAnalysis } = createFixtureContext();
  const first = createScopedReview(company, opportunity, analysis, {
    id: "ai-run-first",
    completedAt: "2026-08-12T08:30:00.000Z",
    result: {
      notes: "First review."
    }
  });
  const differentPair = createScopedReview(company, secondOpportunity, secondAnalysis, {
    id: "ai-run-second-opportunity"
  });

  const next = upsertScopedAiReview([first, differentPair], {
    id: "ai-run-first-rerun",
    companyId: company.id,
    opportunityId: opportunity.id,
    completedAt: "2026-08-12T09:45:00.000Z",
    result: {
      review_status: "accepted",
      confidence: "high",
      notes: "Updated review."
    },
    contextFingerprint: createAiVerificationContextFingerprint(company, opportunity, analysis),
    sourceNoticeVersionId: opportunity.sourceNoticeVersionId ?? null
  });

  assert.equal(next.length, 2);
  assert.equal(next[0].id, "ai-run-first-rerun");
  assert.equal(next[0].result.notes, "Updated review.");
  assert.equal(
    next.filter((item) => item.companyId === company.id && item.opportunityId === opportunity.id).length,
    1
  );
});

test("AI review state is scoped by company and opportunity while legacy unscoped runs stay non-authoritative", () => {
  const { company, opportunity, secondOpportunity, analysis, secondAnalysis } = createFixtureContext();
  const scopedReview = createScopedReview(company, opportunity, analysis);
  const otherCompany = structuredClone(company);
  otherCompany.id = "company-b";
  otherCompany.legalName = "Second Company SL";
  otherCompany.tradingName = "Second Company";
  const legacyReview = normalizeAiRun({
    id: "legacy-ai-review",
    opportunityId: opportunity.id,
    completedAt: "2026-08-12T07:30:00.000Z",
    result: {
      review_status: "accepted",
      notes: "Legacy unscoped review."
    }
  });

  assert.equal(getAiReviewState([scopedReview], company, opportunity, analysis).status, "current");
  assert.equal(getAiReviewState([scopedReview], otherCompany, opportunity, analysis).status, "missing");
  assert.equal(getAiReviewState([scopedReview], company, secondOpportunity, secondAnalysis).status, "missing");

  const legacyState = getAiReviewState([legacyReview], company, opportunity, analysis);
  assert.equal(legacyState.status, "missing");
  assert.equal(legacyState.isLegacyAvailable, true);
});

test("saved AI review becomes stale when decision-relevant company facts change", () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const scopedReview = createScopedReview(company, opportunity, analysis);
  const changedCompany = structuredClone(company);
  changedCompany.preferences.idealProjectValue = (changedCompany.preferences.idealProjectValue ?? 0) + 5000;

  const reviewState = getAiReviewState([scopedReview], changedCompany, opportunity, analysis);

  assert.equal(reviewState.status, "stale");
  assert.equal(reviewState.isStale, true);
  assert.match(reviewState.staleMessage, /changed since this AI review/i);
});

test("saved AI review becomes stale when the opportunity source notice version changes", () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const scopedReview = createScopedReview(company, opportunity, analysis);
  const changedOpportunity = structuredClone(opportunity);
  changedOpportunity.sourceNoticeVersionId = `${opportunity.sourceNoticeVersionId ?? opportunity.id}-v2`;

  const reviewState = getAiReviewState([scopedReview], company, changedOpportunity, analysis);

  assert.equal(reviewState.status, "stale");
  assert.equal(reviewState.isStale, true);
});
