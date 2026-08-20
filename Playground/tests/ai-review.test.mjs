import test from "node:test";
import assert from "node:assert/strict";

import { getEvaluationNow } from "../src/clock.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import { buildAiVerificationSuccessResponse } from "../src/domain/ai-verification-response.js";
import {
  createAiVerificationContextFingerprint,
  extractPersistedAiVerificationResult,
  getAiReviewState,
  normalizeAiRun,
  upsertScopedAiReview
} from "../src/domain/ai-review.js";

function createRuntime() {
  return structuredClone(DEFAULT_RUNTIME);
}

function createFixture() {
  const state = createDemoState();
  return {
    company: structuredClone(state.companyProfiles[0]),
    opportunities: structuredClone(state.opportunities)
  };
}

function resolveAnalysis(company, opportunities, opportunityId = "opp-efficiency-grant") {
  const portfolio = analyzePortfolio(company, opportunities, createRuntime(), getEvaluationNow());
  const opportunity = opportunities.find((item) => item.id === opportunityId) ?? null;
  const analysis = portfolio.analysed.find((item) => item.opportunityId === opportunityId) ?? null;
  assert.ok(opportunity, `Expected opportunity ${opportunityId}`);
  assert.ok(analysis, `Expected analysis for ${opportunityId}`);
  return { portfolio, opportunity, analysis };
}

function createFixtureContext() {
  const fixture = createFixture();
  const primary = resolveAnalysis(fixture.company, fixture.opportunities, "opp-efficiency-grant");
  const secondary = resolveAnalysis(fixture.company, fixture.opportunities, "opp-multi-lot-framework");

  return {
    ...fixture,
    opportunity: primary.opportunity,
    analysis: primary.analysis,
    secondOpportunity: secondary.opportunity,
    secondAnalysis: secondary.analysis
  };
}

function fingerprintSnapshot(company, opportunities, opportunityId = "opp-efficiency-grant") {
  const { opportunity, analysis } = resolveAnalysis(company, opportunities, opportunityId);
  return {
    opportunity,
    analysis,
    fingerprint: createAiVerificationContextFingerprint(company, opportunity, analysis)
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

test("semantic AI fingerprints use the v4 version prefix", () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const fingerprint = createAiVerificationContextFingerprint(company, opportunity, analysis);

  assert.match(fingerprint, /^ai-context-v4:/);
});

test("a freshly saved V4 review remains current immediately after save and does not alter its own context fingerprint", () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const beforeFingerprint = createAiVerificationContextFingerprint(company, opportunity, analysis);
  const response = buildAiVerificationSuccessResponse({
    provider: "openai",
    model: "gpt-5.6-terra",
    derived_review_status: "accepted",
    aiRuntime: {
      provider: "openai",
      status: "connected",
      lastChecked: "2026-08-12T09:45:00.000Z",
      lastError: null
    },
    result: {
      protocol_version: "v4",
      findings: [
        {
          category: "money",
          disposition: "confirmed",
          severity: "informational",
          claim: "The monetary semantics remain correct.",
          company_impact: "For the active company, the published amount can be reviewed without reinterpreting contract semantics.",
          evidence_refs: ["analysis:money", "opportunity-evidence:ev-grant-lot-value"],
          recommended_follow_up: null
        }
      ],
      strongest_counterfactual: {
        exists: false,
        description: null,
        evidence_refs: [],
        would_change_fit_or_action: false
      },
      suggested_corrections: {
        action: null,
        fit_band: null,
        selected_lot_id: null
      },
      advisory_summary: "The deterministic assessment remains materially aligned with the current verification packet.",
      next_actions: [],
      confidence: "high"
    }
  });

  const aiRuns = upsertScopedAiReview([], {
    id: "ai-run-v4",
    companyId: company.id,
    opportunityId: opportunity.id,
    completedAt: "2026-08-12T09:45:00.000Z",
    result: extractPersistedAiVerificationResult(response),
    contextFingerprint: beforeFingerprint,
    sourceNoticeVersionId: opportunity.sourceNoticeVersionId ?? null
  });

  const afterFingerprint = createAiVerificationContextFingerprint(company, opportunity, analysis);
  const reviewState = getAiReviewState(aiRuns, company, opportunity, analysis);

  assert.equal(afterFingerprint, beforeFingerprint);
  assert.equal(reviewState.status, "current");
  assert.equal(reviewState.review.result.protocol_version, "v4");
  assert.equal(reviewState.review.result.derived_review_status, "accepted");
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

test("opportunity lastChecked changes do not stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  const changedOpportunity = opportunities.find((item) => item.id === initial.opportunity.id);
  changedOpportunity.lastChecked = "2026-08-07T06:45:00+02:00";

  const changed = fingerprintSnapshot(company, opportunities);

  assert.equal(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "current");
});

test("source refresh timestamps do not stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  const changedOpportunity = opportunities.find((item) => item.id === initial.opportunity.id);
  changedOpportunity.sources = changedOpportunity.sources.map((source, index) => ({
    ...source,
    lastChecked: `2026-08-07T0${index + 7}:45:00+02:00`,
    fetchedAt: `2026-08-07T0${index + 7}:46:00+02:00`,
    syncedAt: `2026-08-07T0${index + 7}:47:00+02:00`
  }));

  const changed = fingerprintSnapshot(company, opportunities);

  assert.equal(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "current");
});

