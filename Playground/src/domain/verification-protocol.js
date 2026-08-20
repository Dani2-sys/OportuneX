import { ACTION_COPY, FIT_BAND_COPY } from "../config.js";
import {
  getSelectedExplicitLotId,
  getSelectedExplicitLotLabel,
  isSelectedExplicitLot
} from "./opportunity-scope.js";

export const VERIFICATION_PROTOCOL_VERSION = "v4";

export const VERIFICATION_FINDING_CATEGORIES = [
  "actionability",
  "lot",
  "deadline",
  "money",
  "eligibility",
  "company_evidence",
  "capability",
  "geography",
  "scale",
  "submission",
  "source",
  "contact"
];

export const VERIFICATION_FINDING_DISPOSITIONS = [
  "confirmed",
  "unresolved",
  "disagreed",
  "critical_contradiction"
];

export const VERIFICATION_FINDING_SEVERITIES = [
  "informational",
  "material",
  "critical"
];

export const VERIFICATION_CONFIDENCE_LEVELS = ["high", "medium", "low"];

export const VERIFICATION_DERIVED_STATUSES = ["accepted", "needs_review", "rejected"];

export const VERIFICATION_ACTIONS = [
  "INVESTIGATE_NOW",
  "VERIFY_BEFORE_DECIDING",
  "DO_NOT_PURSUE"
];

export const VERIFICATION_FIT_BANDS = [
  "EXCELLENT_FIT",
  "STRONG_FIT",
  "POSSIBLE_FIT",
  "LOW_PRIORITY"
];

