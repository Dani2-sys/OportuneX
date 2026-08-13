import { normalizeText, uid } from "../utils.js";
import { createMoney, parseMoneyInput } from "../domain/money.js";
import { parseSpanishDate, toUtcIso } from "../domain/deadline.js";

const BANNED_KEY_PATTERN = /(gold|benchmark|expected|ranking|answer_key|ground_truth)/i;
const OPPORTUNITY_TYPES = new Set(["contract", "grant"]);
const NOTICE_TYPES = new Set([
  "active_contract_notice",
  "award_notice",
  "grant_call",
  "amendment",
  "cancellation",
  "prior_information"
]);
const STATUSES = new Set([
  "open",
  "upcoming",
  "closing_soon",
  "closed",
  "cancelled",
  "suspended",
  "awarded",
  "unknown"
]);
const SUPPORTED_REQUIREMENT_KINDS = new Set([
  "certification",
  "experience_value",
  "comparable_experience",
  "public_experience",
  "turnover",
  "employee_count",
  "beneficiary",
  "company_age",
  "insurance",
  "co_finance",
  "region",
  "custom"
]);
const TOP_LEVEL_KEYS = new Set([
  "id",
  "canonicalId",
  "sourceOpportunityId",
  "sourceNoticeVersionId",
  "type",
  "noticeType",
  "status",
  "title",
  "description",
  "issuingOrganisation",
  "contractingAuthority",
  "publicationDate",
  "modificationDate",
  "startDate",
  "deadline",
  "location",
  "cpvCodes",
  "keywords",
  "procedureType",
  "estimatedValue",
  "awardValue",
  "baseBudget",
  "relevantValue",
  "wholeProcedureValue",
  "annualValue",
  "multiYearValue",
  "maximumAidPerBeneficiary",
  "programmeBudget",
  "eligibleProjectCost",
  "aidIntensity",
  "duration",
  "guarantees",
  "submissionMechanism",
  "applicationUrl",
  "noticeUrl",
  "referenceNumber",
  "requiredDocuments",
  "documents",
  "lastChecked",
  "contacts",
  "sources",
  "evidence",
  "availabilityWarnings",
  "sourceConflicts",
  "requirements",
  "lots",
  "cancellationStatus"
]);
const MONEY_KEYS = new Set(["amountMinor", "major", "currency", "vatStatus", "amountType", "source", "label", "original"]);
const LOCATION_KEYS = new Set(["municipality", "province", "autonomousCommunity", "display"]);
const SOURCE_KEYS = new Set(["id", "organisation", "title", "url", "official", "publishedAt", "lastChecked"]);
const EVIDENCE_KEYS = new Set(["id", "fieldKey", "excerpt", "sourceId", "sourceType", "confidence"]);
const CONTACT_KEYS = new Set(["role", "name", "email", "phone"]);
const AVAILABILITY_WARNING_KEYS = new Set(["id", "title", "detail", "severity"]);
const SOURCE_CONFLICT_KEYS = new Set(["field", "left", "right", "sourceIds"]);
const REQUIREMENT_KEYS = new Set([
  "id",
  "kind",
  "label",
  "requiredValue",
  "mandatory",
  "gating",
  "question",
  "evidenceIds",
  "minimumAmount",
  "minimumCount",
  "minimumTurnoverBand",
  "publicOnly",
  "lookbackYears",
  "comparableScopeRequired",
  "requiredCapabilities",
  "requiredCpvPrefixes",
  "allowedRegions",
  "minimumYears",
  "defaultStatus"
]);
const LOT_KEYS = new Set([
  "id",
  "title",
  "description",
  "cpvCodes",
  "keywords",
  "value",
  "location",
  "requirements",
  "documents",
  "contacts"
]);
const DEADLINE_KEYS = new Set(["sourceText", "date", "time", "timezone", "sourceTimezone", "utcEquivalent"]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateKeys(object, allowedKeys, label) {
  const keys = Object.keys(object);
  const unsupportedKeys = keys.filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length) {
    throw new Error(`${label} contains unsupported keys: ${unsupportedKeys.join(", ")}`);
  }
}

