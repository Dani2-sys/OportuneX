import { DEFAULT_RUNTIME } from "../config.js";
import { clamp, weightedAverage } from "../utils.js";
import { getCompanyFact, getFactValue } from "./company-profile.js";
import { deadlineFeasibilityScore } from "./deadline.js";
import { assessScaleFit } from "./money.js";
import { resolveLotOrOpportunityLocation } from "./opportunity-scope.js";
import { buildConfidenceShield } from "./evidence.js";
import { qualificationReadinessScore } from "./eligibility.js";

function normalizeRegion(value = "") {
  return value.toString().trim().toLowerCase();
}

const SPECIALIST_REQUIREMENT_KINDS = new Set([
  "certification",
  "experience_value",
  "comparable_experience",
  "public_experience",
  "insurance",
  "custom"
]);

function specialistRequirementRows(eligibility) {
  return (eligibility.requirementRows ?? []).filter((row) => {
    if (SPECIALIST_REQUIREMENT_KINDS.has(row.kind)) return true;
    if ((row.requiredCapabilities?.length ?? 0) > 0) return true;
    if ((row.requiredCpvPrefixes?.length ?? 0) > 0) return true;
    if (row.comparableScopeRequired) return true;
    if (row.publicOnly) return true;
    return false;
  });
}

function specialistCapabilityConfidence(semantic, eligibility) {
  if (!semantic.matchedCapabilities.length) return 0;
  const total = semantic.matchedCapabilities.reduce((sum, capability) => {
    const statusWeight =
      capability.status === "company_confirmed"
        ? 1
        : capability.status === "public_verified"
          ? 0.72
          : capability.status === "public_reported"
            ? 0.58
            : capability.status === "inferred"
              ? 0.42
              : capability.status === "conflicted"
                ? 0.24
                : 0.18;
    const levelWeight =
      capability.level === "high" ? 1 : capability.level === "medium" ? 0.84 : 0.68;
    return sum + statusWeight * levelWeight;
  }, 0);
  const averageCapabilitySignal = total / semantic.matchedCapabilities.length;
  const breadthBonus = Math.min(8, (semantic.matchedTerms?.length ?? 0) * 1.5);
  let score = Math.round(averageCapabilitySignal * 58 + breadthBonus);

  const specialistRows = specialistRequirementRows(eligibility);
  const specialistConfirmed = specialistRows.filter((row) => row.status === "confirmed").length;
  const specialistPotentialHardBlockers = specialistRows.filter(
    (row) => row.status === "needs_verification" && row.gating === "hard" && row.mandatory
  ).length;
  const specialistUnknown = specialistRows.filter(
    (row) => row.status === "needs_verification" && !(row.gating === "hard" && row.mandatory)
  ).length;
  const specialistFailed = specialistRows.filter((row) => row.status === "failed").length;
  const hasCompanyConfirmedCapability = semantic.matchedCapabilities.some((capability) => capability.status === "company_confirmed");

  score += specialistConfirmed * 12;
  score -= specialistPotentialHardBlockers * 18;
  score -= specialistUnknown * 7;
  score -= specialistFailed * 12;

  if (!specialistRows.length && !hasCompanyConfirmedCapability) {
    score = Math.min(score, 48);
  }
  if (specialistPotentialHardBlockers > 0) {
    score = Math.min(score, 44);
  } else if (!specialistConfirmed && !hasCompanyConfirmedCapability) {
    score = Math.min(score, 52);
  }

  return clamp(score, 0, 100);
}

