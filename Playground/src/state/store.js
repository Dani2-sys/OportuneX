import { clone } from "../utils.js";
import { createDemoState } from "../data/demo.js";
import { normalizeAiRun } from "../domain/ai-review.js";
import { isSourceOpportunity } from "../services/source-opportunity-cache.js";

const STORAGE_KEY = "oportunex.phase0.store.v1";
const PERSISTENCE_AVAILABLE_DETAIL = "Browser-local persistence is active.";
const PERSISTENCE_UNAVAILABLE_DETAIL =
  "Browser persistence is unavailable. Changes will work for this session but may be lost after reload.";
const PERSISTENCE_LOAD_ERROR_DETAIL =
  "Saved browser-local data could not be loaded. OportuneX continued in memory with the demo workspace for this session.";
const AUDIT_EVENT_RETENTION = 50;
const SOURCE_SYNC_RUN_RETENTION = 50;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTextValue(value, fallback = "") {
  if (value == null) return fallback;
  return typeof value === "string" ? value : String(value);
}

function normalizeLocation(location = {}, fallbackDisplay = "") {
  const record = isPlainObject(location) ? location : {};
  const display =
    record.display ??
    [record.municipality, record.province, record.autonomousCommunity].filter(Boolean).join(", ") ??
    fallbackDisplay;
  return {
    municipality: record.municipality ?? "",
    province: record.province ?? "",
    autonomousCommunity: record.autonomousCommunity ?? "",
    display: display || fallbackDisplay,
    acceptedRegions: sanitizeArray(record.acceptedRegions),
    excludedRegions: sanitizeArray(record.excludedRegions),
    willingToTravel: record.willingToTravel ?? null,
    preferredWorkingRadiusKm: record.preferredWorkingRadiusKm ?? null
  };
}

function normalizeSourceConflict(conflict = {}, index = 0) {
  const record = isPlainObject(conflict) ? conflict : {};
  return {
    field: normalizeTextValue(record.field, `Source conflict ${index + 1}`),
    left: normalizeTextValue(record.left, ""),
    right: normalizeTextValue(record.right, ""),
    sourceIds: sanitizeArray(record.sourceIds)
  };
}

function normalizeAvailabilityWarning(warning = {}, index = 0) {
  const record = isPlainObject(warning) ? warning : {};
  return {
    id: normalizeTextValue(record.id, `availability-warning-${index + 1}`),
    title: normalizeTextValue(record.title, "Availability / competition warning"),
    detail: normalizeTextValue(
      record.detail,
      "The source indicates heightened competition or reduced remaining availability."
    ),
    severity: normalizeTextValue(record.severity, "medium")
  };
}

function normalizeCompanyProfile(profile = {}, index = 0) {
  const legalName =
    profile?.legalName?.toString?.().trim() ||
    profile?.tradingName?.toString?.().trim() ||
    `Imported company ${index + 1}`;
  const geography = normalizeLocation(profile?.geography, "");
  const preferences = isPlainObject(profile?.preferences) ? profile.preferences : {};
  const experience = isPlainObject(profile?.experience) ? profile.experience : {};
  const grants = isPlainObject(profile?.grants) ? profile.grants : {};
  const size = isPlainObject(profile?.size) ? profile.size : {};
  const classifications = isPlainObject(profile?.classifications) ? profile.classifications : {};

  return {
    id: profile?.id ?? `company-${index + 1}`,
    profileMode: profile?.profileMode === "prospect" ? "prospect" : "confirmed",
    legalName,
    tradingName: profile?.tradingName ?? legalName,
    cif: profile?.cif ?? "",
    preferredLanguage: profile?.preferredLanguage ?? "es",
    website: profile?.website ?? "",
    geography,
    size: {
      employeeBand: size.employeeBand ?? null,
      turnoverBand: size.turnoverBand ?? null,
      companyAgeYears: size.companyAgeYears ?? null,
      smeStatus: size.smeStatus ?? null,
      legalEntityType: size.legalEntityType ?? null
    },
    preferences: {
      minimumAttractiveProjectValue: preferences.minimumAttractiveProjectValue ?? null,
      idealProjectValue: preferences.idealProjectValue ?? null,
      maximumRealisticProjectValue: preferences.maximumRealisticProjectValue ?? null,
      desiredWorkTypes: sanitizeArray(preferences.desiredWorkTypes),
      unwantedWorkTypes: sanitizeArray(preferences.unwantedWorkTypes)
    },
    experience: {
      yearsInTrade: experience.yearsInTrade ?? null,
      maximumProjectValue: experience.maximumProjectValue ?? null,
      publicProcurementProjects: experience.publicProcurementProjects ?? null,
      representativeProjects: sanitizeArray(experience.representativeProjects)
    },
    grants: {
      canCoFinance: grants.canCoFinance ?? null,
      minimumWorthwhileSubsidy: grants.minimumWorthwhileSubsidy ?? null,
      deMinimisUsage: grants.deMinimisUsage ?? null
    },
    facts: isPlainObject(profile?.facts) ? profile.facts : {},
    factsHistory: isPlainObject(profile?.factsHistory) ? profile.factsHistory : {},
    companySources: sanitizeArray(profile?.companySources),
    capabilities: sanitizeArray(profile?.capabilities),
    certifications: sanitizeArray(profile?.certifications),
    insurance: sanitizeArray(profile?.insurance),
    classifications: {
      cnae: sanitizeArray(classifications.cnae),
      iae: sanitizeArray(classifications.iae),
      cpv: sanitizeArray(classifications.cpv)
    },
    customAnswers: isPlainObject(profile?.customAnswers) ? profile.customAnswers : {}
  };
}