function scanForBannedKeys(value, trail = "root") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForBannedKeys(item, `${trail}[${index}]`));
    return;
  }

  if (!isPlainObject(value)) return;

  Object.entries(value).forEach(([key, child]) => {
    if (BANNED_KEY_PATTERN.test(key)) {
      throw new Error(`Structured opportunity import must remain blind. Unsupported key detected at ${trail}.${key}`);
    }
    scanForBannedKeys(child, `${trail}.${key}`);
  });
}

function normalizeString(value, label, fallback = "") {
  if (value == null) return fallback;
  assert(typeof value === "string" || typeof value === "number", `${label} must be a string.`);
  return value.toString();
}

function normalizeStringArray(values, label) {
  assert(Array.isArray(values), `${label} must be an array.`);
  return values.map((value, index) => normalizeString(value, `${label}[${index}]`));
}

function normalizeOptionalNumber(value, label) {
  if (value == null) return null;
  assert(typeof value === "number", `${label} must be a number.`);
  assert(Number.isFinite(value), `${label} must be finite.`);
  return value;
}

function normalizeOptionalBoolean(value, label) {
  if (value == null) return null;
  assert(typeof value === "boolean", `${label} must be true or false.`);
  return value;
}

function normalizeLocation(value, label) {
  if (value == null) {
    return {
      municipality: "",
      province: "",
      autonomousCommunity: "",
      display: "Needs review"
    };
  }

  assert(isPlainObject(value), `${label} must be an object.`);
  validateKeys(value, LOCATION_KEYS, label);
  const municipality = normalizeString(value.municipality, `${label}.municipality`, "");
  const province = normalizeString(value.province, `${label}.province`, "");
  const autonomousCommunity = normalizeString(value.autonomousCommunity, `${label}.autonomousCommunity`, "");
  const display =
    normalizeString(value.display, `${label}.display`, "") ||
    [municipality, province, autonomousCommunity].filter(Boolean).join(", ") ||
    "Needs review";

  return {
    municipality,
    province,
    autonomousCommunity,
    display
  };
}

function normalizeMoneyRecord(value, label, defaults = {}) {
  if (value == null || value === "") return null;

  if (typeof value === "number") {
    return createMoney({ major: value, source: "structured_json", ...defaults });
  }

  if (typeof value === "string") {
    const parsed = parseMoneyInput(value, { source: "structured_json", ...defaults });
    assert(parsed, `${label} must be a valid monetary value.`);
    return parsed;
  }

  assert(isPlainObject(value), `${label} must be a money object, number or string.`);
  validateKeys(value, MONEY_KEYS, label);

  if (value.amountMinor != null) {
    const amountMinor = normalizeOptionalNumber(value.amountMinor, `${label}.amountMinor`);
    return {
      amountMinor: Math.round(amountMinor),
      currency: normalizeString(value.currency, `${label}.currency`, defaults.currency ?? "EUR"),
      vatStatus: normalizeString(value.vatStatus, `${label}.vatStatus`, defaults.vatStatus ?? "unknown"),
      amountType: normalizeString(value.amountType, `${label}.amountType`, defaults.amountType ?? "generic"),
      source: normalizeString(value.source, `${label}.source`, defaults.source ?? "structured_json"),
      label: normalizeString(value.label, `${label}.label`, defaults.label ?? ""),
      original: normalizeString(value.original, `${label}.original`, String(amountMinor / 100))
    };
  }

  const major = normalizeOptionalNumber(value.major, `${label}.major`);
  assert(major != null, `${label} must include amountMinor or major.`);
  return createMoney({
    major,
    currency: normalizeString(value.currency, `${label}.currency`, defaults.currency ?? "EUR"),
    vatStatus: normalizeString(value.vatStatus, `${label}.vatStatus`, defaults.vatStatus ?? "unknown"),
    amountType: normalizeString(value.amountType, `${label}.amountType`, defaults.amountType ?? "generic"),
    source: normalizeString(value.source, `${label}.source`, defaults.source ?? "structured_json"),
    label: normalizeString(value.label, `${label}.label`, defaults.label ?? "")
  });
}

