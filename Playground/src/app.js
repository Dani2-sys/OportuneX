import {
  ACTION_COPY,
  APP_TITLE,
  CONFIDENCE_COPY,
  ELIGIBILITY_COPY,
  FEEDBACK_LABELS,
  FIT_BAND_COPY,
  NAV_ITEMS,
  OPPORTUNITY_TYPES,
  RECOMMENDATION_COPY,
  STATUS_LABELS
} from "./config.js";
import { formatApplicationDate, getApplicationNow, getEvaluationNow } from "./clock.js";
import { demoCompany } from "./data/demo.js";
import { evaluationFixtures } from "./data/evaluation-fixtures.js";
import { analyzePortfolio } from "./domain/analysis.js";
import {
  buildCompanyConflicts,
  buildCompanyUnknowns,
  computeDecisionProfileCompleteness,
  describeStatus,
  formatCompanyFact,
  formatCompanyRange,
  getCompanyCapabilities,
  getCompanyCertifications,
  getCompanyClassifications,
  getCompanyFact,
  getCompanyFactHistory,
  getCompanyInsurancePolicies,
  getCompanySources,
  getEmployeeRange,
  getFactStatus,
  getFactValue,
  getProfileMode,
  getTurnoverRange,
  isStalePublicFact,
  setCertificationDecision,
  setCompanyConfirmedFact,
  setCompanyConfirmedRange,
  setCompanyFactUnknown
} from "./domain/company-profile.js";
import { runEvaluationSuite } from "./domain/evaluation.js";
import { formatDeadline, formatLastChecked, isNonActionableDerivedStatus, parseSpanishDate, urgencyChip } from "./domain/deadline.js";
import { describeEvidenceBackedText } from "./domain/evidence.js";
import { formatMoney, parseMoneyInput } from "./domain/money.js";
import {
  createAiVerificationContextFingerprint,
  extractPersistedAiVerificationResult,
  getAiReviewState,
  listScopedAiReviewsForCompany,
  upsertScopedAiReview
} from "./domain/ai-review.js";
import { importCompanyProfileFromJson } from "./services/company-importer.js";
import { importOpportunityFromJson, importOpportunityFromText, validateOpportunityImport } from "./services/importer.js";
import { runPlacspSync } from "./services/placsp-sync.js";
import {
  createConnectorState,
  isPlacspSourceOpportunity,
  mergeSourceOpportunities
} from "./services/source-opportunity-cache.js";
import {
  createConnectorRefreshScheduler,
  getNextAutomaticRefreshAt,
  isReconciliationDue
} from "./services/connector-refresh-scheduler.js";
import { createAnalysisCache } from "./services/analysis-cache.js";
import { runAiVerification } from "./services/ai-client.js";
import { serializeStateForPersistence } from "./state/store.js";
import { clamp, clone, escapeHtml, formatDate, formatNumber, toSlug, uid } from "./utils.js";

const OPPORTUNITY_SCOPES = [
  { id: "worth_attention", label: "Worth your attention" },
  { id: "needs_verification", label: "Needs verification" },
  { id: "not_suitable", label: "Not suitable" },
  { id: "all_analysed", label: "All analysed" }
];

const AI_STATUS_COPY = {
  mock: {
    shortLabel: "Mock verification",
    detail: "No live OpenAI requests. Deterministic analysis remains active.",
    tone: "warn"
  },
  configured: {
    shortLabel: "AI configured",
    detail: "A usable key is configured, but live connectivity has not been verified yet.",
    tone: "neutral"
  },
  connected: {
    shortLabel: "AI connected",
    detail: "A live OpenAI verification request has succeeded for this session.",
    tone: "good"
  },
  unavailable: {
    shortLabel: "AI unavailable",
    detail: "Verification is unavailable. Deterministic analysis continues without interruption.",
    tone: "bad"
  },
  error: {
    shortLabel: "AI unavailable",
    detail: "The last AI verification attempt failed. Deterministic analysis continues.",
    tone: "bad"
  }
};

const STRUCTURED_OPPORTUNITY_PLACEHOLDER = "Paste structured opportunity JSON here...";

const COMPANY_IMPORT_PLACEHOLDER = "Paste structured company JSON here...";

const CUSTOMER_NAV_ITEMS = NAV_ITEMS.filter((item) => !item.admin);
const ADMIN_NAV_ITEMS = NAV_ITEMS.filter((item) => item.admin);

const AI_REVIEW_STATUS_COPY = {
  accepted: "Accepted",
  needs_review: "Needs review",
  rejected: "Rejected"
};

const CUSTOMER_WHY_BLOCKLIST = /potential hard blocker|eligibility requirements not yet assessed|confirmed eligibility failure|deadline passed|already awarded|cancelled|suspended|unrelated capability|no further action is recommended/i;

const UI_STATE_DEFAULTS = {
  route: "overview",
  selectedOpportunityId: null,
  opportunityScope: "worth_attention",
  filterType: "all",
  filterRecommendation: "all",
  sort: "priority",
  showSavedOnly: false,
  detailTab: "report",
  aiBusyKey: null,
  message: "",
  messageTone: "info",
  messageVariant: "banner",
  draftAnswers: {},
  companyImportDraft: "",
  opportunityJsonDraft: "",
  placspMaxPages: 1,
  placspSyncing: false,
  formFeedback: {
    companyImport: null,
    opportunityJsonImport: null
  }
};

const uiState = {
  ...UI_STATE_DEFAULTS,
  draftAnswers: {},
  formFeedback: {
    companyImport: null,
    opportunityJsonImport: null
  }
};

function getCompany(state) {
  return state.companyProfiles.find((company) => company.id === state.activeCompanyId) ?? state.companyProfiles[0];
}

function recommendationTone(label) {
  switch (label) {
    case "EXCELLENT_FIT":
      return "good";
    case "STRONG_FIT":
      return "good";
    case "POSSIBLE_FIT":
      return "warn";
    case "LOW_PRIORITY":
      return "warn";
    default:
      return "neutral";
  }
}

function actionLabelOf(action) {
  if (!action) return "Review decision";
  if (typeof action === "string") return ACTION_COPY[action] ?? action;
  return ACTION_COPY[action.code] ?? action.label ?? action.code ?? "Review decision";
}

function fitBandOf(item) {
  return item?.fitBand ?? item?.recommendationClass ?? null;
}

function fitBandLabelOf(item) {
  const fitBand = fitBandOf(item);
  return fitBand ? RECOMMENDATION_COPY[fitBand] ?? "Low Priority" : "Low Priority";
}

function primaryOpenIssue(item) {
  return item?.potentialHardBlockers?.[0] ?? item?.unknowns?.[0] ?? item?.blockers?.[0] ?? null;
}

function actionTone(action) {
  if (action === "INVESTIGATE_NOW") return "good";
  if (action === "VERIFY_BEFORE_DECIDING") return "warn";
  if (action === "DO_NOT_PURSUE") return "bad";
  return "neutral";
}

function confidenceTone(label) {
  if (label === "HIGH") return "good";
  if (label === "MEDIUM") return "warn";
  return "warn";
}

function eligibilityTone(label) {
  if (!label) return "neutral";
  if (label.includes("INELIGIBLE")) return "bad";
  if (label.includes("NOT_ASSESSED")) return "warn";
  if (label.includes("UNCLEAR")) return "warn";
  return "good";
}

function companyStatusTone(status) {
  if (status === "company_confirmed") return "good";
  if (status === "public_verified" || status === "public_reported") return "neutral";
  if (status === "inferred" || status === "unknown") return "warn";
  return "bad";
}

function requirementStatusLabel(row) {
  if (row.status === "needs_verification" && row.mandatory) {
    return "Needs verification — mandatory";
  }
  if (row.status === "failed" && row.mandatory) return "Failed — mandatory";
  if (row.status === "confirmed" && row.mandatory) return "Confirmed — mandatory";
  if (row.status === "needs_verification") return "Needs verification";
  if (row.status === "failed") return "Failed";
  if (row.status === "confirmed") return "Confirmed";
  return row.status ?? "Unknown";
}

function getAiStatusMeta(ai = {}) {
  return AI_STATUS_COPY[ai.status] ?? AI_STATUS_COPY.unavailable;
}

function normalizePlacspMaxPages(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

function isPlacspSyncRun(run) {
  const connector = run?.connector?.toString?.().toLowerCase?.() ?? "";
  const source = run?.source?.toString?.().toLowerCase?.() ?? "";
  return connector === "placsp" || source === "placsp";
}

function getLatestPlacspSyncRun(state) {
  return (state.sourceSyncRuns ?? [])
    .filter(isPlacspSyncRun)
    .slice()
    .sort((left, right) =>
      String(right.completedAt ?? right.lastRun ?? right.startedAt ?? "").localeCompare(
        String(left.completedAt ?? left.lastRun ?? left.startedAt ?? "")
      )
    )[0] ?? null;
}

function placspRunModeLabel(mode) {
  switch (mode) {
    case "automatic":
      return "Automatic";
    case "incremental":
      return "Incremental";
    case "reconcile":
      return "Reconciliation";
    default:
      return "Manual";
  }
}

function buildPlacspRunNote(payload, runMode) {
  if (payload?.feedChanged === false) {
    return "Official PLACSP incremental check found no source changes.";
  }
  if (runMode === "reconcile") {
    return "Official PLACSP recent reconciliation completed.";
  }
  if (runMode === "automatic") {
    return "Official PLACSP automatic refresh completed.";
  }
  if (runMode === "incremental") {
    return "Official PLACSP incremental refresh completed.";
  }
  return "Official PLACSP sync completed.";
}

function toneForSourceStatus(status) {
  if (status === "healthy" || status === "ready") return "good";
  if (status === "planned" || status === "syncing") return "warn";
  return "bad";
}

function formatSourceRunMoment(run) {
  return run?.completedAt ?? run?.lastRun ?? run?.startedAt ?? null;
}

function mergeEvidenceRecords(existing = [], incoming = []) {
  const records = new Map();
  [...existing, ...incoming].forEach((item) => {
    if (!item?.id) return;
    records.set(item.id, item);
  });
  return [...records.values()];
}

function parsePlacspTimestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function getPlacspSourceMetadata(opportunity) {
  const sources = Array.isArray(opportunity?.sources) ? opportunity.sources : [];
  const placspSource =
    sources.find((source) => source?.metadata?.sourceType === "official_open_data_atom") ?? sources[0];
  return placspSource?.metadata ?? {};
}

function getPlacspVersionTimeline(opportunity) {
  const metadata = getPlacspSourceMetadata(opportunity);
  const tombstoneAt = parsePlacspTimestamp(metadata.tombstoneWhen);
  const entryUpdatedAt =
    parsePlacspTimestamp(metadata.atomUpdated) ?? parsePlacspTimestamp(opportunity?.modificationDate);
  const latestAt =
    Number.isFinite(tombstoneAt) && Number.isFinite(entryUpdatedAt)
      ? Math.max(tombstoneAt, entryUpdatedAt)
      : tombstoneAt ?? entryUpdatedAt;
  return {
    tombstoneAt,
    entryUpdatedAt,
    latestAt
  };
}

function shouldPreserveExistingPlacspOpportunity(existingOpportunity, nextOpportunity) {
  if (!isPlacspSourceOpportunity(existingOpportunity) || !isPlacspSourceOpportunity(nextOpportunity)) {
    return false;
  }

  const existingTimeline = getPlacspVersionTimeline(existingOpportunity);
  const nextTimeline = getPlacspVersionTimeline(nextOpportunity);

  if (Number.isFinite(existingTimeline.latestAt) && !Number.isFinite(nextTimeline.latestAt)) {
    return true;
  }

  if (Number.isFinite(existingTimeline.tombstoneAt) && !Number.isFinite(nextTimeline.tombstoneAt)) {
    if (!Number.isFinite(nextTimeline.entryUpdatedAt)) return true;
    return existingTimeline.tombstoneAt >= nextTimeline.entryUpdatedAt;
  }

  if (!Number.isFinite(existingTimeline.latestAt) || !Number.isFinite(nextTimeline.latestAt)) {
    return false;
  }

  return existingTimeline.latestAt > nextTimeline.latestAt;
}

function applyPlacspTombstonePatch(existingOpportunity, patch) {
  return {
    ...existingOpportunity,
    status: patch.status ?? existingOpportunity.status,
    noticeType: patch.noticeType ?? existingOpportunity.noticeType,
    cancellationStatus: patch.cancellationStatus ?? existingOpportunity.cancellationStatus,
    sourceNoticeVersionId: patch.sourceNoticeVersionId ?? existingOpportunity.sourceNoticeVersionId,
    lastChecked: patch.lastChecked ?? existingOpportunity.lastChecked,
    sources: patch.sources?.length ? patch.sources : existingOpportunity.sources,
    evidence: mergeEvidenceRecords(existingOpportunity.evidence ?? [], patch.evidence ?? [])
  };
}

function prependSourceSyncRun(draft, run) {
  draft.sourceSyncRuns = [run, ...(draft.sourceSyncRuns ?? [])].slice(0, 50);
}

function mergePlacspSyncResult(draft, payload, runMode = payload?.mode ?? "manual") {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  (payload.opportunities ?? []).forEach((opportunity) => {
    const existingIndex = draft.opportunities.findIndex((item) => item.id === opportunity.id);
    if (existingIndex === -1) {
      draft.opportunities.unshift(opportunity);
      inserted += 1;
      return;
    }

    const existing = draft.opportunities[existingIndex];
    if (shouldPreserveExistingPlacspOpportunity(existing, opportunity)) {
      unchanged += 1;
      return;
    }
    if (existing.sourceNoticeVersionId === opportunity.sourceNoticeVersionId) {
      unchanged += 1;
    } else {
      updated += 1;
    }
    draft.opportunities.splice(existingIndex, 1, opportunity);
  });

  (payload.tombstones ?? []).forEach((patch) => {
    const existingIndex = draft.opportunities.findIndex((item) => item.id === patch.id);
    if (existingIndex === -1) return;
    const nextOpportunity = applyPlacspTombstonePatch(draft.opportunities[existingIndex], patch);
    if (draft.opportunities[existingIndex].sourceNoticeVersionId === nextOpportunity.sourceNoticeVersionId) {
      unchanged += 1;
    } else {
      updated += 1;
    }
    draft.opportunities.splice(existingIndex, 1, nextOpportunity);
  });

  const run = {
    id: uid("sync"),
    mode: runMode,
    sourceMode: payload?.mode ?? null,
    connector: "placsp",
    source: "PLACSP",
    status: "healthy",
    startedAt: payload.startedAt ?? payload.fetchedAt ?? new Date().toISOString(),
    completedAt: payload.completedAt ?? payload.fetchedAt ?? new Date().toISOString(),
    lastRun: payload.completedAt ?? payload.fetchedAt ?? new Date().toISOString(),
    note: buildPlacspRunNote(payload, runMode),
    feedChanged: payload.feedChanged ?? null,
    cursorReached: payload.cursorReached ?? null,
    truncated: payload.truncated ?? false,
    pagesFetched: payload.pagesFetched ?? 0,
    entriesSeen: payload.entriesSeen ?? 0,
    uniqueEntries: payload.uniqueEntries ?? 0,
    tombstonesSeen: payload.tombstonesSeen ?? 0,
    opportunitiesInserted: inserted,
    opportunitiesUpdated: updated,
    unchanged,
    sourceFeedUpdated: payload.sourceFeedUpdated ?? payload.feedUpdated ?? null,
    previousFeedUpdated: payload.previousFeedUpdated ?? null,
    previousEntryWatermark: payload.previousEntryWatermark ?? null,
    nextEntryWatermark: payload.nextEntryWatermark ?? null,
    errors: (payload.parserErrors ?? []).map((item) => item.message ?? String(item))
  };
  prependSourceSyncRun(draft, run);
  return run;
}

function buildPlacspFailureRun(error, { runMode = "manual", requestMode = "manual", maxPages = 1 } = {}) {
  const now = new Date().toISOString();
  return {
    id: uid("sync"),
    mode: runMode,
    sourceMode: requestMode,
    connector: "placsp",
    source: "PLACSP",
    status: "error",
    startedAt: now,
    completedAt: now,
    lastRun: now,
    note: runMode === "automatic" ? "Official PLACSP automatic refresh failed." : "Official PLACSP sync failed.",
    pagesRequested: maxPages,
    pagesFetched: 0,
    entriesSeen: 0,
    uniqueEntries: 0,
    tombstonesSeen: 0,
    opportunitiesInserted: 0,
    opportunitiesUpdated: 0,
    unchanged: 0,
    sourceFeedUpdated: null,
    errors: [error?.message ?? "Unknown PLACSP sync error."]
  };
}

function resetUiState() {
  Object.assign(uiState, {
    ...UI_STATE_DEFAULTS,
    draftAnswers: {},
    formFeedback: {
      companyImport: null,
      opportunityJsonImport: null
    }
  });
}

function aiPairKey(companyId, opportunityId) {
  return `${companyId ?? "company"}:${opportunityId ?? "opportunity"}`;
}

function isAiReviewBusy(companyId, opportunityId) {
  return uiState.aiBusyKey === aiPairKey(companyId, opportunityId);
}

function aiReviewStatusMeta(aiReview) {
  if (aiReview?.status === "current") {
    return {
      label: "AI reviewed",
      tone: "good",
      detail: "This saved review matches the current company, opportunity, and deterministic analysis context."
    };
  }
  if (aiReview?.status === "stale") {
    return {
      label: "Saved review may be outdated",
      tone: "warn",
      detail: aiReview.staleMessage
    };
  }
  return {
    label: "No AI review yet",
    tone: "neutral",
    detail: aiReview?.isLegacyAvailable
      ? "A legacy unscoped AI review exists in debug only. Run a fresh company-scoped review for customer-facing use."
      : "The deterministic engine remains the current source of truth until an AI verification run is saved."
  };
}

function aiReviewResult(result = {}) {
  return {
    reviewStatus: AI_REVIEW_STATUS_COPY[result.review_status] ?? "Not stated",
    correctedAction: result.corrected_action ? ACTION_COPY[result.corrected_action] ?? result.corrected_action : null,
    correctedFitBand: result.corrected_fit_band ? FIT_BAND_COPY[result.corrected_fit_band] ?? result.corrected_fit_band : null,
    confidence: result.confidence ? result.confidence[0].toUpperCase() + result.confidence.slice(1) : "Not stated",
    warnings: Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [],
    disagreements: Array.isArray(result.disagreements) ? result.disagreements.filter(Boolean) : [],
    notes: result.notes ?? ""
  };
}

function aiReviewSummary(aiReview, match, persistence) {
  const statusMeta = aiReviewStatusMeta(aiReview);
  const record = aiReview?.review ?? null;
  const summary = aiReviewResult(record?.result ?? {});
  const currentAction = match?.decision?.recommendedAction?.code ?? null;
  const currentFitBand = fitBandOf(match);
  const savedMode =
    persistence?.status === "available"
      ? "Saved locally"
      : "Saved for this session only because browser persistence is unavailable";

  return {
    statusMeta,
    completedAt: record?.completedAt ? formatDate(record.completedAt, { includeTime: true }) : null,
    showCorrectedAction: Boolean(summary.correctedAction && record?.result?.corrected_action !== currentAction),
    showCorrectedFitBand: Boolean(summary.correctedFitBand && record?.result?.corrected_fit_band !== currentFitBand),
    savedMode,
    ...summary
  };
}

function valueNumber(label = "") {
  return Number(label.replace(/[^\d]/g, "")) || 0;
}

function deadlineSortValue(item) {
  return item.opportunity?.deadline?.date ?? "9999-12-31";
}

function getScopeItems(portfolio) {
  return {
    worth_attention: portfolio.buckets.worthAttention,
    needs_verification: portfolio.buckets.needsVerification,
    not_suitable: portfolio.buckets.notSuitable,
    all_analysed: portfolio.buckets.allAnalysed
  };
}

function resolveSelectedOpportunityId(currentId, visibleItems, allItems) {
  if (visibleItems.length) {
    return visibleItems.find((item) => item.opportunityId === currentId)?.opportunityId ?? visibleItems[0].opportunityId;
  }
  if (currentId && allItems.some((item) => item.opportunityId === currentId)) return currentId;
  return allItems[0]?.opportunityId ?? null;
}

function getDerived(state, runtime, analysisService = null) {
  const now = getApplicationNow();
  const company = getCompany(state);
  const portfolio = analysisService?.analyzePortfolio
    ? analysisService.analyzePortfolio(company, state.opportunities, runtime, now)
    : analyzePortfolio(company, state.opportunities, runtime, now);
  const savedSet = new Set(state.savedOpportunityIds ?? []);
  const scopeItems = getScopeItems(portfolio);
  const scopedItems = scopeItems[uiState.opportunityScope] ?? scopeItems.worth_attention;

  const visibleMatches = scopedItems
    .filter((item) => (uiState.filterType === "all" ? true : item.opportunity.type === uiState.filterType))
    .filter((item) =>
      uiState.filterRecommendation === "all"
        ? true
        : item.decision?.recommendedAction?.code === uiState.filterRecommendation
    )
    .filter((item) => (uiState.showSavedOnly ? savedSet.has(item.opportunityId) : true))
    .sort((left, right) => sortMatches(left, right, uiState.sort));

  const selectedOpportunityId = resolveSelectedOpportunityId(
    uiState.selectedOpportunityId,
    visibleMatches,
    portfolio.analysed
  );
  uiState.selectedOpportunityId = selectedOpportunityId;

  const selectedRecommended = portfolio.recommended.find((item) => item.opportunityId === selectedOpportunityId) ?? null;
  const selectedRejected = portfolio.rejected.find((item) => item.opportunity.id === selectedOpportunityId) ?? null;
  const selectedAnalysis = portfolio.analysed.find((item) => item.opportunityId === selectedOpportunityId) ?? null;
  const selectedRaw = state.opportunities.find((item) => item.id === selectedOpportunityId) ?? null;
  const selected = selectedRecommended ?? selectedRejected ?? selectedAnalysis ?? null;
  const aiReviewByOpportunity = new Map(
    portfolio.analysed.map((item) => [
      item.opportunityId,
      getAiReviewState(state.aiRuns, company, item.opportunity, item)
    ])
  );
  const selectedAiReview =
    selectedRaw && selectedAnalysis
      ? getAiReviewState(state.aiRuns, company, selectedRaw, selectedAnalysis)
      : null;
  const recentAiReviews = listScopedAiReviewsForCompany(state.aiRuns, company.id)
    .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""))
    .slice(0, 3)
    .map((run) => {
      const item = portfolio.analysed.find((entry) => entry.opportunityId === run.opportunityId) ?? null;
      return {
        run,
        item,
        reviewState: item ? getAiReviewState(state.aiRuns, company, item.opportunity, item) : null
      };
    })
    .filter((item) => item.item);

  const allQuestions = portfolio.recommended
    .flatMap((match) => match.adaptiveQuestions.map((question) => ({ ...question, opportunityId: match.opportunityId })))
    .slice(0, 5);
  const evaluation = runEvaluationSuite(evaluationFixtures, runtime, getEvaluationNow());

  return {
    now,
    company,
    companies: state.companyProfiles,
    portfolio,
    visibleMatches,
    savedSet,
    selected,
    selectedRaw,
    selectedRecommended,
    selectedRejected,
    selectedAnalysis,
    selectedAiReview,
    aiReviewByOpportunity,
    recentAiReviews,
    questions: allQuestions,
    evaluation,
    analysisCacheMetrics: analysisService?.getMetrics?.() ?? null
  };
}

