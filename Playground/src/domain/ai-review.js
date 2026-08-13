const FINGERPRINT_VERSION = "ai-context-v2";

const VOLATILE_METADATA_KEYS = new Set([
  "lastChecked",
  "fetchedAt",
  "syncedAt",
  "retrievedAt",
  "checkedAt",
  "cacheCheckedAt",
  "cacheUpdatedAt",
  "connectorRunAt",
  "connectorStartedAt",
  "connectorCompletedAt",
  "syncStartedAt",
  "syncCompletedAt",
  "refreshStartedAt",
  "refreshCompletedAt"
]);

const PRESENTATION_KEYS = new Set([
  "display",
  "displayTitle",
  "displayValue",
  "displayValueLabel",
  "displayLabel",
  "companyAmountLabel",
  "locationLabel",
  "deadlineLabel",
  "fitBandLabel",
  "recommendationLabel",
  "rankLabel",
  "scopeLabel",
  "lotLabel",
  "executiveVerdict",
  "reportMarkdown",
  "analysisNow"
]);

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
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePrimitive(value) {
  if (value == null) return null;
  if (typeof value === "string") return normalizeText(value, null);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return normalizeText(value, null);
}

function isEmptyNormalizedValue(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;

  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce((record, key) => {
      const nextValue = sortValue(value[key]);
      if (nextValue !== undefined) record[key] = nextValue;
      return record;
    }, {});
}

function stableSerialize(value) {
  return JSON.stringify(sortValue(value));
}

function hashFingerprint(input) {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  const mask = 18446744073709551615n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function sortAndDedupe(items) {
  const unique = new Map();
  for (const item of items) {
    if (isEmptyNormalizedValue(item)) continue;
    unique.set(stableSerialize(item), item);
  }
  return [...unique.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map((entry) => entry[1]);
}

function compactObject(record) {
  return Object.keys(record).reduce((next, key) => {
    const value = record[key];
    if (!isEmptyNormalizedValue(value)) next[key] = value;
    return next;
  }, {});
}

function mapSemanticRef(value, idMap) {
  const reference = normalizeText(value, null);
  if (!reference) return null;
  return idMap.get(reference) ?? reference;
}

function normalizeRefArray(value, idMap) {
  return sortAndDedupe(
    sanitizeArray(value)
      .map((item) => mapSemanticRef(item, idMap))
      .filter(Boolean)
  );
}

function looksLikeMoney(value) {
  return isPlainObject(value) && (
    "amountMinor" in value ||
    "original" in value ||
    ("amountType" in value && !("min" in value || "max" in value)) ||
    ("vatStatus" in value && !("min" in value || "max" in value))
  );
}

function normalizeMoney(value) {
  if (!isPlainObject(value)) return null;
  return compactObject({
    amountMinor: normalizeNumber(value.amountMinor),
    currency: normalizeText(value.currency, null),
    vatStatus: normalizeText(value.vatStatus, null),
    amountType: normalizeText(value.amountType, null)
  });
}

function looksLikeLocation(value) {
  if (!isPlainObject(value)) return false;
  return [
    "municipality",
    "province",
    "autonomousCommunity",
    "country",
    "postalCode",
    "acceptedRegions",
    "excludedRegions",
    "willingToTravel",
    "preferredWorkingRadiusKm"
  ].some((key) => key in value);
}

function normalizeLocation(value, context, path) {
  if (!isPlainObject(value)) return null;
  const knownKeys = new Set([
    "municipality",
    "province",
    "autonomousCommunity",
    "country",
    "postalCode",
    "acceptedRegions",
    "excludedRegions",
    "willingToTravel",
    "preferredWorkingRadiusKm",
    "display"
  ]);
  const extras = normalizeRemainingKeys(value, context, path, knownKeys);

  return compactObject({
    municipality: normalizeText(value.municipality, null),
    province: normalizeText(value.province, null),
    autonomousCommunity: normalizeText(value.autonomousCommunity, null),
    country: normalizeText(value.country, null),
    postalCode: normalizeText(value.postalCode, null),
    acceptedRegions: normalizeSemanticValue(value.acceptedRegions, context, [...path, "acceptedRegions"]),
    excludedRegions: normalizeSemanticValue(value.excludedRegions, context, [...path, "excludedRegions"]),
    willingToTravel:
      typeof value.willingToTravel === "boolean" ? value.willingToTravel : null,
    preferredWorkingRadiusKm: normalizeNumber(value.preferredWorkingRadiusKm),
    ...extras
  });
}

function normalizeRemainingKeys(value, context, path, excludedKeys = new Set()) {
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce((record, key) => {
      if (excludedKeys.has(key)) return record;
      const nextValue = normalizeKeyedValue(key, value[key], context, path);
      if (!isEmptyNormalizedValue(nextValue)) record[key] = nextValue;
      return record;
    }, {});
}

function normalizeKeyedValue(key, value, context, path) {
  if (context.excludeKeys?.has(key)) return null;
  if (VOLATILE_METADATA_KEYS.has(key)) return null;
  if (PRESENTATION_KEYS.has(key)) return null;
  if (key === "sourceIds") return normalizeRefArray(value, context.sourceIdMap ?? new Map());
  if (key === "evidenceIds") return normalizeRefArray(value, context.evidenceIdMap ?? new Map());
  if (key === "sourceId") return mapSemanticRef(value, context.sourceIdMap ?? new Map());
  if (key === "evidenceId") return mapSemanticRef(value, context.evidenceIdMap ?? new Map());
  if (key === "label" && path[path.length - 1] === "recommendedAction") return null;
  return normalizeSemanticValue(value, context, [...path, key]);
}

function normalizeSemanticValue(value, context = {}, path = []) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return sortAndDedupe(
      value
        .map((item) => normalizeSemanticValue(item, context, path))
        .filter((item) => !isEmptyNormalizedValue(item))
    );
  }
  if (looksLikeMoney(value)) return normalizeMoney(value);
  if (looksLikeLocation(value)) return normalizeLocation(value, context, path);
  if (!isPlainObject(value)) return normalizePrimitive(value);

  return compactObject(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .reduce((record, key) => {
        const nextValue = normalizeKeyedValue(key, value[key], context, path);
        if (!isEmptyNormalizedValue(nextValue)) record[key] = nextValue;
        return record;
      }, {})
  );
}