function normalizeOpportunity(opportunity = {}, index = 0) {
  const title = opportunity?.title?.toString?.().trim() || `Imported opportunity ${index + 1}`;
  const type = opportunity?.type === "grant" ? "grant" : "contract";
  return {
    id: opportunity?.id ?? `opportunity-${index + 1}`,
    sourceConnector: opportunity?.sourceConnector ?? null,
    canonicalId: opportunity?.canonicalId ?? null,
    sourceOpportunityId: opportunity?.sourceOpportunityId ?? opportunity?.id ?? `source-opportunity-${index + 1}`,
    sourceNoticeVersionId:
      opportunity?.sourceNoticeVersionId ?? opportunity?.canonicalId ?? opportunity?.id ?? `source-version-${index + 1}`,
    type,
    noticeType:
      opportunity?.noticeType ??
      (type === "grant" ? "grant_call" : "active_contract_notice"),
    status: opportunity?.status ?? "open",
    title,
    description: opportunity?.description ?? title,
    issuingOrganisation: opportunity?.issuingOrganisation ?? "",
    contractingAuthority: opportunity?.contractingAuthority ?? "",
    publicationDate: opportunity?.publicationDate ?? null,
    modificationDate: opportunity?.modificationDate ?? null,
    startDate: opportunity?.startDate ?? null,
    deadline: opportunity?.deadline ?? null,
    location: normalizeLocation(opportunity?.location, "Needs review"),
    cpvCodes: sanitizeArray(opportunity?.cpvCodes),
    keywords: sanitizeArray(opportunity?.keywords),
    procedureType: opportunity?.procedureType ?? "",
    estimatedValue: opportunity?.estimatedValue ?? null,
    awardValue: opportunity?.awardValue ?? null,
    baseBudget: opportunity?.baseBudget ?? null,
    relevantValue: opportunity?.relevantValue ?? null,
    wholeProcedureValue: opportunity?.wholeProcedureValue ?? null,
    annualValue: opportunity?.annualValue ?? null,
    multiYearValue: opportunity?.multiYearValue ?? null,
    maximumAidPerBeneficiary: opportunity?.maximumAidPerBeneficiary ?? null,
    programmeBudget: opportunity?.programmeBudget ?? null,
    eligibleProjectCost: opportunity?.eligibleProjectCost ?? null,
    aidIntensity: opportunity?.aidIntensity ?? "",
    duration: opportunity?.duration ?? "",
    guarantees: opportunity?.guarantees ?? "",
    submissionMechanism: opportunity?.submissionMechanism ?? "",
    applicationUrl: opportunity?.applicationUrl ?? "",
    noticeUrl: opportunity?.noticeUrl ?? "",
    referenceNumber: opportunity?.referenceNumber ?? "",
    requiredDocuments: sanitizeArray(opportunity?.requiredDocuments),
    documents: sanitizeArray(opportunity?.documents),
    lastChecked: opportunity?.lastChecked ?? null,
    contacts: sanitizeArray(opportunity?.contacts),
    sources: sanitizeArray(opportunity?.sources),
    evidence: sanitizeArray(opportunity?.evidence),
    availabilityWarnings: sanitizeArray(opportunity?.availabilityWarnings).map(normalizeAvailabilityWarning),
    requirements: sanitizeArray(opportunity?.requirements),
    lots: sanitizeArray(opportunity?.lots).map((lot, lotIndex) => ({
      id: lot?.id ?? `${opportunity?.id ?? `opportunity-${index + 1}`}-lot-${lotIndex + 1}`,
      title: lot?.title ?? title,
      description: lot?.description ?? opportunity?.description ?? title,
      cpvCodes: sanitizeArray(lot?.cpvCodes),
      keywords: sanitizeArray(lot?.keywords),
      value: lot?.value ?? null,
      location: normalizeLocation(lot?.location, ""),
      requirements: sanitizeArray(lot?.requirements),
      documents: sanitizeArray(lot?.documents),
      contacts: sanitizeArray(lot?.contacts),
      synthetic: lot?.synthetic ?? false
    })),
    sourceConflicts: sanitizeArray(opportunity?.sourceConflicts).map(normalizeSourceConflict),
    cancellationStatus: opportunity?.cancellationStatus ?? null
  };
}