test("evidence array reorder does not stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  const changedOpportunity = opportunities.find((item) => item.id === initial.opportunity.id);
  changedOpportunity.evidence = [...changedOpportunity.evidence].reverse();

  const changed = fingerprintSnapshot(company, opportunities);

  assert.equal(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "current");
});

test("source array reorder does not stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const changedOpportunity = opportunities.find((item) => item.id === "opp-efficiency-grant");
  changedOpportunity.sources = [
    {
      ...changedOpportunity.sources[0],
      id: "source-efficiency-grant-faq",
      title: "Grant FAQ summary",
      url: "https://official.oportunex.local/icaen-efficiency/faq",
      official: false
    },
    {
      ...changedOpportunity.sources[0],
      id: "source-efficiency-grant-notice"
    }
  ];
  changedOpportunity.evidence = [
    ...changedOpportunity.evidence,
    {
      ...changedOpportunity.evidence[0],
      id: "ev-grant-faq",
      fieldKey: "requirements",
      excerpt: "FAQ confirms the SME and co-finance requirements.",
      sourceId: "source-efficiency-grant-faq"
    }
  ];

  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  changedOpportunity.sources = [...changedOpportunity.sources].reverse();
  const changed = fingerprintSnapshot(company, opportunities);

  assert.equal(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "current");
});

test("company capability order and opportunity CPV order do not stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  company.capabilities = [...company.capabilities].reverse();
  const changedOpportunity = opportunities.find((item) => item.id === initial.opportunity.id);
  changedOpportunity.cpvCodes = [...changedOpportunity.cpvCodes].reverse();

  const changed = fingerprintSnapshot(company, opportunities);

  assert.equal(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "current");
});

test("saved AI review becomes stale when decision-relevant company facts change", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  company.preferences.idealProjectValue = (company.preferences.idealProjectValue ?? 0) + 5000;
  company.facts.idealProjectValue = {
    ...company.facts.idealProjectValue,
    value: (company.facts.idealProjectValue?.value ?? 0) + 5000
  };

  const changed = fingerprintSnapshot(company, opportunities);
  const reviewState = getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis);

  assert.notEqual(changed.fingerprint, initial.fingerprint);
  assert.equal(reviewState.status, "stale");
  assert.equal(reviewState.isStale, true);
  assert.match(reviewState.staleMessage, /changed since this AI review/i);
});

test("deadline changes stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  const changedOpportunity = opportunities.find((item) => item.id === initial.opportunity.id);
  changedOpportunity.deadline = {
    ...changedOpportunity.deadline,
    sourceText: "20/09/2026",
    date: "2026-09-20",
    time: null,
    utcEquivalent: null
  };

  const changed = fingerprintSnapshot(company, opportunities);

  assert.notEqual(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "stale");
});

test("contract value changes stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  const changedOpportunity = opportunities.find((item) => item.id === initial.opportunity.id);
  changedOpportunity.maximumAidPerBeneficiary = {
    ...changedOpportunity.maximumAidPerBeneficiary,
    amountMinor: changedOpportunity.maximumAidPerBeneficiary.amountMinor + 500000
  };

  const changed = fingerprintSnapshot(company, opportunities);

  assert.notEqual(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "stale");
});