function buildSemanticCollection(items, normalizeRecord) {
  const idMap = new Map();
  const byKey = new Map();

  sanitizeArray(items).forEach((item, index) => {
    const normalized = normalizeRecord(item, index);
    const fallbackId = normalizeText(item?.id, `record-${index + 1}`);
    const keyPayload = isEmptyNormalizedValue(normalized)
      ? { fallbackId }
      : normalized;
    const semanticKey = stableSerialize(keyPayload);

    if (fallbackId) idMap.set(fallbackId, semanticKey);
    if (!byKey.has(semanticKey)) byKey.set(semanticKey, keyPayload);
  });

  return {
    idMap,
    records: [...byKey.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map((entry) => entry[1])
  };
}

function normalizeSourceRecord(source) {
  return normalizeSemanticValue(source, {
    excludeKeys: new Set(["id"])
  }, ["source"]);
}

function normalizeEvidenceRecord(evidence, sourceIdMap) {
  return normalizeSemanticValue(evidence, {
    excludeKeys: new Set(["id"]),
    sourceIdMap
  }, ["evidence"]);
}

function buildCompanyContext(company = {}) {
  const companySources = buildSemanticCollection(company.companySources, normalizeSourceRecord);
  const context = {
    sourceIdMap: companySources.idMap,
    evidenceIdMap: new Map()
  };

  return {
    payload: compactObject({
      id: normalizeText(company.id, null),
      profileMode: normalizeText(company.profileMode, null),
      cif: normalizeText(company.cif, null),
      geography: normalizeSemanticValue(company.geography, context, ["company", "geography"]),
      size: normalizeSemanticValue(company.size, context, ["company", "size"]),
      preferences: normalizeSemanticValue(company.preferences, context, ["company", "preferences"]),
      experience: normalizeSemanticValue(company.experience, context, ["company", "experience"]),
      grants: normalizeSemanticValue(company.grants, context, ["company", "grants"]),
      facts: normalizeSemanticValue(company.facts, context, ["company", "facts"]),
      factsHistory: normalizeSemanticValue(company.factsHistory, context, ["company", "factsHistory"]),
      capabilities: normalizeSemanticValue(company.capabilities, context, ["company", "capabilities"]),
      certifications: normalizeSemanticValue(company.certifications, context, ["company", "certifications"]),
      insurance: normalizeSemanticValue(company.insurance, context, ["company", "insurance"]),
      classifications: normalizeSemanticValue(company.classifications, context, ["company", "classifications"]),
      customAnswers: normalizeSemanticValue(company.customAnswers, context, ["company", "customAnswers"]),
      companySources: companySources.records
    }),
    sourceIdMap: companySources.idMap
  };
}

function buildOpportunityContext(opportunity = {}) {
  const sources = buildSemanticCollection(opportunity.sources, normalizeSourceRecord);
  const evidence = buildSemanticCollection(opportunity.evidence, (item) =>
    normalizeEvidenceRecord(item, sources.idMap)
  );
  const context = {
    sourceIdMap: sources.idMap,
    evidenceIdMap: evidence.idMap
  };

  return {
    payload: compactObject({
      id: normalizeText(opportunity.id, null),
      canonicalId: normalizeText(opportunity.canonicalId, null),
      sourceOpportunityId: normalizeText(opportunity.sourceOpportunityId, null),
      sourceNoticeVersionId: normalizeText(opportunity.sourceNoticeVersionId, null),
      type: normalizeText(opportunity.type, null),
      noticeType: normalizeText(opportunity.noticeType, null),
      status: normalizeText(opportunity.status, null),
      derivedStatus: normalizeText(opportunity.derivedStatus, null),
      cancellationStatus: normalizeText(opportunity.cancellationStatus, null),
      title: normalizeText(opportunity.title, null),
      description: normalizeText(opportunity.description, null),
      issuingOrganisation: normalizeText(opportunity.issuingOrganisation, null),
      contractingAuthority: normalizeText(opportunity.contractingAuthority, null),
      publicationDate: normalizeText(opportunity.publicationDate, null),
      modificationDate: normalizeText(opportunity.modificationDate, null),
      startDate: normalizeText(opportunity.startDate, null),
      deadline: normalizeSemanticValue(opportunity.deadline, context, ["opportunity", "deadline"]),
      location: normalizeSemanticValue(opportunity.location, context, ["opportunity", "location"]),
      cpvCodes: normalizeSemanticValue(opportunity.cpvCodes, context, ["opportunity", "cpvCodes"]),
      keywords: normalizeSemanticValue(opportunity.keywords, context, ["opportunity", "keywords"]),
      procedureType: normalizeText(opportunity.procedureType, null),
      estimatedValue: normalizeMoney(opportunity.estimatedValue),
      awardValue: normalizeMoney(opportunity.awardValue),
      baseBudget: normalizeMoney(opportunity.baseBudget),
      relevantValue: normalizeMoney(opportunity.relevantValue),
      wholeProcedureValue: normalizeMoney(opportunity.wholeProcedureValue),
      annualValue: normalizeMoney(opportunity.annualValue),
      multiYearValue: normalizeMoney(opportunity.multiYearValue),
      maximumAidPerBeneficiary: normalizeMoney(opportunity.maximumAidPerBeneficiary),
      programmeBudget: normalizeMoney(opportunity.programmeBudget),
      eligibleProjectCost: normalizeMoney(opportunity.eligibleProjectCost),
      aidIntensity: normalizeText(opportunity.aidIntensity, null),
      duration: normalizeText(opportunity.duration, null),
      guarantees: normalizeText(opportunity.guarantees, null),
      submissionMechanism: normalizeText(opportunity.submissionMechanism, null),
      applicationUrl: normalizeText(opportunity.applicationUrl, null),
      noticeUrl: normalizeText(opportunity.noticeUrl, null),
      referenceNumber: normalizeText(opportunity.referenceNumber, null),
      requiredDocuments: normalizeSemanticValue(opportunity.requiredDocuments, context, ["opportunity", "requiredDocuments"]),
      documents: normalizeSemanticValue(opportunity.documents, context, ["opportunity", "documents"]),
      contacts: normalizeSemanticValue(opportunity.contacts, context, ["opportunity", "contacts"]),
      availabilityWarnings: normalizeSemanticValue(opportunity.availabilityWarnings, context, ["opportunity", "availabilityWarnings"]),
      requirements: normalizeSemanticValue(opportunity.requirements, context, ["opportunity", "requirements"]),
      lots: normalizeSemanticValue(opportunity.lots, context, ["opportunity", "lots"]),
      sourceConflicts: normalizeSemanticValue(opportunity.sourceConflicts, context, ["opportunity", "sourceConflicts"]),
      sources: sources.records,
      evidence: evidence.records
    }),
    sourceIdMap: sources.idMap,
    evidenceIdMap: evidence.idMap
  };
}

function normalizeAssessment(value, context, path) {
  if (!isPlainObject(value)) return null;
  return normalizeSemanticValue(value, {
    ...context,
    excludeKeys: new Set(["note"])
  }, path);
}

function normalizeConfidenceShield(shield) {
  if (!isPlainObject(shield)) return null;
  return compactObject({
    officialSourceVerified:
      typeof shield.officialSourceVerified === "boolean" ? shield.officialSourceVerified : null,
    sourceFieldsEvidenced: normalizeNumber(shield.sourceFieldsEvidenced),
    totalSourceFields: normalizeNumber(shield.totalSourceFields),
    criticalFieldsVerified: normalizeNumber(shield.criticalFieldsVerified),
    totalCriticalFields: normalizeNumber(shield.totalCriticalFields),
    mandatoryConfirmed: normalizeNumber(shield.mandatoryConfirmed),
    mandatoryNeedsVerification: normalizeNumber(shield.mandatoryNeedsVerification),
    mandatoryFailed: normalizeNumber(shield.mandatoryFailed),
    hardMandatoryConfirmed: normalizeNumber(shield.hardMandatoryConfirmed),
    hardMandatoryNeedsVerification: normalizeNumber(shield.hardMandatoryNeedsVerification),
    hardMandatoryFailed: normalizeNumber(shield.hardMandatoryFailed),
    companyConfirmationsNeeded: normalizeNumber(shield.companyConfirmationsNeeded),
    eligibilityConfidence: normalizeText(shield.eligibilityConfidence, null),
    companyFactConfidence: normalizeText(shield.companyFactConfidence, null),
    allSourceFieldsEvidenced:
      typeof shield.allSourceFieldsEvidenced === "boolean" ? shield.allSourceFieldsEvidenced : null,
    currentEvidenceRequired: normalizeNumber(shield.currentEvidenceRequired),
    conflictingSources:
      typeof shield.conflictingSources === "boolean" ? shield.conflictingSources : null,
    outstandingQuestions: normalizeNumber(shield.outstandingQuestions),
    sourceConflictsCount: normalizeNumber(shield.sourceConflictsCount)
  });
}

function normalizeDecision(decision) {
  if (!isPlainObject(decision)) return null;
  return compactObject({
    recommendedAction: isPlainObject(decision.recommendedAction)
      ? compactObject({
          code: normalizeText(decision.recommendedAction.code, null),
          bucket: normalizeText(decision.recommendedAction.bucket, null)
        })
      : null
  });
}

function normalizeIssueItems(items, context, path) {
  return sortAndDedupe(
    sanitizeArray(items)
      .map((item) => {
        if (!isPlainObject(item)) return normalizePrimitive(item);
        return compactObject({
          id: normalizeText(item.id, null),
          title: normalizeText(item.title, null),
          severity: normalizeText(item.severity, null),
          priority: normalizeNumber(item.priority),
          category: normalizeText(item.category, null),
          requiresVerification:
            typeof item.requiresVerification === "boolean" ? item.requiresVerification : null,
          detail: normalizeText(item.detail, null)
        });
      })
      .map((item) => normalizeSemanticValue(item, context, path))
      .filter((item) => !isEmptyNormalizedValue(item))
  );
}

function normalizeFinancialPicture(financialPicture) {
  if (!isPlainObject(financialPicture)) return null;
  return compactObject({
    kind: normalizeText(financialPicture.kind, null),
    lines: sortAndDedupe(
      sanitizeArray(financialPicture.lines)
        .map((line) => {
          if (!isPlainObject(line)) return null;
          return compactObject({
            id: normalizeText(line.id, null),
            amountType: normalizeText(line.amountType, null),
            vatStatus: normalizeText(line.vatStatus, null),
            primary: typeof line.primary === "boolean" ? line.primary : null,
            money: normalizeMoney(line.money),
            text: normalizeText(line.text, null)
          });
        })
        .filter((line) => !isEmptyNormalizedValue(line))
    )
  });
}

function buildAnalysisContext(analysis = {}, companySourceIdMap, opportunitySourceIdMap, evidenceIdMap) {
  const sourceIdMap = new Map([
    ...companySourceIdMap.entries(),
    ...opportunitySourceIdMap.entries()
  ]);
  const context = {
    sourceIdMap,
    evidenceIdMap
  };

  return compactObject({
    eligibilityStatus: normalizeText(analysis.eligibilityStatus, null),
    decision: normalizeDecision(analysis.decision),
    matchScore: normalizeNumber(analysis.matchScore),
    dimensions: compactObject({
      capabilityFit: normalizeNumber(analysis.dimensions?.capabilityFit),
      baseCapabilityFit: normalizeNumber(analysis.dimensions?.baseCapabilityFit),
      specialistScopeConfidence: normalizeNumber(analysis.dimensions?.specialistScopeConfidence),
      financialScaleFit: normalizeNumber(analysis.dimensions?.financialScaleFit),
      geographicFit: normalizeNumber(analysis.dimensions?.geographicFit),
      strategicFit: normalizeNumber(analysis.dimensions?.strategicFit),
      qualificationReadiness: normalizeNumber(analysis.dimensions?.qualificationReadiness),
      deadlineFeasibility: normalizeNumber(analysis.dimensions?.deadlineFeasibility),
      applicationEffort: normalizeNumber(analysis.dimensions?.applicationEffort),
      scaleAssessment: normalizeAssessment(analysis.dimensions?.scaleAssessment, context, ["analysis", "dimensions", "scaleAssessment"]),
      geographyAssessment: normalizeAssessment(analysis.dimensions?.geographyAssessment, context, ["analysis", "dimensions", "geographyAssessment"])
    }),
    confidenceShield: normalizeConfidenceShield(analysis.confidenceShield),
    blockers: normalizeIssueItems(analysis.blockers, context, ["analysis", "blockers"]),
    potentialHardBlockers: normalizeIssueItems(analysis.potentialHardBlockers, context, ["analysis", "potentialHardBlockers"]),
    unknowns: normalizeIssueItems(analysis.unknowns, context, ["analysis", "unknowns"]),
    risks: normalizeIssueItems(analysis.risks, context, ["analysis", "risks"]),
    requirementRows: normalizeSemanticValue(analysis.requirementRows, context, ["analysis", "requirementRows"]),
    financialPicture: normalizeFinancialPicture(analysis.financialPicture)
  });
}

export function createAiVerificationContextFingerprint(company, opportunity, analysis) {
  const companyContext = buildCompanyContext(company);
  const opportunityContext = buildOpportunityContext(opportunity);
  const payload = {
    company: companyContext.payload,
    opportunity: opportunityContext.payload,
    analysis: buildAnalysisContext(
      analysis,
      companyContext.sourceIdMap,
      opportunityContext.sourceIdMap,
      opportunityContext.evidenceIdMap
    )
  };
  const serialized = stableSerialize(payload);
  return `${FINGERPRINT_VERSION}:${hashFingerprint(serialized)}`;
}

export function extractPersistedAiVerificationResult(result = {}) {
  return {
    provider: normalizeText(result.provider, null),
    model: normalizeText(result.model, null),
    review_status: normalizeText(result.review_status, null),
    warnings: sanitizeArray(result.warnings),
    disagreements: sanitizeArray(result.disagreements),
    corrected_action: normalizeText(result.corrected_action, null),
    corrected_fit_band: normalizeText(result.corrected_fit_band, null),
    confidence: normalizeText(result.confidence, null),
    notes: normalizeText(result.notes, "")
  };
}

export function normalizeAiRun(run = {}, index = 0) {
  const record = isPlainObject(run) ? run : {};
  const companyId = normalizeText(record.companyId, null);
  const opportunityId = normalizeText(record.opportunityId, `legacy-ai-run-${index + 1}`);
  const completedAt = normalizeText(record.completedAt, null);
  const sourceNoticeVersionId = normalizeText(record.sourceNoticeVersionId, null);
  const contextFingerprint = normalizeText(record.contextFingerprint, null);

  return {
    id: normalizeText(record.id, `ai-run-${index + 1}`),
    scope: companyId ? "company_opportunity" : "legacy_unscoped",
    companyId,
    opportunityId,
    completedAt,
    result: isPlainObject(record.result) ? record.result : null,
    contextFingerprint,
    sourceNoticeVersionId,
    lastError: isPlainObject(record.lastError) ? record.lastError : null
  };
}

export function findScopedAiReview(aiRuns = [], companyId, opportunityId) {
  return sanitizeArray(aiRuns).find(
    (item) =>
      item?.scope === "company_opportunity" &&
      item.companyId === companyId &&
      item.opportunityId === opportunityId &&
      item.result
  ) ?? null;
}

export function findLegacyAiReview(aiRuns = [], opportunityId) {
  return sanitizeArray(aiRuns).find(
    (item) =>
      item?.scope === "legacy_unscoped" &&
      item.opportunityId === opportunityId &&
      item.result
  ) ?? null;
}

export function listScopedAiReviewsForCompany(aiRuns = [], companyId) {
  return sanitizeArray(aiRuns).filter(
    (item) => item?.scope === "company_opportunity" && item.companyId === companyId && item.result
  );
}

export function upsertScopedAiReview(aiRuns = [], nextRecord, maxEntries = 60) {
  const normalizedNext = normalizeAiRun(nextRecord, 0);
  const remaining = sanitizeArray(aiRuns).filter(
    (item) =>
      !(
        item?.scope === "company_opportunity" &&
        item.companyId === normalizedNext.companyId &&
        item.opportunityId === normalizedNext.opportunityId
      )
  );

  return [normalizedNext, ...remaining].slice(0, maxEntries);
}

export function getAiReviewState(aiRuns = [], company, opportunity, analysis) {
  const companyId = company?.id ?? null;
  const opportunityId = opportunity?.id ?? null;
  const currentFingerprint =
    company && opportunity && analysis
      ? createAiVerificationContextFingerprint(company, opportunity, analysis)
      : null;
  const review = companyId && opportunityId
    ? findScopedAiReview(aiRuns, companyId, opportunityId)
    : null;
  const legacyReview = opportunityId ? findLegacyAiReview(aiRuns, opportunityId) : null;
  const stale =
    Boolean(review) &&
    (
      !review.contextFingerprint ||
      !currentFingerprint ||
      review.contextFingerprint !== currentFingerprint ||
      (review.sourceNoticeVersionId ?? null) !== (opportunity?.sourceNoticeVersionId ?? null)
    );

  return {
    currentFingerprint,
    review,
    legacyReview,
    status: review ? (stale ? "stale" : "current") : "missing",
    isStale: stale,
    hasSavedReview: Boolean(review),
    buttonLabel: review ? "Re-run AI verification" : "Run AI verification",
    staleMessage:
      stale
        ? "Company or opportunity information changed since this AI review. Re-run verification."
        : "",
    isLegacyAvailable: Boolean(legacyReview)
  };
}