function normalizeDeadline(value, label) {
  if (value == null || value === "") return null;

  if (typeof value === "string") {
    const parsed = parseSpanishDate(value);
    assert(parsed, `${label} must be a DD/MM/YYYY string or a structured deadline object.`);
    return parsed;
  }

  assert(isPlainObject(value), `${label} must be an object.`);
  validateKeys(value, DEADLINE_KEYS, label);

  if (!value.date) {
    const parsed = parseSpanishDate(normalizeString(value.sourceText, `${label}.sourceText`, ""));
    assert(parsed, `${label} must include a valid date or sourceText.`);
    return parsed;
  }

  const date = normalizeString(value.date, `${label}.date`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(date), `${label}.date must use YYYY-MM-DD.`);
  const time = value.time == null ? null : normalizeString(value.time, `${label}.time`);
  if (time != null) {
    assert(/^\d{2}:\d{2}$/.test(time), `${label}.time must use HH:MM.`);
  }
  const timezone = normalizeString(value.timezone, `${label}.timezone`, "Europe/Madrid");
  const sourceTimezone = normalizeString(value.sourceTimezone, `${label}.sourceTimezone`, "") || null;

  return {
    sourceText: normalizeString(value.sourceText, `${label}.sourceText`, time ? `${date} ${time}` : date),
    date,
    time,
    timezone,
    sourceTimezone,
    utcEquivalent: normalizeString(
      value.utcEquivalent,
      `${label}.utcEquivalent`,
      time ? toUtcIso(date, time, timezone) ?? "" : ""
    ) || null
  };
}

function normalizeSourceRecord(source, index) {
  assert(isPlainObject(source), `sources[${index}] must be an object.`);
  validateKeys(source, SOURCE_KEYS, `sources[${index}]`);
  const organisation = normalizeString(source.organisation, `sources[${index}].organisation`, "").trim();
  const title = normalizeString(source.title, `sources[${index}].title`, "").trim();
  assert(organisation, `sources[${index}].organisation is required.`);
  assert(title, `sources[${index}].title is required.`);
  return {
    id: normalizeString(source.id, `sources[${index}].id`, uid("source")),
    organisation,
    title,
    url: normalizeString(source.url, `sources[${index}].url`, ""),
    official: source.official ?? Boolean(source.url),
    publishedAt: normalizeString(source.publishedAt, `sources[${index}].publishedAt`, ""),
    lastChecked: normalizeString(source.lastChecked, `sources[${index}].lastChecked`, "")
  };
}

function normalizeEvidenceRecord(record, index) {
  assert(isPlainObject(record), `evidence[${index}] must be an object.`);
  validateKeys(record, EVIDENCE_KEYS, `evidence[${index}]`);
  const fieldKey = normalizeString(record.fieldKey, `evidence[${index}].fieldKey`, "").trim();
  const excerpt = normalizeString(record.excerpt, `evidence[${index}].excerpt`, "").trim();
  assert(fieldKey, `evidence[${index}].fieldKey is required.`);
  assert(excerpt, `evidence[${index}].excerpt is required.`);
  return {
    id: normalizeString(record.id, `evidence[${index}].id`, uid("ev")),
    fieldKey,
    excerpt,
    sourceId: normalizeString(record.sourceId, `evidence[${index}].sourceId`, "") || null,
    sourceType: normalizeString(record.sourceType, `evidence[${index}].sourceType`, "structured_json"),
    confidence: record.confidence ?? null
  };
}

