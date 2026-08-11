import { currentYmd } from "./deadline.js";
import { bandToRange } from "./money.js";
import {
  factCanConfirmEligibility,
  getCompanyCertifications,
  getCompanyFact,
  getCompanyInsurancePolicies,
  getCompanyRepresentativeProjects,
  getFactValue,
  getTurnoverRange,
  rangeCanConfirmEligibility
} from "./company-profile.js";
import { normalizeText } from "../utils.js";

function certificationValue(record) {
  return getFactValue(record?.currentStatus);
}

function asComparison(status, extras = {}) {
  return { status, ...extras };
}

function normalizeCapabilityList(values = []) {
  return values.map((value) => normalizeText(value)).filter(Boolean);
}

function normalizeCpvPrefixes(values = []) {
  return values
    .map((value) => value?.toString?.().replace(/\D/g, "") ?? "")
    .filter(Boolean);
}

function cpvPrefixMatch(requiredPrefixes = [], projectPrefixes = []) {
  return requiredPrefixes.some((required) =>
    projectPrefixes.some((projectPrefix) => projectPrefix.startsWith(required) || required.startsWith(projectPrefix))
  );
}

function comparableSignals(requirement, subject, { publicOnlyDefault = false, comparableScopeDefault = false } = {}) {
  const comparableScopeRequired =
    requirement.comparableScopeRequired ??
    comparableScopeDefault ??
    Boolean((requirement.requiredCapabilities ?? []).length || (requirement.requiredCpvPrefixes ?? []).length);

  return {
    minimumCount: requirement.minimumCount ?? 1,
    minimumAmount: requirement.minimumAmount ?? null,
    publicOnly: requirement.publicOnly ?? publicOnlyDefault,
    lookbackYears: requirement.lookbackYears ?? null,
    comparableScopeRequired,
    requiredCapabilities: normalizeCapabilityList(
      (requirement.requiredCapabilities ?? []).length
        ? requirement.requiredCapabilities
        : comparableScopeRequired
          ? subject?.keywords ?? []
          : []
    ),
    requiredCpvPrefixes: normalizeCpvPrefixes(
      (requirement.requiredCpvPrefixes ?? []).length
        ? requirement.requiredCpvPrefixes
        : comparableScopeRequired
          ? subject?.cpvCodes ?? []
          : []
    )
  };
}

function projectEvidenceCanConfirm(project) {
  return project.status === "company_confirmed" || project.status === "public_verified";
}

function projectPublicStatus(project, publicOnly) {
  if (!publicOnly) return "confirmed";
  if (project.publicProject === true) return "confirmed";
  if (project.publicProject === false) return "failed";

  const customerType = normalizeText(project.customerType);
  if (
    customerType.includes("public") ||
    customerType.includes("authority") ||
    customerType.includes("municipal") ||
    customerType.includes("government")
  ) {
    return "confirmed";
  }
  if (customerType) return "failed";
  return "needs_verification";
}

function projectScopeStatus(project, signals) {
  if (!signals.comparableScopeRequired) return "confirmed";

  const projectCapabilities = normalizeCapabilityList(project.scopeCapabilities ?? []);
  const projectCpvPrefixes = normalizeCpvPrefixes(project.cpvPrefixes ?? []);
  const hasScopeEvidence = projectCapabilities.length > 0 || projectCpvPrefixes.length > 0;

  if (!hasScopeEvidence) return "needs_verification";

  const capabilityMatch = signals.requiredCapabilities.length
    ? signals.requiredCapabilities.some((required) =>
        projectCapabilities.some((capability) => capability.includes(required) || required.includes(capability))
      )
    : null;
  const cpvMatch = signals.requiredCpvPrefixes.length
    ? cpvPrefixMatch(signals.requiredCpvPrefixes, projectCpvPrefixes)
    : null;

  if (capabilityMatch === true || cpvMatch === true) return "confirmed";

  const capabilityContradiction = signals.requiredCapabilities.length ? capabilityMatch === false : true;
  const cpvContradiction = signals.requiredCpvPrefixes.length ? cpvMatch === false : true;
  if (capabilityContradiction && cpvContradiction) return "failed";

  return "needs_verification";
}

