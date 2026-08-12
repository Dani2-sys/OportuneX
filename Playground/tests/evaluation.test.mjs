import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { OPORTUNEX_RUNTIME: {} };

import { getRuntimeConfig } from "../src/config.js";
import { evaluationFixtures } from "../src/data/evaluation-fixtures.js";
import { runEvaluationSuite } from "../src/domain/evaluation.js";

test("evaluation suite keeps critical safety metrics at 100 percent", () => {
  const evaluation = runEvaluationSuite(evaluationFixtures, getRuntimeConfig());
  assert.equal(evaluation.summary.total, 25);
  assert.equal(evaluation.summary.passed, 25);
  assert.equal(evaluation.summary.hardBlockerAccuracy, 100);
  assert.equal(evaluation.summary.monetaryFieldAccuracy, 100);
  assert.equal(evaluation.summary.deadlineAccuracy, 100);
});