function normalizeRequirementRecord(requirement, label) {
  assert(isPlainObject(requirement), `${label} must be an object.`);
  validateKeys(requirement, REQUIREMENT_KEYS, label);
  const kind = normalizeString(requirement.kind, `${label}.kind`, "").trim();
  const fieldLabel = normalizeString(requirement.label, `${label}.label`, "").trim();
  assert(kind, `${label}.kind is required.`);
  assert(SUPPORTED_REQUIREMENT_KINDS.has(kind), `${label}.kind "${kind}" is not supported.`);
  assert(fieldLabel, `${label}.label is required.`);
  return {
    id: normalizeString(requirement.id, `${label}.id`, uid("req")),
    kind,
    label: fieldLabel,
    requiredValue: normalizeString(requirement.requiredValue, `${label}.requiredValue`, ""),
    mandatory: requirement.mandatory !== false,
    gating: normalizeString(requirement.gating, `${label}.gating`, "soft"),
    question: normalizeString(requirement.question, `${label}.question`, ""),
    evidenceIds: normalizeStringArray(requirement.evidenceIds ?? [], `${label}.evidenceIds`),
    minimumAmount: normalizeOptionalNumber(requirement.minimumAmount, `${label}.minimumAmount`),
    minimumCount: normalizeOptionalNumber(requirement.minimumCount, `${label}.minimumCount`),
    minimumTurnoverBand: normalizeString(requirement.minimumTurnoverBand, `${label}.minimumTurnoverBand`, ""),
    publicOnly: normalizeOptionalBoolean(requirement.publicOnly, `${label}.publicOnly`),
    lookbackYears: normalizeOptionalNumber(requirement.lookbackYears, `${label}.lookbackYears`),
    comparableScopeRequired: normalizeOptionalBoolean(
      requirement.comparableScopeRequired,
      `${label}.comparableScopeRequired`
    ),
    requiredCapabilities: normalizeStringArray(requirement.requiredCapabilities ?? [], `${label}.requiredCapabilities`),
    requiredCpvPrefixes: normalizeStringArray(requirement.requiredCpvPrefixes ?? [], `${label}.requiredCpvPrefixes`),
    allowedRegions: normalizeStringArray(requirement.allowedRegions ?? [], `${label}.allowedRegions`),
    minimumYears: normalizeOptionalNumber(requirement.minimumYears, `${label}.minimumYears`),
    defaultStatus: normalizeString(requirement.defaultStatus, `${label}.defaultStatus`, "")
  };
}

function normalizeSourceConflictRecord(conflict, index) {
  assert(isPlainObject(conflict), `sourceConflicts[${index}] must be an object.`);
  validateKeys(conflict, SOURCE_CONFLICT_KEYS, `sourceConflicts[${index}]`);
  const field = normalizeString(conflict.field, `sourceConflicts[${index}].field`, "").trim();
  const left = normalizeString(conflict.left, `sourceConflicts[${index}].left`, "").trim();
  const right = normalizeString(conflict.right, `sourceConflicts[${index}].right`, "").trim();
  assert(field, `sourceConflicts[${index}].field is required.`);
  assert(left, `sourceConflicts[${index}].left is required.`);
  assert(right, `sourceConflicts[${index}].right is required.`);
  return {
    field,
    left,
    right,
    sourceIds: normalizeStringArray(conflict.sourceIds ?? [], `sourceConflicts[${index}].sourceIds`)
  };
}

function normalizeContactRecord(contact, index) {
  assert(isPlainObject(contact), `contacts[${index}] must be an object.`);
  validateKeys(contact, CONTACT_KEYS, `contacts[${index}]`);
  return {
    role: normalizeString(contact.role, `contacts[${index}].role`, ""),
    name: normalizeString(contact.name, `contacts[${index}].name`, ""),
    email: normalizeString(contact.email, `contacts[${index}].email`, ""),
    phone: normalizeString(contact.phone, `contacts[${index}].phone`, "")
  };
}

