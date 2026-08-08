import { normalizeText } from "../utils.js";

export const PROFILE_MODES = ["confirmed", "prospect"];
export const FACT_STATUSES = [
  "company_confirmed",
  "public_verified",
  "public_reported",
  "inferred",
  "unknown",
  "conflicted"
];
export const FACT_CONFIDENCE = ["high", "medium", "low", null];

const RANGE_FACT_KEYS = new Set(["employeeRange", "turnoverRange"]);
const FACT_HISTORY_KEYS = {
  employeeCountCurrent: "employeeCountHistory",
  turnoverCurrent: "turnoverHistory",
  turnoverRange: "turnoverHistory"
};

const EMPLOYEE_BAND_MAP = {
  "1-9": [1, 9],
  "10-25": [10, 25],
  "26-50": [26, 50],
  "51-100": [51, 100],
  "101-250": [101, 250],
  "250+": [250, null]
};

const TURNOVER_BAND_MAP = {
  "under-250k": [0, 250000],
  "250k-500k": [250000, 500000],
  "500k-1m": [500000, 1000000],
  "1m-2m": [1000000, 2000000],
  "2m-5m": [2000000, 5000000],
  "5m+": [5000000, null]
};

export function createCompanyFact(
  value,
  {
    status = value == null ? "unknown" : "company_confirmed",
    confidence = value == null ? null : "high",
    sourceIds = [],
    asOfDate = null,
    referenceYear = null,
    notes = null
  } = {}
) {
  return {
    value,
    status,
    confidence,
    sourceIds,
    asOfDate,
    referenceYear,
    notes
  };
}

export function createCompanyRange({
  min = null,
  max = null,
  currency = "EUR",
  referenceYear = null,
  status = min == null && max == null ? "unknown" : "company_confirmed",
  confidence = min == null && max == null ? null : "high",
  sourceIds = [],
  asOfDate = null,
  notes = null
} = {}) {
  return {
    min,
    max,
    currency,
    referenceYear,
    status,
    confidence,
    sourceIds,
    asOfDate,
    notes
  };
}

export function createCompanySource({
  id,
  organisation,
  title,
  url = "",
  sourceType = "manual",
  publishedAt = null,
  retrievedAt = null
}) {
  return {
    id,
    organisation,
    title,
    url,
    sourceType,
    publishedAt,
    retrievedAt
  };
}

export function getProfileMode(company) {
  return PROFILE_MODES.includes(company?.profileMode) ? company.profileMode : "confirmed";
}

export function isFactRecord(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "status" in value &&
      ("value" in value || "min" in value || "max" in value)
  );
}

export function isRangeRecord(value) {
  return isFactRecord(value) && ("min" in value || "max" in value);
}

export function getFactStatus(fact) {
  if (isFactRecord(fact)) return fact.status ?? "unknown";
  if (fact == null) return "unknown";
  return "company_confirmed";
}

export function isUnknownStatus(status) {
  return status === "unknown";
}

export function isConflictedStatus(status) {
  return status === "conflicted";
}

export function isUnknownFact(fact) {
  return isUnknownStatus(getFactStatus(fact));
}

export function isConflictedFact(fact) {
  return isConflictedStatus(getFactStatus(fact));
}

export function getFactValue(fact, fallback = null) {
  if (isFactRecord(fact)) {
    return isUnknownFact(fact) || isConflictedFact(fact) ? fallback : fact.value ?? fallback;
  }
  return fact ?? fallback;
}

export function getRangeValue(range) {
  if (!isRangeRecord(range)) return null;
  if (isUnknownFact(range) || isConflictedFact(range)) return null;
  return range;
}

export function employeeBandToRange(band) {
  const [min, max] = EMPLOYEE_BAND_MAP[band] ?? [null, null];
  return min == null && max == null ? null : createCompanyRange({ min, max });
}

export function turnoverBandToRange(band) {
  const [min, max] = TURNOVER_BAND_MAP[band] ?? [null, null];
  return min == null && max == null ? null : createCompanyRange({ min, max });
}

