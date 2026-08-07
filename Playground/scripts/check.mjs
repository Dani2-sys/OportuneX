import assert from "node:assert/strict";

import { getRuntimeConfig } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { evaluationFixtures } from "../src/data/evaluation-fixtures.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import { runEvaluationSuite } from "../src/domain/evaluation.js";

globalThis.window = { OPORTUNEX_RUNTIME: {} };

const runtime = getRuntimeConfig();
const state = createDemoState();
const company = state.companyProfiles[0];
const portfolio = analyzePortfolio(company, state.opportunities, runtime, new Date("2026-08-07T10:00:00+02:00"));
const evaluation = runEvaluationSuite(evaluationFixtures, runtime);

assert.ok(portfolio.recommended.length >= 3, "expected at least three recommended opportunities");
assert.equal(
  portfolio.recommended.find((item) => item.opportunityId === "opp-multi-lot-framework")?.displayValueLabel,
  "€96,000 excl. VAT",
  "lot-level relevant value should override whole-procedure value"
);
assert.ok(
  portfolio.recommended.find((item) => item.opportunityId === "opp-efficiency-grant")?.companyAmountLabel.includes("€40,000"),
  "grant company amount must use the beneficiary maximum, not programme budget"
);
assert.equal(evaluation.summary.hardBlockerAccuracy, 100, "hard blockers must be fully respected in fixtures");
assert.equal(evaluation.summary.monetaryFieldAccuracy, 100, "money fields should pass all fixture checks");
assert.equal(evaluation.summary.deadlineAccuracy, 100, "deadline safety should pass all fixture checks");

console.log(JSON.stringify(
  {
    recommended: portfolio.recommended.length,
    rejected: portfolio.rejected.length,
    evaluation: evaluation.summary
  },
  null,
  2
));