function projectValueStatus(project, minimumAmount) {
  if (minimumAmount == null) return "confirmed";
  if (project.projectValue == null) return "needs_verification";
  return project.projectValue >= minimumAmount ? "confirmed" : "failed";
}

function projectLookbackStatus(project, lookbackYears, now) {
  if (!lookbackYears) return "confirmed";

  const completionDate = project.completionDate ?? project.endDate ?? null;
  if (completionDate) {
    const completedAt = new Date(completionDate);
    if (Number.isNaN(completedAt.getTime())) return "needs_verification";
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - lookbackYears);
    return completedAt >= cutoff ? "confirmed" : "failed";
  }

  const completionYear = Number(project.completionYear ?? NaN);
  if (!Number.isFinite(completionYear)) return "needs_verification";

  const currentYear = Number(currentYmd(now).slice(0, 4));
  const thresholdYear = currentYear - lookbackYears;
  if (completionYear > thresholdYear) return "confirmed";
  if (completionYear < thresholdYear) return "failed";
  return "needs_verification";
}

function assessRepresentativeProject(project, signals, now) {
  if (!projectEvidenceCanConfirm(project)) {
    return {
      status: "needs_verification",
      publicEvidenceConfirmed: false
    };
  }

  const publicStatus = projectPublicStatus(project, signals.publicOnly);
  if (publicStatus === "failed") {
    return {
      status: "failed",
      publicEvidenceConfirmed: false
    };
  }
  if (publicStatus === "needs_verification") {
    return {
      status: "needs_verification",
      publicEvidenceConfirmed: false
    };
  }

  const scopeStatus = projectScopeStatus(project, signals);
  const valueStatus = projectValueStatus(project, signals.minimumAmount);
  const lookbackStatus = projectLookbackStatus(project, signals.lookbackYears, now);
  const statuses = [scopeStatus, valueStatus, lookbackStatus];

  if (statuses.every((status) => status === "confirmed")) {
    return {
      status: "confirmed",
      publicEvidenceConfirmed: publicStatus === "confirmed"
    };
  }

  if (statuses.some((status) => status === "needs_verification")) {
    return {
      status: "needs_verification",
      publicEvidenceConfirmed: publicStatus === "confirmed"
    };
  }

  return {
    status: "failed",
    publicEvidenceConfirmed: publicStatus === "confirmed"
  };
}

function compareCertification(company, requirement, now) {
  const certifications = getCompanyCertifications(company);
  const found = certifications.find(
    (item) => normalizeText(item.name) === normalizeText(requirement.requiredValue ?? requirement.label)
  );
  if (!found) return asComparison("needs_verification");
  const availability = certificationValue(found);
  if (availability === "valid" && factCanConfirmEligibility(found.currentStatus, now)) return asComparison("confirmed");
  if ((availability === "missing" || availability === "expired") && factCanConfirmEligibility(found.currentStatus, now)) {
    return asComparison("failed");
  }
  return asComparison("needs_verification");
}

function compareExperience(company, subject, requirement, now) {
  const comparableScopeRequired =
    requirement.comparableScopeRequired ??
    true;

  if (
    comparableScopeRequired === false &&
    !requirement.publicOnly &&
    !(requirement.requiredCapabilities ?? []).length &&
    !(requirement.requiredCpvPrefixes ?? []).length &&
    !requirement.lookbackYears
  ) {
    const maxProjectValueFact = getCompanyFact(company, "maximumProjectValue");
    const maxProjectValue = getFactValue(maxProjectValueFact);
    if (!requirement.minimumAmount) return asComparison("needs_verification");
    if (maxProjectValue == null || !factCanConfirmEligibility(maxProjectValueFact, now)) {
      return asComparison("needs_verification");
    }
    return asComparison(maxProjectValue >= requirement.minimumAmount ? "confirmed" : "failed");
  }

  return compareComparableExperience(company, subject, requirement, now, {
    publicOnlyDefault: false,
    comparableScopeDefault: true
  });
}

function compareTurnover(company, requirement, now) {
  const turnoverRange = getTurnoverRange(company);
  const minimum = requirement.minimumAmount ?? bandToRange(requirement.minimumTurnoverBand ?? "under-250k")[0];
  if (!rangeCanConfirmEligibility(turnoverRange, now)) return asComparison("needs_verification");
  if (turnoverRange.min != null && turnoverRange.min >= minimum) return asComparison("confirmed");
  if (turnoverRange.max == null) return asComparison("needs_verification");
  if (turnoverRange.max < minimum) return asComparison("failed");
  if (turnoverRange.min == null) return asComparison("needs_verification");
  if (turnoverRange.min < minimum && turnoverRange.max >= minimum) return asComparison("needs_verification");
  return asComparison("failed");
}

