import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { OPORTUNEX_RUNTIME: {} };

import { getEvaluationNow } from "../src/clock.js";
import { getRuntimeConfig } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzeOpportunity, analyzePortfolio } from "../src/domain/analysis.js";
import { daysRemaining, parseSpanishDate } from "../src/domain/deadline.js";
import { createMoney } from "../src/domain/money.js";

function section(markdown, heading, nextHeading) {
  const start = markdown.indexOf(heading);
  if (start === -1) return "";
  const fromStart = markdown.slice(start);
  if (!nextHeading) return fromStart;
  const end = fromStart.indexOf(nextHeading);
  return end === -1 ? fromStart : fromStart.slice(0, end);
}

function makeContractOpportunity({ id, title, estimatedMajor, relevantMajor = null, lots = [] }) {
  return {
    id,
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title,
    description: "Electrical maintenance services.",
    location: {
      municipality: "Tarragona",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Tarragona"
    },
    cpvCodes: ["50711000", "45315300"],
    keywords: ["electrical maintenance"],
    deadline: parseSpanishDate("26/08/2026 14:00"),
    estimatedValue: createMoney({ major: estimatedMajor, amountType: "estimated_value", vatStatus: "excluding" }),
    relevantValue:
      relevantMajor == null
        ? null
        : createMoney({ major: relevantMajor, amountType: "relevant_lot_value", vatStatus: "excluding" }),
    duration: "12 months",
    guarantees: "None",
    lots,
    contacts: [],
    sources: [],
    evidence: [],
    requiredDocuments: [],
    documents: [],
    lastChecked: "2026-08-07T08:12:00+02:00",
    applicationUrl: "",
    noticeUrl: "",
    referenceNumber: `${id}-ref`
  };
}

function makeProgrammeBudgetOnlyGrant() {
  return {
    id: "bdns-programme-budget-only",
    sourceConnector: "bdns",
    sourceOpportunityId: "700007",
    sourceNoticeVersionId: "bdns-version:programme-budget-only",
    type: "grant",
    noticeType: "grant_call",
    status: "open",
    title: "Programme budget only grant",
    description: "Grant without a structured maximum aid per beneficiary.",
    publicationDate: "2026-08-10",
    deadline: parseSpanishDate("01/11/2026 23:59"),
    location: {
      municipality: "",
      province: "",
      autonomousCommunity: "Andalusia",
      display: "Andalusia"
    },
    cpvCodes: [],
    keywords: ["grant"],
    relevantValue: null,
    estimatedValue: null,
    awardValue: null,
    baseBudget: null,
    wholeProcedureValue: null,
    annualValue: null,
    multiYearValue: null,
    maximumAidPerBeneficiary: null,
    programmeBudget: createMoney({
      major: 10000000,
      currency: "EUR",
      amountType: "programme_budget",
      vatStatus: "unknown",
      source: "official_snpsap_api"
    }),
    eligibleProjectCost: null,
    aidIntensity: "",
    duration: "",
    guarantees: "",
    submissionMechanism: "Official electronic application site",
    applicationUrl: "https://sede.example.gob.es/grants/700007",
    noticeUrl: "https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/700007",
    referenceNumber: "700007",
    contacts: [],
    sources: [
      {
        id: "grant-source-700007",
        organisation: "Sistema Nacional de Publicidad de Subvenciones y Ayudas Publicas",
        title: "Official BDNS API",
        url: "https://www.infosubvenciones.es/bdnstrans/api/convocatorias?numConv=700007&vpd=GE",
        official: true
      }
    ],
    evidence: [],
    requirements: [],
    requiredDocuments: [],
    documents: [],
    sourceConflicts: [],
    availabilityWarnings: [],
    lots: [],
    cancellationStatus: null
  };
}

test("prefers relevant lot value over full procedure value", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const portfolio = analyzePortfolio(state.companyProfiles[0], state.opportunities, runtime, getEvaluationNow());
  const lotMatch = portfolio.recommended.find((item) => item.opportunityId === "opp-multi-lot-framework");
  assert.equal(lotMatch.displayValueLabel, "€96,000 excl. VAT");
});

test("does not present programme budget as company amount", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const portfolio = analyzePortfolio(state.companyProfiles[0], state.opportunities, runtime, getEvaluationNow());
  const grant = portfolio.recommended.find((item) => item.opportunityId === "opp-efficiency-grant");
  assert.ok(grant.companyAmountLabel.includes("€40,000"));
  assert.ok(!grant.companyAmountLabel.includes("10,000,000"));
});

