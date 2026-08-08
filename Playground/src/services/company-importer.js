import {
  FACT_STATUSES,
  PROFILE_MODES,
  createCompanyFact,
  createCompanyRange,
  getFactValue
} from "../domain/company-profile.js";
import { uid } from "../utils.js";

const BANNED_KEY_PATTERN = /(gold|benchmark|expected|ranking|answer_key|ground_truth)/i;
const TOP_LEVEL_KEYS = new Set([
  "id",
  "profileMode",
  "legalName",
  "tradingName",
  "cif",
  "preferredLanguage",
  "website",
  "geography",
  "size",
  "preferences",
  "experience",
  "grants",
  "facts",
  "factsHistory",
  "companySources",
  "capabilities",
  "certifications",
  "insurance",
  "classifications"
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateKeys(object, allowedKeys, label) {
  const keys = Object.keys(object);
  const unknownKeys = keys.filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw new Error(`${label} contains unsupported keys: ${unknownKeys.join(", ")}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function scanForBannedKeys(value, trail = "root") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForBannedKeys(item, `${trail}[${index}]`));
    return;
  }

  if (!isPlainObject(value)) return;

  Object.entries(value).forEach(([key, child]) => {
    if (BANNED_KEY_PATTERN.test(key)) {
      throw new Error(`Prospect import must remain blind. Unsupported key detected at ${trail}.${key}`);
    }
    scanForBannedKeys(child, `${trail}.${key}`);
  });
}

function validateStatus(status, label) {
  assert(FACT_STATUSES.includes(status), `${label} has unsupported status "${status}"`);
}

function validateSourceRecord(source, label) {
  assert(isPlainObject(source), `${label} must be an object`);
  validateKeys(
    source,
    new Set(["id", "organisation", "title", "url", "sourceType", "publishedAt", "retrievedAt"]),
    label
  );
  assert(source.organisation, `${label} organisation is required`);
  assert(source.title, `${label} title is required`);
  return {
    id: source.id ?? uid("company-source"),
    organisation: source.organisation,
    title: source.title,
    url: source.url ?? "",
    sourceType: source.sourceType ?? "manual",
    publishedAt: source.publishedAt ?? null,
    retrievedAt: source.retrievedAt ?? null
  };
}

function validateFactRecord(fact, label) {
  assert(isPlainObject(fact), `${label} must be an object`);
  validateKeys(
    fact,
    new Set(["value", "status", "confidence", "sourceIds", "asOfDate", "referenceYear", "notes"]),
    label
  );
  validateStatus(fact.status, label);
  return createCompanyFact(fact.value ?? null, {
    status: fact.status,
    confidence: fact.confidence ?? null,
    sourceIds: fact.sourceIds ?? [],
    asOfDate: fact.asOfDate ?? null,
    referenceYear: fact.referenceYear ?? null,
    notes: fact.notes ?? null
  });
}

function validateRangeRecord(range, label) {
  assert(isPlainObject(range), `${label} must be an object`);
  validateKeys(
    range,
    new Set(["min", "max", "currency", "referenceYear", "status", "confidence", "sourceIds", "asOfDate", "notes"]),
    label
  );
  validateStatus(range.status, label);
  return createCompanyRange({
    min: range.min ?? null,
    max: range.max ?? null,
    currency: range.currency ?? "EUR",
    referenceYear: range.referenceYear ?? null,
    status: range.status,
    confidence: range.confidence ?? null,
    sourceIds: range.sourceIds ?? [],
    asOfDate: range.asOfDate ?? null,
    notes: range.notes ?? null
  });
}

function validateFactHistory(history) {
  assert(!history || isPlainObject(history), "factsHistory must be an object when provided");
  if (!history) return {};
  return Object.fromEntries(
    Object.entries(history).map(([key, items]) => {
      assert(Array.isArray(items), `factsHistory.${key} must be an array`);
      return [key, items.map((item, index) => validateFactRecord(item, `factsHistory.${key}[${index}]`))];
    })
  );
}

function validateCapability(capability, index) {
  assert(isPlainObject(capability), `capabilities[${index}] must be an object`);
  validateKeys(
    capability,
    new Set(["id", "label", "level", "strength", "status", "aliases", "cpvPrefixes", "sourceIds", "evidenceIds", "asOfDate", "notes"]),
    `capabilities[${index}]`
  );
  validateStatus(capability.status, `capabilities[${index}]`);
  assert(capability.label, `capabilities[${index}] label is required`);
  return {
    id: capability.id ?? uid("cap"),
    label: capability.label,
    level: capability.level ?? capability.strength ?? "medium",
    strength: capability.strength ?? capability.level ?? "medium",
    status: capability.status,
    aliases: capability.aliases ?? [],
    cpvPrefixes: capability.cpvPrefixes ?? [],
    sourceIds: capability.sourceIds ?? [],
    evidenceIds: capability.evidenceIds ?? [],
    asOfDate: capability.asOfDate ?? null,
    notes: capability.notes ?? null
  };
}

function validateCertification(certification, index) {
  assert(isPlainObject(certification), `certifications[${index}] must be an object`);
  validateKeys(
    certification,
    new Set(["name", "status", "provenanceStatus", "currentStatus", "sourceIds", "asOfDate", "referenceYear", "notes"]),
    `certifications[${index}]`
  );
  assert(certification.name, `certifications[${index}] name is required`);
  const currentStatus = certification.currentStatus
    ? validateFactRecord(certification.currentStatus, `certifications[${index}].currentStatus`)
    : createCompanyFact(certification.status ?? "unknown", {
        status: certification.provenanceStatus ?? "unknown",
        confidence: certification.status === "unknown" ? null : "medium",
        sourceIds: certification.sourceIds ?? [],
        asOfDate: certification.asOfDate ?? null,
        referenceYear: certification.referenceYear ?? null,
        notes: certification.notes ?? null
      });

  return {
    name: certification.name,
    status: getFactValue(currentStatus) ?? "unknown",
    currentStatus
  };
}

function validateInsurance(policy, index) {
  assert(isPlainObject(policy), `insurance[${index}] must be an object`);
  validateKeys(
    policy,
    new Set(["name", "coverAmount", "coverAmountFact", "sourceIds", "asOfDate", "notes", "provenanceStatus"]),
    `insurance[${index}]`
  );
  assert(policy.name, `insurance[${index}] name is required`);
  const coverAmountFact = policy.coverAmountFact
    ? validateFactRecord(policy.coverAmountFact, `insurance[${index}].coverAmountFact`)
    : createCompanyFact(policy.coverAmount ?? null, {
        status: policy.provenanceStatus ?? "unknown",
        confidence: policy.coverAmount == null ? null : "medium",
        sourceIds: policy.sourceIds ?? [],
        asOfDate: policy.asOfDate ?? null,
        notes: policy.notes ?? null
      });
  return {
    name: policy.name,
    coverAmount: getFactValue(coverAmountFact),
    coverAmountFact
  };
}

function validateClassificationRecord(record, type, index) {
  assert(isPlainObject(record), `${type}[${index}] must be an object`);
  validateKeys(
    record,
    new Set(["code", "label", "status", "sourceIds", "referenceYear", "asOfDate", "notes"]),
    `${type}[${index}]`
  );
  validateStatus(record.status, `${type}[${index}]`);
  assert(record.code, `${type}[${index}] code is required`);
  return {
    code: record.code,
    label: record.label ?? "",
    status: record.status,
    sourceIds: record.sourceIds ?? [],
    referenceYear: record.referenceYear ?? null,
    asOfDate: record.asOfDate ?? null,
    notes: record.notes ?? null
  };
}

function validateFacts(rawFacts = {}) {
  assert(isPlainObject(rawFacts), "facts must be an object");
  return Object.fromEntries(
    Object.entries(rawFacts).map(([key, value]) => {
      const isRange = key === "employeeRange" || key === "turnoverRange";
      return [key, isRange ? validateRangeRecord(value, `facts.${key}`) : validateFactRecord(value, `facts.${key}`)];
    })
  );
}

function normalizeLegacyFields(profile) {
  const facts = profile.facts;
  profile.geography.preferredWorkingRadiusKm = getFactValue(facts.preferredWorkingRadiusKm);
  profile.preferences.minimumAttractiveProjectValue = getFactValue(facts.minimumAttractiveProjectValue);
  profile.preferences.idealProjectValue = getFactValue(facts.idealProjectValue);
  profile.preferences.maximumRealisticProjectValue = getFactValue(facts.maximumRealisticProjectValue);
  profile.experience.maximumProjectValue = getFactValue(facts.maximumProjectValue);
  profile.experience.publicProcurementProjects = getFactValue(facts.publicProcurementProjects);
  profile.grants.canCoFinance = getFactValue(facts.canCoFinance);
  profile.grants.deMinimisUsage = getFactValue(facts.deMinimisUsage);
  profile.size.companyAgeYears = getFactValue(facts.companyAgeYears);
  profile.size.legalEntityType = getFactValue(facts.legalEntityType);
  profile.size.smeStatus = getFactValue(facts.smeStatus);
  return profile;
}

export function importCompanyProfileFromJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Prospect profile import must be valid JSON.");
  }

  assert(isPlainObject(parsed), "Prospect profile import must be a JSON object.");
  scanForBannedKeys(parsed);
  validateKeys(parsed, TOP_LEVEL_KEYS, "Company profile import");

  const profileMode = parsed.profileMode ?? "prospect";
  assert(PROFILE_MODES.includes(profileMode), `Unsupported profileMode "${profileMode}"`);
  assert(parsed.legalName, "legalName is required for company profile import.");

  const profile = {
    id: parsed.id ?? uid("company"),
    profileMode,
    legalName: parsed.legalName,
    tradingName: parsed.tradingName ?? parsed.legalName,
    cif: parsed.cif ?? "",
    preferredLanguage: parsed.preferredLanguage ?? "es",
    website: parsed.website ?? "",
    geography: {
      municipality: parsed.geography?.municipality ?? "",
      province: parsed.geography?.province ?? "",
      autonomousCommunity: parsed.geography?.autonomousCommunity ?? "",
      display: parsed.geography?.display ?? parsed.geography?.municipality ?? parsed.geography?.province ?? "",
      acceptedRegions: parsed.geography?.acceptedRegions ?? [],
      excludedRegions: parsed.geography?.excludedRegions ?? [],
      willingToTravel: parsed.geography?.willingToTravel ?? null,
      preferredWorkingRadiusKm: null
    },
    size: {
      employeeBand: parsed.size?.employeeBand ?? null,
      turnoverBand: parsed.size?.turnoverBand ?? null,
      companyAgeYears: null,
      smeStatus: null,
      legalEntityType: null
    },
    preferences: {
      minimumAttractiveProjectValue: null,
      idealProjectValue: null,
      maximumRealisticProjectValue: null,
      desiredWorkTypes: parsed.preferences?.desiredWorkTypes ?? [],
      unwantedWorkTypes: parsed.preferences?.unwantedWorkTypes ?? []
    },
    experience: {
      yearsInTrade: parsed.experience?.yearsInTrade ?? null,
      maximumProjectValue: null,
      publicProcurementProjects: null,
      representativeProjects: parsed.experience?.representativeProjects ?? []
    },
    grants: {
      canCoFinance: null,
      minimumWorthwhileSubsidy: parsed.grants?.minimumWorthwhileSubsidy ?? null,
      deMinimisUsage: null
    },
    facts: validateFacts(parsed.facts ?? {}),
    factsHistory: validateFactHistory(parsed.factsHistory),
    companySources: (parsed.companySources ?? []).map((source, index) =>
      validateSourceRecord(source, `companySources[${index}]`)
    ),
    capabilities: (parsed.capabilities ?? []).map(validateCapability),
    certifications: (parsed.certifications ?? []).map(validateCertification),
    insurance: (parsed.insurance ?? []).map(validateInsurance),
    classifications: {
      cnae: (parsed.classifications?.cnae ?? []).map((item, index) => validateClassificationRecord(item, "cnae", index)),
      iae: (parsed.classifications?.iae ?? []).map((item, index) => validateClassificationRecord(item, "iae", index)),
      cpv: (parsed.classifications?.cpv ?? []).map((item, index) => validateClassificationRecord(item, "cpv", index))
    },
    customAnswers: {}
  };

  return normalizeLegacyFields(profile);
}