export function normalizeState(input) {
  if (!isPlainObject(input)) return normalizeState(createDemoState());
  const companyProfiles = sanitizeArray(input.companyProfiles).map(normalizeCompanyProfile).filter(Boolean);
  if (!companyProfiles.length) return normalizeState(createDemoState());
  const opportunities = sanitizeArray(input.opportunities).map(normalizeOpportunity);

  return {
    organisations: sanitizeArray(input.organisations),
    companyProfiles,
    activeCompanyId:
      companyProfiles.some((company) => company.id === input.activeCompanyId)
        ? input.activeCompanyId
        : companyProfiles[0].id,
    opportunities,
    savedOpportunityIds: [...new Set(sanitizeArray(input.savedOpportunityIds).filter(Boolean))],
    pursuitStatuses: isPlainObject(input.pursuitStatuses) ? input.pursuitStatuses : {},
    feedback: sanitizeArray(input.feedback),
    aiRuns: sanitizeArray(input.aiRuns).map(normalizeAiRun),
    manualOverrides: sanitizeArray(input.manualOverrides),
    auditEvents: sanitizeArray(input.auditEvents).slice(0, AUDIT_EVENT_RETENTION),
    sourceSyncRuns: sanitizeArray(input.sourceSyncRuns).slice(0, SOURCE_SYNC_RUN_RETENTION)
  };
}

function getStorage() {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

function serializeError(error) {
  return error instanceof Error ? error.message : String(error ?? "Unknown persistence error");
}

function createPersistenceStatus(overrides = {}) {
  return {
    status: "available",
    mode: "browser_local",
    detail: PERSISTENCE_AVAILABLE_DETAIL,
    lastSavedAt: null,
    lastError: null,
    ...overrides
  };
}

function createPersistenceError(result, operation) {
  return {
    code: result?.code ?? `PERSISTENCE_${operation.toUpperCase()}_FAILED`,
    message: result?.message ?? "Unknown persistence error.",
    operation,
    at: new Date().toISOString()
  };
}

function normalizePersistenceResult(result, fallbackCode, fallbackMessage) {
  if (result?.ok === true) return { ok: true };
  if (result?.ok === false) {
    return {
      ok: false,
      code: result.code ?? fallbackCode,
      message: result.message ?? fallbackMessage
    };
  }

  return {
    ok: false,
    code: fallbackCode,
    message: fallbackMessage
  };
}

function loadFromAdapter(storageAdapter) {
  if (!storageAdapter || typeof storageAdapter.load !== "function") {
    return {
      ok: false,
      code: "PERSISTENCE_ADAPTER_INVALID",
      message: "Storage adapter is missing a load() method."
    };
  }

  try {
    const result = storageAdapter.load();
    if (result?.ok === true) {
      return {
        ok: true,
        value: result.value ?? null
      };
    }
    if (result?.ok === false) {
      return {
        ok: false,
        code: result.code ?? "PERSISTENCE_LOAD_FAILED",
        message: result.message ?? "Unknown persistence error."
      };
    }
    return {
      ok: false,
      code: "PERSISTENCE_LOAD_FAILED",
      message: "Storage adapter load() must return a structured result."
    };
  } catch (error) {
    return {
      ok: false,
      code: "PERSISTENCE_LOAD_FAILED",
      message: serializeError(error)
    };
  }
}

function saveToAdapter(storageAdapter, snapshot) {
  if (!storageAdapter || typeof storageAdapter.save !== "function") {
    return {
      ok: false,
      code: "PERSISTENCE_ADAPTER_INVALID",
      message: "Storage adapter is missing a save() method."
    };
  }

  try {
    return normalizePersistenceResult(
      storageAdapter.save(snapshot),
      "PERSISTENCE_SAVE_FAILED",
      "Storage adapter save() must return a structured result."
    );
  } catch (error) {
    return {
      ok: false,
      code: "PERSISTENCE_SAVE_FAILED",
      message: serializeError(error)
    };
  }
}

function persistenceUnavailable(result, operation) {
  return createPersistenceStatus({
    status: "unavailable",
    mode: "memory_only",
    detail: PERSISTENCE_UNAVAILABLE_DETAIL,
    lastError: createPersistenceError(result, operation)
  });
}

function persistenceLoadError(result) {
  return createPersistenceStatus({
    status: "error",
    mode: "browser_local",
    detail: PERSISTENCE_LOAD_ERROR_DETAIL,
    lastError: createPersistenceError(result, "load")
  });
}

function persistenceAvailable(lastSavedAt = null) {
  return createPersistenceStatus({
    status: "available",
    mode: "browser_local",
    detail: PERSISTENCE_AVAILABLE_DETAIL,
    lastSavedAt
  });
}

export function createLocalStorageAdapter({ storage = getStorage(), key = STORAGE_KEY } = {}) {
  return {
    kind: "browser_local",
    load() {
      if (!storage) {
        return {
          ok: false,
          code: "PERSISTENCE_UNAVAILABLE",
          message: "localStorage is not available."
        };
      }

      try {
        return {
          ok: true,
          value: storage.getItem(key)
        };
      } catch (error) {
        return {
          ok: false,
          code: "PERSISTENCE_LOAD_FAILED",
          message: serializeError(error)
        };
      }
    },
    save(snapshot) {
      if (!storage) {
        return {
          ok: false,
          code: "PERSISTENCE_UNAVAILABLE",
          message: "localStorage is not available."
        };
      }

      try {
        storage.setItem(key, JSON.stringify(snapshot));
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: "PERSISTENCE_SAVE_FAILED",
          message: serializeError(error)
        };
      }
    }
  };
}

