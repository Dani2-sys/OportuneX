import { bandToRange, moneyToMajor } from "./money.js";
import { normalizeText } from "../utils.js";

function compareCertification(company, requirement) {
  const certifications = company.certifications ?? [];
  const found = certifications.find(
    (item) => normalizeText(item.name) === normalizeText(requirement.requiredValue ?? requirement.label)
  );
  if (!found) return "needs_verification";
  if (found.status === "valid") return "confirmed";
  if (found.status === "missing" || found.status === "expired") return "failed";
  return "needs_verification";
}

function compareExperience(company, requirement) {
  const maxProjectValue = company.experience?.maximumProjectValue ?? company.preferences?.maximumRealisticProjectValue ?? 0;
  if (!requirement.minimumAmount) return "needs_verification";
  if (!maxProjectValue) return "needs_verification";
  return maxProjectValue >= requirement.minimumAmount ? "confirmed" : "failed";
}

function compareTurnover(company, requirement) {
  const [companyMin, companyMax] = bandToRange(company.size?.turnoverBand);
  const minimum = requirement.minimumAmount ?? bandToRange(requirement.minimumTurnoverBand ?? "under-250k")[0];
  if (!companyMax) return "needs_verification";
  if (companyMin >= minimum || companyMax >= minimum) return "confirmed";
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

function compareBeneficiary(company, requirement) {
  const wanted = normalizeText(requirement.requiredValue ?? "");
  if (!wanted) return "needs_verification";
  if (wanted === "sme") {
    if (company.size?.smeStatus === "confirmed") return "confirmed";
    if (company.size?.smeStatus === "not-sme") return "failed";
    return "needs_verification";
  }
  if (wanted === "sl" || wanted === "sociedad limitada") {
    return normalizeText(company.size?.legalEntityType ?? "").includes("sl") ? "confirmed" : "failed";
  }
  return "needs_verification";
}

function compareCoFinance(company) {
  if (company.grants?.canCoFinance === true) return "confirmed";
  if (company.grants?.canCoFinance === false) return "failed";
  return "needs_verification";
}

function compareCompanyAge(company, requirement) {
  const age = company.size?.companyAgeYears;
  if (!age) return "needs_verification";
  return age >= requirement.minimumYears ? "confirmed" : "failed";
}

function compareInsurance(company, requirement) {
  const insurance = (company.insurance ?? []).find((item) =>
    normalizeText(item.name).includes(normalizeText(requirement.label))
  );
  if (!insurance) return "needs_verification";
  const cover = insurance.coverAmount ?? 0;
  return cover >= (requirement.minimumAmount ?? 0) ? "confirmed" : "failed";
}

function comparePublicExperience(company, requirement) {
  const count = company.experience?.publicProcurementProjects ?? 0;
  if (!count && count !== 0) return "needs_verification";
  return count >= (requirement.minimumCount ?? 1) ? "confirmed" : "failed";
}

function compareCustom(company, requirement) {
  const answer = company.customAnswers?.[requirement.id];
  if (answer === "Yes") return "confirmed";
  if (answer === "No") return "failed";
  return requirement.defaultStatus ?? "needs_verification";
}

export function evaluateRequirement(company, opportunity, requirement) {
  let status = "needs_verification";

  switch (requirement.kind) {
    case "certification":
      status = compareCertification(company, requirement);
      break;
    case "experience_value":
      status = compareExperience(company, requirement);
      break;
    case "turnover":
      status = compareTurnover(company, requirement);
      break;
    case "region":
      status = compareRegion(company, requirement, opportunity);
      break;
    case "beneficiary":
      status = compareBeneficiary(company, requirement);
      break;
    case "co_finance":
      status = compareCoFinance(company);
      break;
    case "company_age":
      status = compareCompanyAge(company, requirement);
      break;
    case "insurance":
      status = compareInsurance(company, requirement);
      break;
    case "public_experience":
      status = comparePublicExperience(company, requirement);
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
    evidenceIds: requirement.evidenceIds ?? [],
    severity:
      status === "failed" && requirement.gating === "hard"
        ? "high"
        : status === "needs_verification" && requirement.mandatory
          ? "medium"
          : "low"
  };
}

export function evaluateEligibility(company, opportunity, lot) {
  const requirements = [...(opportunity.requirements ?? []), ...(lot?.requirements ?? [])];
  const rows = requirements.map((requirement) => evaluateRequirement(company, opportunity, requirement));

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
