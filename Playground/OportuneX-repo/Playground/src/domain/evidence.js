import { clamp } from "../utils.js";
import { scoreFreshness } from "./deadline.js";

const CRITICAL_FIELDS = [
  "status",
  "deadline",
  "lot_value",
  "location",
  "requirements",
  "submission_route",
  "official_notice",
  "contacts"
];

export function evidenceForField(opportunity, fieldKey) {
  return (opportunity.evidence ?? []).filter((item) => item.fieldKey === fieldKey);
}

export function extractClaims(opportunity, lot, analysis) {
  const target = lot ?? opportunity;
  const requirementClaims = (analysis.requirementRows ?? []).map((row) => ({
    claim: row.label,
    claimType: "eligibility_requirement",
    evidenceIds: row.evidenceIds ?? [],
    confidence: row.status === "confirmed" ? "high" : row.status === "failed" ? "high" : "medium",
    interpreted: row.status === "needs_verification",
    critical: true
  }));

  return [
    {
      claim: analysis.displayValueLabel,
      claimType: "money",
      evidenceIds: evidenceForField(opportunity, "lot_value").map((item) => item.id),
      confidence: "high",
      interpreted: false,
      critical: true
    },
    {
      claim: analysis.deadlineLabel,
      claimType: "deadline",
      evidenceIds: evidenceForField(opportunity, "deadline").map((item) => item.id),
      confidence: "high",
      interpreted: false,
      critical: true
    },
    {
      claim: target.location?.display ?? opportunity.location?.display ?? "Location not stated",
      claimType: "location",
      evidenceIds: evidenceForField(opportunity, "location").map((item) => item.id),
      confidence: "high",
      interpreted: false,
      critical: true
    },
    ...requirementClaims
  ];
}

export function buildConfidenceShield(opportunity, analysis, now = new Date()) {
  const sourceFieldsEvidenced = CRITICAL_FIELDS.filter((fieldKey) => evidenceForField(opportunity, fieldKey).length > 0).length;
  const conflicts = opportunity.sourceConflicts?.length ?? 0;
  const summary = analysis.summary ?? {};
  const freshness = scoreFreshness(opportunity.lastChecked, now);
  const evidenceCoverage = (sourceFieldsEvidenced / CRITICAL_FIELDS.length) * 100;
  const dataConfidenceValue = clamp(evidenceCoverage * 0.72 + freshness * 0.28 - conflicts * 18, 0, 100);
  const mandatoryNeedsVerification = summary.mandatoryNeedsVerification ?? analysis.unknowns.length;
  const mandatoryFailed = summary.mandatoryFailed ?? analysis.blockers.length;
  const hardMandatoryNeedsVerification = summary.hardMandatoryNeedsVerification ?? 0;
  const hardMandatoryFailed = summary.hardMandatoryFailed ?? 0;
  const companyConfirmationsNeeded = summary.companyConfirmationsNeeded ?? mandatoryNeedsVerification;

  const eligibilityConfidenceValue = clamp(
    94 -
      mandatoryNeedsVerification * 14 -
      mandatoryFailed * 26 -
      hardMandatoryNeedsVerification * 24 -
      hardMandatoryFailed * 18,
    0,
    100
  );

  const dataConfidence =
    dataConfidenceValue >= 80 ? "HIGH" : dataConfidenceValue >= 55 ? "MEDIUM" : "LOW";
  const eligibilityConfidence =
    eligibilityConfidenceValue >= 80 ? "HIGH" : eligibilityConfidenceValue >= 55 ? "MEDIUM" : "LOW";
  const label =
    dataConfidence === "HIGH" &&
    eligibilityConfidence === "HIGH" &&
    conflicts === 0 &&
    hardMandatoryNeedsVerification === 0 &&
    hardMandatoryFailed === 0
      ? "HIGH"
      : dataConfidence === "LOW" || eligibilityConfidence === "LOW" || hardMandatoryFailed > 0
        ? "LOW"
        : "MEDIUM";

  return {
    label,
    officialSourceVerified: Boolean(opportunity.sources?.some((source) => source.official)),
    lastChecked: opportunity.lastChecked,
    sourceFieldsEvidenced,
    totalSourceFields: CRITICAL_FIELDS.length,
    criticalFieldsVerified: sourceFieldsEvidenced,
    totalCriticalFields: CRITICAL_FIELDS.length,
    mandatoryConfirmed: summary.mandatoryConfirmed ?? 0,
    mandatoryNeedsVerification,
    mandatoryFailed,
    hardMandatoryConfirmed: summary.hardMandatoryConfirmed ?? 0,
    hardMandatoryNeedsVerification,
    hardMandatoryFailed,
    companyConfirmationsNeeded,
    dataConfidence,
    eligibilityConfidence,
    conflictingSources: conflicts > 0,
    outstandingQuestions: mandatoryNeedsVerification,
    sourceConflictsCount: conflicts,
    conflicts: opportunity.sourceConflicts ?? []
  };
}