function legacyFact(company, key) {
  switch (key) {
    case "preferredWorkingRadiusKm":
      return company?.geography?.preferredWorkingRadiusKm != null
        ? createCompanyFact(company.geography.preferredWorkingRadiusKm)
        : createCompanyFact(null);
    case "minimumAttractiveProjectValue":
      return company?.preferences?.minimumAttractiveProjectValue != null
        ? createCompanyFact(company.preferences.minimumAttractiveProjectValue)
        : createCompanyFact(null);
    case "idealProjectValue":
      return company?.preferences?.idealProjectValue != null
        ? createCompanyFact(company.preferences.idealProjectValue)
        : createCompanyFact(null);
    case "maximumRealisticProjectValue":
      return company?.preferences?.maximumRealisticProjectValue != null
        ? createCompanyFact(company.preferences.maximumRealisticProjectValue)
        : createCompanyFact(null);
    case "publicProcurementProjects":
      return company?.experience?.publicProcurementProjects != null
        ? createCompanyFact(company.experience.publicProcurementProjects)
        : createCompanyFact(null);
    case "maximumProjectValue":
      return company?.experience?.maximumProjectValue != null
        ? createCompanyFact(company.experience.maximumProjectValue)
        : createCompanyFact(null);
    case "canCoFinance":
      return company?.grants?.canCoFinance != null ? createCompanyFact(company.grants.canCoFinance) : createCompanyFact(null);
    case "deMinimisUsage":
      return company?.grants?.deMinimisUsage != null ? createCompanyFact(company.grants.deMinimisUsage) : createCompanyFact(null);
    case "companyAgeYears":
      return company?.size?.companyAgeYears != null ? createCompanyFact(company.size.companyAgeYears) : createCompanyFact(null);
    case "legalEntityType":
      return company?.size?.legalEntityType ? createCompanyFact(company.size.legalEntityType) : createCompanyFact(null);
    case "smeStatus":
      return company?.size?.smeStatus ? createCompanyFact(company.size.smeStatus) : createCompanyFact(null);
    case "employeeCountCurrent":
      return createCompanyFact(null);
    default:
      return createCompanyFact(null);
  }
}

function legacyRange(company, key) {
  switch (key) {
    case "employeeRange":
      return employeeBandToRange(company?.size?.employeeBand);
    case "turnoverRange":
      return turnoverBandToRange(company?.size?.turnoverBand);
    default:
      return null;
  }
}

export function getCompanyFact(company, key) {
  const fact = company?.facts?.[key];
  if (isFactRecord(fact)) return fact;
  if (RANGE_FACT_KEYS.has(key) && isRangeRecord(fact)) return fact;
  if (RANGE_FACT_KEYS.has(key)) return legacyRange(company, key) ?? createCompanyRange();
  return legacyFact(company, key);
}

export function getCompanyFactHistory(company, key) {
  const specificHistoryKey = FACT_HISTORY_KEYS[key];
  const factHistory = company?.facts?.[specificHistoryKey];
  if (Array.isArray(factHistory)) return factHistory;
  const genericHistory = company?.factsHistory?.[key];
  return Array.isArray(genericHistory) ? genericHistory : [];
}

export function getEmployeeRange(company) {
  const range = getCompanyFact(company, "employeeRange");
  if (getRangeValue(range)) return range;
  const exact = getCompanyFact(company, "employeeCountCurrent");
  const value = getFactValue(exact);
  if (value == null) return createCompanyRange();
  return createCompanyRange({
    min: value,
    max: value,
    status: getFactStatus(exact),
    confidence: exact.confidence ?? null,
    sourceIds: exact.sourceIds ?? [],
    asOfDate: exact.asOfDate ?? null,
    referenceYear: exact.referenceYear ?? null,
    notes: exact.notes ?? null
  });
}

export function getTurnoverRange(company) {
  const range = getCompanyFact(company, "turnoverRange");
  return getRangeValue(range) ? range : createCompanyRange();
}

export function getCompanyCapabilities(company) {
  const fallbackStatus = getProfileMode(company) === "prospect" ? "public_reported" : "company_confirmed";
  return (company?.capabilities ?? []).map((capability) => ({
    ...capability,
    strength: capability.strength ?? capability.level ?? "medium",
    status: capability.status ?? fallbackStatus,
    sourceIds: capability.sourceIds ?? [],
    evidenceIds: capability.evidenceIds ?? [],
    asOfDate: capability.asOfDate ?? null,
    notes: capability.notes ?? null
  }));
}

export function getCompanyCertifications(company) {
  const fallbackStatus = getProfileMode(company) === "prospect" ? "public_reported" : "company_confirmed";
  return (company?.certifications ?? []).map((item) => ({
    ...item,
    currentStatus:
      isFactRecord(item.currentStatus)
        ? item.currentStatus
        : createCompanyFact(item.status ?? "unknown", {
            status: item.provenanceStatus ?? fallbackStatus,
            confidence: item.confidence ?? (item.status === "unknown" ? null : "high"),
            sourceIds: item.sourceIds ?? [],
            asOfDate: item.asOfDate ?? null,
            referenceYear: item.referenceYear ?? null,
            notes: item.notes ?? null
          })
  }));
}

