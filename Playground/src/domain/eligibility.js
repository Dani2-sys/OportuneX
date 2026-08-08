import { bandToRange, moneyToMajor } from "./money.js";
import {
  factCanConfirmEligibility,
  getCompanyCertifications,
  getCompanyFact,
  getCompanyInsurancePolicies,
  getFactValue,
  getTurnoverRange,
  rangeCanConfirmEligibility
} from "./company-profile.js";
import { normalizeText } from "../utils.js";

function certificationValue(record) {
  return getFactValue(record?.currentStatus);
}

function compareCertification(company, requirement, now) {
  const certifications = getCompanyCertifications(company);
  const found = certifications.find(
    (item) => normalizeText(item.name) === normalizeText(requirement.requiredValue ?? requirement.label)
  );
  if (!found) return "needs_verification";
  const availability = certificationValue(found);
  if (availability === "valid" && factCanConfirmEligibility(found.currentStatus, now)) return "confirmed";
  if ((availability === "missing" || availability === "expired") && factCanConfirmEligibility(found.currentStatus, now)) {
    return "failed";
  }
  return "needs_verification";
}

function compareExperience(company, requirement, now) {
  const maxProjectValueFact = getCompanyFact(company, "maximumProjectValue");
  const maxProjectValue = getFactValue(maxProjectValueFact);
  if (!requirement.minimumAmount) return "needs_verification";
  if (maxProjectValue == null || !factCanConfirmEligibility(maxProjectValueFact, now)) return "needs_verification";
  return maxProjectValue >= requirement.minimumAmount ? "confirmed" : "failed";
}

function compareTurnover(company, requirement, now) {
  const turnoverRange = getTurnoverRange(company);
  const minimum = requirement.minimumAmount ?? bandToRange(requirement.minimumTurnoverBand ?? "under-250k")[0];
  if (!rangeCanConfirmEligibility(turnoverRange, now)) return "needs_verification";
  if (turnoverRange.min != null && turnoverRange.min >= minimum) return "confirmed";
  if (turnoverRange.max == null) return "needs_verification";
  if (turnoverRange.max < minimum) return "failed";
  if (turnoverRange.min == null) return "needs_verification";
  if (turnoverRange.min < minimum && turnoverRange.max >= minimum) return "needs_verification";
  return "failed";
}

function compareRegion(company, requirement, opportunity) {
  const region = normalizeText(opportunity.location?.autonomousCommunity ?? opportunity.location?.province ?? "");
  if (!region) return "needs_verification";
  const excluded = (company.geography?.excludedRegions ?? []).map(normalizeText);
  if (excluded.includes(region)) return "failed";
  const accepted = (requirement.allowedRegions ?? company.geography?.acceptedRegions ?? []).map(normalizeText);
  if (!accepted.length) return "confirmed";
  return accepted.includes(region) ? "confirmed" : "failed";
}

function compareBeneficiary(company, requirement, now) {
  const wanted = normalizeText(requirement.requiredValue ?? "");
  if (!wanted) return "needs_verification";
  if (wanted === "sme") {
    const smeStatus = getCompanyFact(company, "smeStatus");
    if (!factCanConfirmEligibility(smeStatus, now)) return "needs_verification";
    if (getFactValue(smeStatus) === "confirmed") return "confirmed";
    if (getFactValue(smeStatus) === "not-sme") return "failed";
    return "needs_verification";
  }
  if (wanted === "sl" || wanted === "sociedad limitada") {
    const legalEntityType = getCompanyFact(company, "legalEntityType");
    if (!factCanConfirmEligibility(legalEntityType, now)) return "needs_verification";
    return normalizeText(getFactValue(legalEntityType) ?? "").includes("sl") ? "confirmed" : "failed";
  }
  return "needs_verification";
}

function compareCoFinance(company, now) {
  const canCoFinance = getCompanyFact(company, "canCoFinance");
  if (!factCanConfirmEligibility(canCoFinance, now)) return "needs_verification";
  if (getFactValue(canCoFinance) === true) return "confirmed";
  if (getFactValue(canCoFinance) === false) return "failed";
  return "needs_verification";
}

function compareCompanyAge(company, requirement, now) {
  const ageFact = getCompanyFact(company, "companyAgeYears");
  const age = getFactValue(ageFact);
  if (age == null || !factCanConfirmEligibility(ageFact, now)) return "needs_verification";
  return age >= requirement.minimumYears ? "confirmed" : "failed";
}