test("programme-budget-only grants keep programme budget wording and never present it as company amount", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const result = analyzeOpportunity(state.companyProfiles[0], makeProgrammeBudgetOnlyGrant(), runtime, getEvaluationNow());

  assert.equal(result.bestMatch.financialPicture?.primaryLine?.label, "Programme budget");
  assert.match(result.bestMatch.reportMarkdown, /- Programme budget: €10,000,000/);
  assert.doesNotMatch(result.bestMatch.reportMarkdown, /Maximum aid per beneficiary: €10,000,000/);
  assert.doesNotMatch(result.bestMatch.companyAmountLabel, /10,000,000/);
});

test("demo portfolio keeps mutually exclusive opportunity scopes transparent", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const portfolio = analyzePortfolio(state.companyProfiles[0], state.opportunities, runtime, getEvaluationNow());

  assert.equal(portfolio.counts.analysed, 7);
  assert.equal(portfolio.buckets.allAnalysed.length, 7);
  assert.equal(portfolio.counts.worthAttention, 1);
  assert.equal(portfolio.counts.needsVerification, 3);
  assert.equal(portfolio.counts.notSuitable, 3);
  assert.equal(
    portfolio.buckets.worthAttention.length + portfolio.buckets.needsVerification.length + portfolio.buckets.notSuitable.length,
    7
  );
});

test("electrical maintenance demo now stops at verification for comparable public experience", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const portfolio = analyzePortfolio(state.companyProfiles[0], state.opportunities, runtime, getEvaluationNow());
  const match = portfolio.recommended.find((item) => item.opportunityId === "opp-electrical-maintenance");

  assert.equal(match.decision.recommendedAction.code, "VERIFY_BEFORE_DECIDING");
  assert.equal(match.decision.recommendedAction.bucket, "needs_verification");
  assert.equal(match.decision.match.band, match.recommendationClass);
  assert.equal(match.eligibilityStatus, "ELIGIBILITY_UNCLEAR");
  assert.ok(match.potentialHardBlockers.some((item) => item.title === "At least one comparable public maintenance contract"));
  assert.match(match.decision.mainReason, /Potential hard blocker/i);
});

test("expired opportunities remain hard-stopped as do-not-pursue decisions", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const portfolio = analyzePortfolio(state.companyProfiles[0], state.opportunities, runtime, getEvaluationNow());
  const match = portfolio.analysed.find((item) => item.opportunityId === "opp-expired-maintenance");

  assert.equal(match.decision.recommendedAction.code, "DO_NOT_PURSUE");
  assert.equal(match.decision.recommendedAction.bucket, "not_suitable");
  assert.equal(match.decision.mainReason, "Deadline passed");
  assert.ok(portfolio.buckets.notSuitable.some((item) => item.opportunityId === "opp-expired-maintenance"));
});

test("report keeps eligibility requirements separate from submission documents", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const portfolio = analyzePortfolio(state.companyProfiles[0], state.opportunities, runtime, getEvaluationNow());
  const match = portfolio.recommended.find((item) => item.opportunityId === "opp-electrical-maintenance");
  const opportunity = state.opportunities.find((item) => item.id === "opp-electrical-maintenance");
  const report = match.reportMarkdown;
  const requirementsSection = section(report, "### Eligibility / Qualification Requirements", "### Submission Documents");
  const submissionSection = section(report, "### Submission Documents", "### Preparation Items");

  assert.match(requirementsSection, /At least one comparable public maintenance contract/);
  assert.match(submissionSection, /Administrative declaration/);
  assert.doesNotMatch(submissionSection, /At least one comparable public maintenance contract/);
  assert.match(report, new RegExp(`\\*\\*Calendar days remaining:\\*\\* ${daysRemaining(opportunity.deadline, getEvaluationNow())}`));
  assert.doesNotMatch(report, /practical time/i);
});

test("financial picture keeps lot value, base budget and estimated total separate", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const portfolio = analyzePortfolio(state.companyProfiles[0], state.opportunities, runtime, getEvaluationNow());
  const match = portfolio.recommended.find((item) => item.opportunityId === "opp-electrical-maintenance");
  const lines = Object.fromEntries((match.financialPicture?.lines ?? []).map((line) => [line.id, line]));

  assert.equal(match.displayValueLabel, "€84,500 excl. VAT");
  assert.equal(match.financialPicture.primaryLine?.displayValue, "€84,500 excl. VAT");
  assert.equal(lines.base_budget?.displayValue, "€198,000 excl. VAT");
  assert.equal(lines.estimated_value?.displayValue, "€210,000 excl. VAT");
});

