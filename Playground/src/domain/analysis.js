import { RECOMMENDATION_COPY } from "../config.js";
import { clamp, compareDesc } from "../utils.js";
import { deriveStatus } from "./deadline.js";
import { extractClaims } from "./evidence.js";
import { evaluateEligibility } from "./eligibility.js";
import { formatMoney, moneyToMajor } from "./money.js";
import { assembleDimensions, computeScores, deriveRecommendation } from "./scoring.js";
import { scoreCapabilityFit } from "./semantic.js";
import { executiveVerdict, generateReportMarkdown } from "./report.js";

function defaultLot(opportunity) {
  return {
    id: `${opportunity.id}-root`,
    title: opportunity.title,
    description: opportunity.description,
    cpvCodes: opportunity.cpvCodes ?? [],
    value: opportunity.relevantValue ?? opportunity.maximumAidPerBeneficiary ?? opportunity.estimatedValue,
    requirements: []
  };
}

function severityForUnknowns(unknowns) {
  return unknowns.map((item) => ({
    ...item,
    severity: "medium"
  }));
}

function buildAdaptiveQuestions(eligibility) {
  return eligibility.requirementRows
    .filter((row) => row.status === "needs_verification" && row.mandatory)
    .map((row) => ({
      id: row.id,
      question:
        row.question ??
        `Can your company confirm the requirement: ${row.label}?`,
      options: ["Yes", "No", "Unsure", "Add later"]
    }));
}

function buildPreMortem(match) {
  const items = [];
  if (match.blockers.length) items.push(`A confirmed blocker remains unresolved: ${match.blockers[0].title}.`);
  if (match.unknowns.length) items.push(`A mandatory fact stays unknown: ${match.unknowns[0].title}.`);
  if (match.dimensions.deadlineFeasibility < 50)
    items.push("The preparation window may be too short for a careful submission.");
  if (match.dimensions.applicationEffort < 45)
    items.push("The published requirement load looks heavy relative to the likely return.");
  return items.slice(0, 3);
}

function choosePrimaryContact(opportunity) {
  return (
    (opportunity.contacts ?? []).find((contact) => contact.role === "authority") ??
    (opportunity.contacts ?? []).find((contact) => contact.role === "submission") ??
    null
  );
}

function computeCompanyAmountLabel(opportunity) {
  if (opportunity.type === "grant") {
    return opportunity.maximumAidPerBeneficiary
      ? `Up to ${formatMoney(opportunity.maximumAidPerBeneficiary)}`
      : "Potential company amount: Not determined from published information";
  }
  return "Not a grant";
}

function analyzeLot(company, opportunity, lot, runtime, now) {
  const semantic = scoreCapabilityFit(company, lot);
  const eligibility = evaluateEligibility(company, opportunity, lot);
  const dimensions = assembleDimensions(company, opportunity, lot, semantic, eligibility, now);
  const scores = computeScores({ runtime, ...dimensions });
  const recommendationClass = deriveRecommendation({
    status: opportunity.derivedStatus,
    eligibilityStatus: eligibility.eligibilityStatus,
    priorityScore: scores.priorityScore,
    confidenceShield: dimensions.confidenceShield,
    unknownCount: eligibility.unknowns.length
  });

  const displayValue = lot.value ?? opportunity.maximumAidPerBeneficiary ?? opportunity.estimatedValue;
  const match = {
    id: `${company.id}:${opportunity.id}:${lot.id}`,
    opportunityId: opportunity.id,
    companyId: company.id,
    lotId: lot.id,
    recommendationClass,
    recommendationLabel: RECOMMENDATION_COPY[recommendationClass],
    eligibilityStatus: eligibility.eligibilityStatus,
    dimensions,
    confidenceShield: dimensions.confidenceShield,
    matchScore: scores.matchScore,
    priorityScore: scores.priorityScore,
    displayTitle: lot.title !== opportunity.title ? `${opportunity.title} — ${lot.title}` : opportunity.title,
    lotLabel: lot.title,
    displayValueLabel: formatMoney(displayValue),
    companyAmountLabel: computeCompanyAmountLabel(opportunity),
    locationLabel:
      lot.location?.display ??
      opportunity.location?.display ??
      [opportunity.location?.municipality, opportunity.location?.province].filter(Boolean).join(", "),
    deadlineLabel: opportunity.deadline?.sourceText ?? "Not published",
    positives: [],
    blockers: [...eligibility.blockers],
    unknowns: severityForUnknowns(eligibility.unknowns),
    adaptiveQuestions: buildAdaptiveQuestions(eligibility),
    requirementRows: eligibility.requirementRows,
    primaryContact: choosePrimaryContact(opportunity),
    rankLabel: "#1",
    claims: [],
    verificationRequired:
      scores.priorityScore >= runtime.verification.priorityThreshold ||
      (displayValue && moneyToMajor(displayValue) >= runtime.verification.valueThresholdEur) ||
      dimensions.confidenceShield.label !== "HIGH" ||
      eligibility.unknowns.length > 0
  };

  if (semantic.matchedCapabilities.length) {
    match.positives.push({
      title: "Capability match",
      detail: `Matched capabilities: ${semantic.matchedCapabilities.map((item) => item.label).join(", ")}.`
    });
  }
  if (dimensions.geographicFit >= 70) {
    match.positives.push({
      title: "Geographic fit",
      detail: `${match.locationLabel} is compatible with the company working radius and accepted regions.`
    });
  }
  if (dimensions.financialScaleFit >= 70) {
    match.positives.push({
      title: "Scale fit",
      detail: `${match.displayValueLabel} sits inside the company's realistic project range.`
    });
  }
  if (dimensions.deadlineFeasibility >= 70) {
    match.positives.push({
      title: "Deadline currently feasible",
      detail: "The published deadline still leaves practical time for a review and decision."
    });
  }
  if (dimensions.evidenceQuality < 50) {
    match.unknowns.push({
      title: "Evidence quality",
      detail: "Several critical facts still need stronger source confirmation.",
      severity: "medium"
    });
  }
  if (!match.blockers.length && recommendationClass === "DO_NOT_PURSUE") {
    match.blockers.push({
      title: "Weak overall fit",
      detail: "The opportunity remains technically related but not strong enough to justify pursuit.",
      severity: "medium"
    });
  }

  match.preMortem = buildPreMortem(match);
  match.executiveVerdict = executiveVerdict(company, opportunity, match);
  match.claims = extractClaims(opportunity, lot, match);
  match.reportMarkdown = generateReportMarkdown(company, opportunity, match);
  return match;
}