function proximityAssessment(company, opportunity) {
  const geography = company.geography ?? {};
  const target = opportunity.location ?? {};
  const sameMunicipality =
    normalizeRegion(geography.municipality) &&
    normalizeRegion(geography.municipality) === normalizeRegion(target.municipality);
  const sameProvince =
    normalizeRegion(geography.province) &&
    normalizeRegion(geography.province) === normalizeRegion(target.province);
  const sameRegion =
    normalizeRegion(geography.autonomousCommunity) &&
    normalizeRegion(geography.autonomousCommunity) === normalizeRegion(target.autonomousCommunity);

  if (sameMunicipality) return { score: 96, label: "Very strong" };
  if (sameProvince) return { score: 84, label: "Strong" };
  if (sameRegion) return { score: 68, label: "Moderate" };
  if (target.autonomousCommunity || target.province || target.municipality) return { score: 36, label: "Weak" };
  return { score: 24, label: "Unknown" };
}

export function assessGeographicFit(company, opportunity) {
  const geography = company.geography ?? {};
  const target = opportunity.location ?? {};
  const proximity = proximityAssessment(company, opportunity);
  const radius = getFactValue(getCompanyFact(company, "preferredWorkingRadiusKm"));
  const acceptedRegions = (geography.acceptedRegions ?? []).map(normalizeRegion);
  const excludedRegions = (geography.excludedRegions ?? []).map(normalizeRegion);
  const targetRegions = [
    normalizeRegion(target.municipality),
    normalizeRegion(target.province),
    normalizeRegion(target.autonomousCommunity)
  ].filter(Boolean);

  const excluded = targetRegions.some((region) => excludedRegions.includes(region));
  if (excluded) {
    return {
      score: 8,
      proximityLabel: proximity.label,
      travelPreferenceLabel: "Excluded region",
      confidenceLabel: "High",
      note: `Geographic proximity: ${proximity.label}. Company geographic preference excludes this region.`
    };
  }

  const accepted = targetRegions.some((region) => acceptedRegions.includes(region));
  if (accepted) {
    return {
      score: Math.max(proximity.score, 86),
      proximityLabel: proximity.label,
      travelPreferenceLabel: "Confirmed compatible",
      confidenceLabel: "High",
      note: `Geographic proximity: ${proximity.label}. Company geographic preference is explicitly compatible with this region.`
    };
  }

  if (radius != null || geography.willingToTravel != null) {
    const travelCompatible =
      geography.willingToTravel === true ||
      radius == null ||
      radius >= 75 ||
      proximity.score >= 84;

    return {
      score: travelCompatible ? Math.max(proximity.score, 76) : 22,
      proximityLabel: proximity.label,
      travelPreferenceLabel: travelCompatible ? "Compatible" : "Potential mismatch",
      confidenceLabel: "Medium",
      note: travelCompatible
        ? `Geographic proximity: ${proximity.label}. Company travel or radius preference appears compatible.`
        : `Geographic proximity: ${proximity.label}. Company travel or radius preference may not support this opportunity.`
    };
  }

  return {
    score: Math.round(proximity.score * 0.78),
    proximityLabel: proximity.label,
    travelPreferenceLabel: "Unknown",
    confidenceLabel: proximity.score >= 80 ? "Medium" : "Low",
    note: `Geographic proximity: ${proximity.label}. Travel or radius preference remains unknown.`
  };
}

export function strategicFitScore(company, subject) {
  const wanted = (company.preferences?.desiredWorkTypes ?? []).map((item) => item.toLowerCase());
  const unwanted = (company.preferences?.unwantedWorkTypes ?? []).map((item) => item.toLowerCase());
  const text = [subject.title, subject.description, ...(subject.keywords ?? [])].join(" ").toLowerCase();
  if (unwanted.some((item) => text.includes(item))) return 10;
  if (!wanted.length) return 70;
  const matches = wanted.filter((item) => text.includes(item));
  if (!matches.length) return 48;
  return Math.min(98, 55 + matches.length * 14);
}

export function applicationEffortScore(opportunity, lot) {
  const requirementCount = (opportunity.requirements?.length ?? 0) + (lot?.requirements?.length ?? 0);
  const documents = opportunity.documents?.length ?? 0;
  const burdens = requirementCount * 7 + documents * 4 + (opportunity.noticeType === "grant_call" ? 8 : 0);
  return clamp(100 - burdens, 18, 92);
}