function compareRegion(company, requirement, opportunity) {
  const region = normalizeText(opportunity.location?.autonomousCommunity ?? opportunity.location?.province ?? "");
  if (!region) return asComparison("needs_verification");
  const excluded = (company.geography?.excludedRegions ?? []).map(normalizeText);
  if (excluded.includes(region)) return asComparison("failed");
  const accepted = (requirement.allowedRegions ?? company.geography?.acceptedRegions ?? []).map(normalizeText);
  if (!accepted.length) return asComparison("confirmed");
  return asComparison(accepted.includes(region) ? "confirmed" : "failed");
}

function compareBeneficiary(company, requirement, now) {
  const wanted = normalizeText(requirement.requiredValue ?? "");
  if (!wanted) return asComparison("needs_verification");
  if (wanted === "sme") {
    const smeStatus = getCompanyFact(company, "smeStatus");
    if (!factCanConfirmEligibility(smeStatus, now)) return asComparison("needs_verification");
    if (getFactValue(smeStatus) === "confirmed") return asComparison("confirmed");
    if (getFactValue(smeStatus) === "not-sme") return asComparison("failed");
    return asComparison("needs_verification");
  }
  if (wanted === "sl" || wanted === "sociedad limitada") {
    const legalEntityType = getCompanyFact(company, "legalEntityType");
    if (!factCanConfirmEligibility(legalEntityType, now)) return asComparison("needs_verification");
    return asComparison(normalizeText(getFactValue(legalEntityType) ?? "").includes("sl") ? "confirmed" : "failed");
  }
  const legalEntityType = getCompanyFact(company, "legalEntityType");
  if (!factCanConfirmEligibility(legalEntityType, now)) return asComparison("needs_verification");
  const entityType = normalizeText(getFactValue(legalEntityType) ?? "");
  if (!entityType) return asComparison("needs_verification");
  if (wanted === "cooperative" || wanted === "cooperativa") {
    return asComparison(entityType.includes("cooper") ? "confirmed" : "failed");
  }
  return asComparison(entityType.includes(wanted) || wanted.includes(entityType) ? "confirmed" : "failed");
}

function compareCoFinance(company, now) {
  const canCoFinance = getCompanyFact(company, "canCoFinance");
  if (!factCanConfirmEligibility(canCoFinance, now)) return asComparison("needs_verification");
  if (getFactValue(canCoFinance) === true) return asComparison("confirmed");
  if (getFactValue(canCoFinance) === false) return asComparison("failed");
  return asComparison("needs_verification");
}

function compareCompanyAge(company, requirement, now) {
  const ageFact = getCompanyFact(company, "companyAgeYears");
  const age = getFactValue(ageFact);
  if (age == null || !factCanConfirmEligibility(ageFact, now)) return asComparison("needs_verification");
  return asComparison(age >= requirement.minimumYears ? "confirmed" : "failed");
}

function compareInsurance(company, requirement, now) {
  const insurance = getCompanyInsurancePolicies(company).find((item) =>
    normalizeText(item.name).includes(normalizeText(requirement.label))
  );
  if (!insurance) return asComparison("needs_verification");
  const cover = getFactValue(insurance.coverAmountFact);
  if (cover == null || !factCanConfirmEligibility(insurance.coverAmountFact, now)) {
    return asComparison("needs_verification");
  }
  return asComparison(cover >= (requirement.minimumAmount ?? 0) ? "confirmed" : "failed");
}