function normalizeAvailabilityWarningRecord(warning, index) {
  assert(isPlainObject(warning), `availabilityWarnings[${index}] must be an object.`);
  validateKeys(warning, AVAILABILITY_WARNING_KEYS, `availabilityWarnings[${index}]`);
  const title = normalizeString(warning.title, `availabilityWarnings[${index}].title`, "").trim();
  const detail = normalizeString(warning.detail, `availabilityWarnings[${index}].detail`, "").trim();
  const severity = normalizeString(warning.severity, `availabilityWarnings[${index}].severity`, "medium").trim();
  assert(title, `availabilityWarnings[${index}].title is required.`);
  assert(detail, `availabilityWarnings[${index}].detail is required.`);
  assert(["low", "medium", "high"].includes(severity), `availabilityWarnings[${index}].severity must be low, medium or high.`);
  return {
    id: normalizeString(warning.id, `availabilityWarnings[${index}].id`, uid("availability-warning")),
    title,
    detail,
    severity
  };
}

function normalizeLotRecord(lot, index) {
  assert(isPlainObject(lot), `lots[${index}] must be an object.`);
  validateKeys(lot, LOT_KEYS, `lots[${index}]`);
  const title = normalizeString(lot.title, `lots[${index}].title`, "").trim();
  assert(title, `lots[${index}].title is required.`);
  return {
    id: normalizeString(lot.id, `lots[${index}].id`, uid("lot")),
    title,
    description: normalizeString(lot.description, `lots[${index}].description`, title),
    cpvCodes: normalizeStringArray(lot.cpvCodes ?? [], `lots[${index}].cpvCodes`),
    keywords: normalizeStringArray(lot.keywords ?? [], `lots[${index}].keywords`),
    value: normalizeMoneyRecord(lot.value, `lots[${index}].value`, {
      amountType: "relevant_lot_value",
      vatStatus: "unknown"
    }),
    location: normalizeLocation(lot.location, `lots[${index}].location`),
    requirements: (lot.requirements ?? []).map((item, requirementIndex) =>
      normalizeRequirementRecord(item, `lots[${index}].requirements[${requirementIndex}]`)
    ),
    documents: normalizeStringArray(lot.documents ?? [], `lots[${index}].documents`),
    contacts: (lot.contacts ?? []).map(normalizeContactRecord)
  };
}

function defaultNoticeType(type) {
  return type === "grant" ? "grant_call" : "active_contract_notice";
}

function defaultSourceForOpportunity(opportunity) {
  return {
    id: uid("source"),
    organisation:
      opportunity.issuingOrganisation ||
      opportunity.contractingAuthority ||
      "Structured opportunity import",
    title: "Structured JSON import",
    url: opportunity.noticeUrl ?? "",
    official: Boolean(opportunity.noticeUrl),
    publishedAt: opportunity.publicationDate ?? "",
    lastChecked: opportunity.lastChecked
  };
}

function validateEvidenceLinks(opportunity) {
  const sourceIds = new Set((opportunity.sources ?? []).map((source) => source.id));
  const evidenceIds = new Set((opportunity.evidence ?? []).map((item) => item.id));

  (opportunity.evidence ?? []).forEach((item, index) => {
    if (item.sourceId && !sourceIds.has(item.sourceId)) {
      throw new Error(`evidence[${index}].sourceId references an unknown source id "${item.sourceId}"`);
    }
  });

  function checkRequirements(requirements, label) {
    requirements.forEach((requirement, index) => {
      requirement.evidenceIds.forEach((evidenceId) => {
        if (!evidenceIds.has(evidenceId)) {
          throw new Error(`${label}[${index}].evidenceIds references an unknown evidence id "${evidenceId}"`);
        }
      });
    });
  }

  checkRequirements(opportunity.requirements ?? [], "requirements");
  (opportunity.lots ?? []).forEach((lot, lotIndex) => {
    checkRequirements(lot.requirements ?? [], `lots[${lotIndex}].requirements`);
  });
}