test("synthetic default lots do not relabel whole-contract estimated value as a relevant lot", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const opportunity = makeContractOpportunity({
    id: "opp-no-published-lots",
    title: "Standalone electrical maintenance contract",
    estimatedMajor: 100000
  });
  const result = analyzeOpportunity(state.companyProfiles[0], opportunity, runtime, getEvaluationNow());
  const lines = result.bestMatch.financialPicture?.lines ?? [];

  assert.equal(result.bestMatch.financialPicture?.primaryLine?.label, "Estimated contract value");
  assert.equal(result.bestMatch.displayValueLabel, "€100,000 excl. VAT");
  assert.ok(lines.every((line) => !line.label.startsWith("Relevant ")));
  assert.equal(lines.filter((line) => line.displayValue === "€100,000 excl. VAT").length, 1);
  assert.ok(!lines.some((line) => line.id === "estimated_value"));
  assert.equal(result.bestMatch.hasPublishedLot, false);
  assert.equal(result.bestMatch.lotLabel, null);
  assert.match(result.bestMatch.reportMarkdown, /\*\*Scope:\*\* Whole opportunity/);
  assert.doesNotMatch(result.bestMatch.reportMarkdown, /Relevant lot/i);
  assert.doesNotMatch(result.bestMatch.reportMarkdown, /lot value/i);
});

test("published lot value remains the primary relevant lot amount", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const lotValue = createMoney({ major: 25000, amountType: "relevant_lot_value", vatStatus: "excluding" });
  const opportunity = makeContractOpportunity({
    id: "opp-published-lot-primary",
    title: "Framework with published lot",
    estimatedMajor: 100000,
    lots: [
      {
        id: "lot-1",
        title: "Lot 1",
        description: "Electrical maintenance",
        cpvCodes: ["50711000", "45315300"],
        keywords: ["electrical maintenance"],
        value: lotValue,
        requirements: []
      }
    ]
  });
  const result = analyzeOpportunity(state.companyProfiles[0], opportunity, runtime, getEvaluationNow());
  const lines = Object.fromEntries((result.bestMatch.financialPicture?.lines ?? []).map((line) => [line.id, line]));

  assert.equal(result.bestMatch.financialPicture?.primaryLine?.label, "Relevant Lot 1");
  assert.equal(result.bestMatch.displayValueLabel, "€25,000 excl. VAT");
  assert.equal(lines.estimated_value?.displayValue, "€100,000 excl. VAT");
});

test("explicit lot locations are analysed independently and empty lot locations fall back to the top-level opportunity geography", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const opportunity = makeContractOpportunity({
    id: "opp-lot-location-audit",
    title: "Multi-lot location audit",
    estimatedMajor: 100000,
    lots: [
      {
        id: "lot-catalonia-fallback",
        title: "Lot Catalonia fallback",
        description: "Electrical maintenance in the main operating area.",
        cpvCodes: ["50711000", "45315300"],
        keywords: ["electrical maintenance"],
        value: createMoney({ major: 45000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        location: {},
        requirements: []
      },
      {
        id: "lot-andalusia-explicit",
        title: "Lot Andalusia explicit",
        description: "Electrical maintenance outside the main operating area.",
        cpvCodes: ["50711000", "45315300"],
        keywords: ["electrical maintenance"],
        value: createMoney({ major: 45000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        location: {
          municipality: "Seville",
          province: "Seville",
          autonomousCommunity: "Andalusia",
          display: "Seville"
        },
        requirements: []
      }
    ]
  });

  const result = analyzeOpportunity(state.companyProfiles[0], opportunity, runtime, getEvaluationNow());
  const byLotId = Object.fromEntries(result.lotMatches.map((lotMatch) => [lotMatch.lotId, lotMatch]));

  assert.equal(result.lotMatches.length, 2);
  assert.equal(byLotId["lot-catalonia-fallback"].locationLabel, "Tarragona");
  assert.equal(byLotId["lot-andalusia-explicit"].locationLabel, "Seville");
  assert.notEqual(
    byLotId["lot-catalonia-fallback"].locationLabel,
    byLotId["lot-andalusia-explicit"].locationLabel
  );
  assert.ok(
    byLotId["lot-catalonia-fallback"].dimensions.geographicFit >
      byLotId["lot-andalusia-explicit"].dimensions.geographicFit
  );
  assert.equal(
    result.bestMatch.priorityScore,
    Math.max(...result.lotMatches.map((lotMatch) => lotMatch.priorityScore))
  );
});

test("award notices keep awarded value semantics and suppress active-pursuit blockers", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const opportunity = makeContractOpportunity({
    id: "opp-award-value-only",
    title: "Award notice for electrical maintenance",
    estimatedMajor: 100000
  });
  opportunity.noticeType = "award_notice";
  opportunity.status = "awarded";
  opportunity.publicationDate = "2026-08-06";
  opportunity.deadline = null;
  opportunity.estimatedValue = null;
  opportunity.relevantValue = null;
  opportunity.awardValue = createMoney({ major: 300000, amountType: "award_value", vatStatus: "excluding" });

  const result = analyzeOpportunity(state.companyProfiles[0], opportunity, runtime, getEvaluationNow());
  const lines = Object.fromEntries((result.bestMatch.financialPicture?.lines ?? []).map((line) => [line.id, line]));

  assert.equal(result.bestMatch.financialPicture?.primaryLine?.label, "Awarded contract value");
  assert.equal(result.bestMatch.displayValueLabel, "€300,000 excl. VAT");
  assert.equal(lines.award_value, undefined);
  assert.ok(!result.bestMatch.risks.some((risk) => ["missing-contact", "missing-submission-route"].includes(risk.id)));
  assert.ok(result.bestMatch.preMortem.every((item) => !/preparation window|requirement load/i.test(item)));
  assert.equal(result.bestMatch.decision.recommendedAction.code, "DO_NOT_PURSUE");
  assert.equal(result.bestMatch.decision.mainReason, "Already awarded / not an open opportunity.");
});

test("guarantees without linked evidence are explicitly marked as unverified", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const opportunity = makeContractOpportunity({
    id: "opp-unverified-guarantee",
    title: "Contract with unlinked guarantee",
    estimatedMajor: 100000
  });
  opportunity.guarantees = "Definitive guarantee 5%";

  const result = analyzeOpportunity(state.companyProfiles[0], opportunity, runtime, getEvaluationNow());

  assert.match(result.bestMatch.reportMarkdown, /Guarantees: Definitive guarantee 5% \(unverified from linked sources\)/);
});

test("report marks potential hard blockers as not yet assessable when qualification requirements were not retrieved", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const opportunity = makeContractOpportunity({
    id: "opp-no-retrieved-requirements",
    title: "Contract without retrieved qualification dossier",
    estimatedMajor: 100000
  });

  const result = analyzeOpportunity(state.companyProfiles[0], opportunity, runtime, getEvaluationNow());

  assert.equal(result.bestMatch.eligibilityStatus, "ELIGIBILITY_NOT_ASSESSED");
  assert.match(
    result.bestMatch.reportMarkdown,
    /Potential hard blockers: Not yet assessable - qualification requirements have not been retrieved\./
  );
  assert.doesNotMatch(result.bestMatch.reportMarkdown, /Potential hard blockers: None recorded/);
});