function compareComparableExperience(company, subject, requirement, now, options = {}) {
  const signals = comparableSignals(requirement, subject, options);
  const representativeProjects = getCompanyRepresentativeProjects(company);
  const projectAssessments = representativeProjects.map((project) => assessRepresentativeProject(project, signals, now));
  const confirmedProjects = projectAssessments.filter((assessment) => assessment.status === "confirmed").length;
  const unknownProjects = projectAssessments.filter((assessment) => assessment.status === "needs_verification").length;
  const knownPublicProjects = projectAssessments.filter((assessment) => assessment.publicEvidenceConfirmed).length;

  if (confirmedProjects >= signals.minimumCount) return asComparison("confirmed");

  const publicCountFact = getCompanyFact(company, "publicProcurementProjects");
  const publicCount = getFactValue(publicCountFact);
  if (signals.publicOnly && publicCount != null && factCanConfirmEligibility(publicCountFact, now) && publicCount < signals.minimumCount) {
    return asComparison("failed", {
      failureReason: "The confirmed public-procurement count is below the minimum required threshold."
    });
  }

  const maxProjectValueFact = getCompanyFact(company, "maximumProjectValue");
  const maxProjectValue = getFactValue(maxProjectValueFact);
  if (
    signals.minimumAmount != null &&
    maxProjectValue != null &&
    factCanConfirmEligibility(maxProjectValueFact, now) &&
    maxProjectValue < signals.minimumAmount
  ) {
    return asComparison("failed", {
      failureReason: "No evidenced project reaches the required comparable contract value."
    });
  }

  if (
    signals.publicOnly &&
    publicCount != null &&
    factCanConfirmEligibility(publicCountFact, now) &&
    knownPublicProjects >= publicCount &&
    confirmedProjects < signals.minimumCount &&
    unknownProjects === 0
  ) {
    return asComparison("failed", {
      failureReason: "The evidenced public project portfolio does not contain enough comparable projects."
    });
  }

  return asComparison("needs_verification", {
    question:
      requirement.question ??
      "Comparable project evidence is missing or incomplete for this requirement."
  });
}

function comparePublicExperience(company, subject, requirement, now) {
  return compareComparableExperience(company, subject, requirement, now, {
    publicOnlyDefault: true,
    comparableScopeDefault: true
  });
}

function compareCustom(company, requirement) {
  const answer = company.customAnswers?.[requirement.id];
  if (answer === "Yes") return asComparison("confirmed");
  if (answer === "No") return asComparison("failed");
  return asComparison(requirement.defaultStatus ?? "needs_verification");
}

function defaultWhy(requirement) {
  switch (requirement.kind) {
    case "certification":
      return "This answer determines whether the published certification requirement is satisfied.";
    case "experience_value":
      return "This answer determines whether there is evidence of a comparable contract at the required value and scope.";
    case "comparable_experience":
      return "This answer determines whether there is evidence of a comparable project portfolio for the required scope.";
    case "turnover":
      return "This answer determines whether the minimum turnover threshold can be met.";
    case "beneficiary":
      return "This answer determines whether the company fits the eligible beneficiary type.";
    case "co_finance":
      return "This answer determines whether the company can cover the required co-financing share.";
    case "company_age":
      return "This answer determines whether the minimum company-age requirement is satisfied.";
    case "insurance":
      return "This answer determines whether the required insurance cover is in place.";
    case "public_experience":
      return "This answer determines whether there is evidence of the required comparable public-sector project experience.";
    default:
      return "This answer could materially change the decision.";
  }
}

function requirementSeverity(status, requirement) {
  if (status === "failed" && requirement.mandatory && requirement.gating === "hard") return "critical";
  if (status === "failed" && requirement.mandatory) return "high";
  if (status === "needs_verification" && requirement.mandatory && requirement.gating === "hard") return "high";
  if (status === "needs_verification" && requirement.mandatory) return "medium";
  return "low";
}