function compareInsurance(company, requirement, now) {
  const insurance = getCompanyInsurancePolicies(company).find((item) =>
    normalizeText(item.name).includes(normalizeText(requirement.label))
  );
  if (!insurance) return "needs_verification";
  const cover = getFactValue(insurance.coverAmountFact);
  if (cover == null || !factCanConfirmEligibility(insurance.coverAmountFact, now)) return "needs_verification";
  return cover >= (requirement.minimumAmount ?? 0) ? "confirmed" : "failed";
}

function comparePublicExperience(company, requirement, now) {
  const countFact = getCompanyFact(company, "publicProcurementProjects");
  const count = getFactValue(countFact);
  if (count == null || !factCanConfirmEligibility(countFact, now)) return "needs_verification";
  return count >= (requirement.minimumCount ?? 1) ? "confirmed" : "failed";
}

function compareCustom(company, requirement) {
  const answer = company.customAnswers?.[requirement.id];
  if (answer === "Yes") return "confirmed";
  if (answer === "No") return "failed";
  return requirement.defaultStatus ?? "needs_verification";
}

function defaultWhy(requirement) {
  switch (requirement.kind) {
    case "certification":
      return "This answer determines whether the published certification requirement is satisfied.";
    case "experience_value":
      return `This answer determines whether there is evidence of a comparable contract above ${requirement.minimumAmount ?? "the required amount"}.`;
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
      return "This answer determines whether the minimum public-procurement experience threshold is satisfied.";
    default:
      return "This answer could materially change the decision.";
  }
}

export function evaluateRequirement(company, opportunity, requirement, now = new Date()) {
  let status = "needs_verification";

  switch (requirement.kind) {
    case "certification":
      status = compareCertification(company, requirement, now);
      break;
    case "experience_value":
      status = compareExperience(company, requirement, now);
      break;
    case "turnover":
      status = compareTurnover(company, requirement, now);
      break;
    case "region":
      status = compareRegion(company, requirement, opportunity);
      break;
    case "beneficiary":
      status = compareBeneficiary(company, requirement, now);
      break;
    case "co_finance":
      status = compareCoFinance(company, now);
      break;
    case "company_age":
      status = compareCompanyAge(company, requirement, now);
      break;
    case "insurance":
      status = compareInsurance(company, requirement, now);
      break;
    case "public_experience":
      status = comparePublicExperience(company, requirement, now);
      break;
    case "custom":
      status = compareCustom(company, requirement);
      break;
    default:
      status = requirement.defaultStatus ?? "needs_verification";
  }

  return {
    ...requirement,
    status,
    mandatory: requirement.mandatory !== false,
    why: requirement.why ?? defaultWhy(requirement),
    evidenceIds: requirement.evidenceIds ?? [],
    severity:
      status === "failed" && requirement.gating === "hard"
        ? "high"
        : status === "needs_verification" && requirement.mandatory
          ? "medium"
          : "low"
  };
}

export function evaluateEligibility(company, opportunity, lot, now = new Date()) {
  const requirements = [...(opportunity.requirements ?? []), ...(lot?.requirements ?? [])];
  const rows = requirements.map((requirement) => evaluateRequirement(company, opportunity, requirement, now));

  const failedMandatory = rows.filter((row) => row.mandatory && row.status === "failed");
  const unknownMandatory = rows.filter((row) => row.mandatory && row.status === "needs_verification");
  const confirmedMandatory = rows.filter((row) => row.mandatory && row.status === "confirmed");

  let eligibilityStatus = "LIKELY_ELIGIBLE";
  if (failedMandatory.length) eligibilityStatus = "INELIGIBLE";
  else if (unknownMandatory.length) eligibilityStatus = "ELIGIBILITY_UNCLEAR";
  else if (confirmedMandatory.length === rows.filter((row) => row.mandatory).length) eligibilityStatus = "CONFIRMED_ELIGIBLE";

  const blockers = failedMandatory.map((row) => ({
    title: row.label,
    detail: row.failureReason ?? "Mandatory requirement fails based on available company data.",
    severity: "high"
  }));
  const unknowns = unknownMandatory.map((row) => ({
    title: row.label,
    detail: row.question ?? "Requirement exists but company evidence is missing.",
    severity: "medium"
  }));

  return {
    eligibilityStatus,
    requirementRows: rows,
    blockers,
    unknowns
  };
}

export function qualificationReadinessScore(eligibility) {
  const mandatory = eligibility.requirementRows.filter((row) => row.mandatory);
  if (!mandatory.length) return 70;
  const confirmed = mandatory.filter((row) => row.status === "confirmed").length;
  const failed = mandatory.filter((row) => row.status === "failed").length;
  const unknown = mandatory.filter((row) => row.status === "needs_verification").length;
  const score = 100 * (confirmed / mandatory.length) - failed * 55 - unknown * 18;
  return Math.max(0, Math.min(100, score));
}
