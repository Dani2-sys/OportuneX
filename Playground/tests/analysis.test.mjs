import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { OPORTUNEX_RUNTIME: {} };

import { getEvaluationNow } from "../src/clock.js";
import { getRuntimeConfig } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import { daysRemaining } from "../src/domain/deadline.js";

function section(markdown, heading, nextHeading) {
  const start = markdown.indexOf(heading);
  if (start === -1) return "";
  const fromStart = markdown.slice(start);
  if (!nextHeading) return fromStart;
  const end = fromStart.indexOf(nextHeading);
  return end === -1 ? fromStart : fromStart.slice(0, end);
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
