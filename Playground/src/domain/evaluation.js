import { analyzeOpportunity } from "./analysis.js";

function includes(haystack, needle) {
  return haystack?.includes(needle);
}

export function runEvaluationSuite(fixtures, runtime, now = new Date("2026-08-07T10:00:00+02:00")) {
  const results = fixtures.map((fixture) => {
    const outcome = analyzeOpportunity(fixture.company, fixture.opportunity, runtime, now);
    const match = outcome.bestMatch;
    const actionCode = match?.decision?.recommendedAction?.code ?? null;
    const fitBand = match?.fitBand ?? match?.recommendationClass ?? null;
    const decisionReason = match?.decision?.mainReason ?? null;
    const checks = [];
    const expected = fixture.expected;

    if ("active" in expected) {
      const active =
        Boolean(match) &&
        actionCode !== "DO_NOT_PURSUE";
      checks.push({
        label: "active state",
        pass: active === expected.active
      });
    }

    if (expected.fitBand || expected.recommendationClass) {
      const expectedFitBand = expected.fitBand ?? expected.recommendationClass;
      checks.push({
        label: "fit band",
        pass: fitBand === expectedFitBand
      });
    }

    if (expected.recommendedActionCode) {
      checks.push({
        label: "recommended action",
        pass: actionCode === expected.recommendedActionCode
      });
    }

    if (expected.rejectedReasonIncludes) {
      checks.push({
        label: "rejected reason",
        pass: includes(decisionReason, expected.rejectedReasonIncludes)
      });
    }

    if (expected.valueIncludes) {
      checks.push({
        label: "display value",
        pass: includes(match?.displayValueLabel, expected.valueIncludes)
      });
    }

    if (expected.companyAmountIncludes) {
      checks.push({
        label: "company amount",
        pass: includes(match?.companyAmountLabel, expected.companyAmountIncludes)
      });
    }

    if (expected.deadlineIncludes) {
      checks.push({
        label: "deadline text",
        pass: includes(match?.deadlineLabel ?? fixture.opportunity.deadline?.sourceText, expected.deadlineIncludes)
      });
    }

    if (expected.noFabricatedTime) {
      checks.push({
        label: "no fabricated time",
        pass: !match?.deadlineLabel?.includes("00:00")
      });
    }

    if (expected.hardBlocked) {
      checks.push({
        label: "hard blocker respected",
        pass: actionCode === "DO_NOT_PURSUE"
      });
    }

    const passed = checks.every((check) => check.pass);
    return {
      id: fixture.id,
      title: fixture.title,
      passed,
      checks,
      recommendedActionCode: actionCode,
      fitBand,
      recommendationClass: match?.recommendationClass ?? null,
      rejectedReason: decisionReason,
      relevant: expected.relevant
    };
  });

  const relevantFixtures = results.filter((result) => result.relevant);
  const recommendedRelevant = relevantFixtures.filter(
    (result) => result.recommendedActionCode && result.recommendedActionCode !== "DO_NOT_PURSUE"
  );
  const recommendedAll = results.filter(
    (result) => result.recommendedActionCode && result.recommendedActionCode !== "DO_NOT_PURSUE"
  );
  const hardBlockers = results.filter((result) => result.checks.some((check) => check.label === "hard blocker respected"));
  const moneyChecks = results.filter((result) =>
    result.checks.some((check) => ["display value", "company amount"].includes(check.label))
  );
  const deadlineChecks = results.filter((result) =>
    result.checks.some((check) => check.label === "no fabricated time" || check.label === "deadline text")
  );

  return {
    results,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.passed).length,
      candidateRecall:
        relevantFixtures.length === 0 ? 0 : Math.round((recommendedRelevant.length / relevantFixtures.length) * 100),
      recommendationPrecision:
        recommendedAll.length === 0
          ? 0
          : Math.round((recommendedAll.filter((result) => result.relevant).length / recommendedAll.length) * 100),
      hardBlockerAccuracy:
        hardBlockers.length === 0
          ? 100
          : Math.round(
              (hardBlockers.filter((result) => result.checks.find((check) => check.label === "hard blocker respected")?.pass)
                .length /
                hardBlockers.length) *
                100
            ),
      monetaryFieldAccuracy:
        moneyChecks.length === 0
          ? 100
          : Math.round(
              (moneyChecks.filter((result) =>
                result.checks.filter((check) => ["display value", "company amount"].includes(check.label)).every((check) => check.pass)
              ).length /
                moneyChecks.length) *
                100
            ),
      deadlineAccuracy:
        deadlineChecks.length === 0
          ? 100
          : Math.round(
              (deadlineChecks.filter((result) =>
                result.checks.filter((check) => check.label === "deadline text" || check.label === "no fabricated time").every((check) => check.pass)
              ).length /
                deadlineChecks.length) *
                100
            )
    }
  };
}