export function getCompanyInsurancePolicies(company) {
  const fallbackStatus = getProfileMode(company) === "prospect" ? "public_reported" : "company_confirmed";
  return (company?.insurance ?? []).map((item) => ({
    ...item,
    coverAmountFact:
      isFactRecord(item.coverAmountFact)
        ? item.coverAmountFact
        : createCompanyFact(item.coverAmount ?? null, {
            status: item.provenanceStatus ?? fallbackStatus,
            confidence: item.coverAmount == null ? null : "high",
            sourceIds: item.sourceIds ?? [],
            asOfDate: item.asOfDate ?? null,
            notes: item.notes ?? null
          })
  }));
}

export function getCompanyClassifications(company, type) {
  return (company?.classifications?.[type] ?? []).map((item) => ({
    ...item,
    status: item.status ?? "public_reported",
    sourceIds: item.sourceIds ?? [],
    notes: item.notes ?? null,
    referenceYear: item.referenceYear ?? null,
    asOfDate: item.asOfDate ?? null
  }));
}

export function getCompanySources(company) {
  if (Array.isArray(company?.companySources) && company.companySources.length) return company.companySources;
  if (company?.website) {
    return [
      createCompanySource({
        id: `${company.id}-website`,
        organisation: company.legalName ?? company.tradingName ?? "Company website",
        title: "Company website",
        url: company.website,
        sourceType: "company_website",
        publishedAt: null,
        retrievedAt: null
      })
    ];
  }
  return [];
}

export function isStalePublicFact(fact, now = new Date()) {
  const status = getFactStatus(fact);
  if (status === "company_confirmed") return false;
  if (status === "unknown" || status === "conflicted") return false;
  if (fact?.referenceYear != null) {
    return fact.referenceYear < now.getFullYear();
  }
  if (fact?.asOfDate) {
    const ageDays = Math.round((now - new Date(fact.asOfDate)) / 86400000);
    return ageDays > 365;
  }
  return true;
}

export function factCanConfirmEligibility(fact, now = new Date()) {
  const status = getFactStatus(fact);
  if (status === "unknown" || status === "conflicted") return false;
  if (status === "company_confirmed") return true;
  if (status === "public_verified") return !isStalePublicFact(fact, now);
  return false;
}

export function rangeCanConfirmEligibility(range, now = new Date()) {
  return factCanConfirmEligibility(range, now) && getRangeValue(range) != null;
}

function formatIntegerRange(min, max) {
  if (min != null && max != null && min === max) return `${min}`;
  if (min != null && max != null) return `${min}-${max}`;
  if (min != null) return `${min}+`;
  if (max != null) return `Up to ${max}`;
  return "Unknown";
}

function formatCurrencyRange(min, max, currency = "EUR") {
  const formatter = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  });
  if (min != null && max != null && min === max) return formatter.format(min);
  if (min != null && max != null) return `${formatter.format(min)}-${formatter.format(max)}`;
  if (min != null) return `${formatter.format(min)}+`;
  if (max != null) return `Up to ${formatter.format(max)}`;
  return "Unknown";
}

export function formatCompanyRange(range, kind = "number") {
  if (!range) return "Unknown";
  if (kind === "money") return formatCurrencyRange(range.min, range.max, range.currency ?? "EUR");
  return formatIntegerRange(range.min, range.max);
}