export function evaluateRequirement(company, opportunity, requirement, lot = null, now = new Date()) {
  let comparison = asComparison("needs_verification");
  const subject = {
    ...opportunity,
    ...(lot ?? {}),
    cpvCodes: lot?.cpvCodes ?? opportunity.cpvCodes,
    keywords: lot?.keywords ?? opportunity.keywords,
    description: lot?.description ?? opportunity.description,
    title: lot?.title ?? opportunity.title,
    location: lot?.location ?? opportunity.location
  };

  switch (requirement.kind) {
    case "certification":
      comparison = compareCertification(company, requirement, now);
      break;
    case "experience_value":
      comparison = compareExperience(company, subject, requirement, now);
      break;
    case "comparable_experience":
      comparison = compareComparableExperience(company, subject, requirement, now, {
        publicOnlyDefault: false,
        comparableScopeDefault: true
      });
      break;
    case "turnover":
      comparison = compareTurnover(company, requirement, now);
      break;
    case "region":
      comparison = compareRegion(company, requirement, opportunity);
      break;
    case "beneficiary":
      comparison = compareBeneficiary(company, requirement, now);
      break;
    case "co_finance":
      comparison = compareCoFinance(company, now);
      break;
    case "company_age":
      comparison = compareCompanyAge(company, requirement, now);
      break;
    case "insurance":
      comparison = compareInsurance(company, requirement, now);
      break;
    case "public_experience":
      comparison = comparePublicExperience(company, subject, requirement, now);
      break;
    case "custom":
      comparison = compareCustom(company, requirement);
      break;
    default:
      comparison = asComparison(requirement.defaultStatus ?? "needs_verification");
  }

  const mandatory = requirement.mandatory !== false;
  const severity = requirementSeverity(comparison.status, { ...requirement, mandatory });

  return {
    ...requirement,
    status: comparison.status,
    mandatory,
    why: requirement.why ?? defaultWhy(requirement),
    question: comparison.question ?? requirement.question,
    failureReason: comparison.failureReason ?? requirement.failureReason,
    evidenceIds: requirement.evidenceIds ?? [],
    severity
  };
}

export function evaluateEligibility(company, opportunity, lot, now = new Date()) {
  const requirements = [...(opportunity.requirements ?? []), ...(lot?.requirements ?? [])];
  const rows = requirements.map((requirement) => evaluateRequirement(company, opportunity, requirement, lot, now));

  const mandatoryRows = rows.filter((row) => row.mandatory);
  const failedMandatory = mandatoryRows.filter((row) => row.status === "failed");
  const unknownMandatory = mandatoryRows.filter((row) => row.status === "needs_verification");
  const confirmedMandatory = mandatoryRows.filter((row) => row.status === "confirmed");
  const hardMandatoryFailed = mandatoryRows.filter((row) => row.gating === "hard" && row.status === "failed");
  const hardMandatoryNeedsVerification = mandatoryRows.filter(
    (row) => row.gating === "hard" && row.status === "needs_verification"
  );

  let eligibilityStatus = "LIKELY_ELIGIBLE";
  if (failedMandatory.length) eligibilityStatus = "INELIGIBLE";
  else if (unknownMandatory.length) eligibilityStatus = "ELIGIBILITY_UNCLEAR";
  else if (mandatoryRows.length > 0 && confirmedMandatory.length === mandatoryRows.length) {
    eligibilityStatus = "CONFIRMED_ELIGIBLE";
  }

  const blockers = failedMandatory.map((row) => ({
    title: row.label,
    detail: row.failureReason ?? "Mandatory requirement fails based on available company data.",
    severity: row.severity
  }));
  const unknowns = unknownMandatory.map((row) => ({
    title: row.label,
    detail: row.question ?? "Requirement exists but company evidence is missing.",
    severity: row.severity
  }));

  return {
    eligibilityStatus,
    requirementRows: rows,
    blockers,
    unknowns,
    summary: {
      mandatoryConfirmed: confirmedMandatory.length,
      mandatoryNeedsVerification: unknownMandatory.length,
      mandatoryFailed: failedMandatory.length,
      hardMandatoryConfirmed: mandatoryRows.filter((row) => row.gating === "hard" && row.status === "confirmed").length,
      hardMandatoryNeedsVerification: hardMandatoryNeedsVerification.length,
      hardMandatoryFailed: hardMandatoryFailed.length,
      companyConfirmationsNeeded: unknownMandatory.length
    }
  };
}

export function qualificationReadinessScore(eligibility) {
  const mandatory = eligibility.requirementRows.filter((row) => row.mandatory);
  if (!mandatory.length) return 70;
  const confirmed = mandatory.filter((row) => row.status === "confirmed").length;
  const failed = mandatory.filter((row) => row.status === "failed").length;
  const unknown = mandatory.filter((row) => row.status === "needs_verification").length;
  const hardUnknown = mandatory.filter((row) => row.gating === "hard" && row.status === "needs_verification").length;
  const score = 100 * (confirmed / mandatory.length) - failed * 55 - unknown * 18 - hardUnknown * 10;
  return Math.max(0, Math.min(100, score));
}
