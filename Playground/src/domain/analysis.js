import { RECOMMENDATION_COPY } from "../config.js";
import { clamp, compareDesc } from "../utils.js";
import { daysRemaining, deriveStatus } from "./deadline.js";
import { extractClaims } from "./evidence.js";
import { evaluateEligibility } from "./eligibility.js";
import { buildFinancialPicture } from "./financial-picture.js";
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

function buildAdaptiveQuestions(eligibility) {
  return eligibility.requirementRows
    .filter((row) => row.status === "needs_verification" && row.mandatory)
    .map((row) => ({
      id: row.id,
      question:
        row.question ??
        `Can your company confirm the requirement: ${row.label}?`,
      why: row.why,
      options: ["Yes", "No", "Unsure", "Add later"]
    }));
}

function buildDeadlineSignal(opportunity, now) {
  const remaining = daysRemaining(opportunity.deadline, now);
  if (remaining == null) return "The published deadline is not clear enough to assess timing.";
  if (remaining < 0) return "The published deadline has already passed.";
  if (remaining === 0) return "The published deadline is today in Europe/Madrid.";
  return `The published deadline is ${remaining} calendar day${remaining === 1 ? "" : "s"} away in Europe/Madrid.`;
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

function fallbackDisplayValueLabel(opportunity) {
  const value = opportunity.relevantValue ?? opportunity.maximumAidPerBeneficiary ?? opportunity.estimatedValue;
  return value ? formatMoney(value) : "Value not published";
}

function fallbackLocationLabel(opportunity) {
  return (
    opportunity.location?.display ??
    [opportunity.location?.municipality, opportunity.location?.province].filter(Boolean).join(", ") ??
    "Location not published"
  );
}

function buildAnalysedItem(outcome) {
  const bestMatch = outcome.bestMatch;
  const opportunity = outcome.opportunity;
  const uiCategory = outcome.rejectedReason
    ? "not_suitable"
    : bestMatch?.recommendationClass === "VERIFY_BEFORE_DECIDING"
      ? "needs_verification"
      : "worth_attention";

  return {
    opportunity,
    opportunityId: opportunity.id,
    bestMatch,
    rejectedReason: outcome.rejectedReason,
    uiCategory,
    recommendationClass: bestMatch?.recommendationClass ?? "DO_NOT_PURSUE",
    eligibilityStatus: bestMatch?.eligibilityStatus ?? null,
    confidenceShield: bestMatch?.confidenceShield ?? null,
    priorityScore: bestMatch?.priorityScore ?? 0,
    matchScore: bestMatch?.matchScore ?? 0,
    displayTitle: bestMatch?.displayTitle ?? opportunity.title,
    displayValueLabel: bestMatch?.displayValueLabel ?? fallbackDisplayValueLabel(opportunity),
    companyAmountLabel: bestMatch?.companyAmountLabel ?? computeCompanyAmountLabel(opportunity),
    locationLabel: bestMatch?.locationLabel ?? fallbackLocationLabel(opportunity),
    deadlineLabel: bestMatch?.deadlineLabel ?? opportunity.deadline?.sourceText ?? "Not published",
    executiveVerdict:
      bestMatch?.executiveVerdict ??
      outcome.rejectedReason ??
      "The opportunity is not currently suitable for pursuit.",
    positives: bestMatch?.positives ?? [],
    blockers: bestMatch?.blockers ?? [],
    unknowns: bestMatch?.unknowns ?? [],
    adaptiveQuestions: bestMatch?.adaptiveQuestions ?? [],
    requirementRows: bestMatch?.requirementRows ?? [],
    primaryContact: bestMatch?.primaryContact ?? choosePrimaryContact(opportunity),
    rankLabel: bestMatch?.rankLabel ?? null,
    claims: bestMatch?.claims ?? [],
    reportMarkdown: bestMatch?.reportMarkdown ?? "",
    lotLabel: bestMatch?.lotLabel ?? opportunity.title,
    financialPicture: bestMatch?.financialPicture ?? null,
    analysisNow: bestMatch?.analysisNow ?? null,
    dimensions: bestMatch?.dimensions ?? null,
    preMortem: bestMatch?.preMortem ?? []
  };
}

function analyzeLot(company, opportunity, lot, runtime, now) {
  const semantic = scoreCapabilityFit(company, lot);
  const eligibility = evaluateEligibility(company, opportunity, lot, now);
  const dimensions = assembleDimensions(company, opportunity, lot, semantic, eligibility, now);
  const scores = computeScores({ runtime, ...dimensions });
  const recommendationClass = deriveRecommendation({
    status: opportunity.derivedStatus,
    eligibilityStatus: eligibility.eligibilityStatus,
    priorityScore: scores.priorityScore,
    confidenceShield: dimensions.confidenceShield,
    unknownCount: eligibility.unknowns.length,
    hardMandatoryNeedsVerification: eligibility.summary.hardMandatoryNeedsVerification,
    geographicFit: dimensions.geographicFit
  });

  const displayValue = lot.value ?? opportunity.maximumAidPerBeneficiary ?? opportunity.estimatedValue;
  const financialPicture = buildFinancialPicture(opportunity, lot);
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
    displayValueLabel: financialPicture.primaryLine?.displayValue ?? formatMoney(displayValue),
    companyAmountLabel: computeCompanyAmountLabel(opportunity),
    financialPicture,
    analysisNow: now.toISOString(),
    locationLabel:
      lot.location?.display ??
      opportunity.location?.display ??
      [opportunity.location?.municipality, opportunity.location?.province].filter(Boolean).join(", "),
    deadlineLabel: opportunity.deadline?.sourceText ?? "Not published",
    positives: [],
    blockers: [...eligibility.blockers],
    unknowns: [...eligibility.unknowns],
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
      detail: dimensions.scaleAssessment?.note ?? `${match.displayValueLabel} sits inside the company's realistic project range.`
    });
  }
  if (dimensions.financialScaleFit < 35) {
    match.blockers.push({
      title: "Scale fit concern",
      detail:
        dimensions.scaleAssessment?.note ??
        "The opportunity appears larger than the currently evidenced company delivery capacity.",
      severity: "medium"
    });
  }
  if (dimensions.deadlineFeasibility >= 70) {
    match.positives.push({
      title: "Deadline window",
      detail: buildDeadlineSignal(opportunity, now)
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
  match.reportMarkdown = generateReportMarkdown(company, opportunity, match, now);
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
    item.reportMarkdown = generateReportMarkdown(company, item.opportunity, item, now);
  });
  const rejected = analysed
    .filter((item) => item.rejectedReason)
    .map((item) => ({
      opportunity: item.opportunity,
      reason: item.rejectedReason,
      bestMatch: item.bestMatch
    }));
  const analysedItems = analysed
    .map((item) => buildAnalysedItem(item))
    .sort((left, right) => compareDesc(left.priorityScore, right.priorityScore) || left.displayTitle.localeCompare(right.displayTitle));
  const buckets = {
    worthAttention: analysedItems.filter((item) => item.uiCategory === "worth_attention"),
    needsVerification: analysedItems.filter((item) => item.uiCategory === "needs_verification"),
    notSuitable: analysedItems.filter((item) => item.uiCategory === "not_suitable"),
    allAnalysed: analysedItems
  };
  return {
    analysed: analysedItems,
    buckets,
    recommended,
    rejected,
    counts: {
      analysed: opportunities.length,
      worthAttention: buckets.worthAttention.length,
      needsVerification: buckets.needsVerification.length,
      notSuitable: buckets.notSuitable.length
    }
  };
}