function loadStoreSnapshot(storageAdapter = createLocalStorageAdapter()) {
  const fallbackState = normalizeState(createDemoState());
  const loadResult = loadFromAdapter(storageAdapter);

  if (!loadResult.ok) {
    return {
      state: fallbackState,
      persistence: persistenceUnavailable(loadResult, "load")
    };
  }

  if (!loadResult.value) {
    return {
      state: fallbackState,
      persistence: persistenceAvailable()
    };
  }

  try {
    const parsed = JSON.parse(loadResult.value);
    if (!Array.isArray(parsed?.companyProfiles) || parsed.companyProfiles.length === 0) {
      throw new Error("Persisted workspace is missing companyProfiles.");
    }

    return {
      state: normalizeState(parsed),
      persistence: persistenceAvailable()
    };
  } catch (error) {
    return {
      state: fallbackState,
      persistence: persistenceLoadError({
        ok: false,
        code: "PERSISTENCE_PARSE_FAILED",
        message: serializeError(error)
      })
    };
  }
}

export function createStore({ storageAdapter = createLocalStorageAdapter() } = {}) {
  const initial = loadStoreSnapshot(storageAdapter);
  let state = initial.state;
  let persistence = initial.persistence;
  const listeners = new Set();

  function notify() {
    listeners.forEach((listener) => listener(state));
  }

  function commit(nextState) {
    state = normalizeState(nextState);
    const saveResult = saveState(state, storageAdapter);
    persistence = saveResult.ok ? persistenceAvailable(new Date().toISOString()) : persistenceUnavailable(saveResult, "save");
    notify();
  }

  return {
    getState: () => state,
    getPersistence: () => persistence,
    getPersistenceStatus: () => persistence,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(mutator, auditEvent = null) {
      const next = clone(state);
      mutator(next);
      if (auditEvent) {
        next.auditEvents = [auditEvent, ...(next.auditEvents ?? [])].slice(0, AUDIT_EVENT_RETENTION);
      }
      commit(next);
    },
    replace(nextState) {
      commit(clone(nextState));
    },
    reset() {
      commit(createDemoState());
    }
  };
}

export function loadState(storageAdapter = createLocalStorageAdapter()) {
  return loadStoreSnapshot(storageAdapter).state;
}

export function serializeStateForPersistence(state) {
  const snapshot = normalizeState(state);
  snapshot.opportunities = snapshot.opportunities.filter((item) => !isSourceOpportunity(item));
  snapshot.auditEvents = snapshot.auditEvents.slice(0, AUDIT_EVENT_RETENTION);
  snapshot.sourceSyncRuns = snapshot.sourceSyncRuns.slice(0, SOURCE_SYNC_RUN_RETENTION);
  return snapshot;
}

export function saveState(state, storageAdapter = createLocalStorageAdapter()) {
  const snapshot = serializeStateForPersistence(state);
  return saveToAdapter(storageAdapter, snapshot);
}