export function deriveRecommendation({
  priorityScore,
  geographicFit = null,
  capabilityFit = null
}) {
  if (capabilityFit != null && capabilityFit < 18) return "LOW_PRIORITY";
  if (geographicFit != null && geographicFit < 15 && priorityScore < 75) return "LOW_PRIORITY";
  if (priorityScore >= 88) return "EXCELLENT_FIT";
  if (priorityScore >= 76) return "STRONG_FIT";
  if (priorityScore >= 60) return "POSSIBLE_FIT";
  return "LOW_PRIORITY";
}

export function computeScores({
  runtime = DEFAULT_RUNTIME,
  capabilityFit,
  financialScaleFit,
  geographicFit,
  strategicFit,
  qualificationReadiness,
  deadlineFeasibility,
  applicationEffort,
  evidenceQuality
}) {
  const matchScore = weightedAverage([
    { value: capabilityFit, weight: runtime.scoring.match.capabilityFit },
    { value: financialScaleFit, weight: runtime.scoring.match.financialScaleFit },
    { value: geographicFit, weight: runtime.scoring.match.geographicFit },
    { value: strategicFit, weight: runtime.scoring.match.strategicFit },
    { value: qualificationReadiness, weight: runtime.scoring.match.qualificationReadiness },
    { value: deadlineFeasibility, weight: runtime.scoring.match.deadlineFeasibility },
    { value: applicationEffort, weight: runtime.scoring.match.applicationEffort }
  ]);
  const priorityScore = weightedAverage([
    { value: matchScore, weight: runtime.scoring.priority.matchScore },
    { value: qualificationReadiness, weight: runtime.scoring.priority.qualificationReadiness },
    { value: deadlineFeasibility, weight: runtime.scoring.priority.deadlineFeasibility },
    { value: evidenceQuality, weight: runtime.scoring.priority.evidenceQuality },
    { value: applicationEffort, weight: runtime.scoring.priority.applicationEffort }
  ]);

  return {
    matchScore: Math.round(matchScore),
    priorityScore: Math.round(priorityScore)
  };
}

export function assembleDimensions(company, opportunity, lot, semantic, eligibility, now = new Date()) {
  const selectedMoney =
    opportunity.type === "grant"
      ? opportunity.eligibleProjectCost ?? null
      : lot?.value ?? opportunity.relevantValue ?? opportunity.estimatedValue ?? opportunity.baseBudget;
  const capabilityFit = semantic.score;
  const baseCapabilityFit = capabilityFit;
  const specialistScopeConfidence = specialistCapabilityConfidence(semantic, eligibility);
  const scaleAssessment = assessScaleFit(company, selectedMoney);
  const financialScaleFit = scaleAssessment.score;
  const subject = {
    ...opportunity,
    ...(lot ?? {}),
    location: resolveLotOrOpportunityLocation(lot, opportunity)
  };
  const geographyAssessment = assessGeographicFit(company, subject);
  const geographicFit = geographyAssessment.score;
  const strategicFit = strategicFitScore(company, subject);
  const qualificationReadiness = qualificationReadinessScore(eligibility);
  const deadlineFeasibility = deadlineFeasibilityScore(opportunity, now);
  const applicationEffort = applicationEffortScore(opportunity, lot);
  const preliminary = {
    capabilityFit,
    baseCapabilityFit,
    specialistScopeConfidence,
    financialScaleFit,
    geographicFit,
    strategicFit,
    qualificationReadiness,
    deadlineFeasibility,
    applicationEffort
  };
  const confidenceShield = buildConfidenceShield(opportunity, eligibility, now, {
    specialistScopeConfidence
  });
  return {
    ...preliminary,
    scaleAssessment,
    geographyAssessment,
    evidenceQuality: confidenceShield.label === "HIGH" ? 90 : confidenceShield.label === "MEDIUM" ? 68 : 38,
    confidenceShield
  };
}
