import { clamp } from "../utils.js";
import { isNonActionableDerivedStatus, scoreFreshness } from "./deadline.js";

const ACTIVE_CRITICAL_FIELDS = [
  "status",
  "deadline",
  "lot_value",
  "location",
  "requirements",
  "submission_route",
  "official_notice",
  "contacts"
];

const ARCHIVAL_CRITICAL_FIELDS = [
  "status",
  "lot_value",
  "location",
  "official_notice"
];

function criticalFieldsForOpportunity(opportunity) {
  const status = opportunity.derivedStatus ?? opportunity.status;
  return isNonActionableDerivedStatus(status) ? ARCHIVAL_CRITICAL_FIELDS : ACTIVE_CRITICAL_FIELDS;
}

function confidenceBand(value) {
  return value >= 80 ? "HIGH" : value >= 55 ? "MEDIUM" : "LOW";
}

export function evidenceForField(opportunity, fieldKey) {
  return (opportunity.evidence ?? []).filter((item) => item.fieldKey === fieldKey);
}

export function describeEvidenceBackedText(
  opportunity,
  fieldKey,
  value,
  { fallback = "Not stated", unverifiedNote = "unverified from linked sources" } = {}
) {
  if (value == null || value === "") return fallback;
  return evidenceForField(opportunity, fieldKey).length ? String(value) : `${value} (${unverifiedNote})`;
}

export function extractClaims(opportunity, lot, analysis) {
  const target = lot ?? opportunity;
  const nonActionable = isNonActionableDerivedStatus(opportunity.derivedStatus ?? opportunity.status);
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
    ...(!nonActionable
      ? [
          {
            claim: opportunity.applicationUrl || "Submission route not yet verified",
            claimType: "submission_route",
            evidenceIds: evidenceForField(opportunity, "submission_route").map((item) => item.id),
            confidence: opportunity.applicationUrl ? "high" : "medium",
            interpreted: !opportunity.applicationUrl,
            critical: true
          },
          {
            claim: analysis.primaryContact?.name ?? "Contact not found in reviewed/imported sources",
            claimType: "contact",
            evidenceIds: evidenceForField(opportunity, "contacts").map((item) => item.id),
            confidence: analysis.primaryContact ? "high" : "medium",
            interpreted: !analysis.primaryContact,
            critical: true
          }
        ]
      : []),
    ...requirementClaims
  ];
}

export function buildConfidenceShield(opportunity, analysis, now = new Date(), options = {}) {
  const criticalFields = criticalFieldsForOpportunity(opportunity);
  const sourceFieldsEvidenced = criticalFields.filter((fieldKey) => evidenceForField(opportunity, fieldKey).length > 0).length;
  const conflicts = opportunity.sourceConflicts?.length ?? 0;
  const summary = analysis.summary ?? {};
  const freshness = scoreFreshness(opportunity.lastChecked, now);
  const evidenceCoverage = criticalFields.length === 0 ? 0 : (sourceFieldsEvidenced / criticalFields.length) * 100;
  const dataConfidenceValue = clamp(evidenceCoverage * 0.72 + freshness * 0.28 - conflicts * 18, 0, 100);
  const mandatoryNeedsVerification = summary.mandatoryNeedsVerification ?? analysis.unknowns.length;
  const mandatoryFailed = summary.mandatoryFailed ?? analysis.blockers.length;
  const hardMandatoryNeedsVerification = summary.hardMandatoryNeedsVerification ?? 0;
  const hardMandatoryFailed = summary.hardMandatoryFailed ?? 0;
  const companyConfirmationsNeeded = summary.companyConfirmationsNeeded ?? mandatoryNeedsVerification;
  const currentEvidenceRequired = (analysis.requirementRows ?? []).filter(
    (row) => row.mandatory && row.currentEvidenceRequired
  ).length;
  const specialistScopeConfidence = options.specialistScopeConfidence ?? null;

  const eligibilityConfidenceValue =
    analysis.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED"
      ? 28
      : clamp(
          94 -
            mandatoryNeedsVerification * 14 -
            mandatoryFailed * 26 -
            hardMandatoryNeedsVerification * 24 -
            hardMandatoryFailed * 18,
          0,
          100
        );
  const companyFactConfidenceValue =
    analysis.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED"
      ? 34
      : clamp(
          92 -
            companyConfirmationsNeeded * 16 -
            currentEvidenceRequired * 18 -
            hardMandatoryNeedsVerification * 10 -
            hardMandatoryFailed * 18,
          0,
          100
        );
  const decisionConfidenceValue = Math.min(dataConfidenceValue, eligibilityConfidenceValue, companyFactConfidenceValue);

  const dataConfidence = confidenceBand(dataConfidenceValue);
  const eligibilityConfidence = confidenceBand(eligibilityConfidenceValue);
  const companyFactConfidence = confidenceBand(companyFactConfidenceValue);
  const decisionConfidence = confidenceBand(decisionConfidenceValue);
  const label = decisionConfidence;
  const allSourceFieldsEvidenced = criticalFields.length > 0 && sourceFieldsEvidenced === criticalFields.length;
  const qualificationEvidenceIncomplete =
    hardMandatoryNeedsVerification > 0 ||
    hardMandatoryFailed > 0 ||
    currentEvidenceRequired > 0 ||
    (specialistScopeConfidence != null && specialistScopeConfidence < 55);
  const criticalFieldSummary = allSourceFieldsEvidenced
    ? qualificationEvidenceIncomplete
      ? "Source-critical dossier fields are evidenced, but qualification or specialist-scope evidence remains incomplete."
      : "All source-critical dossier and qualification fields needed for the current decision are verified."
    : "Some source-critical dossier fields still lack linked evidence.";

  return {
    label,
    officialSourceVerified: Boolean(opportunity.sources?.some((source) => source.official)),
    lastChecked: opportunity.lastChecked,
    sourceFieldsEvidenced,
    totalSourceFields: criticalFields.length,
    criticalFieldsVerified: sourceFieldsEvidenced,
    totalCriticalFields: criticalFields.length,
    mandatoryConfirmed: summary.mandatoryConfirmed ?? 0,
    mandatoryNeedsVerification,
    mandatoryFailed,
    hardMandatoryConfirmed: summary.hardMandatoryConfirmed ?? 0,
    hardMandatoryNeedsVerification,
    hardMandatoryFailed,
    companyConfirmationsNeeded,
    dataConfidence,
    eligibilityConfidence,
    companyFactConfidence,
    decisionConfidence,
    criticalFieldSummary,
    allSourceFieldsEvidenced,
    currentEvidenceRequired,
    conflictingSources: conflicts > 0,
    outstandingQuestions: mandatoryNeedsVerification,
    sourceConflictsCount: conflicts,
    conflicts: opportunity.sourceConflicts ?? []
  };
}