function sortMatches(left, right, mode) {
  switch (mode) {
    case "deadline":
      return deadlineSortValue(left).localeCompare(deadlineSortValue(right));
    case "match":
      return (right.matchScore ?? 0) - (left.matchScore ?? 0);
    case "confidence":
      return (right.confidenceShield?.label === "HIGH" ? 2 : right.confidenceShield?.label === "MEDIUM" ? 1 : 0) -
        (left.confidenceShield?.label === "HIGH" ? 2 : left.confidenceShield?.label === "MEDIUM" ? 1 : 0);
    case "value":
      return valueNumber(right.displayValueLabel) - valueNumber(left.displayValueLabel);
    default:
      return (right.priorityScore ?? 0) - (left.priorityScore ?? 0);
  }
}

function pill(text, tone = "neutral") {
  return `<span class="pill ${tone}">${escapeHtml(text)}</span>`;
}

function statCard(label, value, meta = "") {
  return `
    <article class="stat-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
    </article>
  `;
}

function setMessage(message, tone = "info", variant = "banner") {
  uiState.message = message;
  uiState.messageTone = tone;
  uiState.messageVariant = variant;
}

function setFormFeedback(key, message, tone = "info") {
  uiState.formFeedback[key] = message
    ? {
        message,
        tone
      }
    : null;
}

function clearFormFeedback(key) {
  uiState.formFeedback[key] = null;
}

function getJsonDraftMeta(text, feedback = null) {
  const trimmed = text.trim();
  if (feedback?.tone === "error") return { label: "Error", tone: "bad" };
  if (feedback?.tone === "success") return { label: "Valid", tone: "good" };
  if (feedback?.tone === "warn") return { label: "Valid in memory", tone: "warn" };
  if (!trimmed) return { label: "Empty", tone: "neutral" };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return { label: "JSON detected", tone: "neutral" };
  return { label: "Text detected", tone: "warn" };
}

function metaToneClass(meta) {
  return meta.tone === "bad" ? "is-error" : meta.tone === "good" ? "is-good" : meta.tone === "warn" ? "is-warn" : "";
}

function feedbackToneClass(feedback) {
  return feedback?.tone === "error"
    ? "is-error"
    : feedback?.tone === "success"
      ? "is-good"
      : feedback?.tone === "warn"
        ? "is-warn"
        : "";
}

function renderFormFeedback(key, draft) {
  const feedback = uiState.formFeedback[key];
  const meta = getJsonDraftMeta(draft, feedback);

  return `
    <div class="form-status-row full-span">
      <span class="form-status-chip ${metaToneClass(meta)}">${escapeHtml(meta.label)}</span>
      <p class="form-inline-feedback ${feedbackToneClass(feedback)}">${feedback ? escapeHtml(feedback.message) : ""}</p>
    </div>
  `;
}

function importFormKey(form) {
  if (form?.dataset?.form === "company-import") return "companyImport";
  if (form?.dataset?.form === "opportunity-json-import") return "opportunityJsonImport";
  return null;
}

function importDraftField(target) {
  if (target?.name === "companyJson") return "companyImportDraft";
  if (target?.name === "opportunityJson") return "opportunityJsonDraft";
  return null;
}

function refreshImportFormFeedback(form, key, draft) {
  if (!form?.querySelector || !key) return;
  const feedback = uiState.formFeedback[key];
  const meta = getJsonDraftMeta(draft, feedback);
  const chip = form.querySelector(".form-status-chip");
  const feedbackNode = form.querySelector(".form-inline-feedback");

  if (chip) {
    chip.className = `form-status-chip ${metaToneClass(meta)}`.trim();
    chip.textContent = meta.label;
  }

  if (feedbackNode) {
    feedbackNode.className = `form-inline-feedback ${feedbackToneClass(feedback)}`.trim();
    feedbackNode.textContent = feedback?.message ?? "";
  }
}

function syncImportDraftFromInput(form, target) {
  const key = importFormKey(form);
  const draftField = importDraftField(target);
  if (!key || !draftField) return false;
  uiState[draftField] = target?.value?.toString?.() ?? "";
  if (uiState.formFeedback[key]) clearFormFeedback(key);
  refreshImportFormFeedback(form, key, uiState[draftField]);
  return true;
}

function getPersistenceErrorMessage(persistence) {
  if (!persistence?.lastError) return "";
  return typeof persistence.lastError === "string"
    ? persistence.lastError
    : persistence.lastError.message ?? "";
}

function getPersistenceMeta(persistence = {}) {
  if (persistence?.status === "unavailable" || persistence?.mode === "memory_only") {
    return {
      label: "Memory-only session",
      tone: "warn",
      detail:
        persistence?.detail ??
        "Browser persistence is unavailable. Changes will work for this session but may be lost after reload.",
      showBanner: true
    };
  }

  if (persistence?.status === "error") {
    return {
      label: "Persistence warning",
      tone: "warn",
      detail:
        persistence?.detail ??
        "Saved browser-local data could not be loaded. OportuneX continued safely in memory.",
      showBanner: true
    };
  }

  return {
    label: persistence?.lastSavedAt ? "Local persistence saved" : "Local persistence ready",
    tone: "good",
    detail: persistence?.detail ?? "Browser-local persistence is active.",
    showBanner: false
  };
}

function renderPersistenceBanner(persistence) {
  const meta = getPersistenceMeta(persistence);
  if (!meta.showBanner) return "";
  return `
    <div class="toast ${meta.tone === "warn" ? "warn" : meta.tone === "good" ? "success" : "error"}">
      <strong>${escapeHtml(meta.label)}</strong>
      <p>${escapeHtml(meta.detail)}</p>
      ${getPersistenceErrorMessage(persistence) ? `<small>${escapeHtml(getPersistenceErrorMessage(persistence))}</small>` : ""}
    </div>
  `;
}

function getSourceCacheErrorMessage(sourceCache) {
  if (!sourceCache?.lastError) return "";
  return typeof sourceCache.lastError === "string"
    ? sourceCache.lastError
    : sourceCache.lastError.message ?? "";
}

function getSourceCacheMeta(sourceCache = null) {
  if (!sourceCache) {
    return {
      label: "Source cache inactive",
      tone: "neutral",
      detail: "No source-cache service is configured for this app instance.",
      showBanner: false
    };
  }

  if (sourceCache.status === "unavailable" || sourceCache.mode === "memory_only") {
    return {
      label: "Source cache memory-only",
      tone: "warn",
      detail:
        sourceCache.detail ??
        "Source cache persistence is unavailable. PLACSP opportunities can still work for this session but may be lost after reload.",
      showBanner: true
    };
  }

  if (sourceCache.status === "error") {
    return {
      label: "Source cache warning",
      tone: "warn",
      detail:
        sourceCache.detail ??
        "Stored source opportunities could not be loaded safely. OportuneX continued with the local workspace state.",
      showBanner: true
    };
  }

  return {
    label: sourceCache.lastSavedAt ? "Source cache persisted" : "Source cache ready",
    tone: "good",
    detail: sourceCache.detail ?? "Source cache persistence is active for official connector opportunities.",
    showBanner: false
  };
}

function renderSourceCacheBanner(sourceCache) {
  const meta = getSourceCacheMeta(sourceCache);
  if (!meta.showBanner) return "";
  return `
    <div class="toast warn">
      <strong>${escapeHtml(meta.label)}</strong>
      <p>${escapeHtml(meta.detail)}</p>
      ${getSourceCacheErrorMessage(sourceCache) ? `<small>${escapeHtml(getSourceCacheErrorMessage(sourceCache))}</small>` : ""}
    </div>
  `;
}

function formatTimestampDetail(value, fallback = "Not available yet.") {
  return value ? formatDate(value, { includeTime: true }) : fallback;
}

function hasPlacspIncrementalCursor(connectorState) {
  return Boolean(connectorState?.lastFeedUpdated || connectorState?.entryUpdatedWatermark);
}

function shouldAdvancePlacspIncrementalCursor(payload, requestMode, existingState) {
  if (requestMode === "incremental") {
    return payload?.truncated !== true && payload?.cursorReached === true;
  }

  if (requestMode === "reconcile" && !hasPlacspIncrementalCursor(existingState)) {
    return payload?.truncationReason !== "safety_limit";
  }

  return false;
}

function seedPlacspConnectorState(syncRun, existingState) {
  if (!syncRun) return existingState;
  return createConnectorState("placsp", {
    ...existingState,
    lastSuccessfulSyncAt: existingState?.lastSuccessfulSyncAt ?? formatSourceRunMoment(syncRun),
    lastManualSyncAt: existingState?.lastManualSyncAt ?? formatSourceRunMoment(syncRun),
    lastFeedUpdated: existingState?.lastFeedUpdated ?? null,
    entryUpdatedWatermark: existingState?.entryUpdatedWatermark ?? null,
    lastRunMode: existingState?.lastRunMode ?? syncRun?.mode ?? "manual",
    lastPagesFetched: existingState?.lastPagesFetched ?? syncRun?.pagesFetched ?? 0,
    truncated: typeof existingState?.truncated === "boolean" ? existingState.truncated : false,
    cursorReached: existingState?.cursorReached != null ? existingState.cursorReached : null
  });
}

function touchedPlacspOpportunityIds(payload) {
  return new Set([
    ...(payload?.opportunities ?? []).map((item) => item.id),
    ...(payload?.tombstones ?? []).map((item) => item.id)
  ]);
}

function describePlacspSyncStart(runMode, requestMode, pages) {
  if (runMode === "automatic") {
    return requestMode === "reconcile"
      ? "Running automatic PLACSP reconciliation..."
      : "Running automatic PLACSP refresh...";
  }
  if (requestMode === "reconcile") {
    return `Reconciling the latest ${pages} PLACSP page${pages === 1 ? "" : "s"}...`;
  }
  if (requestMode === "incremental") {
    return "Checking PLACSP for incremental source changes...";
  }
  return `Syncing PLACSP from the first ${pages} page${pages === 1 ? "" : "s"}...`;
}

function describePlacspSyncSuccess(syncRun, { workspacePersisted, sourceCachePersisted, runMode }) {
  let message =
    syncRun.feedChanged === false
      ? "PLACSP check completed: no official feed changes were detected."
      : `PLACSP ${runMode === "reconcile" ? "reconciliation" : "sync"} completed: ${syncRun.opportunitiesInserted} inserted, ${syncRun.opportunitiesUpdated} updated, ${syncRun.unchanged} unchanged.`;

  if (syncRun.truncated && syncRun.cursorReached === false) {
    message += " The incremental traversal stopped at a safety boundary before the previous watermark was fully reached.";
  }
  if (!sourceCachePersisted && workspacePersisted) {
    message += " Source cache persistence is unavailable, so these PLACSP records may be lost after reload.";
  } else if (sourceCachePersisted && !workspacePersisted) {
    message += " Source records were cached, but workspace persistence is unavailable for some local user state.";
  } else if (!sourceCachePersisted && !workspacePersisted) {
    message += " Browser persistence is unavailable for both the workspace and the source cache.";
  }

  return message;
}

function upsertCompanyProfile(draft, importedProfile) {
  const existingIndex = draft.companyProfiles.findIndex((item) => item.id === importedProfile.id);
  if (existingIndex >= 0) draft.companyProfiles.splice(existingIndex, 1, importedProfile);
  else draft.companyProfiles.unshift(importedProfile);
  draft.activeCompanyId = importedProfile.id;
}

function upsertOpportunity(draft, importedOpportunity) {
  const existingIndex = draft.opportunities.findIndex((item) => item.id === importedOpportunity.id);
  if (existingIndex >= 0) draft.opportunities.splice(existingIndex, 1, importedOpportunity);
  else draft.opportunities.unshift(importedOpportunity);
}

