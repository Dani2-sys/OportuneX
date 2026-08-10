import { DEFAULT_RUNTIME } from "../config.js";
import { clamp, weightedAverage } from "../utils.js";
import { getCompanyFact, getFactValue } from "./company-profile.js";
import { deadlineFeasibilityScore } from "./deadline.js";
import { assessScaleFit } from "./money.js";
import { buildConfidenceShield } from "./evidence.js";
import { qualificationReadinessScore } from "./eligibility.js";

export function geographicFitScore(company, opportunity) {
  const geography = company.geography ?? {};
  const target = opportunity.location ?? {};
  const radius = getFactValue(getCompanyFact(company, "preferredWorkingRadiusKm"));
  const acceptedRegions = (geography.acceptedRegions ?? []).map((value) => value.toLowerCase());
  if (
    acceptedRegions.length &&
    target.autonomousCommunity &&
    !acceptedRegions.includes(target.autonomousCommunity.toLowerCase())
  ) {
    return 8;
  }
  const sameProvince = geography.province && geography.province === target.province;
  const sameRegion = geography.autonomousCommunity && geography.autonomousCommunity === target.autonomousCommunity;
  if (geography.municipality && geography.municipality === target.municipality) return 98;
  if (sameProvince) return 88;
  if (sameRegion) return 72;
  if (geography.willingToTravel && radius >= 150) return 58;
  if (geography.willingToTravel && radius != null && radius >= 75) return 48;
  if (geography.municipality || geography.province || geography.autonomousCommunity) return 25;
  return 25;
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
  status,
  eligibilityStatus,
  priorityScore,
  confidenceShield,
  unknownCount,
  hardMandatoryNeedsVerification = 0,
  geographicFit = null
}) {
  if (["closed", "cancelled", "awarded", "suspended"].includes(status)) return "DO_NOT_PURSUE";
  if (eligibilityStatus === "INELIGIBLE" || eligibilityStatus === "LIKELY_INELIGIBLE") return "DO_NOT_PURSUE";
  if (geographicFit != null && geographicFit < 15 && priorityScore < 75) return "LOW_PRIORITY";
  if (hardMandatoryNeedsVerification > 0) return "VERIFY_BEFORE_DECIDING";
  if (confidenceShield.conflictingSources || unknownCount >= 2) return "VERIFY_BEFORE_DECIDING";
  if (priorityScore >= 88 && confidenceShield.label !== "LOW") return "EXCELLENT_FIT";
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
  const selectedMoney = lot?.value ?? opportunity.maximumAidPerBeneficiary ?? opportunity.relevantValue ?? opportunity.estimatedValue;
  const capabilityFit = semantic.score;
  const scaleAssessment = assessScaleFit(company, selectedMoney);
  const financialScaleFit = scaleAssessment.score;
  const subject = {
    ...opportunity,
    ...(lot ?? {}),
    location: lot?.location ?? opportunity.location
  };
  const geographicFit = geographicFitScore(company, subject);
  const strategicFit = strategicFitScore(company, subject);
  const qualificationReadiness = qualificationReadinessScore(eligibility);
  const deadlineFeasibility = deadlineFeasibilityScore(opportunity, now);
  const applicationEffort = applicationEffortScore(opportunity, lot);
  const preliminary = {
    capabilityFit,
    financialScaleFit,
    geographicFit,
    strategicFit,
    qualificationReadiness,
    deadlineFeasibility,
    applicationEffort
  };
  const confidenceShield = buildConfidenceShield(
    opportunity,
    eligibility,
    now
  );
  return {
    ...preliminary,
    scaleAssessment,
    evidenceQuality: confidenceShield.label === "HIGH" ? 90 : confidenceShield.label === "MEDIUM" ? 68 : 38,
    confidenceShield
  };
}