function matchFirst(pattern, text) {
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function firstMeaningfulLine(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 6) ?? "";
}

function inspectImportText(text = "") {
  const normalized = normalizeText(text);
  const firstLine = firstMeaningfulLine(text);
  const wordCount = normalized ? normalized.split(" ").filter(Boolean).length : 0;
  return {
    firstLine,
    wordCount,
    hasAmount: /€\s?[\d\.\,]+/.test(text),
    hasDeadline: /\d{2}\/\d{2}\/\d{4}(?:\s*(?:at|a las)?\s*\d{1,2}:\d{2})?/i.test(text),
    hasLocation: /(tarragona|barcelona|girona|lleida|catalonia|cataluna|catalunya)/i.test(text),
    mentionsOpportunityType: /(contract|grant|subsid|ayuda|subvencion|licitacion|tender)/i.test(text)
  };
}

export function validateOpportunityImport({
  sourceText = "",
  title = "",
  type = "",
  location = "",
  valueText = "",
  deadlineText = "",
  noticeUrl = ""
} = {}) {
  const sourceSignals = inspectImportText(sourceText);
  const meaningfulTitle = title.trim().length >= 6;
  const structuredDetailCount = [location.trim(), valueText.trim(), deadlineText.trim(), noticeUrl.trim()].filter(Boolean).length;
  const hasUsefulSourceText =
    Boolean(sourceSignals.firstLine) &&
    sourceSignals.wordCount >= 8 &&
    (sourceSignals.hasAmount || sourceSignals.hasDeadline || sourceSignals.hasLocation || sourceSignals.mentionsOpportunityType);
  const hasMeaningfulManualEntry = meaningfulTitle && Boolean(type) && structuredDetailCount >= 1;

  if (hasUsefulSourceText || hasMeaningfulManualEntry) {
    return {
      ok: true
    };
  }

  return {
    ok: false,
    message:
      "Add useful source text, or provide a meaningful title plus the opportunity type and at least one substantive detail such as value, deadline, location, or notice URL."
  };
}

