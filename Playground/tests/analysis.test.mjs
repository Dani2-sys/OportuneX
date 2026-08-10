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

  assert.equal(match.recommendationClass, "VERIFY_BEFORE_DECIDING");
  assert.equal(match.eligibilityStatus, "ELIGIBILITY_UNCLEAR");
  assert.ok(match.unknowns.some((item) => item.title === "At least one comparable public maintenance contract"));
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