export function analyzeOpportunity(company, opportunity, runtime, now = new Date()) {
  const derivedStatus = deriveStatus(opportunity, now);
  const enriched = {
    ...opportunity,
    derivedStatus
  };

  if (["closed", "cancelled", "awarded", "suspended"].includes(derivedStatus)) {
    return {
      opportunity: enriched,
      bestMatch: null,
      lotMatches: [],
      rejectedReason:
        derivedStatus === "closed"
          ? "Deadline passed"
          : derivedStatus === "cancelled"
            ? "Cancelled"
            : derivedStatus === "awarded"
              ? "Award notice rather than active opportunity"
              : "Suspended"
    };
  }

  const lots = opportunity.lots?.length ? opportunity.lots : [defaultLot(opportunity)];
  const lotMatches = lots.map((lot) => analyzeLot(company, enriched, lot, runtime, now));
  lotMatches.sort((left, right) => compareDesc(left.priorityScore, right.priorityScore));
  const bestMatch = lotMatches[0];

  if (bestMatch.dimensions.capabilityFit < 18) {
    return {
      opportunity: enriched,
      bestMatch,
      lotMatches,
      rejectedReason: "Unrelated capability"
    };
  }

  if (bestMatch.dimensions.financialScaleFit === 0) {
    return {
      opportunity: enriched,
      bestMatch,
      lotMatches,
      rejectedReason: "Contract too large"
    };
  }

  return {
    opportunity: enriched,
    bestMatch,
    lotMatches,
    rejectedReason:
      bestMatch.recommendationClass === "LOW_PRIORITY" || bestMatch.recommendationClass === "DO_NOT_PURSUE"
        ? bestMatch.blockers[0]?.title ?? "Low fit"
        : null
  };
}

export function analyzePortfolio(company, opportunities, runtime, now = new Date()) {
  const analysed = opportunities.map((opportunity) => analyzeOpportunity(company, opportunity, runtime, now));
  const recommended = analysed
    .filter((item) => item.bestMatch && !item.rejectedReason)
    .map((item, index) => ({
      ...item.bestMatch,
      rankLabel: `#${index + 1}`,
      opportunity: item.opportunity
    }))
    .sort((left, right) => compareDesc(left.priorityScore, right.priorityScore));
  recommended.forEach((item, index) => {
    item.rankLabel = `#${index + 1}`;
    item.reportMarkdown = generateReportMarkdown(company, item.opportunity, item);
  });
  const rejected = analysed
    .filter((item) => item.rejectedReason)
    .map((item) => ({
      opportunity: item.opportunity,
      reason: item.rejectedReason,
      bestMatch: item.bestMatch
    }));
  return {
    recommended,
    rejected,
    counts: {
      analysed: opportunities.length,
      worthAttention: recommended.filter((item) =>
        ["EXCELLENT_FIT", "STRONG_FIT", "POSSIBLE_FIT", "VERIFY_BEFORE_DECIDING"].includes(item.recommendationClass)
      ).length
    }
  };
}