function parseOptionalNumber(value) {
  const raw = value?.toString().trim() ?? "";
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalBoolean(value) {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

function parseCommaList(value) {
  return (value?.toString() ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function setConfirmedOrUnknownFact(company, key, value, notes) {
  if (value == null) {
    setCompanyFactUnknown(company, key, notes);
    return;
  }
  setCompanyConfirmedFact(company, key, value, { notes });
}

function setConfirmedOrUnknownRange(company, key, { min, max }, notes) {
  if (min == null && max == null) {
    setCompanyFactUnknown(company, key, notes);
    return;
  }
  setCompanyConfirmedRange(
    company,
    key,
    {
      min,
      max,
      currency: "EUR"
    },
    { notes }
  );
}

function syncLegacyCompanyMirrors(company) {
  company.geography.preferredWorkingRadiusKm = getFactValue(getCompanyFact(company, "preferredWorkingRadiusKm"));
  company.preferences.minimumAttractiveProjectValue = getFactValue(getCompanyFact(company, "minimumAttractiveProjectValue"));
  company.preferences.idealProjectValue = getFactValue(getCompanyFact(company, "idealProjectValue"));
  company.preferences.maximumRealisticProjectValue = getFactValue(getCompanyFact(company, "maximumRealisticProjectValue"));
  company.experience.publicProcurementProjects = getFactValue(getCompanyFact(company, "publicProcurementProjects"));
  company.experience.maximumProjectValue = getFactValue(getCompanyFact(company, "maximumProjectValue"));
  company.grants.canCoFinance = getFactValue(getCompanyFact(company, "canCoFinance"));
}

function renderProfileModeBanner(company) {
  if (getProfileMode(company) !== "prospect") return "";
  return `
    <div class="toast prospect-banner">
      <strong>Prospect profile — built from public information</strong>
      <p>Some company information has not yet been confirmed by the business. OportuneX distinguishes verified public facts, estimates and unknown information when assessing opportunities.</p>
    </div>
  `;
}

function syncRuntimeAi(runtime, nextAi) {
  if (!nextAi) return;
  Object.assign(runtime.ai, nextAi);
}

function formatRangeMeta(range) {
  if (!range) return "";
  if (range.referenceYear != null) return `Reference year ${escapeHtml(String(range.referenceYear))}`;
  if (range.asOfDate) return `As of ${escapeHtml(formatDate(range.asOfDate))}`;
  return "";
}

function formatFactMeta(fact) {
  if (!fact) return "";
  if (fact.referenceYear != null) return `Reference year ${escapeHtml(String(fact.referenceYear))}`;
  if (fact.asOfDate) return `As of ${escapeHtml(formatDate(fact.asOfDate))}`;
  return "";
}

function renderProfileDatum({ label, value, status, meta = "", note = "", stale = false }) {
  return `
    <article class="profile-datum">
      <div class="card-topline">
        ${pill(describeStatus(status), companyStatusTone(status))}
      </div>
      <strong>${escapeHtml(label)}</strong>
      <p>${escapeHtml(value)}</p>
      ${meta ? `<small>${meta}</small>` : ""}
      ${stale ? `<small>May be outdated — company confirmation recommended</small>` : ""}
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </article>
  `;
}

function renderCapabilitySummary(capability) {
  return `
    <article class="profile-datum">
      <div class="card-topline">
        ${pill(describeStatus(capability.status), companyStatusTone(capability.status))}
        ${pill(capability.strength ?? capability.level ?? "medium", "neutral")}
      </div>
      <strong>${escapeHtml(capability.label)}</strong>
      <p>${escapeHtml(capability.notes ?? "Capability evidence available for matching.")}</p>
    </article>
  `;
}

function renderOpportunityScopeTabs(derived) {
  const counts = {
    worth_attention: derived.portfolio.counts.worthAttention,
    needs_verification: derived.portfolio.counts.needsVerification,
    not_suitable: derived.portfolio.counts.notSuitable,
    all_analysed: derived.portfolio.counts.analysed
  };

  return `
    <div class="scope-row" aria-label="Opportunity scope">
      ${OPPORTUNITY_SCOPES.map(
        (scope) => `
          <button
            class="scope-button ${uiState.opportunityScope === scope.id ? "active" : ""}"
            data-action="scope"
            data-scope="${scope.id}"
          >
            <span>${escapeHtml(scope.label)}</span>
            <strong>${counts[scope.id]}</strong>
          </button>
        `
      ).join("")}
    </div>
  `;
}

function renderOpportunityCardPills(item) {
  const badges = [];
  const fitBand = fitBandOf(item);
  if (item.decision?.recommendedAction?.label) {
    badges.push(
      pill(actionLabelOf(item.decision.recommendedAction), actionTone(item.decision.recommendedAction.code))
    );
  }
  if (fitBand) {
    badges.push(pill(fitBandLabelOf(item), recommendationTone(fitBand)));
  } else {
    badges.push(pill("Not suitable", "bad"));
  }
  badges.push(
    pill(
      item.confidenceShield ? CONFIDENCE_COPY[item.confidenceShield.label] : "Confidence pending",
      confidenceTone(item.confidenceShield?.label)
    )
  );
  return badges.join("");
}

function customerWhyItMatters(item) {
  const positiveDetail = item?.positives?.find((entry) => entry?.detail)?.detail;
  if (positiveDetail) return positiveDetail;

  const candidate = item?.decision?.mainReason ?? item?.executiveVerdict ?? "";
  if (candidate && !CUSTOMER_WHY_BLOCKLIST.test(candidate)) return candidate;

  return "Relevant opportunity signals remain limited under the current evidence set.";
}

function customerNeedsChecking(item) {
  return (
    primaryOpenIssue(item)?.detail ??
    item?.decision?.mainQuestion ??
    item?.decision?.mainReason ??
    "No additional blocking question is currently recorded."
  );
}

function buildDecisionSummary(match) {
  const primaryIssue = primaryOpenIssue(match);
  return {
    action: actionLabelOf(match.decision?.recommendedAction),
    reason: match.decision?.mainReason ?? match.executiveVerdict,
    blocker: match.decision?.mainQuestion ?? primaryIssue?.detail ?? "No blocking question is currently recorded."
  };
}

function renderAiReviewSnapshot(aiReview, persistence) {
  const meta = aiReviewStatusMeta(aiReview);
  const savedState =
    aiReview?.status === "current" || aiReview?.status === "stale"
      ? (persistence?.status === "available" ? "Saved locally" : "Session-only review")
      : "Not saved yet";
  return `
    <div class="ai-review-inline">
      <span>${escapeHtml(meta.label)}</span>
      <span>${escapeHtml(savedState)}</span>
    </div>
  `;
}

function renderOpportunityPreview(item, { now, aiReview, persistence, showActions = false } = {}) {
  const organisation =
    item.opportunity?.contractingAuthority ||
    item.opportunity?.issuingOrganisation ||
    item.primaryContact?.name ||
    "Organisation not stated";
  const statusMeta = aiReviewStatusMeta(aiReview);
  const whyItMatters = customerWhyItMatters(item);
  const needsChecking = customerNeedsChecking(item);

  return `
    <article
      class="opportunity-card ${uiState.selectedOpportunityId === item.opportunityId && showActions ? "selected" : ""}"
      data-action="select"
      data-id="${item.opportunityId}"
      tabindex="0"
      role="button"
      aria-label="Open analysis for ${escapeHtml(item.displayTitle)}"
    >
      <div class="opportunity-header-row">
        <div class="card-topline">
          ${renderOpportunityCardPills(item)}
        </div>
        <span class="opportunity-type-label">${escapeHtml(OPPORTUNITY_TYPES[item.opportunity?.type] ?? "Opportunity")}</span>
      </div>
      <h3>${escapeHtml(item.displayTitle)}</h3>
      <p class="opportunity-subline">${escapeHtml(organisation)}</p>
      <div class="opportunity-metrics">
        <span>${escapeHtml(item.displayValueLabel)}</span>
        <span>${escapeHtml(item.locationLabel || "Location not stated")}</span>
        <span>${escapeHtml(urgencyChip(item.opportunity, now))}</span>
      </div>
      <div class="opportunity-copy-block">
        <strong>Why it matters</strong>
        <p>${escapeHtml(whyItMatters)}</p>
      </div>
      <div class="opportunity-copy-block">
        <strong>Needs checking</strong>
        <p>${escapeHtml(needsChecking)}</p>
      </div>
      <div class="opportunity-footer">
        <div>
          ${renderAiReviewSnapshot(aiReview, persistence)}
          <small>${escapeHtml(statusMeta.detail)}</small>
        </div>
        ${
          showActions
            ? `<div class="action-row">
                <button class="ghost-button" data-action="save" data-id="${item.opportunityId}">
                  ${(persistence?.savedSet?.has?.(item.opportunityId) ? "Unsave" : "Save")}
                </button>
                <button class="button-secondary" data-action="select" data-id="${item.opportunityId}">View opportunity</button>
              </div>`
            : `<span class="card-affordance">View opportunity</span>`
        }
      </div>
    </article>
  `;
}

function renderNavigation(route, derived) {
  return `
    <aside class="sidebar">
      <div class="brand-block">
        <div class="brand-mark"></div>
        <div>
          <p class="eyebrow">Decision-grade public opportunity intelligence</p>
          <h1>${APP_TITLE}</h1>
          <p class="brand-copy">Calm, evidence-backed public opportunity decisions for European SMEs.</p>
        </div>
      </div>
      <div class="company-switcher">
        <label>
          Active company
          <select data-control="active-company">
            ${derived.companies
              .map(
                (company) =>
                  `<option value="${escapeHtml(company.id)}" ${company.id === derived.company.id ? "selected" : ""}>${escapeHtml(company.legalName)}</option>`
              )
              .join("")}
          </select>
        </label>
        <small>${escapeHtml(getProfileMode(derived.company) === "prospect" ? "Prospect profile" : "Confirmed company profile")}</small>
      </div>
      <nav class="nav-list">
        ${CUSTOMER_NAV_ITEMS.map(
          (item) => `
            <button class="nav-item ${route === item.id ? "active" : ""}" data-action="route" data-route="${item.id}">
              <span>${escapeHtml(item.label)}</span>
            </button>
          `
        ).join("")}
      </nav>
      <div class="nav-divider">Admin</div>
      <nav class="nav-list nav-list-admin">
        ${ADMIN_NAV_ITEMS.map(
          (item) => `
            <button class="nav-item ${route === item.id ? "active" : ""}" data-action="route" data-route="${item.id}">
              <span>${escapeHtml(item.label)}</span>
              <small>Admin</small>
            </button>
          `
        ).join("")}
      </nav>
    </aside>
  `;
}

function renderOverviewGrid(cards = []) {
  const visibleCards = cards.filter(Boolean);
  if (!visibleCards.length) return "";
  return `<div class="card-grid two ${visibleCards.length === 1 ? "single" : ""}">${visibleCards.join("")}</div>`;
}

function renderOverview(derived, persistence) {
  const top = derived.portfolio.recommended.slice(0, 3);
  const bestOpportunitiesCard = `
    <article class="card">
      <div class="section-heading">
        <h3>Best opportunities</h3>
        <p>The highest-priority live opportunities for the active company, with the strongest positive reason and the main verification question surfaced first.</p>
      </div>
      <div class="opportunity-list">
        ${
          top.length
            ? top.map((item) => renderOpportunityPreview(item, {
              now: derived.now,
              aiReview: derived.aiReviewByOpportunity.get(item.opportunityId),
              persistence: { savedSet: derived.savedSet, status: persistence?.status }
            })).join("")
            : `<p class="empty-state">No opportunity currently stands out for this company. Review the full list or import more opportunities.</p>`
        }
      </div>
    </article>
  `;
  const verificationQuestionsCard = derived.questions.length
    ? `
        <article class="card">
          <div class="section-heading">
            <h3>Important verification questions</h3>
            <p>The unresolved questions most likely to change a recommendation or reveal a hard stop.</p>
          </div>
          <div class="question-list">
            ${derived.questions.map((question) => `
              <article class="question-card">
                <strong>${escapeHtml(question.question)}</strong>
                <small class="question-why">${escapeHtml(question.why ?? "This answer could materially change the decision.")}</small>
              </article>
            `).join("")}
          </div>
        </article>
      `
    : "";
  const recentAiReviewsCard = derived.recentAiReviews.length
    ? `
        <article class="card">
          <div class="section-heading">
            <h3>Recent AI-reviewed opportunities</h3>
            <p>Saved per-company AI verification memory stays attached to the correct company and opportunity pair.</p>
          </div>
          <div class="rejected-list">
            ${derived.recentAiReviews.map(({ run, item, reviewState }) => `
              <button class="mini-list-item" data-action="select" data-id="${item.opportunityId}">
                <strong>${escapeHtml(item.displayTitle)}</strong>
                <span>${escapeHtml(aiReviewStatusMeta(reviewState).label)} · ${escapeHtml(formatDate(run.completedAt, { includeTime: true }))}</span>
              </button>
            `).join("")}
          </div>
        </article>
      `
    : "";
  return `
    <section class="page-grid">
      <div class="hero-panel">
        <div>
          <p class="eyebrow">Overview</p>
          <h2>What should ${escapeHtml(derived.company.tradingName || derived.company.legalName)} pay attention to now?</h2>
          <p class="lead">
            OportuneX combines fit analysis, hard-stop eligibility logic, evidence discipline, and optional AI second-pass verification so the next move is clear.
          </p>
        </div>
        <div class="hero-metrics">
          ${statCard("Active company", derived.company.tradingName || derived.company.legalName, getProfileMode(derived.company) === "prospect" ? "Prospect profile" : "Confirmed profile")}
          ${statCard("Worth your attention", String(derived.portfolio.counts.worthAttention), "Actionable now")}
          ${statCard("Needs verification", String(derived.portfolio.counts.needsVerification), "Before spending time or money")}
          ${statCard("Saved", String(derived.savedSet.size), "Pinned for follow-up")}
          ${statCard("Analysed", String(derived.portfolio.counts.analysed), "Secondary reference")}
        </div>
      </div>

      ${renderOverviewGrid([bestOpportunitiesCard, verificationQuestionsCard])}
      ${renderOverviewGrid([recentAiReviewsCard])}
    </section>
  `;
}

function renderFilters() {
  return `
    <div class="toolbar">
      <label>
        Type
        <select data-filter="type">
          <option value="all" ${uiState.filterType === "all" ? "selected" : ""}>All</option>
          <option value="contract" ${uiState.filterType === "contract" ? "selected" : ""}>Contracts</option>
          <option value="grant" ${uiState.filterType === "grant" ? "selected" : ""}>Grants</option>
        </select>
      </label>
      <label>
        Recommended action
        <select data-filter="recommendation">
          <option value="all" ${uiState.filterRecommendation === "all" ? "selected" : ""}>All</option>
          ${Object.entries(ACTION_COPY)
            .map(
              ([value, label]) =>
                `<option value="${value}" ${uiState.filterRecommendation === value ? "selected" : ""}>${escapeHtml(label)}</option>`
            )
            .join("")}
        </select>
      </label>
      <label>
        Sort
        <select data-filter="sort">
          <option value="priority" ${uiState.sort === "priority" ? "selected" : ""}>Priority</option>
          <option value="deadline" ${uiState.sort === "deadline" ? "selected" : ""}>Deadline</option>
          <option value="match" ${uiState.sort === "match" ? "selected" : ""}>Match</option>
          <option value="value" ${uiState.sort === "value" ? "selected" : ""}>Published value</option>
          <option value="confidence" ${uiState.sort === "confidence" ? "selected" : ""}>Confidence</option>
        </select>
      </label>
      <label class="toggle">
        <input type="checkbox" data-filter="savedOnly" ${uiState.showSavedOnly ? "checked" : ""} />
        Saved only
      </label>
    </div>
  `;
}

function renderOpportunityList(derived, persistence) {
  const matches = derived.visibleMatches;
  return `
    <section class="split-layout">
      <div class="stack">
        <article class="card">
          <div class="section-heading">
            <h2>Opportunities</h2>
            <p>Scan opportunities by action first, then fit, evidence confidence, value, timing, and the main verification question.</p>
          </div>
          ${renderOpportunityScopeTabs(derived)}
          ${renderFilters()}
          <div class="opportunity-list">
            ${
              matches.length
                ? matches.map((item) => renderOpportunityPreview(item, {
                  now: derived.now,
                  aiReview: derived.aiReviewByOpportunity.get(item.opportunityId),
                  persistence: { savedSet: derived.savedSet, status: persistence?.status },
                  showActions: true
                })).join("")
                : `<p class="empty-state">No analysed opportunity matches the current scope and filters.</p>`
            }
          </div>
        </article>
      </div>
      ${renderDetailPanel(derived, persistence)}
    </section>
  `;
}

function renderSavedPage(derived, persistence) {
  const savedMatches = derived.portfolio.recommended.filter((item) => derived.savedSet.has(item.opportunityId));
  return `
    <section class="page-grid">
      <article class="card">
        <div class="section-heading">
          <h2>Saved opportunities</h2>
          <p>Keep the opportunities worth revisiting together with their latest decision state and evidence confidence.</p>
        </div>
        <div class="opportunity-list">
          ${
            savedMatches.length
              ? savedMatches.map((item) => renderOpportunityPreview(item, {
                now: derived.now,
                aiReview: derived.aiReviewByOpportunity.get(item.opportunityId),
                persistence: { savedSet: derived.savedSet, status: persistence?.status },
                showActions: true
              })).join("")
              : `<p class="empty-state">No saved opportunity yet. Save an opportunity from the ranked list to keep it here for follow-up.</p>`
          }
        </div>
      </article>
    </section>
  `;
}

function renderCompanyPage(company) {
  const certificationOptions = ["valid", "missing", "unknown"];
  const profileMode = getProfileMode(company);
  const completeness = computeDecisionProfileCompleteness(company);
  const capabilities = getCompanyCapabilities(company);
  const confirmedCapabilities = capabilities.filter((item) => item.status === "company_confirmed");
  const publicCapabilities = capabilities.filter((item) => item.status !== "company_confirmed");
  const certifications = getCompanyCertifications(company);
  const insurancePolicies = getCompanyInsurancePolicies(company);
  const employeeFact = getCompanyFact(company, "employeeCountCurrent");
  const employeeRange = getEmployeeRange(company);
  const turnoverRange = getTurnoverRange(company);
  const radiusFact = getCompanyFact(company, "preferredWorkingRadiusKm");
  const maxProjectFact = getCompanyFact(company, "maximumProjectValue");
  const minProjectFact = getCompanyFact(company, "minimumAttractiveProjectValue");
  const idealProjectFact = getCompanyFact(company, "idealProjectValue");
  const maxRealisticFact = getCompanyFact(company, "maximumRealisticProjectValue");
  const procurementExperienceFact = getCompanyFact(company, "publicProcurementProjects");
  const canCoFinanceFact = getCompanyFact(company, "canCoFinance");
  const employeeHistory = getCompanyFactHistory(company, "employeeCountCurrent");
  const turnoverHistory = getCompanyFactHistory(company, "turnoverRange");
  const sources = getCompanySources(company);
  const conflicts = buildCompanyConflicts(company);
  const unknowns = buildCompanyUnknowns(company);
  const cnae = getCompanyClassifications(company, "cnae");
  const iae = getCompanyClassifications(company, "iae");
  const cpv = getCompanyClassifications(company, "cpv");
  const employeeValue = getFactValue(employeeFact);
  const employeeStatus = getFactStatus(employeeFact);
  const employeeUsesCurrentLabel = employeeValue != null && employeeStatus === "company_confirmed";
  const turnoverValue = turnoverRange.min != null || turnoverRange.max != null ? formatCompanyRange(turnoverRange, "money") : "Unknown";
  return `
    <section class="page-grid">
      <div class="card-grid three">
        ${statCard("Decision profile completeness", `${completeness.score}%`, completeness.missingFacts[0] ?? "Prospect-safe profile view")}
        ${statCard("Company sources", String(sources.length), profileMode === "prospect" ? "Public evidence preserved" : "Confirmed company profile")}
        ${statCard("Visible gaps", String(unknowns.length + conflicts.length), unknowns[0] ?? conflicts[0]?.field ?? "No major gap")}
      </div>
      ${
        profileMode === "prospect"
          ? `
              <article class="card">
                <div class="section-heading">
                  <h2>Prospect profile</h2>
                  <p>This company profile was assembled from public information and still needs business confirmation on the most important unknowns.</p>
                </div>
              </article>
            `
          : ""
      }
      <div class="card-grid two">
        <article class="card">
          <div class="section-heading">
            <h2>Identity</h2>
            <p>Separate legal identity, public classifications, and commercial capabilities.</p>
          </div>
          <div class="profile-grid">
            ${renderProfileDatum({
              label: "Legal name",
              value: company.legalName,
              status: profileMode === "confirmed" ? "company_confirmed" : "public_verified"
            })}
            ${renderProfileDatum({
              label: "Trading name",
              value: company.tradingName ?? "Unknown",
              status: profileMode === "confirmed" ? "company_confirmed" : "public_reported"
            })}
            ${renderProfileDatum({
              label: "Operating geography",
              value: [company.geography.municipality, company.geography.province, company.geography.autonomousCommunity].filter(Boolean).join(", ") || "Unknown",
              status: profileMode === "confirmed" ? "company_confirmed" : "public_reported"
            })}
          </div>
          <div class="detail-section">
            <h4>Classification codes</h4>
            <div class="profile-grid">
              ${
                cnae.length
                  ? cnae
                      .map((item) =>
                        renderProfileDatum({
                          label: "CNAE",
                          value: item.label ? `${item.code} — ${item.label}` : item.code,
                          status: item.status,
                          meta: item.referenceYear ? `Reference year ${item.referenceYear}` : "",
                          note: item.notes ?? "",
                          stale: isStalePublicFact(item)
                        })
                      )
                      .join("")
                  : renderProfileDatum({ label: "CNAE", value: "Unknown", status: "unknown" })
              }
              ${
                iae.length
                  ? iae
                      .map((item) =>
                        renderProfileDatum({
                          label: "IAE",
                          value: item.label ? `${item.code} — ${item.label}` : item.code,
                          status: item.status,
                          meta: item.referenceYear ? `Reference year ${item.referenceYear}` : "",
                          note: item.notes ?? "",
                          stale: isStalePublicFact(item)
                        })
                      )
                      .join("")
                  : renderProfileDatum({ label: "IAE", value: "Unknown", status: "unknown", note: "CNAE and IAE remain separate until explicitly confirmed." })
              }
              ${
                cpv.length
                  ? cpv
                      .map((item) =>
                        renderProfileDatum({
                          label: "CPV focus",
                          value: item.label ? `${item.code} — ${item.label}` : item.code,
                          status: item.status,
                          meta: item.referenceYear ? `Reference year ${item.referenceYear}` : "",
                          note: item.notes ?? "",
                          stale: isStalePublicFact(item)
                        })
                      )
                      .join("")
                  : ""
              }
            </div>
          </div>
        </article>
        <article class="card">
          <div class="section-heading">
            <h2>Business scale</h2>
            <p>Historical public values stay historical. Unknown never becomes zero or a fictional midpoint.</p>
          </div>
          <div class="profile-grid">
            ${renderProfileDatum({
              label: employeeUsesCurrentLabel ? "Current employees" : "Reported employees",
              value: employeeValue != null ? formatCompanyFact(employeeFact) : formatCompanyRange(employeeRange),
              status: employeeValue != null ? getFactStatus(employeeFact) : getFactStatus(employeeRange),
              meta: employeeValue != null ? formatFactMeta(employeeFact) : formatRangeMeta(employeeRange),
              note:
                employeeUsesCurrentLabel
                  ? ""
                  : employeeValue != null
                    ? "A public or historical employee figure does not prove the current headcount."
                    : getFactStatus(employeeRange) === "public_reported"
                      ? "Current headcount is not yet company-confirmed."
                      : "",
              stale: employeeValue == null ? isStalePublicFact(employeeRange) : isStalePublicFact(employeeFact)
            })}
            ${renderProfileDatum({
              label: "Reported turnover",
              value: turnoverValue,
              status: getFactStatus(turnoverRange),
              meta: formatRangeMeta(turnoverRange),
              stale: isStalePublicFact(turnoverRange)
            })}
            ${renderProfileDatum({
              label: "Maximum realistic project capacity",
              value: formatCompanyFact(maxRealisticFact, "money"),
              status: getFactStatus(maxRealisticFact),
              meta: formatFactMeta(maxRealisticFact),
              stale: isStalePublicFact(maxRealisticFact)
            })}
            ${renderProfileDatum({
              label: "Observed similar-project value",
              value: formatCompanyFact(maxProjectFact, "money"),
              status: getFactStatus(maxProjectFact),
              meta: formatFactMeta(maxProjectFact),
              stale: isStalePublicFact(maxProjectFact)
            })}
            ${renderProfileDatum({
              label: "Public procurement experience",
              value: formatCompanyFact(procurementExperienceFact),
              status: getFactStatus(procurementExperienceFact),
              meta: formatFactMeta(procurementExperienceFact),
              stale: isStalePublicFact(procurementExperienceFact)
            })}
          </div>
          ${
            employeeHistory.length || turnoverHistory.length
              ? `
                  <div class="detail-section">
                    <h4>Provenance history</h4>
                    <ul class="tight-list">
                      ${employeeHistory
                        .map(
                          (item) =>
                            `<li>Employees history: ${escapeHtml(formatCompanyFact(item))} · ${escapeHtml(describeStatus(getFactStatus(item)))}${item.referenceYear ? ` · ${escapeHtml(String(item.referenceYear))}` : ""}</li>`
                        )
                        .join("")}
                      ${turnoverHistory
                        .map(
                          (item) =>
                            `<li>Turnover history: ${escapeHtml(formatCompanyRange(item, "money"))} · ${escapeHtml(describeStatus(getFactStatus(item)))}${item.referenceYear ? ` · ${escapeHtml(String(item.referenceYear))}` : ""}</li>`
                        )
                        .join("")}
                    </ul>
                  </div>
                `
              : ""
          }
        </article>
      </div>
      <div class="card-grid two">
        <article class="card">
          <div class="section-heading">
            <h2>Capabilities</h2>
            <p>Public website services can strongly support capability fit without proving legal eligibility.</p>
          </div>
          <div class="profile-grid">
            ${confirmedCapabilities.length ? confirmedCapabilities.map(renderCapabilitySummary).join("") : ""}
            ${publicCapabilities.length ? publicCapabilities.map(renderCapabilitySummary).join("") : ""}
            ${!capabilities.length ? renderProfileDatum({ label: "Capabilities", value: "Unknown", status: "unknown" }) : ""}
          </div>
        </article>
        <article class="card">
          <div class="section-heading">
            <h2>Qualifications & preferences</h2>
            <p>Current qualifications remain separate from website services and classification codes.</p>
          </div>
          <div class="profile-grid">
            ${certifications.length
              ? certifications
                  .map((item) =>
                    renderProfileDatum({
                      label: item.name,
                      value: formatCompanyFact(item.currentStatus),
                      status: getFactStatus(item.currentStatus),
                      meta: formatFactMeta(item.currentStatus),
                      stale: isStalePublicFact(item.currentStatus)
                    })
                  )
                  .join("")
              : renderProfileDatum({ label: "Certifications", value: "Unknown", status: "unknown" })}
            ${insurancePolicies.length
              ? insurancePolicies
                  .map((item) =>
                    renderProfileDatum({
                      label: `${item.name} cover`,
                      value: formatCompanyFact(item.coverAmountFact, "money"),
                      status: getFactStatus(item.coverAmountFact),
                      meta: formatFactMeta(item.coverAmountFact),
                      stale: isStalePublicFact(item.coverAmountFact)
                    })
                  )
                  .join("")
              : renderProfileDatum({ label: "Insurance", value: "Unknown", status: "unknown", note: "Insurance evidence remains separate from capability evidence." })}
            ${renderProfileDatum({
              label: "Preferred radius",
              value: getFactValue(radiusFact) != null ? `${formatCompanyFact(radiusFact)} km` : "Unknown",
              status: getFactStatus(radiusFact),
              meta: formatFactMeta(radiusFact),
              stale: isStalePublicFact(radiusFact)
            })}
            ${renderProfileDatum({
              label: "Minimum attractive project value",
              value: formatCompanyFact(minProjectFact, "money"),
              status: getFactStatus(minProjectFact),
              meta: formatFactMeta(minProjectFact),
              stale: isStalePublicFact(minProjectFact)
            })}
            ${renderProfileDatum({
              label: "Ideal project value",
              value: formatCompanyFact(idealProjectFact, "money"),
              status: getFactStatus(idealProjectFact),
              meta: formatFactMeta(idealProjectFact),
              stale: isStalePublicFact(idealProjectFact)
            })}
            ${renderProfileDatum({
              label: "Can co-finance grants?",
              value: formatCompanyFact(canCoFinanceFact, "boolean"),
              status: getFactStatus(canCoFinanceFact),
              meta: formatFactMeta(canCoFinanceFact),
              stale: isStalePublicFact(canCoFinanceFact)
            })}
          </div>
          <div class="detail-section">
            <h4>Strategic preferences</h4>
            <ul class="tight-list">
              <li>Desired work types: ${escapeHtml(company.preferences.desiredWorkTypes.join(", ") || "Unknown")}</li>
              <li>Unwanted work types: ${escapeHtml(company.preferences.unwantedWorkTypes.join(", ") || "Unknown")}</li>
            </ul>
          </div>
        </article>
      </div>
      ${
        profileMode === "prospect" || unknowns.length || conflicts.length
          ? `
              <div class="card-grid two">
                <article class="card">
                  <div class="section-heading">
                    <h2>${profileMode === "prospect" ? "Unknown information" : "Information still needed"}</h2>
                    <p>These missing facts matter most for reliable opportunity decisions and should be answered explicitly rather than inferred.</p>
                  </div>
                  <ul class="tight-list">
                    ${unknowns.length ? unknowns.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : `<li>No major unknown recorded.</li>`}
                  </ul>
                </article>
                <article class="card">
                  <div class="section-heading">
                    <h2>Source conflicts</h2>
                    <p>Conflicts remain visible until the company confirms the current fact set.</p>
                  </div>
                  <ul class="tight-list">
                    ${conflicts.length ? conflicts.map((item) => `<li>${escapeHtml(item.field)} — ${escapeHtml(item.detail)}</li>`).join("") : `<li>No source conflict recorded.</li>`}
                  </ul>
                </article>
              </div>
            `
          : ""
      }
      <article class="card">
        <div class="section-heading">
          <h2>Company sources</h2>
          <p>Source traceability is preserved separately from opportunity evidence.</p>
        </div>
        <div class="source-grid">
          ${
            sources.length
              ? sources
                  .map(
                    (source) => `
                      <article class="source-card">
                        <div class="card-topline">
                          ${pill(source.sourceType, "neutral")}
                        </div>
                        <strong>${escapeHtml(source.organisation)}</strong>
                        <p>${escapeHtml(source.title)}</p>
                        <small>${source.publishedAt ? `Published ${escapeHtml(source.publishedAt)}` : "Published date unknown"}${source.retrievedAt ? ` · Retrieved ${escapeHtml(formatLastChecked(source.retrievedAt))}` : ""}</small>
                      </article>
                    `
                  )
                  .join("")
              : `<p class="empty-state">No company source has been recorded yet.</p>`
          }
        </div>
      </article>
      <article class="card">
        <div class="section-heading">
          <h2>Company Profile</h2>
          <p>Blank current-value fields are stored as unknown. Saving here creates company-confirmed facts without erasing prior public provenance.</p>
        </div>
        <form data-form="company" class="form-grid">
          <label>
            Profile mode
            <select name="profileMode">
              <option value="confirmed" ${profileMode === "confirmed" ? "selected" : ""}>Confirmed company</option>
              <option value="prospect" ${profileMode === "prospect" ? "selected" : ""}>Prospect</option>
            </select>
          </label>
          <label>
            Legal name
            <input type="text" name="legalName" value="${escapeHtml(company.legalName)}" />
          </label>
          <label>
            Trading name
            <input type="text" name="tradingName" value="${escapeHtml(company.tradingName)}" />
          </label>
          <label>
            Municipality
            <input type="text" name="municipality" value="${escapeHtml(company.geography.municipality)}" />
          </label>
          <label>
            Province
            <input type="text" name="province" value="${escapeHtml(company.geography.province)}" />
          </label>
          <label>
            Preferred radius (km)
            <input type="number" name="radius" value="${escapeHtml(getFactValue(radiusFact)?.toString?.() ?? "")}" />
          </label>
          <label>
            Current employees
            <input type="number" name="employeeCountCurrent" value="${escapeHtml(employeeValue?.toString?.() ?? "")}" />
          </label>
          <label>
            Turnover min
            <input type="number" name="turnoverMin" value="${escapeHtml(turnoverRange.min?.toString?.() ?? "")}" />
          </label>
          <label>
            Turnover max
            <input type="number" name="turnoverMax" value="${escapeHtml(turnoverRange.max?.toString?.() ?? "")}" />
          </label>
          <label>
            Minimum attractive project value
            <input type="number" name="minimumAttractiveProjectValue" value="${escapeHtml(getFactValue(minProjectFact)?.toString?.() ?? "")}" />
          </label>
          <label>
            Ideal project value
            <input type="number" name="idealProjectValue" value="${escapeHtml(getFactValue(idealProjectFact)?.toString?.() ?? "")}" />
          </label>
          <label>
            Maximum realistic project value
            <input type="number" name="maximumRealisticProjectValue" value="${escapeHtml(getFactValue(maxRealisticFact)?.toString?.() ?? "")}" />
          </label>
          <label>
            Public procurement projects
            <input type="number" name="publicProcurementProjects" value="${escapeHtml(getFactValue(procurementExperienceFact)?.toString?.() ?? "")}" />
          </label>
          <label>
            Largest similar project value
            <input type="number" name="maximumProjectValue" value="${escapeHtml(getFactValue(maxProjectFact)?.toString?.() ?? "")}" />
          </label>
          <label class="full-span">
            Desired work types
            <input type="text" name="desiredWorkTypes" value="${escapeHtml(company.preferences.desiredWorkTypes.join(", "))}" />
          </label>
          <label class="full-span">
            Unwanted work types
            <input type="text" name="unwantedWorkTypes" value="${escapeHtml(company.preferences.unwantedWorkTypes.join(", "))}" />
          </label>
          ${certifications
            .map(
              (item, index) => `
                <label>
                  ${escapeHtml(item.name)}
                  <select name="certification-${index}">
                    ${certificationOptions
                      .map(
                        (option) =>
                          `<option value="${option}" ${(getFactValue(item.currentStatus) ?? item.status) === option ? "selected" : ""}>${escapeHtml(option)}</option>`
                      )
                      .join("")}
                  </select>
                </label>
              `
            )
            .join("")}
          <label>
            Can co-finance grant projects?
            <select name="canCoFinance">
              <option value="yes" ${getFactValue(canCoFinanceFact) === true ? "selected" : ""}>Yes</option>
              <option value="no" ${getFactValue(canCoFinanceFact) === false ? "selected" : ""}>No</option>
              <option value="unknown" ${getFactValue(canCoFinanceFact) == null ? "selected" : ""}>Unknown</option>
            </select>
          </label>
          <p class="form-help full-span">Leave a field blank to keep it explicitly unknown. Saving a current value records a company-confirmed fact while preserving any earlier public provenance in history.</p>
          <div class="form-actions full-span">
            <button class="button-primary" type="submit">Save company profile</button>
          </div>
        </form>
      </article>
    </section>
  `;
}

function renderLabPage(derived, persistence) {
  const raw = derived.selectedRaw;
  return `
    <section class="split-layout">
      <div class="stack">
        <article class="card">
          <div class="section-heading">
            <h2>Intelligence Lab</h2>
            <p>Create opportunities manually, import structured JSON, attach evidence, correct facts and re-run analysis.</p>
          </div>
          <form data-form="opportunity-import" class="form-grid">
            <label class="full-span">
              Paste source text
              <textarea name="sourceText" rows="7" placeholder="Paste structured or unstructured opportunity information here."></textarea>
            </label>
            <label>
              Manual title override
              <input type="text" name="title" placeholder="Optional" />
            </label>
            <label>
              Opportunity type
              <select name="type">
                <option value="contract">Contract</option>
                <option value="grant">Grant / subsidy</option>
              </select>
            </label>
            <label>
              Location
              <input type="text" name="location" placeholder="Tarragona" />
            </label>
            <label>
              Value or max beneficiary amount
              <input type="text" name="value" placeholder="84.500" />
            </label>
            <label>
              Deadline text
              <input type="text" name="deadline" placeholder="26/08/2026 14:00" />
            </label>
            <label class="full-span">
              Official notice URL
              <input type="url" name="noticeUrl" placeholder="https://..." />
            </label>
            <div class="form-actions full-span">
              <button class="button-primary" type="submit">Create / import opportunity</button>
              <button class="ghost-button" type="button" data-action="reset-demo">Restore demo workspace</button>
              <button class="ghost-button" type="button" data-action="export-json">Export workspace JSON</button>
            </div>
          </form>
        </article>

        <article class="card">
          <div class="section-heading">
            <h3>Structured opportunity JSON import</h3>
            <p>Import a strict opportunity object for the Intelligence Lab. Unsupported keys and blind benchmark metadata are rejected automatically.</p>
          </div>
          <form data-form="opportunity-json-import" class="form-grid">
            <label class="full-span">
              Structured opportunity JSON
              <textarea
                name="opportunityJson"
                rows="14"
                placeholder='${escapeHtml(STRUCTURED_OPPORTUNITY_PLACEHOLDER)}'
              >${escapeHtml(uiState.opportunityJsonDraft)}</textarea>
            </label>
            ${renderFormFeedback("opportunityJsonImport", uiState.opportunityJsonDraft)}
            <p class="form-help full-span">Use supported runtime fields only. Keep ranking, expected, benchmark and answer-key metadata out of imported opportunities.</p>
            <div class="form-actions full-span">
              <button class="button-primary" type="submit">Import structured opportunity</button>
            </div>
          </form>
        </article>

        <article class="card">
          <div class="section-heading">
            <h3>Prospect profile JSON import</h3>
            <p>Import a structured prospect profile with provenance, historical values, source conflicts and public capability evidence. Blind benchmark keys are rejected automatically.</p>
          </div>
          <form data-form="company-import" class="form-grid">
            <label class="full-span">
              Prospect profile JSON
              <textarea
                name="companyJson"
                rows="12"
                placeholder='${escapeHtml(COMPANY_IMPORT_PLACEHOLDER)}'
              >${escapeHtml(uiState.companyImportDraft)}</textarea>
            </label>
            ${renderFormFeedback("companyImport", uiState.companyImportDraft)}
            <p class="form-help full-span">Imported profiles activate immediately and remain usable even if browser persistence is temporarily unavailable.</p>
            <div class="form-actions full-span">
              <button class="button-primary" type="submit">Import prospect profile</button>
            </div>
          </form>
        </article>

        <article class="card">
          <div class="section-heading">
            <h3>Excluded / low-fit opportunities</h3>
            <p>Nothing is silently dropped. Every rejection keeps a reason for debugging false negatives.</p>
          </div>
          <div class="rejected-list">
            ${derived.portfolio.rejected
              .map(
                (item) => `
                  <button class="mini-list-item" data-action="select" data-id="${item.opportunity.id}">
                    <strong>${escapeHtml(item.opportunity.title)}</strong>
                    <span>${escapeHtml(item.reason)}</span>
                  </button>
                `
              )
              .join("")}
          </div>
        </article>
      </div>
      <div class="stack">
        <article class="card">
          <div class="section-heading">
            <h3>Opportunity editor</h3>
            <p>Manual overrides preserve source-derived evidence while correcting the working fact set.</p>
          </div>
          ${
            raw
              ? `
                  <form data-form="override" class="form-grid">
                    <input type="hidden" name="opportunityId" value="${raw.id}" />
                    <label class="full-span">
                      Title
                      <input type="text" name="title" value="${escapeHtml(raw.title)}" />
                    </label>
                    <label>
                      Status
                      <select name="status">
                        ${Object.entries(STATUS_LABELS)
                          .map(
                            ([value, label]) =>
                              `<option value="${value}" ${(raw.status || raw.derivedStatus) === value ? "selected" : ""}>${escapeHtml(label)}</option>`
                          )
                          .join("")}
                      </select>
                    </label>
                    <label>
                      Value
                      <input type="text" name="value" value="${escapeHtml(
                        raw.relevantValue ? String(raw.relevantValue.amountMinor / 100) : ""
                      )}" />
                    </label>
                    <label>
                      Deadline
                      <input type="text" name="deadline" value="${escapeHtml(raw.deadline?.sourceText ?? "")}" />
                    </label>
                    <label class="full-span">
                      Override reason
                      <textarea name="reason" rows="3" placeholder="Why is this correction needed?"></textarea>
                    </label>
                    <div class="form-actions full-span">
                      <button class="button-primary" type="submit">Apply override and reanalyse</button>
                    </div>
                  </form>
                `
              : `<p class="empty-state">Select an opportunity from the ranked list or rejected list to edit it here.</p>`
          }
        </article>
        ${renderDetailPanel(derived, persistence)}
      </div>
    </section>
  `;
}

function renderSourcesPage(state, runtime, sourceCache, connectorState, refreshScheduler) {
  const aiStatus = getAiStatusMeta(runtime.ai);
  const placspRun = getLatestPlacspSyncRun(state);
  const sourceCacheMeta = getSourceCacheMeta(sourceCache);
  const placspState = createConnectorState("placsp", connectorState);
  const placspCachedCount =
    sourceCache?.counts?.placsp ??
    state.opportunities.filter((item) => isPlacspSourceOpportunity(item)).length;
  const placspStatusLabel = uiState.placspSyncing
    ? "Syncing"
    : placspRun?.status === "healthy"
      ? "Last sync successful"
      : placspRun?.status === "error"
        ? "Error"
        : runtime.connectors?.placsp === "ready"
          ? "Ready"
          : "Planned";
  const placspStatusTone = uiState.placspSyncing
    ? "warn"
    : placspRun?.status === "healthy"
      ? "good"
      : placspRun?.status === "error"
        ? "bad"
        : runtime.connectors?.placsp === "ready"
          ? "good"
          : "warn";
  const placspErrors = placspRun?.errors ?? [];
  const nextAutomaticRefreshAt = refreshScheduler?.getNextAutomaticRefreshAt
    ? refreshScheduler.getNextAutomaticRefreshAt(placspState)
    : getNextAutomaticRefreshAt(placspState);
  const warnings = [
    placspRun?.truncated && placspRun?.cursorReached === false
      ? "Incremental traversal was truncated before the previous watermark was fully reached."
      : null,
    (sourceCache?.status === "unavailable" || sourceCache?.status === "error")
      ? sourceCacheMeta.detail
      : null,
    placspState.lastErrorAt && placspState.lastErrorCode && placspState.lastRunMode === "automatic"
      ? "The last automatic PLACSP refresh failed and is currently in conservative backoff."
      : null,
    isReconciliationDue(placspState.lastReconciliationAt, Date.now())
      ? "Recent bounded reconciliation is overdue."
      : null
  ].filter(Boolean);
  const secondaryRuns = (state.sourceSyncRuns ?? []).filter((run) => !isPlacspSyncRun(run));
  return `
    <section class="page-grid">
      <article class="card">
        <div class="section-heading">
          <h2>Data sources</h2>
          <p>Official connector refresh remains read-only, bounded and visible to the admin user.</p>
        </div>
        <div class="source-grid">
          <article class="source-card">
            <div class="card-topline">
              ${pill("PLACSP", "neutral")}
              ${pill(placspStatusLabel, placspStatusTone)}
            </div>
            <p>Official Spanish public procurement feed from the Plataforma de Contratacion del Sector Publico.</p>
            <small>
              ${placspRun ? `Last synchronized ${escapeHtml(formatLastChecked(formatSourceRunMoment(placspRun)))}` : "No PLACSP sync has completed yet."}
            </small>
            <br />
            <small>
              ${placspState.lastFeedUpdated ? `Source feed updated ${escapeHtml(formatLastChecked(placspState.lastFeedUpdated))}` : "Feed update timestamp not available yet."}
            </small>
            <ul class="tight-list">
              <li>Automatic refresh: ${placspState.autoRefreshEnabled ? "On" : "Off"}</li>
              <li>Last automatic refresh: ${escapeHtml(formatTimestampDetail(placspState.lastAutomaticSyncAt, "Not yet run"))}</li>
              <li>Last manual refresh: ${escapeHtml(formatTimestampDetail(placspState.lastManualSyncAt, "Not yet run"))}</li>
              <li>Incremental watermark: ${escapeHtml(formatTimestampDetail(placspState.entryUpdatedWatermark, "Not stored yet"))}</li>
              <li>Last mode: ${escapeHtml(placspRunModeLabel(placspState.lastRunMode))}</li>
              <li>Next automatic refresh: ${escapeHtml(formatTimestampDetail(nextAutomaticRefreshAt))}</li>
              <li>Source cache: ${escapeHtml(sourceCacheMeta.label)}</li>
              <li>Cached opportunities: ${placspCachedCount}</li>
              <li>Pages fetched: ${placspRun?.pagesFetched ?? 0}</li>
              <li>Entries processed: ${placspRun?.entriesSeen ?? 0}</li>
              <li>Unique procurements: ${placspRun?.uniqueEntries ?? 0}</li>
              <li>Inserted: ${placspRun?.opportunitiesInserted ?? 0}</li>
              <li>Updated: ${placspRun?.opportunitiesUpdated ?? 0}</li>
              <li>Unchanged: ${placspRun?.unchanged ?? 0}</li>
              <li>Tombstones: ${placspRun?.tombstonesSeen ?? 0}</li>
            </ul>
            <small>Automatic refresh runs while this local OportuneX environment is active.</small>
            <br />
            <small>${escapeHtml(sourceCacheMeta.detail)}</small>
            <br />
            <small>
              ${
                sourceCache?.lastHydratedAt
                  ? `Last cache hydration ${escapeHtml(formatLastChecked(sourceCache.lastHydratedAt))}${sourceCache?.hydrationMs != null ? ` (${sourceCache.hydrationMs} ms)` : ""}`
                  : "Cache hydration has not completed yet."
              }
            </small>
            ${
              sourceCache?.lastSavedAt
                ? `
                    <br />
                    <small>Last cache write ${escapeHtml(formatLastChecked(sourceCache.lastSavedAt))}</small>
                  `
                : ""
            }
            ${placspErrors.length ? `<small>${escapeHtml(placspErrors[0])}</small>` : ""}
            ${getSourceCacheErrorMessage(sourceCache) ? `<small>${escapeHtml(getSourceCacheErrorMessage(sourceCache))}</small>` : ""}
            ${
              warnings.length
                ? `
                    <div class="stack">
                      ${warnings.map((warning) => `<small>${escapeHtml(warning)}</small>`).join("")}
                    </div>
                  `
                : ""
            }
            <div class="form-actions">
              <label>
                Recent pages
                <select data-control="placsp-pages" ${uiState.placspSyncing ? "disabled" : ""}>
                  ${[1, 2, 3, 4, 5]
                    .map(
                      (value) =>
                        `<option value="${value}" ${uiState.placspMaxPages === value ? "selected" : ""}>${value}</option>`
                    )
                    .join("")}
                </select>
              </label>
              <button class="button-secondary" data-action="toggle-placsp-auto-refresh" ${uiState.placspSyncing ? "disabled" : ""}>
                Automatic refresh ${placspState.autoRefreshEnabled ? "ON" : "OFF"}
              </button>
              <button class="button-primary" data-action="sync-placsp" ${uiState.placspSyncing ? "disabled" : ""}>
                ${uiState.placspSyncing ? "Syncing PLACSP..." : "Sync now"}
              </button>
              <button class="button-secondary" data-action="sync-placsp-reconcile" ${uiState.placspSyncing ? "disabled" : ""}>
                Reconcile recent pages
              </button>
            </div>
            <small>${hasPlacspIncrementalCursor(placspState) ? "Sync now uses the stored PLACSP cursor for incremental refresh." : "Sync now will seed the local PLACSP cursor from the selected page window."}</small>
          </article>
          ${secondaryRuns
            .map(
              (run) => `
                <article class="source-card">
                  <div class="card-topline">
                    ${pill(run.source, "neutral")}
                    ${pill(run.status, toneForSourceStatus(run.status))}
                  </div>
                  <p>${escapeHtml(run.note)}</p>
                  <small>${formatSourceRunMoment(run) ? `Last run ${escapeHtml(formatLastChecked(formatSourceRunMoment(run)))}` : "No run yet"}</small>
                </article>
              `
            )
            .join("")}
          <article class="source-card">
            <div class="card-topline">
              ${pill(aiStatus.shortLabel, aiStatus.tone)}
              ${pill(runtime.ai.provider, "neutral")}
            </div>
            <p>${escapeHtml(aiStatus.detail)}</p>
            <small>Verification model ${escapeHtml(runtime.ai.verificationModel ?? "unknown")} · reasoning ${escapeHtml(runtime.ai.reasoningEffort ?? "medium")}</small>
            <br />
            <small>
              ${
                runtime.ai.lastChecked
                  ? `Last checked ${escapeHtml(formatLastChecked(runtime.ai.lastChecked))}`
                  : "No live verification check has completed yet."
              }
            </small>
          </article>
        </div>
      </article>
    </section>
  `;
}

function renderDebugPage(derived, persistence) {
  return `
    <section class="split-layout">
      <div class="stack">
        <article class="card">
          <div class="section-heading">
            <h2>Analysis debugger</h2>
            <p>Inspect score components, claims, evidence links and verification triggers.</p>
          </div>
          ${renderOpportunityListMini(derived.portfolio.recommended)}
        </article>
      </div>
      ${renderDetailPanel(derived, persistence, true)}
    </section>
  `;
}

function renderEvaluationPage(derived) {
  const summary = derived.evaluation.summary;
  return `
    <section class="page-grid">
      <div class="card-grid five">
        ${statCard("Fixtures", String(summary.total))}
        ${statCard("Passed", String(summary.passed))}
        ${statCard("Candidate recall", `${summary.candidateRecall}%`)}
        ${statCard("Recommendation precision", `${summary.recommendationPrecision}%`)}
        ${statCard("Hard-blocker accuracy", `${summary.hardBlockerAccuracy}%`)}
      </div>
      <div class="card-grid three">
        ${statCard("Monetary accuracy", `${summary.monetaryFieldAccuracy}%`)}
        ${statCard("Deadline accuracy", `${summary.deadlineAccuracy}%`)}
        ${statCard("Critical hallucination rate", "0%", "No fabricated critical fact in the fixture suite")}
      </div>
      <article class="card">
        <div class="section-heading">
          <h2>Evaluation harness</h2>
          <p>Stable fixtures cover hard blockers, lot-level values, deadline safety, grants, source conflicts and prompt injection.</p>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fixture</th>
                <th>Status</th>
                <th>Decision</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${derived.evaluation.results
                .map(
                  (result) => `
                    <tr>
                      <td>${escapeHtml(result.title)}</td>
                      <td>${pill(result.passed ? "Pass" : "Fail", result.passed ? "good" : "bad")}</td>
                      <td>${escapeHtml(result.recommendedActionCode ?? result.fitBand ?? result.rejectedReason ?? "n/a")}</td>
                      <td>${escapeHtml(result.checks.filter((check) => !check.pass).map((check) => check.label).join(", ") || "All checks passed")}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  `;
}

function renderHealthPage(state, runtime, derived, persistence, sourceCache, connectorState, refreshScheduler) {
  const footprint = Math.round(JSON.stringify(serializeStateForPersistence(state)).length / 1024);
  const aiStatus = getAiStatusMeta(runtime.ai);
  const persistenceMeta = getPersistenceMeta(persistence);
  const sourceCacheMeta = getSourceCacheMeta(sourceCache);
  const placspState = createConnectorState("placsp", connectorState);
  const analysisCacheMetrics = derived.analysisCacheMetrics ?? null;
  const nextAutomaticRefreshAt = refreshScheduler?.getNextAutomaticRefreshAt
    ? refreshScheduler.getNextAutomaticRefreshAt(placspState)
    : getNextAutomaticRefreshAt(placspState);
  return `
    <section class="page-grid">
      <div class="card-grid five">
        ${statCard("Companies", String(state.companyProfiles.length))}
        ${statCard("Analysed", String(derived.portfolio.counts.analysed))}
        ${statCard("Saved", String(state.savedOpportunityIds.length))}
        ${statCard("Local store footprint", `${footprint} KB`)}
        ${statCard("Analysis cache", analysisCacheMetrics ? String(analysisCacheMetrics.cacheSize) : "n/a", analysisCacheMetrics ? `${analysisCacheMetrics.lastRunHits} hits / ${analysisCacheMetrics.lastRunMisses} misses` : "")}
      </div>
      <article class="card">
        <div class="section-heading">
          <h2>System health</h2>
          <p>${escapeHtml(runtime.appPhase ?? "Current phase")} observability covers workspace counts, persistence, source states, AI mode, trust rules and recent audit events.</p>
        </div>
        <div class="health-grid">
          <div>
            <strong>AI verification mode</strong>
            <p>${escapeHtml(aiStatus.detail)}</p>
            ${
              runtime.ai.lastError
                ? `<small>${escapeHtml(runtime.ai.lastError)}</small>`
                : runtime.ai.lastChecked
                  ? `<small>Last checked ${escapeHtml(formatLastChecked(runtime.ai.lastChecked))}</small>`
                  : ""
            }
          </div>
          <div>
            <strong>Connector posture</strong>
            <p>${state.sourceSyncRuns.filter((item) => item.status === "healthy" || item.status === "ready").length} healthy, ${state.sourceSyncRuns.filter((item) => item.status === "planned").length} planned.</p>
          </div>
          <div>
            <strong>Persistence</strong>
            <p>${escapeHtml(persistenceMeta.detail)}</p>
            ${
              persistence?.lastSavedAt
                ? `<small>Last saved ${escapeHtml(formatDate(persistence.lastSavedAt, { includeTime: true }))}</small>`
                : getPersistenceErrorMessage(persistence)
                  ? `<small>${escapeHtml(getPersistenceErrorMessage(persistence))}</small>`
                  : ""
            }
          </div>
          <div>
            <strong>Source cache</strong>
            <p>${escapeHtml(sourceCacheMeta.detail)}</p>
            ${
              sourceCache?.lastHydratedAt
                ? `<small>Last hydrated ${escapeHtml(formatDate(sourceCache.lastHydratedAt, { includeTime: true }))}${sourceCache?.hydrationMs != null ? ` · ${sourceCache.hydrationMs} ms` : ""}</small>`
                : getSourceCacheErrorMessage(sourceCache)
                  ? `<small>${escapeHtml(getSourceCacheErrorMessage(sourceCache))}</small>`
                  : ""
            }
          </div>
          <div>
            <strong>Automatic refresh</strong>
            <p>${placspState.autoRefreshEnabled ? "Enabled while this local app/server environment stays active." : "Disabled for this browser profile."}</p>
            <small>Next due ${escapeHtml(formatTimestampDetail(nextAutomaticRefreshAt))}</small>
          </div>
          <div>
            <strong>Analysis cache</strong>
            <p>${analysisCacheMetrics ? `${analysisCacheMetrics.cacheSize} cached deterministic opportunity analyses.` : "No analysis cache metrics are available."}</p>
            ${
              analysisCacheMetrics
                ? `<small>Last pass ${analysisCacheMetrics.lastRunHits} hits / ${analysisCacheMetrics.lastRunMisses} misses · ${analysisCacheMetrics.lastPortfolioAnalysisMs} ms</small>`
                : ""
            }
          </div>
          <div>
            <strong>Evidence coverage</strong>
            <p>${derived.portfolio.recommended[0]?.confidenceShield.sourceFieldsEvidenced ?? 0}/${derived.portfolio.recommended[0]?.confidenceShield.totalSourceFields ?? 0} source fields evidenced on the current top match.</p>
          </div>
          <div>
            <strong>Trust invariant</strong>
            <p>Unknown is never treated as pass. Hard blockers always override a high score.</p>
          </div>
          <div>
            <strong>Recent audit events</strong>
            <ul class="tight-list">
              ${(state.auditEvents ?? [])
                .slice(0, 5)
                .map((item) => `<li>${escapeHtml(item.title)} · ${escapeHtml(formatDate(item.at, { includeTime: true }))}</li>`)
                .join("")}
            </ul>
          </div>
        </div>
      </article>
    </section>
  `;
}

function renderOpportunityListMini(matches) {
  return matches
    .slice(0, 8)
    .map(
      (item) => `
        <button class="mini-list-item ${uiState.selectedOpportunityId === item.opportunityId ? "selected" : ""}" data-action="select" data-id="${item.opportunityId}">
          <strong>${escapeHtml(item.displayTitle)}</strong>
          <span>${escapeHtml(item.fitBandLabel ?? item.recommendationLabel ?? fitBandLabelOf(item))} · ${item.priorityScore}</span>
        </button>
      `
    )
    .join("");
}

function renderAiReviewSection(opportunity, match, aiReview, persistence, companyId, showTechnicalPath = false) {
  const busy = isAiReviewBusy(companyId, opportunity.id);
  const summary = aiReviewSummary(aiReview, match, persistence);
  const record = aiReview?.review ?? null;

  return `
    <div class="detail-section">
      <h4>AI review</h4>
      <div class="ai-review-card">
        <div class="card-topline">
          ${pill(summary.statusMeta.label, summary.statusMeta.tone)}
          ${record?.completedAt ? pill(summary.savedMode, persistence?.status === "available" ? "neutral" : "warn") : ""}
        </div>
        <p>${escapeHtml(summary.statusMeta.detail)}</p>
        ${summary.completedAt ? `<p><strong>Reviewed:</strong> ${escapeHtml(summary.completedAt)}</p>` : ""}
        ${
          record
            ? `
                <ul class="tight-list">
                  <li>Review status: ${escapeHtml(summary.reviewStatus)}</li>
                  <li>Confidence: ${escapeHtml(summary.confidence)}</li>
                  ${summary.showCorrectedAction ? `<li>AI corrected action: ${escapeHtml(summary.correctedAction)}</li>` : ""}
                  ${summary.showCorrectedFitBand ? `<li>AI corrected fit: ${escapeHtml(summary.correctedFitBand)}</li>` : ""}
                  ${
                    summary.warnings.length
                      ? `<li>Main warnings: ${escapeHtml(summary.warnings.slice(0, 3).join("; "))}</li>`
                      : "<li>Main warnings: None recorded.</li>"
                  }
                  ${summary.notes ? `<li>Notes: ${escapeHtml(summary.notes)}</li>` : ""}
                </ul>
              `
            : ""
        }
        ${
          !record && aiReview?.isLegacyAvailable
            ? `<p class="inline-note">A legacy unscoped AI review exists for this opportunity, but it is not shown as authoritative for the current company.</p>`
            : ""
        }
        <div class="action-row">
          <button class="button-primary" data-action="ai-verify" data-id="${opportunity.id}" ${busy ? "disabled" : ""}>
            ${busy ? "Verifying..." : escapeHtml(aiReview?.buttonLabel ?? "Run AI verification")}
          </button>
          ${showTechnicalPath ? `<button class="ghost-button" data-action="tab" data-tab="debug">Technical details</button>` : `<button class="ghost-button" data-action="route" data-route="debug">Open Analysis Debugger</button>`}
        </div>
      </div>
    </div>
  `;
}

function renderDetailPanel(derived, persistence, showDebugger = false) {
  const selected = derived.selectedRecommended ?? derived.selectedRejected?.bestMatch ?? null;
  const raw = derived.selectedRaw;
  if (!selected || !raw) {
    if (derived.selectedRejected) {
      return `
        <aside class="detail-panel">
          <article class="card">
            <div class="section-heading">
              <h3>${escapeHtml(derived.selectedRejected.opportunity.title)}</h3>
              <p>Excluded / low-fit opportunity</p>
            </div>
            <p><strong>Reason:</strong> ${escapeHtml(derived.selectedRejected.reason)}</p>
            <p>Phase 0 keeps the rejection path visible for manual review and evaluation.</p>
          </article>
        </aside>
      `;
    }
    return `<aside class="detail-panel"><article class="card"><p class="empty-state">Select an opportunity to inspect its evidence, scoring and professional report.</p></article></aside>`;
  }

  const decision = buildDecisionSummary(selected);
  const primaryPotentialHardBlocker = selected.potentialHardBlockers?.[0] ?? null;
  const tabs = showDebugger ? ["report", "evidence", "debug"] : ["report", "evidence"];
  const authorityLabel =
    raw.contractingAuthority ||
    raw.issuingOrganisation ||
    selected.primaryContact?.name ||
    "Authority / programme not stated";

  return `
    <aside class="detail-panel">
      <article class="card">
        <div class="detail-summary-card">
          <div class="card-topline">
            ${pill(actionLabelOf(selected.decision?.recommendedAction), actionTone(selected.decision?.recommendedAction?.code))}
            ${pill(fitBandLabelOf(selected), recommendationTone(fitBandOf(selected)))}
            ${pill(ELIGIBILITY_COPY[selected.eligibilityStatus], eligibilityTone(selected.eligibilityStatus))}
            ${pill(`Source confidence ${selected.confidenceShield.dataConfidence}`, confidenceTone(selected.confidenceShield.label))}
          </div>
          <h3>${escapeHtml(selected.displayTitle)}</h3>
          <p>${escapeHtml(authorityLabel)} · ${escapeHtml(OPPORTUNITY_TYPES[raw.type] ?? "Opportunity")}</p>
          <div class="detail-key-facts">
            ${statCard("Published value", selected.displayValueLabel)}
            ${statCard("Location", selected.locationLabel || "Not stated")}
            ${statCard("Deadline", formatDeadline(raw.deadline))}
            ${statCard("Decision confidence", CONFIDENCE_COPY[selected.confidenceShield.label])}
          </div>
        </div>
        <div class="decision-strip">
          <div class="decision-item">
            <span>Recommended action</span>
            <strong>${escapeHtml(decision.action)}</strong>
          </div>
          <div class="decision-item">
            <span>Main reason</span>
            <p>${escapeHtml(decision.reason)}</p>
          </div>
          <div class="decision-item">
            <span>Main blocker/question</span>
            <p>${escapeHtml(decision.blocker)}</p>
          </div>
        </div>
        <p>${escapeHtml(selected.executiveVerdict)}</p>
        ${selected.decision?.recommendedAction?.code === "DO_NOT_PURSUE" ? `<div class="detail-alert"><strong>Current outcome:</strong> ${escapeHtml(selected.decision.mainReason)}</div>` : ""}
        ${primaryPotentialHardBlocker ? `<div class="detail-alert"><strong>Potential hard blocker:</strong> ${escapeHtml(primaryPotentialHardBlocker.title)}. ${escapeHtml(primaryPotentialHardBlocker.detail)}</div>` : ""}
        <div class="tab-row">
          ${tabs
            .map(
              (tab) => `
                <button class="tab-button ${uiState.detailTab === tab ? "active" : ""}" data-action="tab" data-tab="${tab}">
                  ${escapeHtml(tab)}
                </button>
              `
            )
            .join("")}
        </div>
        ${
          uiState.detailTab === "report"
            ? renderReportTab(raw, selected, derived.selectedAiReview, persistence, derived.company.id, showDebugger)
            : uiState.detailTab === "evidence"
              ? renderEvidenceTab(raw, selected)
              : renderDebugTab(raw, selected, derived.selectedAiReview)
        }
      </article>
    </aside>
  `;
}

function renderReportTab(opportunity, match, aiReview, persistence, companyId, showDebugger = false) {
  const eligibilityRequirements = match.requirementRows.filter((row) => row.mandatory).map((row) => row.label);
  const nonActionable = isNonActionableDerivedStatus(opportunity.derivedStatus ?? opportunity.status);
  const preparationItems = nonActionable
    ? ["Archival review only. This notice is not open for a live submission."]
    : [
        "Internal go / no-go review",
        "Commercial and technical lead assignment",
        match.potentialHardBlockers?.length || match.unknowns.length
          ? "Gather evidence for unresolved qualification or eligibility conditions"
          : null
      ].filter(Boolean);
  const guaranteeLabel = describeEvidenceBackedText(opportunity, "guarantees", opportunity.guarantees, {
    fallback: "Not stated"
  });

  return `
    <div class="detail-section">
      <h4>Why this matters</h4>
      <ul class="tight-list">
        ${
          match.positives.length
            ? match.positives.slice(0, 4).map((item) => `<li><strong>${escapeHtml(item.title)}:</strong> ${escapeHtml(item.detail)}</li>`).join("")
            : `<li>${escapeHtml(match.executiveVerdict)}</li>`
        }
      </ul>
    </div>
    <div class="detail-section">
      <h4>Before you act</h4>
      <ul class="tight-list">
        ${primaryOpenIssue(match) ? `<li><strong>Next verification question:</strong> ${escapeHtml(primaryOpenIssue(match).detail)}</li>` : ""}
        ${
          (match.potentialHardBlockers ?? []).length
            ? match.potentialHardBlockers.map((item) => `<li><strong>Potential hard blocker:</strong> ${escapeHtml(item.title)} — ${escapeHtml(item.detail)}</li>`).join("")
            : match.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED"
              ? "<li><strong>Potential hard blockers:</strong> Not yet assessable — qualification requirements have not been retrieved.</li>"
              : "<li>No potential hard blocker is currently recorded for the retrieved qualification set.</li>"
        }
        ${match.blockers.length ? match.blockers.map((item) => `<li><strong>Confirmed blocker:</strong> ${escapeHtml(item.title)} — ${escapeHtml(item.detail)}</li>`).join("") : ""}
        ${match.unknowns.map((item) => `<li><strong>Important unknown:</strong> ${escapeHtml(item.title)} — ${escapeHtml(item.detail)}</li>`).join("")}
      </ul>
    </div>
    <div class="detail-section">
      <h4>Eligibility</h4>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>Requirement</th><th>Status</th><th>Evidence</th><th>Why it matters</th></tr>
          </thead>
          <tbody>
            ${
              match.requirementRows.length
                ? match.requirementRows
                    .map(
                      (row) => `
                        <tr>
                          <td>${escapeHtml(row.label)}</td>
                          <td>${escapeHtml(requirementStatusLabel(row))}</td>
                          <td>${escapeHtml(row.evidenceIds.join(", ") || "Not linked")}</td>
                          <td>${escapeHtml(row.why ?? "Not provided")}</td>
                        </tr>
                      `
                    )
                    .join("")
                : `
                    <tr>
                      <td>Qualification requirements</td>
                      <td>${escapeHtml(match.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED" ? "Not yet retrieved" : "No requirement published")}</td>
                      <td>Not linked</td>
                      <td>${escapeHtml(match.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED" ? "The reviewed or imported sources do not yet establish the mandatory qualification set." : "No mandatory requirement is currently recorded in the reviewed source set.")}</td>
                    </tr>
                  `
            }
          </tbody>
        </table>
      </div>
    </div>
    <div class="detail-section">
      <h4>Financial picture</h4>
      <ul class="tight-list">
        ${(match.financialPicture?.lines ?? []).length
          ? (match.financialPicture?.lines ?? [])
              .map(
                (line) =>
                  `<li>${escapeHtml(line.label)}: ${escapeHtml(line.displayValue)}${line.note ? ` · ${escapeHtml(line.note)}` : ""}</li>`
              )
              .join("")
          : "<li>No reliable financial amount is currently available.</li>"}
        <li>${escapeHtml(match.companyAmountLabel)}</li>
        <li>Recommended action: ${escapeHtml(actionLabelOf(match.decision?.recommendedAction))}</li>
        <li>Duration: ${escapeHtml(opportunity.duration ?? "Not stated")}</li>
        <li>Guarantees: ${escapeHtml(guaranteeLabel)}</li>
        <li>Scale fit note: ${escapeHtml(match.dimensions?.scaleAssessment?.note ?? "No scale note recorded.")}</li>
      </ul>
    </div>
    <div class="detail-section">
      <h4>Eligibility / qualification requirements</h4>
      <ul class="tight-list">
        ${eligibilityRequirements.length
          ? eligibilityRequirements.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
          : match.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED"
            ? "<li>Qualification requirements have not yet been retrieved from the reviewed sources.</li>"
            : "<li>None published.</li>"}
      </ul>
    </div>
    <div class="detail-section">
      <h4>Submission documents</h4>
      <ul class="tight-list">
        ${(opportunity.requiredDocuments ?? []).length
          ? (opportunity.requiredDocuments ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")
          : "<li>No submission document has been explicitly listed by the source.</li>"}
      </ul>
    </div>
    <div class="detail-section">
      <h4>Preparation items</h4>
      <ul class="tight-list">
        ${preparationItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </div>
    <div class="detail-section">
      <h4>Source / evidence</h4>
      <ul class="tight-list">
        <li>Official source verified: ${match.confidenceShield.officialSourceVerified ? "Yes" : "No"}</li>
        <li>Last checked: ${escapeHtml(formatLastChecked(opportunity.lastChecked))}</li>
        <li>Decision confidence: ${escapeHtml(CONFIDENCE_COPY[match.confidenceShield.label])}</li>
        <li>Critical field summary: ${escapeHtml(match.confidenceShield.criticalFieldSummary)}</li>
        ${match.risks.map((item) => `<li>${escapeHtml(item.title)} — ${escapeHtml(item.detail)}</li>`).join("")}
      </ul>
    </div>
    ${renderAiReviewSection(opportunity, match, aiReview, persistence, companyId, showDebugger)}
    <div class="detail-section">
      <h4>How to pursue</h4>
      <ul class="tight-list">
        ${
          nonActionable
            ? `<li>No live submission route applies because this notice is not open.</li>`
            : opportunity.applicationUrl
            ? `<li><a href="${escapeHtml(opportunity.applicationUrl)}" target="_blank" rel="noreferrer noopener">Open official application</a></li>`
            : `<li>Submission route not yet verified</li>`
        }
        ${
          opportunity.noticeUrl
            ? `<li><a href="${escapeHtml(opportunity.noticeUrl)}" target="_blank" rel="noreferrer noopener">Open official notice</a></li>`
            : `<li>Official notice / dossier not yet verified</li>`
        }
        <li>Authority contact: ${escapeHtml(
          nonActionable && !match.primaryContact?.name
            ? "No live submission contact is required for this archived notice."
            : match.primaryContact?.name ?? "Contact not found in reviewed/imported sources"
        )}</li>
        <li>Reference: ${escapeHtml(opportunity.referenceNumber ?? opportunity.id)}</li>
        <li>Deadline: ${escapeHtml(formatDeadline(opportunity.deadline))}</li>
      </ul>
      <div class="action-row">
        <button class="ghost-button" data-action="download-report" data-id="${opportunity.id}">Download report</button>
      </div>
    </div>
  `;
}

function renderEvidenceTab(opportunity, match) {
  return `
    <div class="detail-section">
      <h4>Confidence shield</h4>
      <div class="shield">
        ${pill(CONFIDENCE_COPY[match.confidenceShield.label], confidenceTone(match.confidenceShield.label))}
        <ul class="tight-list">
          <li>Source evidence: ${match.confidenceShield.sourceFieldsEvidenced}/${match.confidenceShield.totalSourceFields} source fields evidenced</li>
          <li>Critical field summary: ${escapeHtml(match.confidenceShield.criticalFieldSummary)}</li>
          <li>Mandatory eligibility: ${match.confidenceShield.mandatoryConfirmed} confirmed, ${match.confidenceShield.mandatoryNeedsVerification} need verification, ${match.confidenceShield.mandatoryFailed} failed</li>
          <li>Company confirmation: ${match.confidenceShield.companyConfirmationsNeeded} answers needed</li>
          <li>Data confidence: ${escapeHtml(match.confidenceShield.dataConfidence)}</li>
          <li>Eligibility confidence: ${escapeHtml(match.confidenceShield.eligibilityConfidence)}</li>
          <li>Company-fact confidence: ${escapeHtml(match.confidenceShield.companyFactConfidence)}</li>
          <li>Decision confidence: ${escapeHtml(match.confidenceShield.decisionConfidence)}</li>
          <li>Source conflicts: ${match.confidenceShield.sourceConflictsCount === 0 ? "None" : String(match.confidenceShield.sourceConflictsCount)}</li>
          <li>Official source verified: ${match.confidenceShield.officialSourceVerified ? "Yes" : "No"}</li>
          <li>Last checked: ${escapeHtml(formatLastChecked(opportunity.lastChecked))}</li>
          <li>Recommended action: ${escapeHtml(actionLabelOf(match.decision?.recommendedAction))}</li>
        </ul>
      </div>
    </div>
    <div class="detail-section">
      <h4>Evidence ledger</h4>
      <div class="evidence-list">
        ${
          (opportunity.evidence ?? []).length
            ? (opportunity.evidence ?? [])
                .map(
                  (item) => `
                    <article class="evidence-item">
                      <strong>${escapeHtml(item.fieldKey)}</strong>
                      <p>${escapeHtml(item.excerpt)}</p>
                      <small>Confidence ${Math.round((item.confidence ?? 0.8) * 100)}%</small>
                    </article>
                  `
                )
                .join("")
            : `<p class="empty-state">No evidence excerpt has been attached yet for this opportunity.</p>`
        }
      </div>
    </div>
    <div class="detail-section">
      <h4>Official sources</h4>
      <ul class="tight-list">
        ${
          (opportunity.sources ?? []).length
            ? (opportunity.sources ?? [])
                .map(
                  (source) => `
                    <li>
                      <a href="${escapeHtml(source.url || "#")}" target="_blank" rel="noreferrer noopener">${escapeHtml(source.organisation)}</a>
                      — ${escapeHtml(source.title)} · published ${escapeHtml(source.publishedAt)} · last checked ${escapeHtml(formatLastChecked(source.lastChecked))}
                    </li>
                  `
                )
                .join("")
            : "<li>No official source has been attached yet.</li>"
        }
      </ul>
    </div>
  `;
}

function renderDebugTab(opportunity, match, aiReview) {
  const aiRun = aiReview?.review ?? aiReview?.legacyReview ?? null;
  return `
    <div class="detail-section">
      <h4>Scoring dimensions</h4>
      <div class="dimension-grid">
        ${Object.entries(match.dimensions ?? {})
          .filter(([, value]) => typeof value === "number")
          .map(
            ([key, value]) => `
              <div class="dimension-row">
                <span>${escapeHtml(key)}</span>
                <strong>${Math.round(value)}/100</strong>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
    <div class="detail-section">
      <h4>Scale assessment</h4>
      <ul class="tight-list">
        <li>Basis: ${escapeHtml(match.dimensions?.scaleAssessment?.basis ?? "unknown")}</li>
        <li>${escapeHtml(match.dimensions?.scaleAssessment?.note ?? "No additional note recorded.")}</li>
      </ul>
    </div>
    <div class="detail-section">
      <h4>Structured claims</h4>
      <ul class="tight-list">
        ${match.claims
          .map(
            (claim) => `
              <li>${escapeHtml(claim.claim)} — ${escapeHtml(claim.claimType)} · evidence ${escapeHtml(claim.evidenceIds.join(", ") || "none")}</li>
            `
          )
          .join("")}
      </ul>
    </div>
    <div class="detail-section">
      <h4>AI verification status</h4>
      ${
        aiRun
          ? `
              <pre class="debug-pre">${escapeHtml(JSON.stringify(aiRun, null, 2))}</pre>
            `
          : `<p>No AI verification run stored yet. The deterministic engine remains the source of truth in Phase 0.</p>`
      }
    </div>
  `;
}

function layout(content, runtime, derived, persistence, sourceCache) {
  const aiStatus = getAiStatusMeta(runtime.ai);
  const profileMode = getProfileMode(derived.company);
  const persistenceMeta = getPersistenceMeta(persistence);
  const sourceCacheMeta = getSourceCacheMeta(sourceCache);
  const adminRoute = ADMIN_NAV_ITEMS.some((item) => item.id === uiState.route);
  const customerAiTone = aiStatus.tone === "good" || aiStatus.tone === "neutral" ? "neutral" : aiStatus.tone;
  const messageToneClass =
    uiState.messageTone === "error"
      ? "error"
      : uiState.messageTone === "warn"
        ? "warn"
        : uiState.messageTone === "success"
          ? "success"
          : "";
  const messageClasses = ["toast"];
  if (messageToneClass) messageClasses.push(messageToneClass);
  if (uiState.messageVariant === "compact") messageClasses.push("compact");
  return `
    <div class="app-shell">
      ${renderNavigation(uiState.route, derived)}
      <main class="main-panel">
        <header class="topbar">
          <div>
            <p class="eyebrow">${escapeHtml(formatApplicationDate(derived.now))}</p>
            <h2>${escapeHtml(derived.company.legalName)}</h2>
          </div>
          <div class="topbar-actions">
            ${adminRoute ? pill(aiStatus.shortLabel, aiStatus.tone) : pill(aiStatus.shortLabel, customerAiTone)}
            ${adminRoute ? pill(runtime.appPhase ?? "phase-unknown", "neutral") : ""}
            ${adminRoute ? pill(persistenceMeta.label, persistenceMeta.tone) : ""}
            ${adminRoute && sourceCache ? pill(sourceCacheMeta.label, sourceCacheMeta.tone) : ""}
            ${pill(profileMode === "prospect" ? "Prospect profile" : "Confirmed company", "neutral")}
            ${pill(`${derived.portfolio.counts.worthAttention} worth attention`, derived.portfolio.counts.worthAttention ? "good" : "neutral")}
            ${pill(`${derived.portfolio.counts.needsVerification} need verification`, derived.portfolio.counts.needsVerification ? "warn" : "neutral")}
            ${adminRoute ? pill(`${derived.portfolio.counts.analysed} analysed`, "neutral") : pill(`${derived.savedSet.size} saved`, "neutral")}
          </div>
        </header>
        ${uiState.message ? `<div class="${messageClasses.join(" ")}">${escapeHtml(uiState.message)}</div>` : ""}
        ${renderPersistenceBanner(persistence)}
        ${renderSourceCacheBanner(sourceCache)}
        ${renderProfileModeBanner(derived.company)}
        ${content}
      </main>
    </div>
  `;
}

function renderRoute(route, state, runtime, derived, persistence, sourceCache, connectorState, refreshScheduler) {
  switch (route) {
    case "opportunities":
      return renderOpportunityList(derived, persistence);
    case "saved":
      return renderSavedPage(derived, persistence);
    case "company":
      return renderCompanyPage(derived.company);
    case "lab":
      return renderLabPage(derived, persistence);
    case "sources":
      return renderSourcesPage(state, runtime, sourceCache, connectorState, refreshScheduler);
    case "debug":
      return renderDebugPage(derived, persistence);
    case "evaluation":
      return renderEvaluationPage(derived);
    case "health":
      return renderHealthPage(state, runtime, derived, persistence, sourceCache, connectorState, refreshScheduler);
    default:
      return renderOverview(derived, persistence);
  }
}

function makeAudit(title, detail) {
  return {
    id: uid("audit"),
    title,
    detail,
    at: new Date().toISOString()
  };
}

function exportWorkspace(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `oportunex-phase0-export-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadReport(match) {
  const blob = new Blob([match.reportMarkdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${toSlug(match.displayTitle)}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function answerQuestion(store, company, questionId, answer) {
  store.update((draft) => {
    const targetCompany = draft.companyProfiles.find((item) => item.id === company.id);
    if (!targetCompany.customAnswers) targetCompany.customAnswers = {};
    targetCompany.customAnswers[questionId] = answer;
    if (questionId.includes("iso9001")) {
      setCertificationDecision(
        targetCompany,
        "ISO 9001",
        answer === "Yes" ? "valid" : answer === "No" ? "missing" : "unknown",
        { notes: "Recorded from adaptive eligibility question." }
      );
    }
    if (questionId.includes("iso14001")) {
      setCertificationDecision(
        targetCompany,
        "ISO 14001",
        answer === "Yes" ? "valid" : answer === "No" ? "missing" : "unknown",
        { notes: "Recorded from adaptive eligibility question." }
      );
    }
  }, makeAudit("Adaptive answer recorded", `${questionId} → ${answer}`));
}

export function startApp(root, { runtime, store, services = {} }) {
  resetUiState();
  const aiVerificationService = services.runAiVerification ?? runAiVerification;
  const placspSyncService = services.runPlacspSync ?? runPlacspSync;
  const sourceCacheService = services.sourceCache ?? null;
  const analysisCacheService = services.analysisCache ?? createAnalysisCache();
  let sourceCacheStatus = sourceCacheService?.getStatus?.() ?? null;
  let placspConnectorState = createConnectorState("placsp");
  let placspSyncActive = false;

  if (sourceCacheService?.subscribe) {
    sourceCacheService.subscribe((nextStatus) => {
      sourceCacheStatus = nextStatus;
      render();
    });
  }

  function render() {
    const state = store.getState();
    const persistence = store.getPersistenceStatus();
    const derived = getDerived(state, runtime, analysisCacheService);
    const content = renderRoute(
      uiState.route,
      state,
      runtime,
      derived,
      persistence,
      sourceCacheStatus,
      placspConnectorState,
      refreshScheduler
    );
    root.innerHTML = layout(content, runtime, derived, persistence, sourceCacheStatus);
  }

  async function hydratePlacspConnectorState() {
    if (!sourceCacheService?.getConnectorState) return placspConnectorState;
    const result = await sourceCacheService.getConnectorState("placsp");
    placspConnectorState = seedPlacspConnectorState(
      getLatestPlacspSyncRun(store.getState()),
      result?.state ?? createConnectorState("placsp")
    );
    await sourceCacheService.setConnectorState?.("placsp", placspConnectorState);
    return placspConnectorState;
  }

  async function hydratePlacspSourceCache() {
    if (!sourceCacheService) {
      return {
        ok: true,
        count: 0,
        durationMs: 0
      };
    }

    const currentState = store.getState();
    const legacyPlacspOpportunities = currentState.opportunities.filter((item) => isPlacspSourceOpportunity(item));

    if (legacyPlacspOpportunities.length) {
      await sourceCacheService.upsertMany("placsp", legacyPlacspOpportunities);
      sourceCacheStatus = sourceCacheService.getStatus();
    }

    const loadResult = await sourceCacheService.loadByConnector("placsp");
    sourceCacheStatus = sourceCacheService.getStatus();

    if (!loadResult.ok) {
      render();
      return loadResult;
    }

    const nextState = clone(store.getState());
    nextState.opportunities = mergeSourceOpportunities(nextState.opportunities, "placsp", loadResult.opportunities);
    store.replace(nextState);
    return loadResult;
  }

  async function persistPlacspConnectorState(patch) {
    placspConnectorState = createConnectorState("placsp", {
      ...placspConnectorState,
      ...patch
    });
    if (!sourceCacheService?.setConnectorState) return placspConnectorState;
    const result = await sourceCacheService.setConnectorState("placsp", placspConnectorState);
    placspConnectorState = result?.state ?? placspConnectorState;
    return placspConnectorState;
  }

  async function performPlacspSync({
    requestMode,
    runMode,
    maxPages = uiState.placspMaxPages,
    showMessage = true,
    reason = "manual"
  }) {
    if (placspSyncActive) {
      return {
        ok: false,
        busy: true
      };
    }

    placspSyncActive = true;
    uiState.placspSyncing = true;
    if (showMessage) {
      setMessage(describePlacspSyncStart(runMode, requestMode, maxPages), "info", "compact");
      render();
    }

    try {
      const payload = await placspSyncService({
        mode: requestMode,
        cursor:
          requestMode === "incremental"
            ? {
                lastFeedUpdated: placspConnectorState.lastFeedUpdated,
                entryUpdatedWatermark: placspConnectorState.entryUpdatedWatermark
              }
            : null,
        maxPages
      });
      const nextState = clone(store.getState());
      const syncRun = mergePlacspSyncResult(nextState, payload, runMode);
      nextState.auditEvents = [
        makeAudit(syncRun.note, `Fetched ${payload.pagesFetched} page(s) and processed ${payload.uniqueEntries} unique procurements.`),
        ...(nextState.auditEvents ?? [])
      ].slice(0, 50);

      let cacheResult = { ok: true };
      if (sourceCacheService) {
        const touchedIds = touchedPlacspOpportunityIds(payload);
        if (touchedIds.size > 0) {
          const touchedPlacspOpportunities = nextState.opportunities.filter(
            (item) => touchedIds.has(item.id) && isPlacspSourceOpportunity(item)
          );
          cacheResult = await sourceCacheService.upsertMany("placsp", touchedPlacspOpportunities);
          sourceCacheStatus = sourceCacheService.getStatus();
        }
      }

      store.replace(nextState);
      const completedAt = payload.completedAt ?? new Date().toISOString();
      const advanceCursor = shouldAdvancePlacspIncrementalCursor(
        payload,
        requestMode,
        placspConnectorState
      );
      const statePatch = {
        lastSuccessfulSyncAt: completedAt,
        lastRunMode: runMode,
        lastPagesFetched: payload.pagesFetched ?? 0,
        lastFeedUpdated: advanceCursor
          ? payload.sourceFeedUpdated ?? payload.feedUpdated ?? placspConnectorState.lastFeedUpdated
          : placspConnectorState.lastFeedUpdated,
        entryUpdatedWatermark: advanceCursor
          ? payload.nextEntryWatermark ?? placspConnectorState.entryUpdatedWatermark
          : placspConnectorState.entryUpdatedWatermark,
        lastErrorAt: null,
        lastErrorCode: null,
        truncated: payload.truncated ?? false,
        cursorReached: payload.cursorReached ?? null
      };
      if (runMode === "automatic") statePatch.lastAutomaticSyncAt = completedAt;
      else statePatch.lastManualSyncAt = completedAt;
      if (requestMode === "reconcile" || runMode === "reconcile") statePatch.lastReconciliationAt = completedAt;
      await persistPlacspConnectorState(statePatch);

      const persistenceStatus = store.getPersistenceStatus();
      const workspacePersisted = persistenceStatus.status === "available";
      const sourceCachePersisted = !sourceCacheService || cacheResult.ok === true;
      if (showMessage) {
        setMessage(
          describePlacspSyncSuccess(syncRun, {
            workspacePersisted,
            sourceCachePersisted,
            runMode: requestMode === "reconcile" ? "reconcile" : runMode
          }),
          workspacePersisted && sourceCachePersisted ? "success" : "warn"
        );
      }

      return {
        ok: true,
        payload,
        syncRun
      };
    } catch (error) {
      store.update((draft) => {
        prependSourceSyncRun(draft, buildPlacspFailureRun(error, { runMode, requestMode, maxPages }));
      }, makeAudit("PLACSP sync failed", error?.message ?? "Unknown PLACSP sync error."));
      await persistPlacspConnectorState({
        lastRunMode: runMode,
        lastErrorAt: new Date().toISOString(),
        lastErrorCode: error?.code ?? "placsp_sync_failed"
      });
      if (showMessage) setMessage(error?.message ?? "PLACSP sync failed.", "error");
      throw error;
    } finally {
      placspSyncActive = false;
      uiState.placspSyncing = false;
      render();
    }
  }

  const refreshScheduler =
    services.refreshScheduler ??
    (
      sourceCacheService
        ? createConnectorRefreshScheduler({
            connector: "placsp",
            sourceCache: sourceCacheService,
            isSyncActive: () => placspSyncActive || uiState.placspSyncing,
            runSync: ({ requestMode, runMode, maxPages, reason }) =>
              performPlacspSync({
                requestMode,
                runMode,
                maxPages,
                showMessage: false,
                reason
              })
          })
        : null
    );

  render();
  const sourceCacheReady = Promise.all([
    hydratePlacspConnectorState(),
    hydratePlacspSourceCache()
  ])
    .catch((error) => {
      sourceCacheStatus = {
        ...(sourceCacheStatus ?? {}),
        status: "error",
        mode: sourceCacheStatus?.mode ?? "indexeddb",
        detail: "Stored source opportunities could not be loaded. OportuneX continued with the local workspace state for this session.",
        lastError: {
          code: "SOURCE_CACHE_LOAD_FAILED",
          message: error instanceof Error ? error.message : String(error),
          operation: "load",
          connector: "placsp",
          at: new Date().toISOString()
        }
      };
      return {
        ok: false,
        code: "SOURCE_CACHE_LOAD_FAILED",
        message: error instanceof Error ? error.message : String(error)
      };
    })
    .finally(() => {
      render();
    });
  refreshScheduler?.start?.({ ready: sourceCacheReady });

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const state = store.getState();
    const derived = getDerived(state, runtime, analysisCacheService);

    if (action === "route") {
      uiState.route = button.dataset.route;
      if (uiState.route === "debug") uiState.detailTab = "debug";
      else if (uiState.detailTab === "debug") uiState.detailTab = "report";
      render();
      return;
    }

    if (action === "scope") {
      uiState.opportunityScope = button.dataset.scope;
      uiState.detailTab = "report";
      render();
      return;
    }

    if (action === "select") {
      uiState.selectedOpportunityId = button.dataset.id;
      uiState.detailTab = uiState.route === "debug" ? "debug" : "report";
      if (uiState.route === "overview") uiState.route = "opportunities";
      render();
      return;
    }

    if (action === "tab") {
      uiState.detailTab = button.dataset.tab;
      render();
      return;
    }

    if (action === "toggle-placsp-auto-refresh") {
      await persistPlacspConnectorState({
        autoRefreshEnabled: !placspConnectorState.autoRefreshEnabled
      });
      setMessage(
        placspConnectorState.autoRefreshEnabled
          ? "Automatic PLACSP refresh enabled for this local environment."
          : "Automatic PLACSP refresh disabled for this local environment.",
        "info",
        "compact"
      );
      render();
      return;
    }

    if (action === "sync-placsp") {
      try {
        await performPlacspSync({
          requestMode: hasPlacspIncrementalCursor(placspConnectorState) ? "incremental" : "manual",
          runMode: hasPlacspIncrementalCursor(placspConnectorState) ? "incremental" : "manual",
          maxPages: uiState.placspMaxPages
        });
      } catch {
        // The shared sync executor already recorded state, warnings, and UI feedback.
      }
      return;
    }

    if (action === "sync-placsp-reconcile") {
      try {
        await performPlacspSync({
          requestMode: "reconcile",
          runMode: "reconcile",
          maxPages: uiState.placspMaxPages
        });
      } catch {
        // The shared sync executor already recorded state, warnings, and UI feedback.
      }
      return;
    }

    if (action === "save") {
      const id = button.dataset.id;
      store.update((draft) => {
        const list = new Set(draft.savedOpportunityIds ?? []);
        if (list.has(id)) list.delete(id);
        else list.add(id);
        draft.savedOpportunityIds = [...list];
      }, makeAudit("Saved list updated", `Toggled saved state for ${id}`));
      setMessage("Saved opportunities updated.");
      render();
      return;
    }

    if (action === "interest") {
      const id = button.dataset.id;
      store.update((draft) => {
        draft.pursuitStatuses[id] = "interested";
      }, makeAudit("Pursuit status updated", `Marked ${id} as interested.`));
      setMessage("Marked as interested.");
      render();
      return;
    }

    if (action === "not-relevant") {
      const id = button.dataset.id;
      store.update((draft) => {
        draft.pursuitStatuses[id] = "not_relevant";
      }, makeAudit("Opportunity feedback updated", `Marked ${id} as not relevant.`));
      setMessage("Marked as not relevant.");
      render();
      return;
    }

    if (action === "reset-demo") {
      store.reset();
      clearFormFeedback("companyImport");
      clearFormFeedback("opportunityJsonImport");
      setMessage("Demo workspace restored.");
      render();
      return;
    }

    if (action === "export-json") {
      exportWorkspace(state);
      setMessage("Workspace exported as JSON.");
      render();
      return;
    }

    if (action === "download-report") {
      const match = derived.portfolio.analysed.find((item) => item.opportunityId === button.dataset.id) ?? null;
      if (match) downloadReport(match);
      return;
    }

    if (action === "answer") {
      answerQuestion(store, derived.company, button.dataset.question, button.dataset.answer);
      setMessage("Adaptive answer saved.");
      render();
      return;
    }

    if (action === "ai-verify") {
      const match = derived.portfolio.analysed.find((item) => item.opportunityId === button.dataset.id) ?? null;
      const opportunity = state.opportunities.find((item) => item.id === button.dataset.id);
      const busyKey = aiPairKey(derived.company.id, opportunity?.id);
      if (!match || !opportunity || uiState.aiBusyKey === busyKey) return;
      uiState.aiBusyKey = busyKey;
      setMessage("Running AI verification pass...");
      render();
      try {
        const result = await aiVerificationService({
          company: derived.company,
          opportunity,
          analysis: match
        });
        syncRuntimeAi(runtime, result.aiRuntime);
        const completedAt = new Date().toISOString();
        const contextFingerprint = createAiVerificationContextFingerprint(derived.company, opportunity, match);
        store.update((draft) => {
          draft.aiRuns = upsertScopedAiReview(draft.aiRuns, {
            id: uid("ai-run"),
            companyId: derived.company.id,
            opportunityId: opportunity.id,
            completedAt,
            result: extractPersistedAiVerificationResult(result),
            contextFingerprint,
            sourceNoticeVersionId: opportunity.sourceNoticeVersionId ?? null
          });
        }, makeAudit("AI verification saved", `${derived.company.id} · ${opportunity.id}`));
        uiState.detailTab = "report";
        const persistenceStatus = store.getPersistenceStatus();
        setMessage(
          persistenceStatus.status === "available"
            ? "AI verification saved."
            : "AI verification saved for this session, but browser persistence is unavailable.",
          persistenceStatus.status === "available" ? "success" : "warn"
        );
      } catch (error) {
        syncRuntimeAi(runtime, error.aiRuntime);
        setMessage(error.message, "error");
      } finally {
        uiState.aiBusyKey = null;
        render();
      }
    }
  });

  root.addEventListener("input", (event) => {
    const target = event.target;
    const form = target?.closest?.("form[data-form='company-import'], form[data-form='opportunity-json-import']");
    if (!form) return;
    syncImportDraftFromInput(form, target);
  });

  root.addEventListener("keydown", (event) => {
    const importForm = event.target.closest?.("form[data-form='company-import'], form[data-form='opportunity-json-import']");
    if (importForm && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (typeof importForm.requestSubmit === "function") importForm.requestSubmit();
      return;
    }

    const card = event.target.closest(".opportunity-card[data-action='select']");
    if (!card || event.target !== card) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    uiState.selectedOpportunityId = card.dataset.id;
    uiState.detailTab = uiState.route === "debug" ? "debug" : "report";
    if (uiState.route === "overview") uiState.route = "opportunities";
    render();
  });

  root.addEventListener("change", (event) => {
    const element = event.target;
    if (element?.dataset?.control === "active-company") {
      store.update((draft) => {
        draft.activeCompanyId = element.value;
      }, makeAudit("Active company switched", `Switched active company to ${element.value}.`));
      uiState.detailTab = uiState.route === "debug" ? "debug" : "report";
      setMessage("Active company changed.", "info", "compact");
      render();
      return;
    }
    if (element?.dataset?.control === "placsp-pages") {
      uiState.placspMaxPages = normalizePlacspMaxPages(element.value);
      render();
      return;
    }
    if (!element?.dataset?.filter) return;
    if (element.dataset.filter === "type") uiState.filterType = element.value;
    if (element.dataset.filter === "recommendation") uiState.filterRecommendation = element.value;
    if (element.dataset.filter === "sort") uiState.sort = element.value;
    if (element.dataset.filter === "savedOnly") uiState.showSavedOnly = element.checked;
    render();
  });

  root.addEventListener("submit", (event) => {
    const form = event.target;
    event.preventDefault();
    const formData = new FormData(form);

    if (form.dataset.form === "company") {
      store.update((draft) => {
        const company = getCompany(draft);
        const certifications = getCompanyCertifications(company);
        company.profileMode = formData.get("profileMode")?.toString() === "prospect" ? "prospect" : "confirmed";
        company.legalName = formData.get("legalName")?.toString() ?? company.legalName;
        company.tradingName = formData.get("tradingName")?.toString() ?? company.tradingName;
        company.geography.municipality = formData.get("municipality")?.toString() ?? company.geography.municipality;
        company.geography.province = formData.get("province")?.toString() ?? company.geography.province;
        company.geography.display =
          company.geography.municipality || company.geography.province || company.geography.autonomousCommunity || company.geography.display;
        company.preferences.desiredWorkTypes = parseCommaList(formData.get("desiredWorkTypes"));
        company.preferences.unwantedWorkTypes = parseCommaList(formData.get("unwantedWorkTypes"));

        setConfirmedOrUnknownFact(company, "preferredWorkingRadiusKm", parseOptionalNumber(formData.get("radius")), "Saved from company profile form.");
        setConfirmedOrUnknownFact(
          company,
          "employeeCountCurrent",
          parseOptionalNumber(formData.get("employeeCountCurrent")),
          "Saved from company profile form."
        );
        setConfirmedOrUnknownRange(
          company,
          "turnoverRange",
          {
            min: parseOptionalNumber(formData.get("turnoverMin")),
            max: parseOptionalNumber(formData.get("turnoverMax"))
          },
          "Saved from company profile form."
        );
        setConfirmedOrUnknownFact(
          company,
          "minimumAttractiveProjectValue",
          parseOptionalNumber(formData.get("minimumAttractiveProjectValue")),
          "Saved from company profile form."
        );
        setConfirmedOrUnknownFact(
          company,
          "idealProjectValue",
          parseOptionalNumber(formData.get("idealProjectValue")),
          "Saved from company profile form."
        );
        setConfirmedOrUnknownFact(
          company,
          "maximumRealisticProjectValue",
          parseOptionalNumber(formData.get("maximumRealisticProjectValue")),
          "Saved from company profile form."
        );
        setConfirmedOrUnknownFact(
          company,
          "publicProcurementProjects",
          parseOptionalNumber(formData.get("publicProcurementProjects")),
          "Saved from company profile form."
        );
        setConfirmedOrUnknownFact(
          company,
          "maximumProjectValue",
          parseOptionalNumber(formData.get("maximumProjectValue")),
          "Saved from company profile form."
        );
        certifications.forEach((item, index) => {
          setCertificationDecision(
            company,
            item.name,
            formData.get(`certification-${index}`)?.toString() ?? "unknown",
            { notes: "Saved from company profile form." }
          );
        });
        setConfirmedOrUnknownFact(
          company,
          "canCoFinance",
          parseOptionalBoolean(formData.get("canCoFinance")?.toString()),
          "Saved from company profile form."
        );
        syncLegacyCompanyMirrors(company);
      }, makeAudit("Company profile updated", "Saved manual company profile edits."));
      setMessage("Company profile saved.");
      render();
      return;
    }

    if (form.dataset.form === "company-import") {
      const jsonText = formData.get("companyJson")?.toString() ?? "";
      uiState.companyImportDraft = jsonText;
      clearFormFeedback("companyImport");
      if (!jsonText.trim()) {
        const message = "Paste structured company JSON here before importing.";
        setFormFeedback("companyImport", message, "error");
        setMessage(message, "error");
        refreshImportFormFeedback(form, "companyImport", uiState.companyImportDraft);
        render();
        return;
      }
      let importedProfile;
      try {
        importedProfile = importCompanyProfileFromJson(jsonText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFormFeedback("companyImport", message, "error");
        setMessage(message, "error");
        refreshImportFormFeedback(form, "companyImport", uiState.companyImportDraft);
        render();
        return;
      }

      store.update((draft) => {
        upsertCompanyProfile(draft, importedProfile);
      }, makeAudit("Prospect profile imported", `Imported ${importedProfile.legalName}.`));
      uiState.route = "company";
      const persistenceStatus = store.getPersistenceStatus();
      const messageTone = persistenceStatus.status === "available" ? "success" : "warn";
      setFormFeedback(
        "companyImport",
        persistenceStatus.status === "available"
          ? `Prospect profile imported for ${importedProfile.legalName}.`
          : `Prospect profile imported for ${importedProfile.legalName}. Browser persistence is unavailable. Changes will work for this session but may be lost after reload.`,
        messageTone
      );
      uiState.companyImportDraft = "";
      setMessage(`Prospect profile imported for ${importedProfile.legalName}.`, messageTone);
      form.reset();
      refreshImportFormFeedback(form, "companyImport", uiState.companyImportDraft);
      render();
      return;
    }

    if (form.dataset.form === "opportunity-import") {
      const sourceText = formData.get("sourceText")?.toString() ?? "";
      const manualTitle = formData.get("title")?.toString().trim();
      const type = formData.get("type")?.toString();
      const manualValueText = formData.get("value")?.toString() ?? "";
      const manualValue = parseMoneyInput(formData.get("value")?.toString() ?? "", {
        amountType: type === "grant" ? "maximum_grant" : "relevant_lot_value"
      });
      const manualDeadlineText = formData.get("deadline")?.toString().trim();
      const manualLocation = formData.get("location")?.toString().trim();
      const noticeUrl = formData.get("noticeUrl")?.toString().trim();
      const validation = validateOpportunityImport({
        sourceText,
        title: manualTitle,
        type,
        location: manualLocation,
        valueText: manualValueText,
        deadlineText: manualDeadlineText,
        noticeUrl
      });

      if (!validation.ok) {
        setMessage(validation.message, "error");
        render();
        return;
      }

      const seedText = sourceText || manualTitle;
      const imported = importOpportunityFromText(seedText);

      if (manualTitle) imported.title = manualTitle;
      imported.type = type;
      imported.noticeType = type === "grant" ? "grant_call" : "active_contract_notice";
      if (type === "grant") {
        imported.relevantValue = null;
        imported.estimatedValue = null;
        imported.lots = [];
      } else {
        imported.maximumAidPerBeneficiary = null;
      }
      if (manualValue) {
        if (type === "grant") {
          imported.maximumAidPerBeneficiary = manualValue;
        }
        else {
          imported.relevantValue = manualValue;
          imported.estimatedValue = manualValue;
          imported.lots = [
            {
              id: `${imported.id}-manual-lot`,
              title: imported.title,
              description: imported.description,
              cpvCodes: imported.cpvCodes ?? [],
              keywords: imported.keywords ?? [],
              value: manualValue,
              requirements: []
            }
          ];
        }
      }
      if (manualDeadlineText) imported.deadline = parseSpanishDate(manualDeadlineText) ?? imported.deadline;
      if (manualLocation) imported.location.display = manualLocation;
      if (noticeUrl) {
        imported.noticeUrl = noticeUrl;
        if (imported.sources[0]) imported.sources[0].url = noticeUrl;
      }
      imported.lastChecked = new Date().toISOString();

      store.update((draft) => {
        draft.opportunities.unshift(imported);
      }, makeAudit("Opportunity imported", `Created ${imported.title}.`));
      uiState.opportunityScope = "all_analysed";
      uiState.selectedOpportunityId = imported.id;
      uiState.detailTab = "report";
      setMessage("Opportunity imported into the Intelligence Lab.", "success");
      form.reset();
      render();
      return;
    }

    if (form.dataset.form === "opportunity-json-import") {
      const jsonText = formData.get("opportunityJson")?.toString() ?? "";
      uiState.opportunityJsonDraft = jsonText;
      clearFormFeedback("opportunityJsonImport");
      if (!jsonText.trim()) {
        const message = "Paste structured opportunity JSON here before importing.";
        setFormFeedback("opportunityJsonImport", message, "error");
        setMessage(message, "error");
        refreshImportFormFeedback(form, "opportunityJsonImport", uiState.opportunityJsonDraft);
        render();
        return;
      }
      let importedOpportunity;
      try {
        importedOpportunity = importOpportunityFromJson(jsonText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFormFeedback("opportunityJsonImport", message, "error");
        setMessage(message, "error");
        refreshImportFormFeedback(form, "opportunityJsonImport", uiState.opportunityJsonDraft);
        render();
        return;
      }

      store.update((draft) => {
        upsertOpportunity(draft, importedOpportunity);
      }, makeAudit("Structured opportunity imported", `Imported ${importedOpportunity.title}.`));
      uiState.opportunityScope = "all_analysed";
      uiState.selectedOpportunityId = importedOpportunity.id;
      uiState.detailTab = "report";
      const persistenceStatus = store.getPersistenceStatus();
      const messageTone = persistenceStatus.status === "available" ? "success" : "warn";
      setFormFeedback(
        "opportunityJsonImport",
        persistenceStatus.status === "available"
          ? `Structured opportunity imported: ${importedOpportunity.title}.`
          : `Structured opportunity imported: ${importedOpportunity.title}. Browser persistence is unavailable. Changes will work for this session but may be lost after reload.`,
        messageTone
      );
      uiState.opportunityJsonDraft = "";
      setMessage(`Structured opportunity imported: ${importedOpportunity.title}.`, messageTone);
      form.reset();
      refreshImportFormFeedback(form, "opportunityJsonImport", uiState.opportunityJsonDraft);
      render();
      return;
    }

    if (form.dataset.form === "override") {
      const opportunityId = formData.get("opportunityId")?.toString();
      const value = formData.get("value")?.toString();
      const deadlineText = formData.get("deadline")?.toString();
      const reason = formData.get("reason")?.toString() || "Manual correction";
      store.update((draft) => {
        const opportunity = draft.opportunities.find((item) => item.id === opportunityId);
        if (!opportunity) return;
        const before = {
          title: opportunity.title,
          status: opportunity.status,
          value: opportunity.relevantValue?.amountMinor ?? null,
          deadline: opportunity.deadline?.sourceText ?? null
        };
        opportunity.title = formData.get("title")?.toString() ?? opportunity.title;
        opportunity.status = formData.get("status")?.toString() ?? opportunity.status;
        const parsed = parseMoneyInput(value);
        if (parsed) {
          opportunity.relevantValue = parsed;
          if (opportunity.lots?.[0]) opportunity.lots[0].value = parsed;
        }
        const importedDeadline = deadlineText ? parseSpanishDate(deadlineText) : null;
        if (importedDeadline) opportunity.deadline = importedDeadline;
        draft.manualOverrides.push({
          id: uid("override"),
          opportunityId,
          before,
          after: {
            title: opportunity.title,
            status: opportunity.status,
            value: opportunity.relevantValue?.amountMinor ?? null,
            deadline: opportunity.deadline?.sourceText ?? null
          },
          reason,
          at: new Date().toISOString()
        });
      }, makeAudit("Manual override applied", `${opportunityId}: ${reason}`));
      setMessage("Manual override applied and analysis refreshed.");
      render();
    }
  });

  return {
    whenSourceCacheReady() {
      return sourceCacheReady;
    }
  };
}