test("eligibility requirement changes stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  const changedOpportunity = opportunities.find((item) => item.id === initial.opportunity.id);
  changedOpportunity.requirements = changedOpportunity.requirements.map((requirement, index) =>
    index === 0
      ? {
          ...requirement,
          requiredValue: "midcap"
        }
      : requirement
  );

  const changed = fingerprintSnapshot(company, opportunities);

  assert.notEqual(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "stale");
});

test("company capability changes stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  company.capabilities = company.capabilities.filter((capability) => capability.id !== "solar-pv");

  const changed = fingerprintSnapshot(company, opportunities);

  assert.notEqual(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "stale");
});

test("current employee and turnover fact changes stale a saved review", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  company.facts.employeeRange = {
    ...company.facts.employeeRange,
    min: 2,
    max: 4,
    referenceYear: 2026
  };
  company.facts.turnoverRange = {
    ...company.facts.turnoverRange,
    min: 200000,
    max: 400000,
    referenceYear: 2026
  };

  const changed = fingerprintSnapshot(company, opportunities);

  assert.notEqual(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "stale");
});

test("saved AI review becomes stale when the opportunity source notice version changes", () => {
  const { company, opportunities } = createFixture();
  const initial = fingerprintSnapshot(company, opportunities);
  const scopedReview = createScopedReview(company, initial.opportunity, initial.analysis);

  const changedOpportunity = opportunities.find((item) => item.id === initial.opportunity.id);
  changedOpportunity.sourceNoticeVersionId = `${changedOpportunity.sourceNoticeVersionId}-vnext`;

  const changed = fingerprintSnapshot(company, opportunities);

  assert.notEqual(changed.fingerprint, initial.fingerprint);
  assert.equal(getAiReviewState([scopedReview], company, changed.opportunity, changed.analysis).status, "stale");
});

test("deterministic recommended action changes stale a saved review", () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const scopedReview = createScopedReview(company, opportunity, analysis);
  const changedAnalysis = structuredClone(analysis);
  changedAnalysis.decision = {
    ...changedAnalysis.decision,
    recommendedAction: {
      ...changedAnalysis.decision.recommendedAction,
      code: "DO_NOT_PURSUE",
      bucket: "not_suitable"
    }
  };

  const initialFingerprint = createAiVerificationContextFingerprint(company, opportunity, analysis);
  const changedFingerprint = createAiVerificationContextFingerprint(company, opportunity, changedAnalysis);
  const reviewState = getAiReviewState([scopedReview], company, opportunity, changedAnalysis);

  assert.notEqual(changedFingerprint, initialFingerprint);
  assert.equal(reviewState.status, "stale");
});

test("presentation-only analysis label changes do not stale a saved review", () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const scopedReview = createScopedReview(company, opportunity, analysis);
  const relabeledAnalysis = structuredClone(analysis);
  relabeledAnalysis.displayTitle = "Presentation-only relabel";
  relabeledAnalysis.displayValueLabel = "Presentation-only value";
  relabeledAnalysis.companyAmountLabel = "Presentation-only company amount";
  relabeledAnalysis.locationLabel = "Presentation-only location";
  relabeledAnalysis.deadlineLabel = "Presentation-only deadline";
  relabeledAnalysis.scopeLabel = "Presentation-only scope";
  relabeledAnalysis.lotLabel = "Presentation-only lot";
  relabeledAnalysis.confidenceShield = {
    ...relabeledAnalysis.confidenceShield,
    criticalFieldSummary: "Presentation-only confidence copy."
  };

  const initialFingerprint = createAiVerificationContextFingerprint(company, opportunity, analysis);
  const relabeledFingerprint = createAiVerificationContextFingerprint(company, opportunity, relabeledAnalysis);
  const reviewState = getAiReviewState([scopedReview], company, opportunity, relabeledAnalysis);

  assert.equal(relabeledFingerprint, initialFingerprint);
  assert.equal(reviewState.status, "current");
});

test("saved v2 fingerprints remain stored but are treated as stale under v3", () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const v2Review = createScopedReview(company, opportunity, analysis, {
    contextFingerprint: "ai-context-v2:deadbeef"
  });

  const reviewState = getAiReviewState([v2Review], company, opportunity, analysis);

  assert.equal(reviewState.hasSavedReview, true);
  assert.equal(reviewState.status, "stale");
  assert.equal(reviewState.isStale, true);
});