export function importOpportunityFromJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Structured opportunity import must be valid JSON.");
  }

  assert(isPlainObject(parsed), "Structured opportunity import must be a JSON object.");
  scanForBannedKeys(parsed);
  validateKeys(parsed, TOP_LEVEL_KEYS, "Structured opportunity import");

  const type = normalizeString(parsed.type, "type", "contract");
  assert(OPPORTUNITY_TYPES.has(type), `Unsupported opportunity type "${type}"`);
  const noticeType = normalizeString(parsed.noticeType, "noticeType", defaultNoticeType(type));
  assert(NOTICE_TYPES.has(noticeType), `Unsupported noticeType "${noticeType}"`);
  const status = normalizeString(parsed.status, "status", "open");
  assert(STATUSES.has(status), `Unsupported status "${status}"`);
  const title = normalizeString(parsed.title, "title", "").trim();
  assert(title, "title is required for structured opportunity import.");

  const opportunity = {
    id: normalizeString(parsed.id, "id", uid("opp")),
    canonicalId: normalizeString(parsed.canonicalId, "canonicalId", "") || null,
    sourceOpportunityId: normalizeString(parsed.sourceOpportunityId, "sourceOpportunityId", uid("src")),
    sourceNoticeVersionId: normalizeString(parsed.sourceNoticeVersionId, "sourceNoticeVersionId", uid("ver")),
    type,
    noticeType,
    status,
    title,
    description: normalizeString(parsed.description, "description", title),
    issuingOrganisation: normalizeString(parsed.issuingOrganisation, "issuingOrganisation", ""),
    contractingAuthority: normalizeString(parsed.contractingAuthority, "contractingAuthority", ""),
    publicationDate: normalizeString(parsed.publicationDate, "publicationDate", "") || null,
    modificationDate: normalizeString(parsed.modificationDate, "modificationDate", "") || null,
    startDate: normalizeString(parsed.startDate, "startDate", "") || null,
    deadline: normalizeDeadline(parsed.deadline, "deadline"),
    location: normalizeLocation(parsed.location, "location"),
    cpvCodes: normalizeStringArray(parsed.cpvCodes ?? [], "cpvCodes"),
    keywords: normalizeStringArray(parsed.keywords ?? [], "keywords"),
    procedureType: normalizeString(parsed.procedureType, "procedureType", ""),
    estimatedValue: normalizeMoneyRecord(parsed.estimatedValue, "estimatedValue", {
      amountType: "estimated_value",
      vatStatus: "excluding"
    }),
    awardValue: normalizeMoneyRecord(parsed.awardValue, "awardValue", {
      amountType: "award_value",
      vatStatus: "excluding"
    }),
    baseBudget: normalizeMoneyRecord(parsed.baseBudget, "baseBudget", {
      amountType: "base_budget",
      vatStatus: "excluding"
    }),
    relevantValue: normalizeMoneyRecord(parsed.relevantValue, "relevantValue", {
      amountType: "relevant_lot_value",
      vatStatus: "excluding"
    }),
    wholeProcedureValue: normalizeMoneyRecord(parsed.wholeProcedureValue, "wholeProcedureValue", {
      amountType: "whole_procedure_value",
      vatStatus: "excluding"
    }),
    annualValue: normalizeMoneyRecord(parsed.annualValue, "annualValue", {
      amountType: "annual_value",
      vatStatus: "excluding"
    }),
    multiYearValue: normalizeMoneyRecord(parsed.multiYearValue, "multiYearValue", {
      amountType: "multi_year_value",
      vatStatus: "excluding"
    }),
    maximumAidPerBeneficiary: normalizeMoneyRecord(
      parsed.maximumAidPerBeneficiary,
      "maximumAidPerBeneficiary",
      {
        amountType: "maximum_grant",
        vatStatus: "unknown"
      }
    ),
    programmeBudget: normalizeMoneyRecord(parsed.programmeBudget, "programmeBudget", {
      amountType: "programme_budget",
      vatStatus: "unknown"
    }),
    eligibleProjectCost: normalizeMoneyRecord(parsed.eligibleProjectCost, "eligibleProjectCost", {
      amountType: "eligible_project_cost",
      vatStatus: "unknown"
    }),
    aidIntensity: normalizeString(parsed.aidIntensity, "aidIntensity", ""),
    duration: normalizeString(parsed.duration, "duration", ""),
    guarantees: normalizeString(parsed.guarantees, "guarantees", ""),
    submissionMechanism: normalizeString(parsed.submissionMechanism, "submissionMechanism", ""),
    applicationUrl: normalizeString(parsed.applicationUrl, "applicationUrl", ""),
    noticeUrl: normalizeString(parsed.noticeUrl, "noticeUrl", ""),
    referenceNumber: normalizeString(parsed.referenceNumber, "referenceNumber", uid("ref")),
    requiredDocuments: normalizeStringArray(parsed.requiredDocuments ?? [], "requiredDocuments"),
    documents: normalizeStringArray(parsed.documents ?? [], "documents"),
    lastChecked: normalizeString(parsed.lastChecked, "lastChecked", new Date().toISOString()),
    contacts: (parsed.contacts ?? []).map(normalizeContactRecord),
    sources: (parsed.sources ?? []).map(normalizeSourceRecord),
    evidence: (parsed.evidence ?? []).map(normalizeEvidenceRecord),
    availabilityWarnings: (parsed.availabilityWarnings ?? []).map(normalizeAvailabilityWarningRecord),
    sourceConflicts: (parsed.sourceConflicts ?? []).map(normalizeSourceConflictRecord),
    requirements: (parsed.requirements ?? []).map((item, index) => normalizeRequirementRecord(item, `requirements[${index}]`)),
    lots: (parsed.lots ?? []).map(normalizeLotRecord),
    cancellationStatus: normalizeString(parsed.cancellationStatus, "cancellationStatus", "") || null
  };

  if (!opportunity.sources.length) {
    opportunity.sources = [defaultSourceForOpportunity(opportunity)];
  }

  validateEvidenceLinks(opportunity);
  return opportunity;
}