const categorySet = new Set(VERIFICATION_FINDING_CATEGORIES);
const dispositionSet = new Set(VERIFICATION_FINDING_DISPOSITIONS);
const severitySet = new Set(VERIFICATION_FINDING_SEVERITIES);
const confidenceSet = new Set(VERIFICATION_CONFIDENCE_LEVELS);
const actionSet = new Set(VERIFICATION_ACTIONS);
const fitBandSet = new Set(VERIFICATION_FIT_BANDS);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value, fallback = null) {
  if (value == null) return fallback;
  const text = typeof value === "string" ? value : String(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function normalizeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function slugToken(value, fallback = "item") {
  return normalizeText(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function dedupeAndSortStrings(values) {
  return [...new Set(sanitizeArray(values).map((value) => normalizeText(value, null)).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function dedupeAndSortObjects(values) {
  const byKey = new Map();
  sanitizeArray(values).forEach((value) => {
    if (!value) return;
    byKey.set(stableStringify(value), value);
  });
  return [...byKey.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map((entry) => entry[1]);
}

function normalizeMoneySnapshot(value) {
  if (!isPlainObject(value)) return null;
  return compactObject({
    amountMinor: normalizeNumber(value.amountMinor),
    currency: normalizeText(value.currency, null),
    vatStatus: normalizeText(value.vatStatus, null),
    amountType: normalizeText(value.amountType, null)
  });
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry == null) return false;
      if (Array.isArray(entry)) return entry.length > 0;
      if (isPlainObject(entry)) return Object.keys(entry).length > 0;
      return true;
    })
  );
}

function buildDeadlineSnapshot(deadline = {}) {
  const sourceText = normalizeText(deadline?.sourceText, null);
  const sourceDate = normalizeText(deadline?.date, null);
  const sourceTime = normalizeText(deadline?.time, null);
  const sourceTimezone = normalizeText(deadline?.sourceTimezone, null);
  const interpretedTimezone = normalizeText(deadline?.timezone, null);
  const interpretationSource = sourceTimezone
    ? "source_stated_timezone"
    : interpretedTimezone
      ? "oportunex_default_timezone_for_local_deadline"
      : null;

  return {
    source_text: sourceText,
    source_date: sourceDate,
    source_time: sourceTime,
    source_timezone: sourceTimezone,
    interpreted_timezone: interpretedTimezone,
    interpretation_source: interpretationSource,
    utc_equivalent: normalizeText(deadline?.utcEquivalent, null)
  };
}

function buildEvidenceAlias(index) {
  return `E${String(index).padStart(3, "0")}`;
}

function buildEvidenceRecord(canonicalRef, kind, data, extras = {}) {
  return {
    canonicalRef,
    kind,
    data,
    ...extras
  };
}

function buildCustomerEvidenceLabel(alias, kind) {
  const prefix = {
    company_source: "Company source",
    company_fact: "Company fact",
    opportunity_source: "Opportunity source",
    opportunity_evidence: "Opportunity evidence",
    lot: "Lot evidence",
    requirement: "Requirement evidence",
    analysis: "Analysis evidence"
  }[kind] ?? "Evidence";

  return `${prefix} · ${alias}`;
}

function summarizeIssueItems(items) {
  return sanitizeArray(items)
    .map((item) => {
      if (!isPlainObject(item)) return null;
      return compactObject({
        id: normalizeText(item.id, null),
        title: normalizeText(item.title, null),
        detail: normalizeText(item.detail, null),
        severity: normalizeText(item.severity, null),
        category: normalizeText(item.category, null),
        priority: normalizeNumber(item.priority),
        requiresVerification: normalizeBoolean(item.requiresVerification)
      });
    })
    .filter(Boolean);
}

function findLotValueSnapshot(lotMatch, lot) {
  return (
    normalizeMoneySnapshot(lot?.value) ??
    normalizeMoneySnapshot(lotMatch?.financialPicture?.primaryLine?.money) ??
    null
  );
}

function summarizeRequirement(requirement, index) {
  const baseId = normalizeText(requirement?.id, `requirement-${index + 1}`);
  return buildEvidenceRecord(
    `opportunity-requirement:${baseId}`,
    "requirement",
    compactObject({
      label: normalizeText(requirement?.label, null),
      title: normalizeText(requirement?.title, null),
      kind: normalizeText(requirement?.kind, null),
      mandatory: normalizeBoolean(requirement?.mandatory),
      gating: normalizeText(requirement?.gating, null),
      question: normalizeText(requirement?.question, null),
      why: normalizeText(requirement?.why, null),
      minimumAmount: normalizeMoneySnapshot(requirement?.minimumAmount),
      minimumValue: normalizeMoneySnapshot(requirement?.minimumValue),
      minimumCover: normalizeMoneySnapshot(requirement?.minimumCover),
      minimumEmployeeCount: normalizeNumber(requirement?.minimumEmployeeCount),
      requiredCertification: normalizeText(requirement?.requiredCertification, null),
      acceptedRegions: dedupeAndSortStrings(requirement?.acceptedRegions),
      eligibleEntityTypes: dedupeAndSortStrings(requirement?.eligibleEntityTypes)
    }),
    {
      original_id: baseId
    }
  );
}

function summarizeRequirementRow(row, index) {
  const baseId = normalizeText(row?.id, `analysis-requirement-${index + 1}`);
  return buildEvidenceRecord(
    `opportunity-requirement:${baseId}`,
    "requirement",
    compactObject({
      label: normalizeText(row?.label, null),
      mandatory: normalizeBoolean(row?.mandatory),
      gating: normalizeText(row?.gating, null),
      status: normalizeText(row?.status, null),
      why: normalizeText(row?.why, null),
      question: normalizeText(row?.question, null),
      evidenceIds: dedupeAndSortStrings(row?.evidenceIds)
    }),
    {
      original_id: baseId
    }
  );
}

function summarizeCompanySources(company = {}) {
  return sanitizeArray(company.companySources).map((source, index) =>
    buildEvidenceRecord(
      `company-source:${normalizeText(source?.id, `company-source-${index + 1}`)}`,
      "company_source",
      compactObject({
      organisation: normalizeText(source?.organisation, null),
      title: normalizeText(source?.title, null),
      url: normalizeText(source?.url, null),
      publishedAt: normalizeText(source?.publishedAt, null),
      status: normalizeText(source?.status, null),
      official: normalizeBoolean(source?.official)
      }),
      {
        source_id: normalizeText(source?.id, null),
        original_id: normalizeText(source?.id, null)
      }
    )
  );
}

function summarizeCompanyFacts(company = {}) {
  const facts = [];
  const pushFact = (suffix, data) => {
    const record = compactObject(data);
    if (!Object.keys(record).length) return;
    facts.push(
      buildEvidenceRecord(
        `company-fact:${suffix}`,
        "company_fact",
        record,
        {
          original_id: suffix
        }
      )
    );
  };

  pushFact("geography", {
    municipality: normalizeText(company?.geography?.municipality, null),
    province: normalizeText(company?.geography?.province, null),
    autonomousCommunity: normalizeText(company?.geography?.autonomousCommunity, null),
    country: normalizeText(company?.geography?.country, null),
    acceptedRegions: dedupeAndSortStrings(company?.geography?.acceptedRegions),
    excludedRegions: dedupeAndSortStrings(company?.geography?.excludedRegions),
    willingToTravel: normalizeBoolean(company?.geography?.willingToTravel),
    preferredWorkingRadiusKm: normalizeNumber(company?.geography?.preferredWorkingRadiusKm)
  });

  pushFact("employee-range", {
    min: normalizeNumber(company?.size?.employeeRange?.min),
    max: normalizeNumber(company?.size?.employeeRange?.max),
    updatedAt: normalizeText(company?.size?.employeeRange?.updatedAt, null)
  });

  pushFact("turnover-range", {
    min: normalizeMoneySnapshot(company?.size?.turnoverRange?.min),
    max: normalizeMoneySnapshot(company?.size?.turnoverRange?.max),
    updatedAt: normalizeText(company?.size?.turnoverRange?.updatedAt, null)
  });

  sanitizeArray(company.capabilities).forEach((capability, index) => {
    pushFact(`capability:${slugToken(capability?.label, `capability-${index + 1}`)}`, {
      label: normalizeText(capability?.label, null),
      source: normalizeText(capability?.source, null),
      confidence: normalizeNumber(capability?.confidence)
    });
  });

  sanitizeArray(company.certifications).forEach((certification, index) => {
    pushFact(`certification:${slugToken(certification?.name ?? certification?.label, `certification-${index + 1}`)}`, {
      name: normalizeText(certification?.name ?? certification?.label, null),
      status: normalizeText(certification?.status, null),
      scope: normalizeText(certification?.scope, null)
    });
  });

  sanitizeArray(company.classifications).forEach((classification, index) => {
    pushFact(`classification:${slugToken(classification?.code ?? classification?.label, `classification-${index + 1}`)}`, {
      code: normalizeText(classification?.code, null),
      label: normalizeText(classification?.label, null),
      group: normalizeText(classification?.group, null),
      category: normalizeText(classification?.category, null)
    });
  });

  sanitizeArray(company.insurance).forEach((policy, index) => {
    pushFact(`insurance:${slugToken(policy?.type ?? policy?.provider ?? `insurance-${index + 1}`)}`, {
      type: normalizeText(policy?.type, null),
      provider: normalizeText(policy?.provider, null),
      coverAmount: normalizeMoneySnapshot(policy?.coverAmount),
      status: normalizeText(policy?.status, null)
    });
  });

  Object.entries(isPlainObject(company.facts) ? company.facts : {}).forEach(([key, value]) => {
    pushFact(slugToken(key), {
      key,
      value: isPlainObject(value)
        ? compactObject({
            status: normalizeText(value.status, null),
            label: normalizeText(value.label, null),
            value: normalizeText(value.value, null),
            exactValue: normalizeNumber(value.exactValue),
            source: normalizeText(value.source, null)
          })
        : normalizeText(value, null)
    });
  });

  return dedupeAndSortObjects(facts);
}

function summarizeOpportunitySources(opportunity = {}) {
  return sanitizeArray(opportunity.sources).map((source, index) =>
    buildEvidenceRecord(
      `opportunity-source:${normalizeText(source?.id, `opportunity-source-${index + 1}`)}`,
      "opportunity_source",
      compactObject({
      organisation: normalizeText(source?.organisation, null),
      title: normalizeText(source?.title, null),
      url: normalizeText(source?.url, null),
      publishedAt: normalizeText(source?.publishedAt, null),
      official: normalizeBoolean(source?.official),
      sourceType: normalizeText(source?.metadata?.sourceType, null),
      entryLinkUrl: normalizeText(source?.metadata?.entryLinkUrl, null)
      }),
      {
        source_id: normalizeText(source?.id, null),
        original_id: normalizeText(source?.id, null)
      }
    )
  );
}

function summarizeOpportunityEvidence(opportunity = {}) {
  return sanitizeArray(opportunity.evidence).map((item, index) =>
    buildEvidenceRecord(
      `opportunity-evidence:${normalizeText(item?.id, `opportunity-evidence-${index + 1}`)}`,
      "opportunity_evidence",
      compactObject({
      fieldKey: normalizeText(item?.fieldKey, null),
      excerpt: normalizeText(item?.excerpt, null),
      sourcePath: normalizeText(item?.sourcePath, null),
      confidence: normalizeNumber(item?.confidence)
      }),
      {
        source_id: normalizeText(item?.sourceId, null),
        original_id: normalizeText(item?.id, null)
      }
    )
  );
}

function summarizeOpportunityLots(opportunity = {}, analysis = {}) {
  const lotMatchesById = new Map(
    sanitizeArray(analysis?.lotMatches).map((item) => [item?.lotId, item])
  );

  return sanitizeArray(opportunity.lots)
    .filter((lot) => lot && !lot.synthetic)
    .map((lot, index) => {
      const lotId = normalizeText(lot?.id, `lot-${index + 1}`);
      const lotMatch = lotMatchesById.get(lotId) ?? null;
      return buildEvidenceRecord(
        `opportunity-lot:${lotId}`,
        "lot",
        compactObject({
          title: normalizeText(lot?.title, null),
          description: normalizeText(lot?.description, null),
          location: compactObject({
            municipality: normalizeText(lot?.location?.municipality, null),
            province: normalizeText(lot?.location?.province, null),
            autonomousCommunity: normalizeText(lot?.location?.autonomousCommunity, null),
            country: normalizeText(lot?.location?.country, null),
            display: normalizeText(lotMatch?.locationLabel ?? lot?.location?.display, null)
          }),
          publishedValue: findLotValueSnapshot(lotMatch, lot),
          cpvCodes: dedupeAndSortStrings(lot?.cpvCodes)
        }),
        {
          original_id: lotId
        }
      );
    });
}

function buildAnalysisRefRecords(analysis = {}, opportunity = {}) {
  const selectedLotId = normalizeText(getSelectedExplicitLotId(analysis), null);
  const selectedLotLabel = selectedLotId
    ? normalizeText(getSelectedExplicitLotLabel(analysis), selectedLotId)
    : "Whole opportunity";
  const records = [
    buildEvidenceRecord("analysis:actionability", "analysis", compactObject({
        status: normalizeText(opportunity?.status, null),
        derivedStatus: normalizeText(opportunity?.derivedStatus ?? analysis?.opportunity?.derivedStatus, null),
        recommendedAction: normalizeText(analysis?.decision?.recommendedAction?.code, null)
      })),
    buildEvidenceRecord("analysis:selected-lot", "analysis", compactObject({
        selectedLotId,
        selectedLotLabel,
        publishedLotCount: normalizeNumber(analysis?.publishedLotCount),
        selected: normalizeText(selectedLotId ? `Explicit published lot ${selectedLotLabel}` : "Whole opportunity", null)
      })),
    buildEvidenceRecord("analysis:action", "analysis", compactObject({
        recommendedAction: normalizeText(analysis?.decision?.recommendedAction?.code, null),
        mainReason: normalizeText(analysis?.decision?.mainReason, null),
        mainQuestion: normalizeText(analysis?.decision?.mainQuestion, null),
        fitBand: normalizeText(analysis?.fitBand ?? analysis?.recommendationClass, null)
      })),
    buildEvidenceRecord("analysis:capability", "analysis", compactObject({
        capabilityFit: normalizeNumber(analysis?.dimensions?.capabilityFit),
        baseCapabilityFit: normalizeNumber(analysis?.dimensions?.baseCapabilityFit),
        specialistScopeConfidence: normalizeNumber(analysis?.dimensions?.specialistScopeConfidence)
      })),
    buildEvidenceRecord("analysis:geography", "analysis", compactObject({
        geographicFit: normalizeNumber(analysis?.dimensions?.geographicFit),
        geographyNote: normalizeText(analysis?.dimensions?.geographyAssessment?.note, null)
      })),
    buildEvidenceRecord("analysis:scale", "analysis", compactObject({
        financialScaleFit: normalizeNumber(analysis?.dimensions?.financialScaleFit),
        scaleNote: normalizeText(analysis?.dimensions?.scaleAssessment?.note, null)
      })),
    buildEvidenceRecord("analysis:eligibility", "analysis", compactObject({
        eligibilityStatus: normalizeText(analysis?.eligibilityStatus, null),
        qualificationReadiness: normalizeNumber(analysis?.dimensions?.qualificationReadiness),
        blockers: summarizeIssueItems(analysis?.blockers).map((item) => item.title),
        potentialHardBlockers: summarizeIssueItems(analysis?.potentialHardBlockers).map((item) => item.title),
        unknowns: summarizeIssueItems(analysis?.unknowns).map((item) => item.title)
      })),
    buildEvidenceRecord("analysis:deadline", "analysis", {
        deadlineFeasibility: normalizeNumber(analysis?.dimensions?.deadlineFeasibility),
        deadlineLabel: normalizeText(analysis?.deadlineLabel, null),
        ...buildDeadlineSnapshot(opportunity?.deadline)
      }),
    buildEvidenceRecord("analysis:money", "analysis", compactObject({
        displayValueLabel: normalizeText(analysis?.displayValueLabel, null),
        companyAmountLabel: normalizeText(analysis?.companyAmountLabel, null),
        primaryFinancialLine: normalizeText(analysis?.financialPicture?.primaryLine?.label, null)
      })),
    buildEvidenceRecord("analysis:company-evidence", "analysis", compactObject({
        companyFactConfidence: normalizeText(analysis?.confidenceShield?.companyFactConfidence, null),
        dataConfidence: normalizeText(analysis?.confidenceShield?.dataConfidence, null),
        decisionConfidence: normalizeText(analysis?.confidenceShield?.decisionConfidence, null)
      })),
    buildEvidenceRecord("analysis:submission", "analysis", compactObject({
        applicationUrlPresent: Boolean(opportunity?.applicationUrl),
        requiredDocumentCount: sanitizeArray(opportunity?.requiredDocuments).length
      })),
    buildEvidenceRecord("analysis:source", "analysis", compactObject({
        officialSourceVerified: normalizeBoolean(analysis?.confidenceShield?.officialSourceVerified),
        sourceFieldsEvidenced: normalizeNumber(analysis?.confidenceShield?.sourceFieldsEvidenced),
        totalSourceFields: normalizeNumber(analysis?.confidenceShield?.totalSourceFields)
      })),
    buildEvidenceRecord("analysis:contact", "analysis", compactObject({
        primaryContactName: normalizeText(analysis?.primaryContact?.name, null),
        primaryContactRole: normalizeText(analysis?.primaryContact?.role, null)
      }))
  ];

  return dedupeAndSortObjects(records);
}

export function buildVerificationLotComparison(opportunity = {}, analysis = {}) {
  return dedupeAndSortObjects(
    sanitizeArray(analysis?.lotMatches)
      .filter((lotMatch) => lotMatch?.hasPublishedLot && lotMatch?.lotId)
      .map((lotMatch) => compactObject({
        lot_id: normalizeText(lotMatch.lotId, null),
        title: normalizeText(lotMatch.lotLabel ?? lotMatch.displayTitle, null),
        location: normalizeText(lotMatch.locationLabel, null),
        published_value_label: normalizeText(lotMatch.displayValueLabel, null),
        capability_fit: normalizeNumber(lotMatch.dimensions?.capabilityFit),
        geographic_fit: normalizeNumber(lotMatch.dimensions?.geographicFit),
        financial_scale_fit: normalizeNumber(lotMatch.dimensions?.financialScaleFit),
        qualification_readiness: normalizeNumber(lotMatch.dimensions?.qualificationReadiness),
        evidence_data_confidence: normalizeText(lotMatch.confidenceShield?.dataConfidence, null),
        decision_confidence: normalizeText(lotMatch.confidenceShield?.decisionConfidence, null),
        match_score: normalizeNumber(lotMatch.matchScore),
        priority_score: normalizeNumber(lotMatch.priorityScore),
        fit_band: normalizeText(lotMatch.fitBand ?? lotMatch.recommendationClass, null),
        recommended_action: normalizeText(lotMatch.decision?.recommendedAction?.code, null),
        selected_best_match: isSelectedExplicitLot(analysis, lotMatch)
      }))
  );
}

export function buildVerificationEvidenceCatalog(company = {}, opportunity = {}, analysis = {}) {
  const records = [
    ...summarizeCompanySources(company),
    ...summarizeCompanyFacts(company),
    ...summarizeOpportunitySources(opportunity),
    ...summarizeOpportunityEvidence(opportunity),
    ...summarizeOpportunityLots(opportunity, analysis),
    ...sanitizeArray(opportunity.requirements).map((item, index) => summarizeRequirement(item, index)),
    ...(!sanitizeArray(opportunity.requirements).length
      ? sanitizeArray(analysis.requirementRows).map((item, index) => summarizeRequirementRow(item, index))
      : []),
    ...buildAnalysisRefRecords(analysis, analysis?.opportunity ?? opportunity)
  ];

  const canonicalRecords = dedupeAndSortObjects(records);
  const aliasEntries = canonicalRecords.map((item, index) => {
    const ref = buildEvidenceAlias(index + 1);
    return {
      ref,
      kind: item.kind,
      data: item.data,
      canonical_ref: item.canonicalRef,
      original_id: item.original_id ?? null,
      display_label: buildCustomerEvidenceLabel(ref, item.kind)
    };
  });
  const evidenceCatalog = aliasEntries.map((item) => ({
    ref: item.ref,
    kind: item.kind,
    data: item.data
  }));
  const evidenceRefMap = Object.fromEntries(aliasEntries.map((item) => [item.ref, item]));
  const allowedEvidenceRefs = aliasEntries.map((item) => item.ref);
  const explicitLotIds = aliasEntries
    .filter((item) => item.kind === "lot")
    .map((item) => item.original_id)
    .filter(Boolean);

  return {
    evidenceCatalog,
    evidenceRefCatalog: aliasEntries,
    evidenceRefMap,
    allowedEvidenceRefs,
    explicitLotIds
  };
}

function buildCompanySnapshot(company = {}) {
  return compactObject({
    id: normalizeText(company.id, null),
    profile_mode: normalizeText(company.profileMode, null),
    legal_name: normalizeText(company.legalName, null),
    trading_name: normalizeText(company.tradingName, null),
    cif: normalizeText(company.cif, null),
    geography: compactObject({
      municipality: normalizeText(company?.geography?.municipality, null),
      province: normalizeText(company?.geography?.province, null),
      autonomousCommunity: normalizeText(company?.geography?.autonomousCommunity, null),
      country: normalizeText(company?.geography?.country, null)
    }),
    employee_range: compactObject({
      min: normalizeNumber(company?.size?.employeeRange?.min),
      max: normalizeNumber(company?.size?.employeeRange?.max)
    }),
    turnover_range: compactObject({
      min: normalizeMoneySnapshot(company?.size?.turnoverRange?.min),
      max: normalizeMoneySnapshot(company?.size?.turnoverRange?.max)
    }),
    capabilities: dedupeAndSortStrings(sanitizeArray(company?.capabilities).map((item) => item?.label)),
    certifications: dedupeAndSortStrings(sanitizeArray(company?.certifications).map((item) => item?.name ?? item?.label)),
    classifications: dedupeAndSortStrings(sanitizeArray(company?.classifications).map((item) => item?.code ?? item?.label)),
    insurance: dedupeAndSortStrings(sanitizeArray(company?.insurance).map((item) => item?.type ?? item?.provider))
  });
}

function buildOpportunitySnapshot(opportunity = {}) {
  return compactObject({
    id: normalizeText(opportunity.id, null),
    source_connector: normalizeText(opportunity.sourceConnector, null),
    canonical_id: normalizeText(opportunity.canonicalId, null),
    source_notice_version_id: normalizeText(opportunity.sourceNoticeVersionId, null),
    type: normalizeText(opportunity.type, null),
    notice_type: normalizeText(opportunity.noticeType, null),
    status: normalizeText(opportunity.status, null),
    derived_status: normalizeText(opportunity.derivedStatus, null),
    title: normalizeText(opportunity.title, null),
    description: normalizeText(opportunity.description, null),
    issuing_organisation: normalizeText(opportunity.issuingOrganisation, null),
    contracting_authority: normalizeText(opportunity.contractingAuthority, null),
    publication_date: normalizeText(opportunity.publicationDate, null),
    modification_date: normalizeText(opportunity.modificationDate, null),
    reference_number: normalizeText(opportunity.referenceNumber, null),
    deadline: buildDeadlineSnapshot(opportunity?.deadline),
    location: compactObject({
      municipality: normalizeText(opportunity?.location?.municipality, null),
      province: normalizeText(opportunity?.location?.province, null),
      autonomousCommunity: normalizeText(opportunity?.location?.autonomousCommunity, null),
      country: normalizeText(opportunity?.location?.country, null),
      display: normalizeText(opportunity?.location?.display, null)
    }),
    estimatedValue: normalizeMoneySnapshot(opportunity.estimatedValue),
    awardValue: normalizeMoneySnapshot(opportunity.awardValue),
    baseBudget: normalizeMoneySnapshot(opportunity.baseBudget),
    relevantValue: normalizeMoneySnapshot(opportunity.relevantValue),
    wholeProcedureValue: normalizeMoneySnapshot(opportunity.wholeProcedureValue),
    annualValue: normalizeMoneySnapshot(opportunity.annualValue),
    multiYearValue: normalizeMoneySnapshot(opportunity.multiYearValue),
    maximumAidPerBeneficiary: normalizeMoneySnapshot(opportunity.maximumAidPerBeneficiary),
    programmeBudget: normalizeMoneySnapshot(opportunity.programmeBudget),
    eligibleProjectCost: normalizeMoneySnapshot(opportunity.eligibleProjectCost),
    aidIntensity: normalizeText(opportunity.aidIntensity, null),
    application_url: normalizeText(opportunity.applicationUrl, null),
    notice_url: normalizeText(opportunity.noticeUrl, null),
    required_document_count: sanitizeArray(opportunity.requiredDocuments).length,
    explicit_published_lot_count: sanitizeArray(opportunity.lots).filter((lot) => lot && !lot.synthetic).length
  });
}

function buildSelectedAssessment(opportunity = {}, analysis = {}) {
  const selectedLotId = normalizeText(getSelectedExplicitLotId(analysis), null);
  const fitBand = normalizeText(analysis?.fitBand ?? analysis?.recommendationClass, null);
  const selectedLotLabel = selectedLotId ? normalizeText(getSelectedExplicitLotLabel(analysis), selectedLotId) : null;

  const assessment = compactObject({
    recommended_action: normalizeText(analysis?.decision?.recommendedAction?.code, null),
    fit_band: fitBand,
    match_score: normalizeNumber(analysis?.matchScore),
    priority_score: normalizeNumber(analysis?.priorityScore),
    eligibility_status: normalizeText(analysis?.eligibilityStatus, null),
    main_reason: normalizeText(analysis?.decision?.mainReason, null),
    main_question: normalizeText(analysis?.decision?.mainQuestion, null),
    value_label: normalizeText(analysis?.displayValueLabel, null),
    company_amount_label: normalizeText(analysis?.companyAmountLabel, null),
    deadline_label: normalizeText(analysis?.deadlineLabel, null),
    location_label: normalizeText(analysis?.locationLabel, null),
    dimensions: compactObject({
      capability_fit: normalizeNumber(analysis?.dimensions?.capabilityFit),
      base_capability_fit: normalizeNumber(analysis?.dimensions?.baseCapabilityFit),
      specialist_scope_confidence: normalizeNumber(analysis?.dimensions?.specialistScopeConfidence),
      geographic_fit: normalizeNumber(analysis?.dimensions?.geographicFit),
      financial_scale_fit: normalizeNumber(analysis?.dimensions?.financialScaleFit),
      qualification_readiness: normalizeNumber(analysis?.dimensions?.qualificationReadiness),
      deadline_feasibility: normalizeNumber(analysis?.dimensions?.deadlineFeasibility),
      application_effort: normalizeNumber(analysis?.dimensions?.applicationEffort)
    }),
    confidence: compactObject({
      decision_confidence: normalizeText(analysis?.confidenceShield?.decisionConfidence, null),
      source_confidence: normalizeText(analysis?.confidenceShield?.dataConfidence, null),
      eligibility_confidence: normalizeText(analysis?.confidenceShield?.eligibilityConfidence, null),
      company_fact_confidence: normalizeText(analysis?.confidenceShield?.companyFactConfidence, null),
      critical_field_summary: normalizeText(analysis?.confidenceShield?.criticalFieldSummary, null)
    }),
    blockers: summarizeIssueItems(analysis?.blockers),
    potential_hard_blockers: summarizeIssueItems(analysis?.potentialHardBlockers),
    unknowns: summarizeIssueItems(analysis?.unknowns),
    risks: summarizeIssueItems(analysis?.risks)
  });

  assessment.selected_lot_id = selectedLotId;
  assessment.selected_lot_label = selectedLotLabel;
  return assessment;
}

function attachPacketEvidenceMeta(packet, evidence) {
  Object.defineProperties(packet, {
    evidence_ref_catalog: {
      value: structuredClone(evidence.evidenceRefCatalog),
      enumerable: false
    },
    evidence_ref_map: {
      value: structuredClone(evidence.evidenceRefMap),
      enumerable: false
    }
  });
  return packet;
}

export function getVerificationPacketEvidenceRefEntry(packet = {}, ref = null) {
  const normalizedRef = normalizeText(ref, null);
  if (!normalizedRef) return null;
  if (isPlainObject(packet?.evidence_ref_map) && isPlainObject(packet.evidence_ref_map[normalizedRef])) {
    return packet.evidence_ref_map[normalizedRef];
  }
  const catalog = Array.isArray(packet?.evidence_ref_catalog) ? packet.evidence_ref_catalog : [];
  return catalog.find((item) => item?.ref === normalizedRef) ?? null;
}

function getVerificationPacketAliasForCanonicalRef(packet = {}, canonicalRef = null) {
  const normalizedCanonicalRef = normalizeText(canonicalRef, null);
  if (!normalizedCanonicalRef) return null;
  const catalog = Array.isArray(packet?.evidence_ref_catalog) ? packet.evidence_ref_catalog : [];
  return catalog.find((item) => item?.canonical_ref === normalizedCanonicalRef)?.ref ?? null;
}

export function buildVerificationResultEvidenceRefCatalog(result = {}, packet = null) {
  if (!packet) return [];
  const usedRefs = dedupeAndSortStrings([
    ...sanitizeArray(result?.findings).flatMap((item) => sanitizeArray(item?.evidence_refs)),
    ...sanitizeArray(result?.strongest_counterfactual?.evidence_refs)
  ]);

  return usedRefs
    .map((ref) => getVerificationPacketEvidenceRefEntry(packet, ref))
    .filter(Boolean)
    .map((item) => ({
      ref: item.ref,
      kind: item.kind,
      display_label: item.display_label,
      canonical_ref: item.canonical_ref
    }));
}

export function buildVerificationPacket(company = {}, opportunity = {}, analysis = {}) {
  const resolvedOpportunity = analysis?.opportunity ?? opportunity ?? {};
  const evidence = buildVerificationEvidenceCatalog(company, resolvedOpportunity, analysis);

  const packet = {
    protocol_version: VERIFICATION_PROTOCOL_VERSION,
    company: buildCompanySnapshot(company),
    opportunity: buildOpportunitySnapshot(resolvedOpportunity),
    selected_assessment: buildSelectedAssessment(resolvedOpportunity, analysis),
    lot_comparison: buildVerificationLotComparison(resolvedOpportunity, analysis),
    evidence_catalog: evidence.evidenceCatalog,
    allowed_evidence_refs: evidence.allowedEvidenceRefs,
    explicit_published_lot_ids: evidence.explicitLotIds,
    canonical_vocabularies: {
      finding_categories: VERIFICATION_FINDING_CATEGORIES,
      finding_dispositions: VERIFICATION_FINDING_DISPOSITIONS,
      finding_severities: VERIFICATION_FINDING_SEVERITIES,
      actions: VERIFICATION_ACTIONS,
      fit_bands: VERIFICATION_FIT_BANDS,
      confidence_levels: VERIFICATION_CONFIDENCE_LEVELS
    }
  };

  return attachPacketEvidenceMeta(packet, evidence);
}

export function isVerificationResultV4(result = {}) {
  return isPlainObject(result) && result.protocol_version === VERIFICATION_PROTOCOL_VERSION;
}

function validateFindingShape(finding, index) {
  if (!isPlainObject(finding)) return `findings[${index}] must be an object.`;
  if (!categorySet.has(finding.category)) return `findings[${index}].category must be a known category.`;
  if (!dispositionSet.has(finding.disposition)) return `findings[${index}].disposition must be a known disposition.`;
  if (!severitySet.has(finding.severity)) return `findings[${index}].severity must be informational, material, or critical.`;
  if (typeof finding.claim !== "string" || !finding.claim.trim()) return `findings[${index}].claim must be a non-empty string.`;
  if (typeof finding.company_impact !== "string" || !finding.company_impact.trim()) {
    return `findings[${index}].company_impact must be a non-empty string.`;
  }
  if (!Array.isArray(finding.evidence_refs) || finding.evidence_refs.some((ref) => typeof ref !== "string")) {
    return `findings[${index}].evidence_refs must be an array of strings.`;
  }
  if (finding.recommended_follow_up !== null && typeof finding.recommended_follow_up !== "string") {
    return `findings[${index}].recommended_follow_up must be a string or null.`;
  }
  return null;
}

export function validateVerificationResultSemantics(result = {}) {
  if (!isPlainObject(result) || Array.isArray(result)) {
    return "Structured output must be a JSON object.";
  }
  if ("review_status" in result || "warnings" in result || "disagreements" in result || "notes" in result) {
    return "V3-shaped object pretending to be V4.";
  }
  if (result.protocol_version !== VERIFICATION_PROTOCOL_VERSION) {
    return `protocol_version must be ${VERIFICATION_PROTOCOL_VERSION}.`;
  }
  if (!Array.isArray(result.findings)) return "findings must be an array.";
  for (let index = 0; index < result.findings.length; index += 1) {
    const error = validateFindingShape(result.findings[index], index);
    if (error) return error;
  }
  if (!isPlainObject(result.strongest_counterfactual)) {
    return "strongest_counterfactual must be an object.";
  }
  if (typeof result.strongest_counterfactual.exists !== "boolean") {
    return "strongest_counterfactual.exists must be boolean.";
  }
  if (
    result.strongest_counterfactual.description !== null &&
    typeof result.strongest_counterfactual.description !== "string"
  ) {
    return "strongest_counterfactual.description must be a string or null.";
  }
  if (
    !Array.isArray(result.strongest_counterfactual.evidence_refs) ||
    result.strongest_counterfactual.evidence_refs.some((item) => typeof item !== "string")
  ) {
    return "strongest_counterfactual.evidence_refs must be an array of strings.";
  }
  if (typeof result.strongest_counterfactual.would_change_fit_or_action !== "boolean") {
    return "strongest_counterfactual.would_change_fit_or_action must be boolean.";
  }
  if (!result.strongest_counterfactual.exists) {
    if (result.strongest_counterfactual.description !== null) {
      return "strongest_counterfactual.description must be null when exists is false.";
    }
    if (result.strongest_counterfactual.evidence_refs.length > 0) {
      return "strongest_counterfactual.evidence_refs must be empty when exists is false.";
    }
    if (result.strongest_counterfactual.would_change_fit_or_action) {
      return "strongest_counterfactual.would_change_fit_or_action must be false when exists is false.";
    }
  } else if (!normalizeText(result.strongest_counterfactual.description, null)) {
    return "strongest_counterfactual.description must be provided when exists is true.";
  }
  if (!isPlainObject(result.suggested_corrections)) {
    return "suggested_corrections must be an object.";
  }
  if (result.suggested_corrections.action !== null && !actionSet.has(result.suggested_corrections.action)) {
    return "suggested_corrections.action must be null or a canonical action.";
  }
  if (result.suggested_corrections.fit_band !== null && !fitBandSet.has(result.suggested_corrections.fit_band)) {
    return "suggested_corrections.fit_band must be null or a canonical fit band.";
  }
  if (result.suggested_corrections.selected_lot_id !== null && typeof result.suggested_corrections.selected_lot_id !== "string") {
    return "suggested_corrections.selected_lot_id must be a string or null.";
  }
  if (typeof result.advisory_summary !== "string" || !result.advisory_summary.trim()) {
    return "advisory_summary must be a non-empty string.";
  }
  if (!Array.isArray(result.next_actions) || result.next_actions.some((item) => typeof item !== "string")) {
    return "next_actions must be an array of strings.";
  }
  if (!confidenceSet.has(result.confidence)) {
    return "confidence must be high, medium, or low.";
  }

  for (let index = 0; index < result.findings.length; index += 1) {
    const finding = result.findings[index];
    if (finding.disposition === "confirmed" && finding.severity === "critical") {
      return "confirmed findings cannot use critical severity.";
    }
    if (finding.disposition === "disagreed" && finding.severity === "informational") {
      return "disagreed findings cannot use informational severity.";
    }
    if (finding.disposition === "critical_contradiction" && finding.severity !== "critical") {
      return "critical_contradiction findings must use critical severity.";
    }
    if (finding.disposition === "unresolved" && finding.severity === "critical") {
      return "unresolved findings cannot use critical severity.";
    }
    if (
      (finding.severity === "material" || finding.severity === "critical") &&
      finding.evidence_refs.length < 1
    ) {
      return `${finding.severity} findings must include evidence_refs.`;
    }
  }

  return null;
}

function normalizedEvidenceRefs(value = []) {
  return dedupeAndSortStrings(value);
}

function hasNonAnalysisEvidenceRef(refs = [], packet = null) {
  return normalizedEvidenceRefs(refs).some((ref) => getVerificationPacketEvidenceRefEntry(packet, ref)?.kind !== "analysis");
}

export function validateVerificationEvidenceRefs(result = {}, packet = null) {
  if (!packet) return null;
  const allowed = new Set(sanitizeArray(packet.allowed_evidence_refs));
  const validateRefList = (refs, label, needsGrounding = false) => {
    const normalized = normalizedEvidenceRefs(refs);
    for (const ref of normalized) {
      if (!allowed.has(ref)) return `${label} contains an unknown evidence ref: ${ref}.`;
    }
    if (needsGrounding && normalized.length > 0 && !hasNonAnalysisEvidenceRef(normalized, packet)) {
      return `${label} must include at least one non-analysis evidence ref.`;
    }
    return null;
  };

  for (let index = 0; index < sanitizeArray(result.findings).length; index += 1) {
    const finding = result.findings[index];
    const needsGrounding = finding.severity === "material" || finding.severity === "critical";
    const error = validateRefList(finding.evidence_refs, `findings[${index}].evidence_refs`, needsGrounding);
    if (error) return error;
  }

  const counterfactualNeedsGrounding =
    Boolean(result.strongest_counterfactual?.would_change_fit_or_action) ||
    Boolean(result.strongest_counterfactual?.exists);
  return validateRefList(
    result.strongest_counterfactual?.evidence_refs,
    "strongest_counterfactual.evidence_refs",
    counterfactualNeedsGrounding
  );
}

export function validateVerificationCorrections(result = {}, packet = null, analysis = {}) {
  const selectedLotId = normalizeText(getSelectedExplicitLotId(analysis), null);
  const explicitLots = new Set(sanitizeArray(packet?.explicit_published_lot_ids));
  const correctedLotId = normalizeText(result?.suggested_corrections?.selected_lot_id, null);

  if (!explicitLots.size && correctedLotId) {
    return "selected_lot_id correction is not allowed when the opportunity has no explicit published lots.";
  }
  if (correctedLotId && !explicitLots.has(correctedLotId)) {
    return "selected_lot_id correction must reference an explicit published lot in the verification packet.";
  }
  if (!selectedLotId && correctedLotId && !explicitLots.size) {
    return "selected_lot_id correction must be null when no explicit lot exists.";
  }
  return null;
}

export function validateVerificationResultV4(result = {}, { packet = null, analysis = null } = {}) {
  const semanticError = validateVerificationResultSemantics(result);
  if (semanticError) return semanticError;
  const evidenceError = validateVerificationEvidenceRefs(result, packet);
  if (evidenceError) return evidenceError;
  const correctionError = validateVerificationCorrections(result, packet, analysis);
  if (correctionError) return correctionError;
  return null;
}

export function deriveVerificationStatusV4(result = {}, analysis = {}) {
  const currentAction = normalizeText(analysis?.decision?.recommendedAction?.code, null);
  const currentFit = normalizeText(analysis?.fitBand ?? analysis?.recommendationClass, null);
  const currentLotId = normalizeText(getSelectedExplicitLotId(analysis), null);
  const correctedLotId = normalizeText(result?.suggested_corrections?.selected_lot_id, null);

  if (
    sanitizeArray(result.findings).some(
      (finding) =>
        finding?.disposition === "critical_contradiction" ||
        (finding?.disposition === "disagreed" && finding?.severity === "critical")
    )
  ) {
    return "rejected";
  }

  if (
    sanitizeArray(result.findings).some(
      (finding) =>
        (finding?.disposition === "unresolved" || finding?.disposition === "disagreed") &&
        finding?.severity === "material"
    )
  ) {
    return "needs_review";
  }

  if (normalizeText(result?.suggested_corrections?.action, null) && result.suggested_corrections.action !== currentAction) {
    return "needs_review";
  }
  if (normalizeText(result?.suggested_corrections?.fit_band, null) && result.suggested_corrections.fit_band !== currentFit) {
    return "needs_review";
  }
  if (correctedLotId && correctedLotId !== currentLotId) {
    return "needs_review";
  }
  if (result?.strongest_counterfactual?.would_change_fit_or_action) {
    return "needs_review";
  }

  return "accepted";
}

export function groupVerificationFindings(findings = []) {
  const groups = {
    confirmed: [],
    unresolved: [],
    disagreed: [],
    critical_contradictions: [],
    headline_confirmed: [],
    headline_needs_verification: [],
    headline_challenged: []
  };

  sanitizeArray(findings).forEach((finding) => {
    if (!finding) return;
    if (finding.disposition === "confirmed") {
      groups.confirmed.push(finding);
      groups.headline_confirmed.push(finding);
      return;
    }
    if (finding.disposition === "unresolved") {
      groups.unresolved.push(finding);
      groups.headline_needs_verification.push(finding);
      return;
    }
    if (finding.disposition === "disagreed") {
      groups.disagreed.push(finding);
      groups.headline_challenged.push(finding);
      return;
    }
    if (finding.disposition === "critical_contradiction") {
      groups.critical_contradictions.push(finding);
      groups.headline_challenged.push(finding);
    }
  });

  return groups;
}

export function buildVerificationCorrectionChanges(result = {}, analysis = {}) {
  const currentAction = normalizeText(analysis?.decision?.recommendedAction?.code, null);
  const currentFit = normalizeText(analysis?.fitBand ?? analysis?.recommendationClass, null);
  const currentLotId = normalizeText(getSelectedExplicitLotId(analysis), null);
  const currentLotLabel = currentLotId
    ? normalizeText(getSelectedExplicitLotLabel(analysis), currentLotId)
    : "Whole opportunity";
  const changes = [];

  if (result?.suggested_corrections?.fit_band && result.suggested_corrections.fit_band !== currentFit) {
    changes.push({
      kind: "fit_band",
      from: currentFit,
      to: result.suggested_corrections.fit_band
    });
  }
  if (result?.suggested_corrections?.action && result.suggested_corrections.action !== currentAction) {
    changes.push({
      kind: "action",
      from: currentAction,
      to: result.suggested_corrections.action
    });
  }
  if (
    normalizeText(result?.suggested_corrections?.selected_lot_id, null) &&
    result.suggested_corrections.selected_lot_id !== currentLotId
  ) {
    changes.push({
      kind: "selected_lot",
      from: currentLotLabel,
      from_id: currentLotId,
      to: result.suggested_corrections.selected_lot_id,
      to_id: result.suggested_corrections.selected_lot_id
    });
  }

  return changes;
}

function buildEvidenceDisplayMap(catalog = []) {
  return new Map(
    sanitizeArray(catalog)
      .filter((item) => normalizeText(item?.ref, null))
      .map((item) => [
        item.ref,
        {
          displayLabel: normalizeText(item.display_label, `Evidence ${item.ref}`),
          canonicalRef: normalizeText(item.canonical_ref, null),
          kind: normalizeText(item.kind, null)
        }
      ])
  );
}

function withEvidenceDisplayRefs(item, evidenceDisplayMap) {
  if (!isPlainObject(item)) return item;
  return {
    ...item,
    evidence_refs: normalizedEvidenceRefs(item.evidence_refs),
    evidence_ref_display: normalizedEvidenceRefs(item.evidence_refs).map(
      (ref) => evidenceDisplayMap.get(ref)?.displayLabel ?? `Evidence ${ref}`
    )
  };
}

export function buildVerificationCustomerSummary(result = {}, analysis = {}, company = {}) {
  const derivedStatus = normalizeText(result?.derived_review_status, null) || deriveVerificationStatusV4(result, analysis);
  const evidenceDisplayMap = buildEvidenceDisplayMap(result?.evidence_ref_catalog);
  const grouped = groupVerificationFindings(result?.findings);
  const companyName = normalizeText(company?.tradingName || company?.legalName, "the active company");

  return {
    protocol_version: result?.protocol_version ?? null,
    derived_review_status: derivedStatus,
    confidence: normalizeText(result?.confidence, "medium"),
    advisory_summary: normalizeText(result?.advisory_summary, ""),
    company_name: companyName,
    evidence_ref_catalog: sanitizeArray(result?.evidence_ref_catalog).map((item) => ({
      ref: normalizeText(item?.ref, null),
      kind: normalizeText(item?.kind, null),
      display_label: normalizeText(item?.display_label, null),
      canonical_ref: normalizeText(item?.canonical_ref, null)
    })).filter((item) => item.ref),
    next_actions: sanitizeArray(result?.next_actions).map((item) => normalizeText(item, null)).filter(Boolean),
    grouped_findings: {
      confirmed: grouped.confirmed.map((item) => withEvidenceDisplayRefs(item, evidenceDisplayMap)),
      unresolved: grouped.unresolved.map((item) => withEvidenceDisplayRefs(item, evidenceDisplayMap)),
      disagreed: grouped.disagreed.map((item) => withEvidenceDisplayRefs(item, evidenceDisplayMap)),
      critical_contradictions: grouped.critical_contradictions.map((item) => withEvidenceDisplayRefs(item, evidenceDisplayMap)),
      headline_confirmed: grouped.headline_confirmed.map((item) => withEvidenceDisplayRefs(item, evidenceDisplayMap)),
      headline_needs_verification: grouped.headline_needs_verification.map((item) => withEvidenceDisplayRefs(item, evidenceDisplayMap)),
      headline_challenged: grouped.headline_challenged.map((item) => withEvidenceDisplayRefs(item, evidenceDisplayMap))
    },
    correction_changes: buildVerificationCorrectionChanges(result, analysis),
    strongest_counterfactual: isPlainObject(result?.strongest_counterfactual)
      ? withEvidenceDisplayRefs({
          exists: Boolean(result.strongest_counterfactual.exists),
          description: normalizeText(result.strongest_counterfactual.description, null),
          evidence_refs: normalizedEvidenceRefs(result.strongest_counterfactual.evidence_refs),
          would_change_fit_or_action: Boolean(result.strongest_counterfactual.would_change_fit_or_action)
        }, evidenceDisplayMap)
      : null
  };
}

function firstAllowedRef(packet, preferredPrefixes = []) {
  const refs = sanitizeArray(packet?.allowed_evidence_refs);
  for (const prefix of preferredPrefixes) {
    const match = refs.find((ref) => getVerificationPacketEvidenceRefEntry(packet, ref)?.canonical_ref?.startsWith(prefix));
    if (match) return match;
  }
  return refs.find((ref) => getVerificationPacketEvidenceRefEntry(packet, ref)?.kind !== "analysis") ?? refs[0] ?? null;
}

export function buildMockVerificationResult(packet = {}) {
  const companyName =
    packet?.company?.trading_name ||
    packet?.company?.legal_name ||
    "the active company";
  const selectedAssessment = packet?.selected_assessment ?? {};
  const findings = [];
  const actionabilityRef = normalizedEvidenceRefs([
    getVerificationPacketAliasForCanonicalRef(packet, "analysis:actionability"),
    firstAllowedRef(packet, ["opportunity-source:", "analysis:actionability"])
  ].filter(Boolean));
  const moneyRef = normalizedEvidenceRefs([
    getVerificationPacketAliasForCanonicalRef(packet, "analysis:money"),
    firstAllowedRef(packet, ["opportunity-evidence:", "opportunity-source:"])
  ].filter(Boolean));

  findings.push({
    category: "money",
    disposition: "confirmed",
    severity: "informational",
    claim: "The deterministic money semantics are preserved in the verification packet.",
    company_impact: `For ${companyName}, the AI review should not reinterpret lot value, procedure value, or grant budget semantics.`,
    evidence_refs: moneyRef,
    recommended_follow_up: null
  });

  if (selectedAssessment.recommended_action === "DO_NOT_PURSUE") {
    findings.push({
      category: "actionability",
      disposition: "confirmed",
      severity: "informational",
      claim: "The current notice appears non-actionable under the deterministic assessment.",
      company_impact: `For ${companyName}, AI follow-up should not reopen a non-actionable notice without new evidence.`,
      evidence_refs: actionabilityRef,
      recommended_follow_up: null
    });
  }

  const unresolvedRefs = normalizedEvidenceRefs([
    getVerificationPacketAliasForCanonicalRef(packet, "analysis:eligibility"),
    firstAllowedRef(packet, ["opportunity-requirement:", "company-fact:", "opportunity-source:", "opportunity-evidence:"])
  ].filter(Boolean));

  if ((selectedAssessment.potential_hard_blockers?.length ?? 0) > 0 || (selectedAssessment.unknowns?.length ?? 0) > 0) {
    findings.push({
      category: "eligibility",
      disposition: "unresolved",
      severity: "material",
      claim: "Important qualification evidence is still unresolved.",
      company_impact: `For ${companyName}, the current opportunity should stay in follow-up until the missing qualification evidence is checked.`,
      evidence_refs: unresolvedRefs,
      recommended_follow_up: "Confirm the published qualification conditions against current company evidence."
    });
  }

  const nextActions = findings
    .map((finding) => normalizeText(finding.recommended_follow_up, null))
    .filter(Boolean)
    .slice(0, 4);

  return {
    protocol_version: VERIFICATION_PROTOCOL_VERSION,
    findings,
    strongest_counterfactual: {
      exists: false,
      description: null,
      evidence_refs: [],
      would_change_fit_or_action: false
    },
    suggested_corrections: {
      action: null,
      fit_band: null,
      selected_lot_id: null
    },
    advisory_summary:
      findings.some((finding) => finding.disposition === "unresolved")
        ? `For ${companyName}, the deterministic assessment remains useful, but unresolved qualification evidence still needs review before relying on it.`
        : `For ${companyName}, the deterministic assessment is materially aligned with the current verification packet.`,
    next_actions: nextActions,
    confidence: "medium"
  };
}

export function formatVerificationChange(change = {}) {
  if (change.kind === "fit_band") {
    return `Fit: ${FIT_BAND_COPY[change.from] ?? change.from ?? "Not stated"} → ${FIT_BAND_COPY[change.to] ?? change.to}`;
  }
  if (change.kind === "action") {
    return `Action: ${ACTION_COPY[change.from] ?? change.from ?? "Not stated"} → ${ACTION_COPY[change.to] ?? change.to}`;
  }
  if (change.kind === "selected_lot") {
    return `Selected lot: ${change.from ?? "Whole opportunity"} → ${change.to ?? change.to_id}`;
  }
  return "";
}