test("confidence shield does not overstate verification when a hard gate is unresolved", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const opportunity = makeContractOpportunity({
    id: "opp-high-source-low-eligibility",
    title: "High-source-evidence contract",
    estimatedMajor: 100000,
    lots: [
      {
        id: "lot-1",
        title: "Lot 1",
        description: "Electrical maintenance",
        cpvCodes: ["50711000", "45315300"],
        keywords: ["electrical maintenance"],
        value: createMoney({ major: 100000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        requirements: [
          {
            id: "req-hard-classification",
            kind: "custom",
            label: "Required specialist classification",
            mandatory: true,
            gating: "hard",
            evidenceIds: []
          }
        ]
      }
    ]
  });
  opportunity.contacts = [{ role: "authority", name: "Ajuntament", email: "authority@example.com" }];
  opportunity.sources = [{ id: "src-1", organisation: "Ajuntament", title: "Official notice", url: "https://example.com", official: true, publishedAt: "2026-08-01", lastChecked: "2026-08-07T08:00:00Z" }];
  opportunity.noticeUrl = "https://example.com";
  opportunity.applicationUrl = "https://example.com/apply";
  opportunity.evidence = [
    "status",
    "deadline",
    "lot_value",
    "location",
    "requirements",
    "submission_route",
    "official_notice",
    "contacts"
  ].map((fieldKey, index) => ({
    id: `ev-${index + 1}`,
    fieldKey,
    excerpt: `${fieldKey} evidence`,
    sourceId: "src-1",
    confidence: 0.95
  }));

  const result = analyzeOpportunity(state.companyProfiles[0], opportunity, runtime, getEvaluationNow());

  assert.equal(result.bestMatch.confidenceShield.dataConfidence, "HIGH");
  assert.notEqual(result.bestMatch.confidenceShield.eligibilityConfidence, "HIGH");
  assert.notEqual(result.bestMatch.confidenceShield.decisionConfidence, "HIGH");
  assert.match(
    result.bestMatch.confidenceShield.criticalFieldSummary,
    /qualification or specialist-scope evidence remains incomplete/i
  );
  assert.doesNotMatch(result.bestMatch.reportMarkdown, /All critical fields verified/i);
  assert.match(result.bestMatch.reportMarkdown, /Critical field summary: Source-critical dossier fields are evidenced, but qualification or specialist-scope evidence remains incomplete\./i);
});