export function importOpportunityFromText(text) {
  const lower = text.toLowerCase();
  const amountMatch = text.match(/€\s?([\d\.\,]+)/);
  const deadlineMatch = text.match(/\d{2}\/\d{2}\/\d{4}(?:\s*(?:at|a las)?\s*\d{1,2}:\d{2})?/i);
  const title = matchFirst(/title:\s*(.+)/i, text) || firstMeaningfulLine(text).slice(0, 120) || "Manual opportunity";
  const type = /subsid|grant|ayuda|subvencion/i.test(lower) ? "grant" : "contract";
  const deadline = deadlineMatch ? parseSpanishDate(deadlineMatch[0]) : null;
  const amount = amountMatch ? parseMoneyInput(amountMatch[1], { amountType: type === "grant" ? "maximum_grant" : "estimated_value" }) : null;
  const certificationRequired = /iso\s*9001/i.test(lower);
  const location =
    /tarragona/i.test(lower)
      ? { municipality: "Tarragona", province: "Tarragona", autonomousCommunity: "Catalonia", display: "Tarragona" }
      : /barcelona/i.test(lower)
        ? { municipality: "Barcelona", province: "Barcelona", autonomousCommunity: "Catalonia", display: "Barcelona" }
        : { display: "Needs review" };

  const evidence = [];
  if (amount) {
    evidence.push({
      id: uid("ev"),
      fieldKey: type === "grant" ? "lot_value" : "lot_value",
      excerpt: amountMatch[0],
      sourceType: "pasted_text",
      confidence: 0.84
    });
  }
  if (deadline) {
    evidence.push({
      id: uid("ev"),
      fieldKey: "deadline",
      excerpt: deadlineMatch[0],
      sourceType: "pasted_text",
      confidence: 0.88
    });
  }
  if (location.display !== "Needs review") {
    evidence.push({
      id: uid("ev"),
      fieldKey: "location",
      excerpt: location.display,
      sourceType: "pasted_text",
      confidence: 0.75
    });
  }

  return {
    id: uid("opp"),
    sourceOpportunityId: uid("src"),
    sourceNoticeVersionId: uid("ver"),
    type,
    noticeType: type === "grant" ? "grant_call" : "active_contract_notice",
    status: "open",
    title,
    description: text,
    location,
    cpvCodes: [],
    estimatedValue: type === "contract" ? amount : null,
    maximumAidPerBeneficiary: type === "grant" ? amount : null,
    relevantValue: type === "contract" ? amount : null,
    deadline,
    lastChecked: new Date().toISOString(),
    referenceNumber: uid("ref"),
    sources: [
      {
        id: uid("source"),
        organisation: "Manual import",
        title: "Pasted source text",
        url: "",
        official: false,
        publishedAt: new Date().toISOString().slice(0, 10),
        lastChecked: new Date().toISOString()
      }
    ],
    evidence,
    requirements: certificationRequired
      ? [
          {
            id: uid("req"),
            kind: "certification",
            label: "Valid ISO 9001 certification",
            requiredValue: "ISO 9001",
            mandatory: true,
            gating: "hard",
            evidenceIds: evidence.map((item) => item.id),
            question: "This opportunity requires ISO 9001. Does your company currently hold a valid ISO 9001 certification?"
          }
        ]
      : [],
    documents: [],
    contacts: [],
    lots: []
  };
}