export function formatCompanyFact(fact, kind = "text") {
  const value = getFactValue(fact);
  if (value == null) return "Unknown";
  if (kind === "money") {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0
    }).format(value);
  }
  if (kind === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function describeStatus(status) {
  switch (status) {
    case "company_confirmed":
      return "Company confirmed";
    case "public_verified":
      return "Public source";
    case "public_reported":
      return "Public reported";
    case "inferred":
      return "Inferred";
    case "conflicted":
      return "Conflict";
    default:
      return "Unknown";
  }
}

export function buildCompanyUnknowns(company) {
  const unknowns = [];
  const employeeRange = getEmployeeRange(company);
  if (!getRangeValue(employeeRange)) unknowns.push("Current employee count");
  const turnoverRange = getTurnoverRange(company);
  if (!getRangeValue(turnoverRange)) unknowns.push("Current turnover");
  if (getFactValue(getCompanyFact(company, "maximumRealisticProjectValue")) == null) unknowns.push("Maximum realistic project capacity");
  if (getFactValue(getCompanyFact(company, "publicProcurementProjects")) == null) unknowns.push("Public procurement experience");
  if (!getCompanyCertifications(company).some((item) => getFactValue(item.currentStatus) === "valid")) {
    unknowns.push("Key certifications / professional qualifications");
  }
  return [...new Set(unknowns)];
}

export function buildCompanyConflicts(company) {
  const conflicts = [];
  const classificationGroups = ["cnae", "iae", "cpv"];
  classificationGroups.forEach((type) => {
    getCompanyClassifications(company, type)
      .filter((item) => item.status === "conflicted")
      .forEach((item) => {
        conflicts.push({
          field: type.toUpperCase(),
          detail: item.label ? `${item.code} — ${item.label}` : item.code
        });
      });
  });
  return conflicts;
}

export function computeDecisionProfileCompleteness(company) {
  const capabilitiesKnown = getCompanyCapabilities(company).some((item) => item.status !== "unknown");
  const geographyKnown = Boolean(
    company?.geography?.municipality ||
      company?.geography?.province ||
      (company?.geography?.acceptedRegions ?? []).length
  );
  const scaleKnown = Boolean(
    getFactValue(getCompanyFact(company, "maximumRealisticProjectValue")) != null ||
      getRangeValue(getTurnoverRange(company)) != null ||
      getFactValue(getCompanyFact(company, "maximumProjectValue")) != null
  );
  const certificationKnown = getCompanyCertifications(company).some((item) => getFactValue(item.currentStatus) != null);
  const experienceKnown =
    getFactValue(getCompanyFact(company, "publicProcurementProjects")) != null ||
    getFactValue(getCompanyFact(company, "maximumProjectValue")) != null;
  const strategyKnown = Boolean(
    (company?.preferences?.desiredWorkTypes ?? []).length || (company?.preferences?.unwantedWorkTypes ?? []).length
  );

  const weights = [
    [capabilitiesKnown, 25],
    [geographyKnown, 15],
    [scaleKnown, 20],
    [certificationKnown, 15],
    [experienceKnown, 15],
    [strategyKnown, 10]
  ];
  const score = Math.round(weights.reduce((sum, [known, weight]) => sum + (known ? weight : 0), 0));

  return {
    score,
    missingFacts: buildCompanyUnknowns(company).slice(0, 4)
  };
}

export function setCompanyFact(company, key, nextFact) {
  if (!company.facts) company.facts = {};
  const current = company.facts[key];
  if (isFactRecord(current) && !isUnknownFact(current)) {
    if (!company.factsHistory) company.factsHistory = {};
    company.factsHistory[key] = [current, ...(company.factsHistory[key] ?? [])];
  }
  company.facts[key] = nextFact;
}

export function setCompanyFactUnknown(company, key, notes = null) {
  setCompanyFact(company, key, createCompanyFact(null, { status: "unknown", confidence: null, notes }));
}

export function setCompanyConfirmedFact(company, key, value, { sourceIds = [], notes = null, asOfDate = new Date().toISOString().slice(0, 10) } = {}) {
  setCompanyFact(
    company,
    key,
    createCompanyFact(value, {
      status: "company_confirmed",
      confidence: "high",
      sourceIds,
      asOfDate,
      notes
    })
  );
}

export function setCompanyConfirmedRange(company, key, range, { sourceIds = [], notes = null, referenceYear = null, asOfDate = new Date().toISOString().slice(0, 10) } = {}) {
  setCompanyFact(
    company,
    key,
    createCompanyRange({
      ...range,
      status: "company_confirmed",
      confidence: "high",
      sourceIds,
      notes,
      referenceYear,
      asOfDate
    })
  );
}

export function setCertificationDecision(company, name, availability, options = {}) {
  if (!Array.isArray(company.certifications)) company.certifications = [];
  const existing = getCompanyCertifications(company).find((item) => normalizeText(item.name) === normalizeText(name));
  if (existing) {
    existing.currentStatus = createCompanyFact(availability, {
      status: "company_confirmed",
      confidence: "high",
      sourceIds: options.sourceIds ?? [],
      asOfDate: options.asOfDate ?? new Date().toISOString().slice(0, 10),
      notes: options.notes ?? null
    });
    const targetIndex = company.certifications.findIndex((item) => normalizeText(item.name) === normalizeText(name));
    company.certifications[targetIndex] = existing;
    return;
  }

  company.certifications.push({
    name,
    currentStatus: createCompanyFact(availability, {
      status: "company_confirmed",
      confidence: "high",
      sourceIds: options.sourceIds ?? [],
      asOfDate: options.asOfDate ?? new Date().toISOString().slice(0, 10),
      notes: options.notes ?? null
    })
  });
}
