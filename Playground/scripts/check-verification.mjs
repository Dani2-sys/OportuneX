import assert from "node:assert/strict";

import { verificationEvaluationFixtures } from "../src/data/verification-evaluation-fixtures.js";
import { runVerificationEvaluationSuite } from "../src/domain/verification-evaluation.js";

const evaluation = runVerificationEvaluationSuite(verificationEvaluationFixtures);

assert.equal(
  evaluation.summary.passed,
  evaluation.summary.total,
  "expected all offline verification fixtures to pass"
);

console.log(JSON.stringify(evaluation.summary, null, 2));
