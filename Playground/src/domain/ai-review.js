function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value, fallback = null) {
  if (value == null || value === "") return fallback;
  return typeof value === "string" ? value : String(value);
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
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function pickDecisionRelevantCompanyData(company = {}) {
  return {
    id: company.id ?? null,
    profileMode: company.profileMode ?? null,
    legalName: company.legalName ?? null,
    tradingName: company.tradingName ?? null,
    geography: company.geography ?? {},
    size: company.size ?? {},
    preferences: company.preferences ?? {},
    experience: company.experience ?? {},
    grants: company.grants ?? {},
    facts: company.facts ?? {},
    factsHistory: company.factsHistory ?? {},
    capabilities: sanitizeArray(company.capabilities),
    certifications: sanitizeArray(company.certifications),
    insurance: sanitizeArray(company.insurance),
    classifications: company.classifications ?? {},
    customAnswers: company.customAnswers ?? {}
  };
}

function pickDecisionRelevantOpportunityData(opportunity = {}) {
  return {
    id: opportunity.id ?? null,
    canonicalId: opportunity.canonicalId ?? null,
    sourceOpportunityId: opportunity.sourceOpportunityId ?? null,
    sourceNoticeVersionId: opportunity.sourceNoticeVersionId ?? null,
    type: opportunity.type ?? null,
    noticeType: opportunity.noticeType ?? null,
    status: opportunity.status ?? null,
    title: opportunity.title ?? null,
    description: opportunity.description ?? null,
    issuingOrganisation: opportunity.issuingOrganisation ?? null,
    contractingAuthority: opportunity.contractingAuthority ?? null,
    publicationDate: opportunity.publicationDate ?? null,
    modificationDate: opportunity.modificationDate ?? null,
    startDate: opportunity.startDate ?? null,
    deadline: opportunity.deadline ?? null,
    location: opportunity.location ?? {},
    cpvCodes: sanitizeArray(opportunity.cpvCodes),
    keywords: sanitizeArray(opportunity.keywords),
    procedureType: opportunity.procedureType ?? null,
    estimatedValue: opportunity.estimatedValue ?? null,
    awardValue: opportunity.awardValue ?? null,
    baseBudget: opportunity.baseBudget ?? null,
    relevantValue: opportunity.relevantValue ?? null,
    wholeProcedureValue: opportunity.wholeProcedureValue ?? null,
    annualValue: opportunity.annualValue ?? null,
    multiYearValue: opportunity.multiYearValue ?? null,
    maximumAidPerBeneficiary: opportunity.maximumAidPerBeneficiary ?? null,
    programmeBudget: opportunity.programmeBudget ?? null,
    eligibleProjectCost: opportunity.eligibleProjectCost ?? null,
    aidIntensity: opportunity.aidIntensity ?? null,
    duration: opportunity.duration ?? null,
    guarantees: opportunity.guarantees ?? null,
    submissionMechanism: opportunity.submissionMechanism ?? null,
    applicationUrl: opportunity.applicationUrl ?? null,
    noticeUrl: opportunity.noticeUrl ?? null,
    referenceNumber: opportunity.referenceNumber ?? null,
    requiredDocuments: sanitizeArray(opportunity.requiredDocuments),
    documents: sanitizeArray(opportunity.documents),
    lastChecked: opportunity.lastChecked ?? null,
    contacts: sanitizeArray(opportunity.contacts),
    sources: sanitizeArray(opportunity.sources),
    evidence: sanitizeArray(opportunity.evidence),
    availabilityWarnings: sanitizeArray(opportunity.availabilityWarnings),
    requirements: sanitizeArray(opportunity.requirements),
    lots: sanitizeArray(opportunity.lots),
    sourceConflicts: sanitizeArray(opportunity.sourceConflicts),
    derivedStatus: opportunity.derivedStatus ?? null
  };
}

function pickDecisionRelevantAnalysisData(analysis = {}) {
  return {
    fitBand: analysis.fitBand ?? analysis.recommendationClass ?? null,
    recommendationClass: analysis.recommendationClass ?? null,
    eligibilityStatus: analysis.eligibilityStatus ?? null,
    displayTitle: analysis.displayTitle ?? null,
    displayValueLabel: analysis.displayValueLabel ?? null,
    companyAmountLabel: analysis.companyAmountLabel ?? null,
    locationLabel: analysis.locationLabel ?? null,
    deadlineLabel: analysis.deadlineLabel ?? null,
    hasPublishedLot: analysis.hasPublishedLot ?? false,
    lotLabel: analysis.lotLabel ?? null,
    scopeLabel: analysis.scopeLabel ?? null,
    decision: analysis.decision
      ? {
          recommendedAction: {
            code: analysis.decision.recommendedAction?.code ?? null,
            label: analysis.decision.recommendedAction?.label ?? null,
            bucket: analysis.decision.recommendedAction?.bucket ?? null
          },
          mainReason: analysis.decision.mainReason ?? null,
          mainQuestion: analysis.decision.mainQuestion ?? null
        }
      : null,
    dimensions: analysis.dimensions
      ? {
          capabilityFit: analysis.dimensions.capabilityFit ?? null,
          baseCapabilityFit: analysis.dimensions.baseCapabilityFit ?? null,
          specialistScopeConfidence: analysis.dimensions.specialistScopeConfidence ?? null,
          financialScaleFit: analysis.dimensions.financialScaleFit ?? null,
          geographicFit: analysis.dimensions.geographicFit ?? null,
          strategicFit: analysis.dimensions.strategicFit ?? null,
          qualificationReadiness: analysis.dimensions.qualificationReadiness ?? null,
          deadlineFeasibility: analysis.dimensions.deadlineFeasibility ?? null,
          applicationEffort: analysis.dimensions.applicationEffort ?? null,
          evidenceQuality: analysis.dimensions.evidenceQuality ?? null,
          scaleAssessment: analysis.dimensions.scaleAssessment ?? null,
          geographyAssessment: analysis.dimensions.geographyAssessment ?? null
        }
      : null,
    confidenceShield: analysis.confidenceShield ?? null,
    positives: sanitizeArray(analysis.positives),
    blockers: sanitizeArray(analysis.blockers),
    potentialHardBlockers: sanitizeArray(analysis.potentialHardBlockers),
    unknowns: sanitizeArray(analysis.unknowns),
    risks: sanitizeArray(analysis.risks),
    requirementRows: sanitizeArray(analysis.requirementRows),
    adaptiveQuestions: sanitizeArray(analysis.adaptiveQuestions),
    financialPicture: analysis.financialPicture ?? null,
    preMortem: sanitizeArray(analysis.preMortem),
    matchScore: analysis.matchScore ?? null,
    priorityScore: analysis.priorityScore ?? null
  };
}

export function createAiVerificationContextFingerprint(company, opportunity, analysis) {
  const payload = {
    company: pickDecisionRelevantCompanyData(company),
    opportunity: pickDecisionRelevantOpportunityData(opportunity),
    analysis: pickDecisionRelevantAnalysisData(analysis)
  };
  const serialized = stableSerialize(payload);
  return `ai-context-v1:${hashFingerprint(serialized)}`;
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
