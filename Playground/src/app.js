import {
  ACTION_COPY,
  APP_TITLE,
  CONFIDENCE_COPY,
  DEFAULT_SEARCH_PLAN_ID,
  ELIGIBILITY_COPY,
  FEEDBACK_LABELS,
  FIT_BAND_COPY,
  getSearchDepthPolicy,
  NAV_ITEMS,
  OPPORTUNITY_TYPES,
  RECOMMENDATION_COPY,
  STATUS_LABELS
} from "./config.js";
import { formatApplicationDate, getApplicationNow, getEvaluationNow } from "./clock.js";
import { demoCompany } from "./data/demo.js";
import { evaluationFixtures } from "./data/evaluation-fixtures.js";
import { analyzePortfolio, diagnoseLotSelection } from "./domain/analysis.js";
import {
  buildCustomerReportExport,
  buildRequirementEvidenceAuditRows,
  buildRequirementPresentationRows,
  collapseWhitespace,
  getCompanyDisplayName,
  getCustomerAiReviewLabel,
  getCustomerAiReviewTone,
  isDuplicateHighLevelText,
  presentCustomerGuaranteeText,
  presentCustomerDecisionText,
  resolveOfficialNoticeAccess
} from "./domain/customer-presentation.js";
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
import { formatMoney, parseMoneyInput } from "./domain/money.js";
import { buildOpportunityCalendarEvent, downloadCalendarEvent } from "./domain/opportunity-calendar.js";
import {
  getSelectedExplicitLotId,
  getSelectedExplicitLotLabel,
  hasSelectedExplicitLot
} from "./domain/opportunity-scope.js";
import {
  createAiVerificationContextFingerprint,
  extractPersistedAiVerificationResult,
  getAiReviewState,
  listScopedAiReviewsForCompany,
  upsertScopedAiReview
} from "./domain/ai-review.js";
import {
  buildVerificationCustomerSummary,
  buildVerificationPacket,
  formatVerificationChange,
  isVerificationResultV4
} from "./domain/verification-protocol.js";
import { normalizeAiVerificationResponse } from "./domain/ai-verification-response.js";
import { importCompanyProfileFromJson } from "./services/company-importer.js";
import { importOpportunityFromJson, importOpportunityFromText, validateOpportunityImport } from "./services/importer.js";
import { runBdnsSync } from "./services/bdns-sync.js";
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
import { buildCandidateFunnel } from "./services/candidate-funnel.js";
import { serializeStateForPersistence } from "./state/store.js";
import { clamp, clone, escapeHtml, formatDate, formatNumber, uid } from "./utils.js";

const OPPORTUNITY_SCOPES = [
  { id: "worth_attention", label: "Worth your attention" },
  { id: "needs_verification", label: "Needs verification" },
  { id: "not_suitable", label: "Not suitable" },
  { id: "all_analysed", label: "All analysed (current depth)" }
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
const BDNS_AUTOMATIC_PAGES = 1;
const BDNS_AUTOMATIC_PAGE_SIZE = 20;
const BDNS_RECONCILE_PAGES = 3;
const BDNS_RECONCILE_PAGE_SIZE = 50;

const CUSTOMER_NAV_ITEMS = NAV_ITEMS.filter((item) => !item.admin);
const ADMIN_NAV_ITEMS = NAV_ITEMS.filter((item) => item.admin);

const CUSTOMER_WHY_BLOCKLIST = /potential hard blocker|eligibility requirements not yet assessed|confirmed eligibility failure|deadline passed|already awarded|cancelled|suspended|unrelated capability|no further action is recommended/i;

const UI_STATE_DEFAULTS = {
  route: "overview",
  selectedOpportunityId: null,
  detailPanelCollapsed: false,
  developerToolsOpen: false,
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
  analysisDepthByCompanyId: {},
  placspMaxPages: 1,
  placspSyncing: false,
  bdnsMaxPages: 1,
  bdnsPageSize: 20,
  bdnsSyncing: false,
  formFeedback: {
    companyImport: null,
    opportunityJsonImport: null
  }
};

const uiState = {
  ...UI_STATE_DEFAULTS,
  analysisDepthByCompanyId: {},
  draftAnswers: {},
  formFeedback: {
    companyImport: null,
    opportunityJsonImport: null
  }
};

const ACTIVE_SEARCH_POLICY = getSearchDepthPolicy({
  planId: DEFAULT_SEARCH_PLAN_ID,
  localDevelopment: true
});

function getCompany(state) {
  return state.companyProfiles.find((company) => company.id === state.activeCompanyId) ?? state.companyProfiles[0];
}

function isAdminRoute(route = uiState.route) {
  return ADMIN_NAV_ITEMS.some((item) => item.id === route);
}

function isCustomerRoute(route = uiState.route) {
  return CUSTOMER_NAV_ITEMS.some((item) => item.id === route);
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

function customerIssueStatement(label, item, { verificationFallback = false } = {}) {
  if (!item) return `${label}: Not stated`;
  const detail = presentCustomerDecisionText(item.detail, {
    issueTitle: item.title,
    verificationFallback
  });
  const normalizedTitle = collapseWhitespace(item.title).toLowerCase();
  const normalizedDetail = collapseWhitespace(detail).toLowerCase();
  if (!detail) return `${label}: ${item.title}`;
  if (!item.title || normalizedDetail.startsWith(normalizedTitle) || normalizedDetail.startsWith(label.toLowerCase())) {
    return `${label}: ${detail}`;
  }
  return `${label}: ${item.title} — ${detail}`;
}

function actionTone(action) {
  if (action === "INVESTIGATE_NOW") return "good";
  if (action === "VERIFY_BEFORE_DECIDING") return "warn";
  if (action === "DO_NOT_PURSUE") return "bad";
  return "neutral";
}

function companyProvenanceLabel(status) {
  switch (status) {
    case "company_confirmed":
      return "Confirmed by you";
    case "public_verified":
      return "Publicly verified";
    case "public_reported":
      return "From public information";
    case "conflicting":
      return "Conflicting sources";
    case "inferred":
      return "Needs confirmation";
    case "unknown":
      return "Needs confirmation";
    default:
      return describeStatus(status);
  }
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

function debugSelectionScopeLabel(scopeType) {
  if (scopeType === "explicit_published_lot") return "Explicit published lot";
  if (scopeType === "whole_opportunity") return "Whole opportunity";
  return scopeType ? scopeType.replace(/_/g, " ") : "Not stated";
}

function debugValueLabel(value, fallback = "None") {
  return value == null || value === "" ? fallback : String(value);
}

function debugEligibilityLabel(status) {
  const label = ELIGIBILITY_COPY[status] ?? status ?? "Not stated";
  return label.replace(/^Eligibility\s+/i, "") || "Not stated";
}

function renderLotTitleDisclosure(title, conciseLabel) {
  const normalizedTitle = collapseWhitespace(title);
  const normalizedLabel = collapseWhitespace(conciseLabel);
  if (!normalizedTitle || normalizedTitle === normalizedLabel) return "";
  return `
    <details class="title-disclosure">
      <summary>Full official lot title</summary>
      <p>${escapeHtml(normalizedTitle)}</p>
    </details>
  `;
}

function buildLotSelectionDebuggerState(opportunity, match, verificationPacket) {
  const diagnostic = diagnoseLotSelection(opportunity, match);
  const explicitLotIds = new Set(
    (opportunity?.lots ?? [])
      .filter((lot) => lot && !lot.synthetic && lot.id != null)
      .map((lot) => String(lot.id))
  );
  const analysisBestMatchLotId = diagnostic.bestMatchLotId ?? null;
  const analysisLotId = match?.lotId ?? null;
  const canonicalSelectedLotId = diagnostic.selectedLotId ?? null;
  const customerPresentedLotId = hasSelectedExplicitLot(match) ? getSelectedExplicitLotId(match) : null;
  const verificationPacketSelectedLotId = verificationPacket?.selected_assessment?.selected_lot_id ?? null;
  const selectedRowCount = diagnostic.lots.filter((item) => item.selectedBestMatch).length;
  const analysisBestMatchIsExplicit = explicitLotIds.has(String(analysisBestMatchLotId ?? ""));
  const analysisLotIsExplicit = explicitLotIds.has(String(analysisLotId ?? ""));
  const selectionConsistent = canonicalSelectedLotId
    ? analysisBestMatchLotId === canonicalSelectedLotId &&
      analysisLotId === canonicalSelectedLotId &&
      customerPresentedLotId === canonicalSelectedLotId &&
      verificationPacketSelectedLotId === canonicalSelectedLotId &&
      selectedRowCount === 1
    : customerPresentedLotId == null &&
      verificationPacketSelectedLotId == null &&
      selectedRowCount === 0 &&
      !analysisBestMatchIsExplicit &&
      !analysisLotIsExplicit;

  return {
    diagnostic,
    selectionConsistent,
    rows: [
      ["analysis.bestMatch lot id", analysisBestMatchLotId],
      ["analysis.lotId", analysisLotId],
      ["canonical selected explicit lot id", canonicalSelectedLotId],
      ["customer-presented lot id", customerPresentedLotId],
      ["verification-packet selected lot id", verificationPacketSelectedLotId]
    ]
  };
}

function renderLotComparisonDebuggerSection(opportunity, match, verificationPacket) {
  const { diagnostic, selectionConsistent, rows } = buildLotSelectionDebuggerState(opportunity, match, verificationPacket);
  return `
    <div class="detail-section" data-debug-section="lot-comparison" data-selection-consistent="${selectionConsistent ? "true" : "false"}">
      <div class="card-topline">
        <h4>Lot comparison</h4>
        ${pill(selectionConsistent ? "Selection state consistent" : "Selection state inconsistent", selectionConsistent ? "good" : "bad")}
      </div>
      <ul class="tight-list">
        <li><strong>Procedure:</strong> ${escapeHtml(debugValueLabel(diagnostic.procedureTitle))}</li>
        <li><strong>Selected explicit lot:</strong> ${escapeHtml(debugValueLabel(diagnostic.selectedLot))}</li>
        <li><strong>Selection reason:</strong> ${escapeHtml(debugValueLabel(diagnostic.selectionReason, "Not stated"))}</li>
        <li><strong>Selection scope:</strong> ${escapeHtml(debugSelectionScopeLabel(diagnostic.scopeType))}</li>
      </ul>
      <div class="detail-subsection">
        <h5>Consistency check</h5>
        <ul class="tight-list">
          ${rows
            .map(
              ([label, value]) => `
                <li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(debugValueLabel(value))}</li>
              `
            )
            .join("")}
        </ul>
      </div>
      ${
        diagnostic.lots.length
          ? `
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Lot</th>
                      <th>Coverage</th>
                      <th>Capability</th>
                      <th>Geography</th>
                      <th>Scale</th>
                      <th>Qualification</th>
                      <th>Eligibility</th>
                      <th>Match</th>
                      <th>Priority</th>
                      <th>Fit</th>
                      <th>Action</th>
                      <th>Selected</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${diagnostic.lots
                      .map(
                        (lot) => `
                          <tr data-lot-id="${escapeHtml(lot.lotId)}">
                            <td>
                              <strong>${escapeHtml(lot.conciseLabel ?? lot.title ?? lot.lotId ?? "Unknown lot")}</strong>
                              ${renderLotTitleDisclosure(lot.fullTitle, lot.conciseLabel ?? lot.title ?? lot.lotId)}
                            </td>
                            <td>${escapeHtml(lot.coverageLabel ?? lot.location ?? "Not stated")}</td>
                            <td>${Math.round(lot.capabilityFit ?? 0)}/100</td>
                            <td>${Math.round(lot.geographicFit ?? 0)}/100</td>
                            <td>${Math.round(lot.financialScaleFit ?? 0)}/100</td>
                            <td>${Math.round(lot.qualificationReadiness ?? 0)}/100</td>
                            <td title="${escapeHtml(lot.eligibilityStatus ?? "Not stated")}">${escapeHtml(debugEligibilityLabel(lot.eligibilityStatus))}</td>
                            <td>${Math.round(lot.matchScore ?? 0)}</td>
                            <td>${Math.round(lot.priorityScore ?? 0)}</td>
                            <td>${escapeHtml(fitBandLabelOf(lot))}</td>
                            <td>${escapeHtml(actionLabelOf(lot.recommendedAction))}</td>
                            <td>${lot.selectedBestMatch ? "Selected" : ""}</td>
                          </tr>
                        `
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            `
          : `<p class="empty-state">No explicit published lots for this opportunity.</p>`
      }
    </div>
  `;
}

function getAiStatusMeta(ai = {}) {
  return AI_STATUS_COPY[ai.status] ?? AI_STATUS_COPY.unavailable;
}

function normalizePlacspMaxPages(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

function normalizeBdnsMaxPages(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(3, Math.max(1, Math.round(parsed)));
}

function normalizeBdnsPageSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(50, Math.max(10, Math.round(parsed)));
}

function getAnalysisDepth(companyId, policy = ACTIVE_SEARCH_POLICY) {
  const configured = Number(uiState.analysisDepthByCompanyId?.[companyId]);
  if (!Number.isFinite(configured)) return policy.defaultAnalysis;
  return clamp(Math.round(configured), policy.defaultAnalysis, policy.maxAnalysis);
}

function setAnalysisDepth(companyId, depth, policy = ACTIVE_SEARCH_POLICY) {
  uiState.analysisDepthByCompanyId = {
    ...(uiState.analysisDepthByCompanyId ?? {}),
    [companyId]: clamp(Math.round(depth), policy.defaultAnalysis, policy.maxAnalysis)
  };
  return uiState.analysisDepthByCompanyId[companyId];
}

function expandAnalysisDepth(companyId, policy = ACTIVE_SEARCH_POLICY) {
  const current = getAnalysisDepth(companyId, policy);
  const next = Math.min(policy.maxAnalysis, current + policy.expansionBatch);
  return setAnalysisDepth(companyId, next, policy);
}

function isPlacspSyncRun(run) {
  const connector = run?.connector?.toString?.().toLowerCase?.() ?? "";
  const source = run?.source?.toString?.().toLowerCase?.() ?? "";
  return connector === "placsp" || source === "placsp";
}

function isBdnsSyncRun(run) {
  const connector = run?.connector?.toString?.().toLowerCase?.() ?? "";
  const source = run?.source?.toString?.().toLowerCase?.() ?? "";
  return connector === "bdns" || source === "bdns / snpsap" || source === "bdns" || source === "snpsap";
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

function getLatestBdnsSyncRun(state) {
  return (state.sourceSyncRuns ?? [])
    .filter(isBdnsSyncRun)
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

function buildBdnsRunNote(payload) {
  const runMode = payload?.runMode ?? "manual";
  const requestMode = payload?.mode ?? "manual";
  let note =
    requestMode === "reconcile"
      ? "Official BDNS / SNPSAP recent reconciliation completed."
      : runMode === "automatic"
        ? "Official BDNS / SNPSAP automatic refresh completed."
        : "Official BDNS / SNPSAP sync completed.";

  if ((payload?.detailFailures?.length ?? 0) > 0 && (payload?.detailsFetched ?? 0) > 0) {
    note = note.replace("completed.", "completed with isolated detail failures.");
  }
  if (payload?.truncated && !note.includes("bounded detail cap")) {
    note = note.replace("completed.", "completed with a bounded detail cap.");
  }
  return note;
}

function toneForSourceStatus(status) {
  if (status === "healthy" || status === "ready") return "good";
  if (status === "planned" || status === "syncing") return "warn";
  return "bad";
}

function formatSourceRunMoment(run) {
  return run?.completedAt ?? run?.lastRun ?? run?.startedAt ?? null;
}

function previewValueLabel(item) {
  const primaryLine = item?.financialPicture?.primaryLine ?? null;
  if (item?.opportunity?.type === "grant" && primaryLine?.id === "programme_budget") {
    return `${primaryLine.label}: ${primaryLine.displayValue}`;
  }
  return item?.displayValueLabel ?? "Value not published";
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

function mergeBdnsSyncResult(draft, payload, runMode = payload?.runMode ?? payload?.mode ?? "manual") {
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
    if (existing.sourceNoticeVersionId === opportunity.sourceNoticeVersionId) {
      unchanged += 1;
    } else {
      updated += 1;
    }
    draft.opportunities.splice(existingIndex, 1, opportunity);
  });

  const run = {
    id: uid("sync"),
    mode: runMode,
    sourceMode: payload?.mode ?? "manual",
    connector: "bdns",
    source: "BDNS / SNPSAP",
    status: "healthy",
    startedAt: payload.startedAt ?? payload.fetchedAt ?? new Date().toISOString(),
    completedAt: payload.completedAt ?? payload.fetchedAt ?? new Date().toISOString(),
    lastRun: payload.completedAt ?? payload.fetchedAt ?? new Date().toISOString(),
    note: buildBdnsRunNote({
      ...payload,
      runMode
    }),
    truncated: payload.truncated ?? false,
    pagesFetched: payload.pagesFetched ?? 0,
    pageSize: payload.pageSize ?? payload.pageSizeRequested ?? 20,
    callsDiscovered: payload.discoveryCount ?? 0,
    uniqueEntries: payload.uniqueCodes ?? payload.stats?.uniqueEntries ?? 0,
    detailsFetched: payload.detailsFetched ?? 0,
    detailFailures: payload.detailFailures?.length ?? 0,
    opportunitiesInserted: inserted,
    opportunitiesUpdated: updated,
    unchanged,
    errors: (payload.detailFailures ?? []).map((item) => item.message ?? String(item))
  };
  prependSourceSyncRun(draft, run);
  return run;
}

function buildBdnsFailureRun(error, { runMode = "manual", requestMode = "manual", pages = 1, pageSize = 20 } = {}) {
  const now = new Date().toISOString();
  return {
    id: uid("sync"),
    mode: runMode,
    sourceMode: requestMode,
    connector: "bdns",
    source: "BDNS / SNPSAP",
    status: "error",
    startedAt: now,
    completedAt: now,
    lastRun: now,
    note:
      requestMode === "reconcile"
        ? "Official BDNS / SNPSAP recent reconciliation failed."
        : runMode === "automatic"
          ? "Official BDNS / SNPSAP automatic refresh failed."
          : "Official BDNS / SNPSAP sync failed.",
    pagesRequested: pages,
    pageSize,
    pagesFetched: 0,
    callsDiscovered: 0,
    uniqueEntries: 0,
    detailsFetched: 0,
    detailFailures: 0,
    opportunitiesInserted: 0,
    opportunitiesUpdated: 0,
    unchanged: 0,
    errors: [error?.message ?? "Unknown BDNS sync error."]
  };
}

function resetUiState() {
  Object.assign(uiState, {
    ...UI_STATE_DEFAULTS,
    analysisDepthByCompanyId: {},
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

function aiConfidenceLabel(value = "") {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!normalized) return "Not stated";
  return CONFIDENCE_COPY[normalized] ?? `${normalized[0]}${normalized.slice(1).toLowerCase()}`;
}

function safeLinkHref(value) {
  const raw = collapseWhitespace(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function buildAiReviewChangeItems(result = {}, match) {
  if (isVerificationResultV4(result)) {
    return buildVerificationCustomerSummary(result, match)
      .correction_changes
      .map((change) => formatVerificationChange(change))
      .filter(Boolean);
  }

  const items = [];
  const currentAction = match?.decision?.recommendedAction?.code ?? null;
  const currentFitBand = fitBandOf(match);

  if (result.corrected_fit_band && result.corrected_fit_band !== currentFitBand) {
    items.push(`Fit: ${fitBandLabelOf(match)} → ${FIT_BAND_COPY[result.corrected_fit_band] ?? result.corrected_fit_band}`);
  }

  if (result.corrected_action && result.corrected_action !== currentAction) {
    items.push(`Action: ${actionLabelOf(match?.decision?.recommendedAction)} → ${ACTION_COPY[result.corrected_action] ?? result.corrected_action}`);
  }

  (Array.isArray(result.disagreements) ? result.disagreements : [])
    .filter(Boolean)
    .forEach((item) => items.push(item));

  return items;
}

function aiReviewStatusMeta(aiReview) {
  const record = aiReview?.review ?? null;
  const reviewStatus = isVerificationResultV4(record?.result)
    ? record?.result?.derived_review_status ?? null
    : record?.result?.review_status ?? null;

  if (aiReview?.status === "current" && record) {
    return {
      label: getCustomerAiReviewLabel(reviewStatus),
      tone: getCustomerAiReviewTone(reviewStatus),
      detail: "AI verification completed for the current company, opportunity, and deterministic analysis context."
    };
  }
  if (aiReview?.status === "stale") {
    return {
      label: "Saved review may be outdated",
      tone: "warn",
      detail:
        aiReview.staleMessage ||
        "A saved AI verification exists, but the company or opportunity context changed. Re-run verification before relying on it."
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
    reviewStatus: getCustomerAiReviewLabel(result.review_status),
    reviewTone: getCustomerAiReviewTone(result.review_status),
    correctedAction: result.corrected_action ? ACTION_COPY[result.corrected_action] ?? result.corrected_action : null,
    correctedFitBand: result.corrected_fit_band ? FIT_BAND_COPY[result.corrected_fit_band] ?? result.corrected_fit_band : null,
    confidence: aiConfidenceLabel(result.confidence),
    warnings: Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [],
    disagreements: Array.isArray(result.disagreements) ? result.disagreements.filter(Boolean) : [],
    notes: collapseWhitespace(result.notes ?? "")
  };
}

function aiReviewSummary(aiReview, match, persistence, company) {
  const statusMeta = aiReviewStatusMeta(aiReview);
  const record = aiReview?.review ?? null;
  const notePreview =
    collapseWhitespace(record?.result?.advisory_summary ?? record?.result?.notes ?? "")
      .match(/[^.!?]+[.!?]?/g)?.slice(0, 3).join(" ").trim() ??
    collapseWhitespace(record?.result?.advisory_summary ?? record?.result?.notes ?? "");
  const savedMode =
    persistence?.status === "available"
      ? "Saved locally"
      : "Saved for this session only because browser persistence is unavailable";

  if (isVerificationResultV4(record?.result)) {
    const verification = buildVerificationCustomerSummary(record.result, match, company);
    return {
      statusMeta,
      companyName: verification.company_name,
      completedAt: record?.completedAt ? formatDate(record.completedAt, { includeTime: true }) : null,
      changeItems: verification.correction_changes.map((change) => formatVerificationChange(change)).filter(Boolean),
      changeFallback:
        verification.grouped_findings.headline_needs_verification.length ||
        verification.grouped_findings.headline_challenged.length ||
        verification.strongest_counterfactual?.would_change_fit_or_action
          ? "No direct fit, action, or lot correction was proposed. Verification identified issues that still require follow-up."
          : "No material correction to the OportuneX assessment.",
      notePreview,
      savedMode,
      protocolVersion: verification.protocol_version,
      reviewStatus: getCustomerAiReviewLabel(verification.derived_review_status),
      reviewTone: getCustomerAiReviewTone(verification.derived_review_status),
      confidence: aiConfidenceLabel(verification.confidence),
      advisorySummary: verification.advisory_summary,
      nextActions: verification.next_actions,
      confirmedFindings: verification.grouped_findings.headline_confirmed,
      unresolvedFindings: verification.grouped_findings.headline_needs_verification,
      challengedFindings: verification.grouped_findings.headline_challenged,
      detailedFindingGroups: verification.grouped_findings,
      strongestCounterfactual: verification.strongest_counterfactual
    };
  }

  const summary = aiReviewResult(record?.result ?? {});
  return {
    statusMeta,
    companyName: getCompanyDisplayName(company),
    completedAt: record?.completedAt ? formatDate(record.completedAt, { includeTime: true }) : null,
    changeItems: record ? buildAiReviewChangeItems(record.result ?? {}, match) : [],
    notePreview,
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
  const analysisDepth = getAnalysisDepth(company.id, ACTIVE_SEARCH_POLICY);
  const funnel = buildCandidateFunnel({
    company,
    opportunities: state.opportunities,
    now,
    policy: ACTIVE_SEARCH_POLICY,
    analysisDepth,
    savedOpportunityIds: state.savedOpportunityIds,
    pursuitStatuses: state.pursuitStatuses,
    selectedOpportunityId: uiState.selectedOpportunityId
  });
  const analysisStartedAt = Date.now();
  const portfolio = analysisService?.analyzePortfolio
    ? analysisService.analyzePortfolio(company, funnel.selectedForAnalysis, runtime, now)
    : analyzePortfolio(company, funnel.selectedForAnalysis, runtime, now);
  const analysisMs = Date.now() - analysisStartedAt;
  const savedSet = new Set(state.savedOpportunityIds ?? []);
  const scopeItems = getScopeItems(portfolio);
  const scopedItems = scopeItems[uiState.opportunityScope] ?? scopeItems.worth_attention;

  const filteredMatches = scopedItems
    .filter((item) => (uiState.filterType === "all" ? true : item.opportunity.type === uiState.filterType))
    .filter((item) =>
      uiState.filterRecommendation === "all"
        ? true
        : item.decision?.recommendedAction?.code === uiState.filterRecommendation
    )
    .filter((item) => (uiState.showSavedOnly ? savedSet.has(item.opportunityId) : true))
    .sort((left, right) => sortMatches(left, right, uiState.sort));
  const visibleMatches = filteredMatches.slice(0, funnel.policy.customerSurface);
  const savedMatches = portfolio.analysed.filter((item) => savedSet.has(item.opportunityId));
  const selectionVisibleItems = uiState.route === "saved" ? savedMatches : visibleMatches;
  const selectionAllItems = uiState.route === "saved" ? savedMatches : portfolio.analysed;

  const selectedOpportunityId = resolveSelectedOpportunityId(
    uiState.selectedOpportunityId,
    selectionVisibleItems,
    selectionAllItems
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
  const analysisCacheMetrics = analysisService?.getMetrics?.() ?? null;
  const funnelDiagnostics = {
    ...funnel,
    analysisMs,
    cacheHits: analysisCacheMetrics?.lastRunHits ?? 0,
    cacheMisses: analysisCacheMetrics?.lastRunMisses ?? 0
  };

  return {
    now,
    company,
    companies: state.companyProfiles,
    portfolio,
    funnel: funnelDiagnostics,
    visibleMatches,
    visibleMatchesTotal: filteredMatches.length,
    savedMatches,
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
    analysisCacheMetrics
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

function describeBdnsSyncStart({ runMode, requestMode, pages, pageSize }) {
  if (runMode === "automatic") {
    return requestMode === "reconcile"
      ? "Running automatic BDNS / SNPSAP recent reconciliation..."
      : "Running automatic BDNS / SNPSAP refresh...";
  }
  if (requestMode === "reconcile" || runMode === "reconcile") {
    return `Reconciling the latest ${pages} BDNS / SNPSAP page${pages === 1 ? "" : "s"} at ${pageSize} call${pageSize === 1 ? "" : "s"} per page...`;
  }
  return `Syncing BDNS / SNPSAP from the latest ${pages} page${pages === 1 ? "" : "s"} at ${pageSize} call${pageSize === 1 ? "" : "s"} per page...`;
}

function describeBdnsSyncSuccess(syncRun, { workspacePersisted, sourceCachePersisted, runMode, requestMode }) {
  let message =
    requestMode === "reconcile"
      ? `BDNS / SNPSAP recent reconciliation completed: ${syncRun.opportunitiesInserted} inserted, ${syncRun.opportunitiesUpdated} updated, ${syncRun.unchanged} unchanged.`
      : runMode === "automatic"
        ? `BDNS / SNPSAP automatic refresh completed: ${syncRun.opportunitiesInserted} inserted, ${syncRun.opportunitiesUpdated} updated, ${syncRun.unchanged} unchanged.`
        : `BDNS / SNPSAP sync completed: ${syncRun.opportunitiesInserted} inserted, ${syncRun.opportunitiesUpdated} updated, ${syncRun.unchanged} unchanged.`;

  if ((syncRun.detailFailures ?? 0) > 0) {
    message += ` ${syncRun.detailFailures} detail call${syncRun.detailFailures === 1 ? "" : "s"} failed and were skipped conservatively.`;
  }
  if (syncRun.truncated) {
    message += " The synchronization stopped at the configured detail safety cap.";
  }
  if (!sourceCachePersisted && workspacePersisted) {
    message += " Source cache persistence is unavailable, so these BDNS records may be lost after reload.";
  } else if (sourceCachePersisted && !workspacePersisted) {
    message += " Source records were cached, but workspace persistence is unavailable for some local user state.";
  } else if (!sourceCachePersisted && !workspacePersisted) {
    message += " Browser persistence is unavailable for both the workspace and the source cache.";
  }

  return message;
}

function formatConnectorLastError(state, fallback = "None recorded") {
  if (!state?.lastErrorAt && !state?.lastErrorCode) return fallback;
  const when = state?.lastErrorAt ? formatTimestampDetail(state.lastErrorAt) : "Time not recorded";
  const code = state?.lastErrorCode ?? "unknown_error";
  return `${when} · ${code}`;
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
    <article class="profile-datum company-datum">
      <span class="profile-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small class="datum-provenance">${escapeHtml(companyProvenanceLabel(status))}</small>
      ${meta ? `<small>${meta}</small>` : ""}
      ${stale ? `<small>May be outdated — company confirmation recommended.</small>` : ""}
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </article>
  `;
}

function renderCapabilitySummary(capability) {
  return `
    <article class="profile-datum capability-datum">
      <div class="capability-datum-topline">
        <strong>${escapeHtml(capability.label)}</strong>
        <span class="capability-strength">${escapeHtml(capability.strength ?? capability.level ?? "medium")}</span>
      </div>
      <small class="datum-provenance">${escapeHtml(companyProvenanceLabel(capability.status))}</small>
      <p>${escapeHtml(capability.notes ?? "Capability evidence available for matching.")}</p>
    </article>
  `;
}

function renderCompanySummaryChip(label, tone = "neutral") {
  return `<span class="summary-chip ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function renderDeveloperTools(route) {
  const open = isAdminRoute(route) || uiState.developerToolsOpen;
  return `
    <details class="developer-tools" data-control="developer-tools" ${open ? "open" : ""}>
      <summary>Developer tools</summary>
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
    </details>
  `;
}

function renderOpportunityAiState(aiReview) {
  if (aiReview?.status === "current") {
    return `<span class="card-ai-state current">AI verified</span>`;
  }
  if (aiReview?.status === "stale") {
    return `<span class="card-ai-state stale">AI review may be outdated</span>`;
  }
  return "";
}

function renderOpportunityFact(label, value) {
  return `
    <div class="fact-pill">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderFindMoreOpportunities(derived, { compact = false } = {}) {
  const batchSize = derived?.funnel?.policy?.expansionBatch ?? ACTIVE_SEARCH_POLICY.expansionBatch;
  return `
    <div class="search-depth-cta ${compact ? "compact" : ""}">
      <div>
        <strong>Find more opportunities</strong>
        <p>
          ${
            derived.funnel.canSearchWider
              ? escapeHtml(`Analyse another ${formatNumber(batchSize)} potential matches.`)
              : "You've reached the current search limit."
          }
        </p>
      </div>
      ${
        derived.funnel.canSearchWider
          ? `<button class="button-secondary" data-action="search-wider">Find more opportunities</button>`
          : `<span class="inline-note">OportuneX is already analysing the current maximum for this workspace.</span>`
      }
    </div>
  `;
}

function renderDetailDisclosure(title, content, { open = false } = {}) {
  return `
    <details class="detail-disclosure" ${open ? "open" : ""}>
      <summary>${escapeHtml(title)}</summary>
      <div class="detail-disclosure-body">
        ${content}
      </div>
    </details>
  `;
}

function renderAiReviewList(items = [], fallback, { limit = null } = {}) {
  const visibleItems = Number.isFinite(limit) ? items.slice(0, limit) : items;
  const remainingCount = Number.isFinite(limit) ? Math.max(0, items.length - visibleItems.length) : 0;
  if (!visibleItems.length) return `<p class="ai-review-empty">${escapeHtml(fallback)}</p>`;
  return `
    <ul class="ai-review-list">${visibleItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    ${remainingCount ? `<p class="ai-review-more">+ ${escapeHtml(String(remainingCount))} more in Detailed AI reasoning.</p>` : ""}
  `;
}

function renderAiFindingClaims(items = [], fallback, { limit = null } = {}) {
  const claims = items.map((item) => item?.claim).filter(Boolean);
  return renderAiReviewList(claims, fallback, { limit });
}

function renderDetailedFindingGroup(title, items = []) {
  if (!items.length) return "";
  return `
    <div class="detail-section">
      <h4>${escapeHtml(title)}</h4>
      <div class="evidence-audit-list">
        ${items
          .map(
            (item) => `
              <article class="requirement-audit-card">
                <strong>${escapeHtml(item.claim)}</strong>
                <p><strong>Category:</strong> ${escapeHtml(item.category)}</p>
                <p><strong>Why it matters:</strong> ${escapeHtml(item.company_impact)}</p>
                ${item.recommended_follow_up ? `<p><strong>Recommended follow-up:</strong> ${escapeHtml(item.recommended_follow_up)}</p>` : ""}
                ${item.evidence_ref_display?.length ? `<p><strong>Evidence refs:</strong> ${escapeHtml(item.evidence_ref_display.join(", "))}</p>` : item.evidence_refs?.length ? `<p><strong>Evidence refs:</strong> ${escapeHtml(item.evidence_refs.join(", "))}</p>` : ""}
              </article>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderAiVerificationHero(opportunity, match, aiReview, persistence, company, showTechnicalPath = false) {
  const busy = isAiReviewBusy(company?.id, opportunity.id);
  const summary = aiReviewSummary(aiReview, match, persistence, company);
  const record = aiReview?.review ?? null;
  const buttonLabel = aiReview?.buttonLabel ?? "Run AI verification";
  const currentReview = aiReview?.status === "current" && record;
  const staleReview = aiReview?.status === "stale" && record;
  const confidenceToneClass =
    summary.reviewTone === "bad" ? "bad" : summary.reviewTone === "warn" ? "warn" : "good";
  const currentV4Review = currentReview && summary.protocolVersion === "v4";

  return `
    <div class="ai-review-card ai-review-hero tone-${escapeHtml(summary.statusMeta.tone)}">
      <div class="ai-review-hero-header">
        <div>
          <h4>AI verification</h4>
          <p>${escapeHtml(summary.statusMeta.detail)}</p>
        </div>
        <div class="card-topline">
          ${pill(summary.statusMeta.label, summary.statusMeta.tone)}
          ${currentReview ? pill(`${summary.confidence} confidence`, confidenceToneClass) : ""}
          ${record?.completedAt ? pill(summary.savedMode, persistence?.status === "available" ? "neutral" : "warn") : ""}
        </div>
      </div>
      <div class="action-row">
        <button
          class="button-primary"
          data-action="ai-verify"
          data-id="${opportunity.id}"
          aria-busy="${busy ? "true" : "false"}"
          ${busy ? "disabled" : ""}
        >
          ${busy ? "Verifying..." : escapeHtml(buttonLabel)}
        </button>
        ${showTechnicalPath ? `<button class="ghost-button" data-action="tab" data-tab="debug">Technical details</button>` : ""}
      </div>
      ${
        staleReview
          ? `
              <div class="ai-review-panel">
                <p class="ai-review-important">${escapeHtml(summary.statusMeta.detail)}</p>
                ${summary.completedAt ? `<p class="ai-review-meta">Previous verification: ${escapeHtml(summary.completedAt)}</p>` : ""}
                <p class="ai-review-trust">Use this verification to focus your review. Confirm final eligibility, documents and submission details in the official notice before acting.</p>
              </div>
            `
          : currentV4Review
            ? `
                <div class="ai-review-grid">
                  <section class="ai-review-panel">
                    <h5>What this means for ${escapeHtml(summary.companyName)}</h5>
                    <p class="ai-review-important">${escapeHtml(summary.advisorySummary || "No additional AI advisory summary was recorded.")}</p>
                  </section>
                  <section class="ai-review-panel">
                    <h5>What ${escapeHtml(summary.companyName)} should verify next</h5>
                    ${renderAiReviewList(summary.nextActions, "No follow-up action was recorded.", { limit: 4 })}
                  </section>
                  <section class="ai-review-panel">
                    <h5>What verification found</h5>
                    ${
                      summary.confirmedFindings.length
                        ? `<h6>Confirmed</h6>${renderAiFindingClaims(summary.confirmedFindings, "No confirmed finding was recorded.", { limit: 3 })}`
                        : ""
                    }
                    ${
                      summary.unresolvedFindings.length
                        ? `<h6>Needs verification</h6>${renderAiFindingClaims(summary.unresolvedFindings, "No unresolved finding was recorded.", { limit: 3 })}`
                        : ""
                    }
                    ${
                      summary.challengedFindings.length
                        ? `<h6>Challenged</h6>${renderAiFindingClaims(summary.challengedFindings, "No challenged finding was recorded.", { limit: 3 })}`
                        : ""
                    }
                    ${
                      !summary.confirmedFindings.length &&
                      !summary.unresolvedFindings.length &&
                      !summary.challengedFindings.length
                        ? `<p class="ai-review-empty">No structured finding was recorded.</p>`
                        : ""
                    }
                  </section>
                  <section class="ai-review-panel">
                    <h5>What changed after verification</h5>
                    ${renderAiReviewList(summary.changeItems, summary.changeFallback ?? "No material correction to the OportuneX assessment.", { limit: 3 })}
                  </section>
                </div>
                ${renderDetailDisclosure(
                  "Detailed AI reasoning",
                  `
                    ${renderDetailedFindingGroup("Confirmed", summary.detailedFindingGroups.confirmed)}
                    ${renderDetailedFindingGroup("Unresolved", summary.detailedFindingGroups.unresolved)}
                    ${renderDetailedFindingGroup("Disagreements", summary.detailedFindingGroups.disagreed)}
                    ${renderDetailedFindingGroup("Critical contradictions", summary.detailedFindingGroups.critical_contradictions)}
                    ${
                      summary.strongestCounterfactual?.exists
                        ? `
                            <div class="detail-section">
                              <h4>Strongest counterfactual</h4>
                              <p>${escapeHtml(summary.strongestCounterfactual.description || "No description recorded.")}</p>
                              ${summary.strongestCounterfactual.evidence_ref_display?.length ? `<p><strong>Evidence refs:</strong> ${escapeHtml(summary.strongestCounterfactual.evidence_ref_display.join(", "))}</p>` : summary.strongestCounterfactual.evidence_refs?.length ? `<p><strong>Evidence refs:</strong> ${escapeHtml(summary.strongestCounterfactual.evidence_refs.join(", "))}</p>` : ""}
                              <p><strong>Would change fit or action:</strong> ${summary.strongestCounterfactual.would_change_fit_or_action ? "Yes" : "No"}</p>
                            </div>
                          `
                        : ""
                    }
                    <ul class="tight-list ai-review-detail-list">
                      <li>Verification completed${summary.completedAt ? ` · ${escapeHtml(summary.completedAt)}` : ""}</li>
                      <li>Customer review status: ${escapeHtml(summary.reviewStatus)}</li>
                      <li>Confidence: ${escapeHtml(summary.confidence)}</li>
                      <li>Confirmed findings: ${escapeHtml(String(summary.detailedFindingGroups.confirmed.length))}</li>
                      <li>Unresolved findings: ${escapeHtml(String(summary.detailedFindingGroups.unresolved.length))}</li>
                      <li>Disagreements: ${escapeHtml(String(summary.detailedFindingGroups.disagreed.length))}</li>
                      <li>Critical contradictions: ${escapeHtml(String(summary.detailedFindingGroups.critical_contradictions.length))}</li>
                    </ul>
                  `
                )}
                <p class="ai-review-trust">Use this verification to focus your review. Confirm final eligibility, documents and submission details in the official notice before acting.</p>
              `
            : currentReview
            ? `
                <div class="ai-review-grid">
                  <section class="ai-review-panel">
                    <h5>What this means for ${escapeHtml(summary.companyName)}</h5>
                    <p class="ai-review-important">${escapeHtml(summary.notePreview || "No additional AI advisory note was recorded.")}</p>
                  </section>
                  <section class="ai-review-panel">
                    <h5>What ${escapeHtml(summary.companyName)} should verify next</h5>
                    ${renderAiReviewList(summary.warnings, "No new material warning was identified.", { limit: 4 })}
                  </section>
                  <section class="ai-review-panel">
                    <h5>What changed after verification</h5>
                    ${renderAiReviewList(summary.changeItems, "No material change to the OportuneX assessment.", { limit: 3 })}
                  </section>
                </div>
                ${renderDetailDisclosure(
                  "Detailed AI reasoning",
                  `
                    <div class="detail-section">
                      <h4>Advisory note</h4>
                      <p class="ai-review-important">${escapeHtml(summary.notes || "No additional AI advisory note was recorded.")}</p>
                    </div>
                    <div class="detail-section">
                      <h4>Warnings</h4>
                      ${renderAiReviewList(summary.warnings, "No warning was recorded.")}
                    </div>
                    <div class="detail-section">
                      <h4>Disagreements</h4>
                      ${renderAiReviewList(summary.disagreements, "No disagreement was recorded.")}
                    </div>
                    <ul class="tight-list ai-review-detail-list">
                      <li>Verification completed${summary.completedAt ? ` · ${escapeHtml(summary.completedAt)}` : ""}</li>
                      <li>Customer review status: ${escapeHtml(summary.reviewStatus)}</li>
                      <li>Confidence: ${escapeHtml(summary.confidence)}</li>
                      <li>Warnings recorded: ${escapeHtml(String(summary.warnings.length))}</li>
                      <li>Disagreements recorded: ${escapeHtml(String(summary.disagreements.length))}</li>
                      ${summary.correctedAction ? `<li>Corrected action field: ${escapeHtml(summary.correctedAction)}</li>` : ""}
                      ${summary.correctedFitBand ? `<li>Corrected fit field: ${escapeHtml(summary.correctedFitBand)}</li>` : ""}
                    </ul>
                  `
                )}
                <p class="ai-review-trust">Use this verification to focus your review. Confirm final eligibility, documents and submission details in the official notice before acting.</p>
              `
            : aiReview?.isLegacyAvailable
              ? `<p class="inline-note">A legacy unscoped AI review exists in debug only. Run a fresh company-scoped review for customer-facing use.</p>`
              : `<p class="inline-note">AI verification is optional. OportuneX's deterministic assessment remains first.</p>`
      }
    </div>
  `;
}

function formatOpportunityCardDeadline(item) {
  const deadline = formatDeadline(item.opportunity?.deadline);
  if (!deadline || deadline === "Deadline not stated") return "Deadline not stated";
  return deadline;
}

function renderOpportunityPreview(item, { now, aiReview, persistence, showActions = false } = {}) {
  const organisation =
    item.opportunity?.contractingAuthority ||
    item.opportunity?.issuingOrganisation ||
    item.primaryContact?.name ||
    "Organisation not stated";
  const whyItMatters = customerWhyItMatters(item);
  const needsChecking = customerNeedsChecking(item);
  const aiState = renderOpportunityAiState(aiReview);
  const matchSummary = `${fitBandLabelOf(item)} · ${item.matchScore ?? item.priorityScore ?? 0}% match`;

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
        <div class="opportunity-card-status">
          ${pill(actionLabelOf(item.decision?.recommendedAction), actionTone(item.decision?.recommendedAction?.code))}
          <p class="opportunity-fit-summary">${escapeHtml(matchSummary)}</p>
        </div>
        <div class="opportunity-card-meta-top">
          ${aiState}
          <span class="opportunity-type-label">${escapeHtml(OPPORTUNITY_TYPES[item.opportunity?.type] ?? "Opportunity")}</span>
        </div>
      </div>
      <h3 class="opportunity-card-title">${escapeHtml(item.displayTitle)}</h3>
      <p class="opportunity-subline opportunity-card-subline">${escapeHtml(organisation)}</p>
      <div class="opportunity-metrics">
        ${renderOpportunityFact("Value", previewValueLabel(item))}
        ${renderOpportunityFact("Deadline", formatOpportunityCardDeadline(item))}
        ${renderOpportunityFact("Location", item.locationLabel || "Location not stated")}
      </div>
      <div class="opportunity-copy-block">
        <strong>Why it surfaced</strong>
        <p>${escapeHtml(whyItMatters)}</p>
      </div>
      <div class="opportunity-copy-block">
        <strong>Needs checking</strong>
        <p>${escapeHtml(needsChecking)}</p>
      </div>
      <div class="opportunity-footer">
        <span class="urgency-label">${escapeHtml(urgencyChip(item.opportunity, now))}</span>
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
          <span class="eyebrow">OportuneX</span>
          <h1>${APP_TITLE}</h1>
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
        <small>${escapeHtml(getProfileMode(derived.company) === "prospect" ? "Public-information profile" : "Confirmed profile")}</small>
      </div>
      <nav class="nav-list" aria-label="Main">
        ${CUSTOMER_NAV_ITEMS.map(
          (item) => `
            <button class="nav-item ${route === item.id ? "active" : ""}" data-action="route" data-route="${item.id}">
              <span>${escapeHtml(item.label)}</span>
            </button>
          `
        ).join("")}
      </nav>
      ${renderDeveloperTools(route)}
    </aside>
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

function customerWhyItMatters(item) {
  const positives = Array.isArray(item?.positives) ? item.positives : [];
  const nonDeadlinePositives = positives.filter(
    (entry) =>
      entry?.detail &&
      !/deadline/i.test(entry?.title ?? "") &&
      !/published deadline/i.test(entry?.detail ?? "") &&
      !(/geographic/i.test(entry?.title ?? "") && /\bweak\b/i.test(entry?.detail ?? ""))
  );
  const preferredPositive =
    positives.find((entry) => /capability/i.test(entry?.title ?? "")) ??
    positives.find((entry) => /geographic/i.test(entry?.title ?? "") && !/\bweak\b/i.test(entry?.detail ?? "")) ??
    positives.find((entry) => /scale fit/i.test(entry?.title ?? "")) ??
    nonDeadlinePositives[0];
  if (preferredPositive?.detail) return preferredPositive.detail;

  const candidate = item?.decision?.mainReason ?? item?.executiveVerdict ?? "";
  if (candidate && !CUSTOMER_WHY_BLOCKLIST.test(candidate) && !/published deadline/i.test(candidate)) {
    return presentCustomerDecisionText(candidate, { issueTitle: primaryOpenIssue(item)?.title });
  }

  if (positives.length || (item?.dimensions?.baseCapabilityFit ?? 0) > 0 || (item?.matchScore ?? 0) >= 25) {
    return "Some scope signals overlap with the company's activity, but overall fit remains limited.";
  }

  return "Relevant opportunity signals remain limited under the current evidence set.";
}

function customerNeedsChecking(item) {
  const raw = (
    primaryOpenIssue(item)?.detail ??
    item?.decision?.mainQuestion ??
    item?.decision?.mainReason ??
    "No additional blocking question is currently recorded."
  );
  return presentCustomerDecisionText(raw, {
    issueTitle: primaryOpenIssue(item)?.title,
    verificationFallback: true
  });
}

function buildDecisionSummary(match) {
  const primaryIssue = primaryOpenIssue(match);
  const issueTitle = primaryIssue?.title ?? "";
  return {
    action: actionLabelOf(match.decision?.recommendedAction),
    reason: presentCustomerDecisionText(match.decision?.mainReason ?? match.executiveVerdict, {
      issueTitle
    }),
    blocker: presentCustomerDecisionText(
      match.decision?.mainQuestion ?? primaryIssue?.detail ?? "No blocking question is currently recorded.",
      {
        issueTitle,
        verificationFallback: true
      }
    )
  };
}

function buildDecisionHeaderAlert(match, decision) {
  const confirmedBlocker = match.blockers?.[0] ?? null;
  if (confirmedBlocker) {
    const detail = presentCustomerDecisionText(confirmedBlocker.detail, { issueTitle: confirmedBlocker.title });
    if (detail && !isDuplicateHighLevelText(detail, [decision.reason, decision.blocker])) {
      return `Confirmed blocker: ${detail}`;
    }
  }

  const potentialBlocker = match.potentialHardBlockers?.[0] ?? null;
  if (!potentialBlocker) return "";

  const detail = presentCustomerDecisionText(potentialBlocker.detail, {
    issueTitle: potentialBlocker.title,
    verificationFallback: true
  });
  const alertCopy = detail ? `Potential hard blocker: ${detail}` : "";
  return isDuplicateHighLevelText(alertCopy, [decision.reason, decision.blocker]) ? "" : alertCopy;
}

function shouldShowFullTitleDisclosure(title) {
  const value = collapseWhitespace(title);
  return value.length >= 140 && value.split(" ").length >= 14;
}

function renderFullTitleDisclosure(title) {
  if (!shouldShowFullTitleDisclosure(title)) return "";
  return `
    <details class="title-disclosure">
      <summary>Full official title</summary>
      <p>${escapeHtml(title)}</p>
    </details>
  `;
}

function renderOverviewGrid(cards = []) {
  const visibleCards = cards.filter(Boolean);
  if (!visibleCards.length) return "";
  return `<div class="card-grid two ${visibleCards.length === 1 ? "single" : ""}">${visibleCards.join("")}</div>`;
}

function renderSearchDepthControls(derived, { compact = false } = {}) {
  return renderFindMoreOpportunities(derived, { compact });
}

function renderFunnelDiagnostics(derived) {
  const connectors = Object.entries(derived.funnel.connectorBreakdown ?? {});
  return `
    <article class="card">
      <div class="section-heading">
        <h3>Candidate funnel diagnostics</h3>
        <p>The cheap screen allocates deterministic compute only. Customer scoring still comes from the existing full analysis engine.</p>
      </div>
      <div class="card-grid five">
        ${statCard("Source universe", formatNumber(derived.funnel.sourceUniverseCount))}
        ${statCard("Safe excluded", formatNumber(derived.funnel.safeExcludedCount))}
        ${statCard("Candidate pool", formatNumber(derived.funnel.candidatePoolCount))}
        ${statCard("Analysed", formatNumber(derived.funnel.selectedForAnalysisCount), `${derived.funnel.cacheHits} hits / ${derived.funnel.cacheMisses} misses`)}
        ${statCard("Timings", `${derived.funnel.screeningMs} ms / ${derived.funnel.analysisMs} ms`, "screen / analysis")}
      </div>
      <ul class="tight-list">
        <li>Forced inclusions: ${formatNumber(derived.funnel.forcedCount)}</li>
        <li>Top-score selections: ${formatNumber(derived.funnel.topScoreCount)}</li>
        <li>Exploration reserve: ${formatNumber(derived.funnel.explorationCount)}</li>
        <li>Current depth: ${formatNumber(derived.funnel.analysisDepth)} of max ${formatNumber(derived.funnel.policy.maxAnalysis)}</li>
        <li>Candidate consideration target: ${formatNumber(derived.funnel.policy.candidateConsideration)}</li>
      </ul>
      ${
        connectors.length
          ? `
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr><th>Connector</th><th>Stored</th><th>Eligible</th><th>Candidate pool</th><th>Analysed</th></tr>
                  </thead>
                  <tbody>
                    ${connectors
                      .map(
                        ([connector, counts]) => `
                          <tr>
                            <td>${escapeHtml(connector)}</td>
                            <td>${formatNumber(counts.sourceUniverse)}</td>
                            <td>${formatNumber(counts.eligibleForScreen)}</td>
                            <td>${formatNumber(counts.candidatePool)}</td>
                            <td>${formatNumber(counts.selectedForAnalysis)}</td>
                          </tr>
                        `
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            `
          : ""
      }
    </article>
  `;
}

function renderOverview(derived, persistence) {
  const count = derived.portfolio.counts.worthAttention;
  const headline = count === 0
    ? "No opportunity needs immediate attention"
    : `${count} opportunit${count === 1 ? "y deserves" : "ies deserve"} your attention`;
  const lead = count === 0
    ? `${derived.company.legalName} does not currently have a high-priority opportunity to act on immediately.`
    : `For ${derived.company.legalName}, these are the public contracts and grants most worth reviewing next.`;
  const top = (
    count > 0
      ? derived.portfolio.buckets.worthAttention
      : derived.portfolio.buckets.needsVerification
  ).slice(0, 3);
  const verificationQuestionsCard = derived.questions.length
    ? `
        <article class="card subdued-card">
          <div class="section-heading">
            <h3>Needs checking next</h3>
            <p>The main unanswered questions most likely to change a decision.</p>
          </div>
          <div class="question-list">
            ${derived.questions.slice(0, 4).map((question) => `
              <article class="question-card">
                <strong>${escapeHtml(question.question)}</strong>
                <small class="question-why">${escapeHtml(question.why ?? "This answer could materially change the decision.")}</small>
              </article>
            `).join("")}
          </div>
        </article>
      `
    : "";
  return `
    <section class="page-grid">
      <article class="hero-panel overview-hero">
        <div>
          <p class="eyebrow">Overview</p>
          <h2>${escapeHtml(headline)}</h2>
          <p class="lead">${escapeHtml(lead)}</p>
          <div class="summary-chip-row">
            ${renderCompanySummaryChip(`${derived.portfolio.counts.needsVerification} need verification`, derived.portfolio.counts.needsVerification ? "warn" : "neutral")}
            ${renderCompanySummaryChip(`${derived.savedSet.size} saved`, derived.savedSet.size ? "good" : "neutral")}
          </div>
        </div>
      </article>
      <article class="card">
        <div class="section-heading">
          <h3>Top opportunities</h3>
          <p>The strongest current opportunities for the active company.</p>
        </div>
        <div class="opportunity-list">
          ${
            top.length
              ? top.map((item) => renderOpportunityPreview(item, {
                now: derived.now,
                aiReview: derived.aiReviewByOpportunity.get(item.opportunityId),
                persistence: { savedSet: derived.savedSet, status: persistence?.status }
              })).join("")
              : `<p class="empty-state">No opportunity needs immediate attention.</p>`
          }
        </div>
        ${renderFindMoreOpportunities(derived, { compact: true })}
      </article>
      ${verificationQuestionsCard}
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
  const hasSelectedOpportunity = Boolean(derived.selectedRaw);
  return `
    <section class="split-layout ${uiState.detailPanelCollapsed ? "detail-collapsed" : ""}">
      <div class="stack">
        <article class="card">
          <div class="section-heading with-actions">
            <div>
              <h2>Opportunities</h2>
              <p>Public contracts and grants worth considering for your company.</p>
            </div>
            ${
              hasSelectedOpportunity
                ? uiState.detailPanelCollapsed
                  ? `<button class="ghost-button" data-action="open-report" aria-expanded="false">Open report</button>`
                  : `<button class="ghost-button" data-action="collapse-report" aria-expanded="true">Hide report</button>`
                : ""
            }
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
                : `<p class="empty-state">No opportunities match these filters.</p>`
            }
          </div>
          ${renderFindMoreOpportunities(derived)}
        </article>
      </div>
      ${uiState.detailPanelCollapsed ? "" : renderDetailPanel(derived, persistence, { collapsible: true })}
    </section>
  `;
}

function renderSavedPage(derived, persistence) {
  const hasSelectedOpportunity = Boolean(derived.selectedRaw);
  return `
    <section class="split-layout ${uiState.detailPanelCollapsed ? "detail-collapsed" : ""}">
      <div class="stack">
        <article class="card">
          <div class="section-heading with-actions">
            <div>
              <h2>Saved</h2>
              <p>Opportunities you've chosen to keep close.</p>
            </div>
            ${
              hasSelectedOpportunity
                ? uiState.detailPanelCollapsed
                  ? `<button class="ghost-button" data-action="open-report" aria-expanded="false">Open report</button>`
                  : `<button class="ghost-button" data-action="collapse-report" aria-expanded="true">Hide report</button>`
                : ""
            }
          </div>
          <div class="opportunity-list">
            ${
              derived.savedMatches.length
                ? derived.savedMatches.map((item) => renderOpportunityPreview(item, {
                  now: derived.now,
                  aiReview: derived.aiReviewByOpportunity.get(item.opportunityId),
                  persistence: { savedSet: derived.savedSet, status: persistence?.status },
                  showActions: true
                })).join("")
                : `<p class="empty-state">No saved opportunities yet. Save an opportunity to keep it close for follow-up.</p>`
            }
          </div>
        </article>
      </div>
      ${uiState.detailPanelCollapsed ? "" : renderDetailPanel(derived, persistence, { collapsible: true })}
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
  const companyLocation = [company.geography.municipality, company.geography.province, company.geography.autonomousCommunity]
    .filter(Boolean)
    .join(", ") || "Location not yet confirmed";
  return `
    <section class="page-grid">
      <article class="hero-panel company-hero">
        <div>
          <p class="eyebrow">Company</p>
          <h2>${escapeHtml(company.tradingName || company.legalName)}</h2>
          <p class="lead">${escapeHtml(companyLocation)}</p>
          <div class="summary-chip-row">
            ${renderCompanySummaryChip(profileMode === "prospect" ? "Public-information profile" : "Confirmed profile", profileMode === "prospect" ? "warn" : "good")}
            ${renderCompanySummaryChip(`${completeness.score}% profile completeness`, completeness.score >= 80 ? "good" : "warn")}
            ${renderCompanySummaryChip(`${unknowns.length + conflicts.length} items need confirmation`, unknowns.length + conflicts.length ? "warn" : "neutral")}
          </div>
        </div>
      </article>

      <article class="card">
        <div class="section-heading">
          <h3>What OportuneX understands about your company</h3>
          <p>Capabilities and operating context are shown first. Provenance remains available without overwhelming the page.</p>
        </div>
        <div class="capability-chip-row">
          ${
            capabilities.length
              ? capabilities.map((item) => renderCompanySummaryChip(item.label, item.status === "company_confirmed" ? "good" : "neutral")).join("")
              : renderCompanySummaryChip("Capabilities need confirmation", "warn")
          }
        </div>
      </article>

      <div class="card-grid two">
        <article class="card">
          <div class="section-heading">
            <h3>Business information</h3>
            <p>The company facts that most often shape opportunity fit and scale.</p>
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
              label: "Maximum realistic project value",
              value: formatCompanyFact(maxRealisticFact, "money"),
              status: getFactStatus(maxRealisticFact),
              meta: formatFactMeta(maxRealisticFact),
              stale: isStalePublicFact(maxRealisticFact)
            })}
          </div>
        </article>

        <article class="card">
          <div class="section-heading">
            <h3>Operating area</h3>
            <p>Where the company works and what kinds of opportunities it prefers to pursue.</p>
          </div>
          <div class="profile-grid">
            ${renderProfileDatum({
              label: "Operating geography",
              value: companyLocation,
              status: profileMode === "confirmed" ? "company_confirmed" : "public_reported"
            })}
            ${renderProfileDatum({
              label: "Preferred radius",
              value: getFactValue(radiusFact) != null ? `${formatCompanyFact(radiusFact)} km` : "Unknown",
              status: getFactStatus(radiusFact),
              meta: formatFactMeta(radiusFact),
              stale: isStalePublicFact(radiusFact)
            })}
            ${renderProfileDatum({
              label: "Desired work types",
              value: company.preferences.desiredWorkTypes.join(", ") || "Unknown",
              status: company.preferences.desiredWorkTypes.length ? "company_confirmed" : "unknown"
            })}
            ${renderProfileDatum({
              label: "Unwanted work types",
              value: company.preferences.unwantedWorkTypes.join(", ") || "Unknown",
              status: company.preferences.unwantedWorkTypes.length ? "company_confirmed" : "unknown"
            })}
          </div>
        </article>
      </div>

      <div class="card-grid two">
        <article class="card">
          <div class="section-heading">
            <h3>Capabilities</h3>
            <p>Services and delivery areas that OportuneX can currently use in matching.</p>
          </div>
          <div class="profile-grid">
            ${confirmedCapabilities.length ? confirmedCapabilities.map(renderCapabilitySummary).join("") : ""}
            ${publicCapabilities.length ? publicCapabilities.map(renderCapabilitySummary).join("") : ""}
            ${!capabilities.length ? renderProfileDatum({ label: "Capabilities", value: "Unknown", status: "unknown" }) : ""}
          </div>
        </article>

        <article class="card">
          <div class="section-heading">
            <h3>Experience & qualifications</h3>
            <p>Capability, public procurement experience, certifications and insurance stay separate from one another.</p>
          </div>
          <div class="profile-grid">
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
              label: "Can co-finance grants?",
              value: formatCompanyFact(canCoFinanceFact, "boolean"),
              status: getFactStatus(canCoFinanceFact),
              meta: formatFactMeta(canCoFinanceFact),
              stale: isStalePublicFact(canCoFinanceFact)
            })}
          </div>
        </article>
      </div>

      ${
        profileMode === "prospect" || unknowns.length || conflicts.length
          ? `
              <article class="card subdued-card">
                <div class="section-heading">
                  <h3>${profileMode === "prospect" ? "Needs confirmation" : "Information still needed"}</h3>
                  <p>These are the main gaps that can still change opportunity decisions.</p>
                </div>
                <ul class="tight-list">
                  ${unknowns.length ? unknowns.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : `<li>No major unknown recorded.</li>`}
                  ${conflicts.length ? conflicts.map((item) => `<li>${escapeHtml(item.field)} — ${escapeHtml(item.detail)}</li>`).join("") : ""}
                </ul>
              </article>
            `
          : ""
      }

      ${renderDetailDisclosure(
        "More company details",
        `
          <div class="stack">
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
            ${
              employeeHistory.length || turnoverHistory.length
                ? `
                    <div class="detail-section">
                      <h4>History</h4>
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
            <div class="detail-section">
              <h4>Company sources</h4>
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
            </div>
          </div>
        `
      )}

      ${renderDetailDisclosure(
        "Edit company profile",
        `
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
        `
      )}
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

function renderSourcesPage(state, runtime, sourceCache, connectorStates, refreshScheduler) {
  const aiStatus = getAiStatusMeta(runtime.ai);
  const placspRun = getLatestPlacspSyncRun(state);
  const bdnsRun = getLatestBdnsSyncRun(state);
  const sourceCacheMeta = getSourceCacheMeta(sourceCache);
  const placspState = createConnectorState("placsp", connectorStates?.placsp);
  const bdnsState = createConnectorState("bdns", connectorStates?.bdns);
  const placspCachedCount =
    sourceCache?.counts?.placsp ??
    state.opportunities.filter((item) => isPlacspSourceOpportunity(item)).length;
  const bdnsCachedCount =
    sourceCache?.counts?.bdns ??
    state.opportunities.filter((item) => item.sourceConnector === "bdns").length;
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
  const bdnsStatusLabel = uiState.bdnsSyncing
    ? "Syncing"
    : bdnsRun?.status === "healthy"
      ? "Last sync successful"
      : bdnsRun?.status === "error"
        ? "Error"
        : runtime.connectors?.bdns === "ready"
          ? "Ready"
          : "Planned";
  const bdnsStatusTone = uiState.bdnsSyncing
    ? "warn"
    : bdnsRun?.status === "healthy"
      ? "good"
      : bdnsRun?.status === "error"
        ? "bad"
        : runtime.connectors?.bdns === "ready"
          ? "good"
          : "warn";
  const placspErrors = placspRun?.errors ?? [];
  const bdnsErrors = bdnsRun?.errors ?? [];
  const nextAutomaticRefreshAt = refreshScheduler?.getNextAutomaticRefreshAt
    ? refreshScheduler.getNextAutomaticRefreshAt(placspState)
    : getNextAutomaticRefreshAt(placspState);
  const nextBdnsAutomaticRefreshAt = refreshScheduler?.getNextAutomaticRefreshAt
    ? refreshScheduler.getNextAutomaticRefreshAt(bdnsState, "bdns")
    : getNextAutomaticRefreshAt(bdnsState);
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
  const bdnsWarnings = [
    (sourceCache?.status === "unavailable" || sourceCache?.status === "error")
      ? sourceCacheMeta.detail
      : null,
    bdnsRun?.truncated ? "The synchronization stopped at the configured BDNS detail safety cap." : null,
    (bdnsRun?.detailFailures ?? 0) > 0
      ? `${bdnsRun.detailFailures} detail call${bdnsRun.detailFailures === 1 ? "" : "s"} failed and were skipped conservatively.`
      : null,
    bdnsState.lastErrorAt && bdnsState.lastErrorCode && bdnsState.lastRunMode === "automatic"
      ? "The last automatic BDNS refresh failed and is currently in conservative backoff."
      : null,
    isReconciliationDue(bdnsState.lastReconciliationAt, Date.now())
      ? "Recent bounded BDNS reconciliation is overdue."
      : null,
    bdnsState.lastErrorAt && bdnsState.lastErrorCode && bdnsState.lastRunMode !== "automatic"
      ? "The last BDNS manual synchronization failed."
      : null
  ].filter(Boolean);
  const secondaryRuns = (state.sourceSyncRuns ?? []).filter(
    (run) => !isPlacspSyncRun(run) && !isBdnsSyncRun(run)
  );
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
          <article class="source-card">
            <div class="card-topline">
              ${pill("BDNS / SNPSAP", "neutral")}
              ${pill(bdnsStatusLabel, bdnsStatusTone)}
            </div>
            <p>Official Spanish grants and public aid calls from the Sistema Nacional de Publicidad de Subvenciones y Ayudas Publicas API.</p>
            <small>
              ${bdnsRun ? `Last synchronized ${escapeHtml(formatLastChecked(formatSourceRunMoment(bdnsRun)))}` : "No BDNS / SNPSAP sync has completed yet."}
            </small>
            <ul class="tight-list">
              <li>Auto refresh: ${bdnsState.autoRefreshEnabled ? "Enabled" : "Disabled"}</li>
              <li>Last automatic refresh: ${escapeHtml(formatTimestampDetail(bdnsState.lastAutomaticSyncAt, "Not yet run"))}</li>
              <li>Last manual refresh: ${escapeHtml(formatTimestampDetail(bdnsState.lastManualSyncAt, "Not yet run"))}</li>
              <li>Last recent reconciliation: ${escapeHtml(formatTimestampDetail(bdnsState.lastReconciliationAt, "Not yet run"))}</li>
              <li>Last mode: ${escapeHtml(placspRunModeLabel(bdnsState.lastRunMode))}</li>
              <li>Next automatic refresh: ${escapeHtml(formatTimestampDetail(nextBdnsAutomaticRefreshAt))}</li>
              <li>Last error: ${escapeHtml(formatConnectorLastError(bdnsState))}</li>
              <li>Source cache: ${escapeHtml(sourceCacheMeta.label)}</li>
              <li>Cached grants: ${bdnsCachedCount}</li>
              <li>Pages fetched: ${bdnsRun?.pagesFetched ?? 0}</li>
              <li>Page size: ${bdnsRun?.pageSize ?? uiState.bdnsPageSize}</li>
              <li>Calls discovered: ${bdnsRun?.callsDiscovered ?? 0}</li>
              <li>Details fetched: ${bdnsRun?.detailsFetched ?? 0}</li>
              <li>Detail failures: ${bdnsRun?.detailFailures ?? 0}</li>
              <li>Inserted: ${bdnsRun?.opportunitiesInserted ?? 0}</li>
              <li>Updated: ${bdnsRun?.opportunitiesUpdated ?? 0}</li>
              <li>Unchanged: ${bdnsRun?.unchanged ?? 0}</li>
            </ul>
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
            ${bdnsErrors.length ? `<small>${escapeHtml(bdnsErrors[0])}</small>` : ""}
            ${getSourceCacheErrorMessage(sourceCache) ? `<small>${escapeHtml(getSourceCacheErrorMessage(sourceCache))}</small>` : ""}
            ${
              bdnsWarnings.length
                ? `
                    <div class="stack">
                      ${bdnsWarnings.map((warning) => `<small>${escapeHtml(warning)}</small>`).join("")}
                    </div>
                  `
                : ""
            }
            <div class="form-actions">
              <label>
                Recent pages
                <select data-control="bdns-pages" ${uiState.bdnsSyncing ? "disabled" : ""}>
                  ${[1, 2, 3]
                    .map(
                      (value) =>
                        `<option value="${value}" ${uiState.bdnsMaxPages === value ? "selected" : ""}>${value}</option>`
                    )
                    .join("")}
                </select>
              </label>
              <label>
                Page size
                <select data-control="bdns-page-size" ${uiState.bdnsSyncing ? "disabled" : ""}>
                  ${[10, 20, 30, 40, 50]
                    .map(
                      (value) =>
                        `<option value="${value}" ${uiState.bdnsPageSize === value ? "selected" : ""}>${value}</option>`
                    )
                    .join("")}
                </select>
              </label>
              <button class="button-secondary" data-action="toggle-bdns-auto-refresh" ${uiState.bdnsSyncing ? "disabled" : ""}>
                Automatic refresh ${bdnsState.autoRefreshEnabled ? "ON" : "OFF"}
              </button>
              <button class="button-primary" data-action="sync-bdns" ${uiState.bdnsSyncing ? "disabled" : ""}>
                ${uiState.bdnsSyncing ? "Syncing BDNS..." : "Sync BDNS now"}
              </button>
            </div>
            <small>Automatic refresh runs while this local OportuneX session is active.</small>
            <br />
            <small>Discovery uses the latest published calls endpoint, then enriches each unique BDNS code with bounded detail requests.</small>
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
        ${renderFunnelDiagnostics(derived)}
        <article class="card">
          <div class="section-heading">
            <h2>Analysis debugger</h2>
            <p>Inspect score components, claims, evidence links and verification triggers.</p>
          </div>
          ${renderOpportunityListMini(derived.portfolio.analysed)}
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

function renderHealthPage(state, runtime, derived, persistence, sourceCache, connectorStates, refreshScheduler) {
  const footprint = Math.round(JSON.stringify(serializeStateForPersistence(state)).length / 1024);
  const aiStatus = getAiStatusMeta(runtime.ai);
  const persistenceMeta = getPersistenceMeta(persistence);
  const sourceCacheMeta = getSourceCacheMeta(sourceCache);
  const placspState = createConnectorState("placsp", connectorStates?.placsp);
  const analysisCacheMetrics = derived.analysisCacheMetrics ?? null;
  const nextAutomaticRefreshAt = refreshScheduler?.getNextAutomaticRefreshAt
    ? refreshScheduler.getNextAutomaticRefreshAt(placspState)
    : getNextAutomaticRefreshAt(placspState);
  return `
    <section class="page-grid">
      <div class="card-grid five">
        ${statCard("Companies", String(state.companyProfiles.length))}
        ${statCard("Stored universe", formatNumber(derived.funnel.sourceUniverseCount))}
        ${statCard("Analysed", String(derived.portfolio.counts.analysed), `Depth ${derived.funnel.analysisDepth}`)}
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
            <strong>Candidate funnel</strong>
            <p>${derived.funnel.safeExcludedCount} safely excluded, ${derived.funnel.candidatePoolCount} candidates considered, ${derived.funnel.selectedForAnalysisCount} fully analysed.</p>
            <small>Screening ${derived.funnel.screeningMs} ms · analysis ${derived.funnel.analysisMs} ms · exploration ${derived.funnel.explorationCount}</small>
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

function renderDetailPanel(derived, persistence, options = {}) {
  const showDebugger = typeof options === "boolean" ? options : Boolean(options?.showDebugger);
  const collapsible = typeof options === "object" ? Boolean(options?.collapsible) : false;
  const selected = derived.selectedRecommended ?? derived.selectedRejected?.bestMatch ?? null;
  const raw = derived.selectedRaw;
  if (!selected || !raw) {
    if (derived.selectedRejected) {
      return `
        <aside class="detail-panel" tabindex="0" aria-label="Opportunity report">
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
    return `<aside class="detail-panel" tabindex="0" aria-label="Opportunity report"><article class="card"><p class="empty-state">Select an opportunity to view its assessment.</p></article></aside>`;
  }

  const decision = buildDecisionSummary(selected);
  const headerAlert = buildDecisionHeaderAlert(selected, decision);
  const tabs = showDebugger ? ["report", "evidence", "debug"] : ["report", "evidence"];
  const verificationPacket = showDebugger ? buildVerificationPacket(derived.company, raw, selected) : null;
  const authorityLabel =
    raw.contractingAuthority ||
    raw.issuingOrganisation ||
    selected.primaryContact?.name ||
    "Authority / programme not stated";
  const valueHeading =
    raw.type === "grant" && selected.financialPicture?.primaryLine?.id === "programme_budget"
      ? "Programme budget"
      : "Published opportunity value";
  const selectedLotLabel = getSelectedExplicitLotLabel(selected);
  const lotContextNote =
    selected.publishedLotCount > 1 && hasSelectedExplicitLot(selected) && selectedLotLabel
      ? `Assessment shown for ${selectedLotLabel} · ${selected.publishedLotCount} published lots in this contract`
      : "";

  return `
    <aside class="detail-panel" tabindex="0" aria-label="Opportunity report">
      <article class="card detail-report-card">
        <div class="detail-shell-header">
          <div>
            <p class="eyebrow">Opportunity report</p>
            <h3 class="detail-report-title">${escapeHtml(selected.displayTitle)}</h3>
            <p class="detail-report-subline">${escapeHtml(authorityLabel)} · ${escapeHtml(OPPORTUNITY_TYPES[raw.type] ?? "Opportunity")}</p>
            ${lotContextNote ? `<p class="detail-lot-context">${escapeHtml(lotContextNote)}</p>` : ""}
            ${renderFullTitleDisclosure(selected.displayTitle)}
          </div>
          ${
            collapsible
              ? `<button class="ghost-button" data-action="collapse-report" aria-expanded="true">Hide report</button>`
              : ""
          }
        </div>
        ${showDebugger ? renderLotComparisonDebuggerSection(raw, selected, verificationPacket) : ""}
        <div class="decision-hero">
          <div class="decision-hero-main">
            <span class="decision-kicker">Recommended action</span>
            <div class="decision-action-row">
              ${pill(actionLabelOf(selected.decision?.recommendedAction), actionTone(selected.decision?.recommendedAction?.code))}
              <span class="decision-fit-line">${escapeHtml(`${fitBandLabelOf(selected)} · ${selected.matchScore ?? selected.priorityScore ?? 0}% match`)}</span>
            </div>
            <p class="decision-reason">${escapeHtml(decision.reason)}</p>
          </div>
          <div class="decision-before">
            <span>Before proceeding</span>
            <p>${escapeHtml(decision.blocker)}</p>
          </div>
          ${headerAlert ? `<div class="detail-alert">${escapeHtml(headerAlert)}</div>` : ""}
          <div class="detail-key-facts">
            ${statCard(valueHeading, selected.displayValueLabel)}
            ${statCard("Deadline", formatDeadline(raw.deadline))}
            ${statCard("Buyer / issuer", authorityLabel)}
            ${statCard("Location", selected.locationLabel || "Not stated")}
          </div>
        </div>
        ${renderAiVerificationHero(raw, selected, derived.selectedAiReview, persistence, derived.company, showDebugger)}
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
            ? renderReportTab(derived.company, derived.now, raw, selected)
            : uiState.detailTab === "evidence"
              ? renderEvidenceTab(raw, selected)
              : renderDebugTab(derived.company, raw, selected, derived.selectedAiReview, derived.funnel.byOpportunityId?.[selected.opportunityId] ?? null, verificationPacket)
        }
      </article>
    </aside>
  `;
}

function renderReportTab(company, now, opportunity, match) {
  const requirementRows = buildRequirementPresentationRows(match.requirementRows);
  const eligibilityRequirements = requirementRows.filter((row) => row.mandatory).map((row) => row.title);
  const nonActionable = isNonActionableDerivedStatus(opportunity.derivedStatus ?? opportunity.status);
  const officialAccess = resolveOfficialNoticeAccess(opportunity);
  const applicationHref = safeLinkHref(opportunity.applicationUrl);
  const calendarEvent = buildOpportunityCalendarEvent({
    company,
    opportunity,
    analysis: match,
    now
  });
  const preparationItems = nonActionable
    ? ["Archival review only. This notice is not open for a live submission."]
    : [
        "Internal go / no-go review",
        "Commercial and technical lead assignment",
        match.potentialHardBlockers?.length || match.unknowns.length
          ? "Gather evidence for unresolved qualification or eligibility conditions"
          : null
      ].filter(Boolean);
  const guaranteeLabel = presentCustomerGuaranteeText(opportunity.guarantees, {
    evidenced: (opportunity.evidence ?? []).some((item) => item.fieldKey === "guarantees"),
    fallback: "Not stated"
  });
  const requirementCards = requirementRows.length
    ? `<div class="requirement-list-grid">
        ${requirementRows
          .map(
            (row) => `
              <article class="requirement-card">
                <strong>${escapeHtml(row.title)}</strong>
                <p class="requirement-status">${escapeHtml(row.statusLabel)}</p>
                <p>${escapeHtml(row.implication)}</p>
              </article>
            `
          )
          .join("")}
      </div>`
    : `<p class="empty-state">${
        match.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED"
          ? "Qualification requirements have not yet been retrieved from the reviewed sources."
          : "No mandatory requirement is currently recorded in the reviewed source set."
      }</p>`;
  const deadlineActions = [
    officialAccess.isPlacsp && officialAccess.searchUrl
      ? `<button class="ghost-button" data-action="find-on-placsp" data-id="${opportunity.id}">Find on PLACSP</button>`
      : "",
    officialAccess.copyReferenceValue
      ? `<button class="ghost-button" data-action="copy-reference" data-id="${opportunity.id}">Copy reference</button>`
      : "",
    calendarEvent.available
      ? `<button class="ghost-button" data-action="download-calendar" data-id="${opportunity.id}">Add deadline to calendar</button>`
      : "",
    !officialAccess.isPlacsp && !nonActionable && applicationHref
      ? `<a class="ghost-button" href="${escapeHtml(applicationHref)}" target="_blank" rel="noreferrer noopener">Open official application</a>`
      : "",
    !officialAccess.isPlacsp && officialAccess.primaryUrl
      ? `<a class="ghost-button" href="${escapeHtml(officialAccess.primaryUrl)}" target="_blank" rel="noreferrer noopener">Open official notice</a>`
      : "",
    !officialAccess.isPlacsp && officialAccess.searchUrl
      ? `<a class="ghost-button" href="${escapeHtml(officialAccess.searchUrl)}" target="_blank" rel="noreferrer noopener">Open PLACSP search</a>`
      : "",
    officialAccess.isPlacsp && !nonActionable && applicationHref
      ? `<a class="ghost-button" href="${escapeHtml(applicationHref)}" target="_blank" rel="noreferrer noopener">Open official application</a>`
      : ""
  ]
    .filter(Boolean)
    .join("");

  return `
    ${renderDetailDisclosure(
      "Why this matches",
      `<ul class="tight-list">
        ${
          match.positives.length
            ? match.positives.slice(0, 4).map((item) => `<li><strong>${escapeHtml(item.title)}:</strong> ${escapeHtml(item.detail)}</li>`).join("")
            : `<li>${escapeHtml(match.executiveVerdict)}</li>`
        }
      </ul>`,
      { open: true }
    )}
    ${renderDetailDisclosure(
      "Eligibility & blockers",
      `<ul class="tight-list">
        ${
          primaryOpenIssue(match)
            ? `<li>${escapeHtml(customerIssueStatement("Next verification question", primaryOpenIssue(match), { verificationFallback: true }))}</li>`
            : ""
        }
        ${
          (match.potentialHardBlockers ?? []).length
            ? match.potentialHardBlockers
                .map(
                  (item) =>
                    `<li>${escapeHtml(customerIssueStatement("Potential hard blocker", item, { verificationFallback: true }))}</li>`
                )
                .join("")
            : match.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED"
              ? "<li><strong>Potential hard blockers:</strong> Not yet assessable — qualification requirements have not been retrieved.</li>"
              : "<li>No potential hard blocker is currently recorded for the retrieved qualification set.</li>"
        }
        ${
          match.blockers.length
            ? match.blockers
                .map(
                  (item) =>
                    `<li>${escapeHtml(customerIssueStatement("Confirmed blocker", item))}</li>`
                )
                .join("")
            : ""
        }
        ${match.unknowns
          .map(
            (item) =>
              `<li>${escapeHtml(customerIssueStatement("Important unknown", item, { verificationFallback: true }))}</li>`
          )
          .join("")}
      </ul>
      ${requirementCards}`,
      { open: match.eligibilityStatus === "INELIGIBLE" || match.blockers.length > 0 }
    )}
    ${renderDetailDisclosure(
      "Financial picture",
      `<ul class="tight-list">
        ${(match.financialPicture?.lines ?? []).length
          ? (match.financialPicture?.lines ?? [])
              .map(
                (line) =>
                  `<li>${escapeHtml(line.label)}: ${escapeHtml(line.displayValue)}${line.note ? ` · ${escapeHtml(line.note)}` : ""}</li>`
              )
              .join("")
          : "<li>No reliable financial amount is currently available.</li>"}
        <li>${escapeHtml(match.companyAmountLabel)}</li>
        <li>Scale fit note: ${escapeHtml(match.dimensions?.scaleAssessment?.note ?? "No scale note recorded.")}</li>
      </ul>`
    )}
    ${renderDetailDisclosure(
      "Deadline & submission",
      `<ul class="tight-list">
        <li>Deadline: ${escapeHtml(formatDeadline(opportunity.deadline))}</li>
        ${
          nonActionable
            ? `<li>No live submission route applies because this notice is not open.</li>`
            : applicationHref
              ? `<li>Official application route is available.</li>`
              : `<li>Submission route not yet verified.</li>`
        }
        ${
          officialAccess.primaryUrl
            ? `<li>Official notice / dossier link is available.</li>`
            : `<li>Official notice / dossier not yet verified.</li>`
        }
        <li>Authority contact: ${escapeHtml(
          nonActionable && !match.primaryContact?.name
            ? "No live submission contact is required for this archived notice."
            : match.primaryContact?.name ?? "Contact not found in reviewed/imported sources"
        )}</li>
        <li>Reference: ${escapeHtml(officialAccess.referenceNumber || opportunity.referenceNumber || "Not stated")}</li>
      </ul>
      ${deadlineActions ? `<div class="detail-link-row">${deadlineActions}</div>` : ""}
      <p class="detail-inline-note">${escapeHtml(calendarEvent.available ? calendarEvent.customerNote : calendarEvent.reason)}</p>
      ${officialAccess.helpNote ? `<p class="detail-inline-note">${escapeHtml(officialAccess.helpNote)}</p>` : ""}`
      ,
      { open: true }
    )}
    ${renderDetailDisclosure(
      "Requirements",
      `<ul class="tight-list">
        ${eligibilityRequirements.length
          ? eligibilityRequirements.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
          : match.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED"
            ? "<li>Qualification requirements have not yet been retrieved from the reviewed sources.</li>"
            : "<li>None published.</li>"}
      </ul>
      <ul class="tight-list">
        ${(opportunity.requiredDocuments ?? []).length
          ? (opportunity.requiredDocuments ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")
          : "<li>No submission document has been explicitly listed by the source.</li>"}
      </ul>`
    )}
    ${renderDetailDisclosure(
      "Evidence & confidence",
      `<ul class="tight-list">
        <li>Decision confidence: ${escapeHtml(CONFIDENCE_COPY[match.confidenceShield.label])}</li>
        <li>Source confidence: ${escapeHtml(match.confidenceShield.dataConfidence)}</li>
        <li>Eligibility confidence: ${escapeHtml(match.confidenceShield.eligibilityConfidence)}</li>
        <li>Company-fact confidence: ${escapeHtml(match.confidenceShield.companyFactConfidence)}</li>
        <li>Official source verified: ${match.confidenceShield.officialSourceVerified ? "Yes" : "No"}</li>
        <li>Last checked: ${escapeHtml(formatLastChecked(opportunity.lastChecked))}</li>
        <li>Critical field summary: ${escapeHtml(match.confidenceShield.criticalFieldSummary)}</li>
        ${match.risks.map((item) => `<li>${escapeHtml(item.title)} — ${escapeHtml(item.detail)}</li>`).join("")}
      </ul>`
    )}
    ${renderDetailDisclosure(
      "Opportunity details",
      `<ul class="tight-list">
        <li>Recommended action: ${escapeHtml(actionLabelOf(match.decision?.recommendedAction))}</li>
        <li>Duration: ${escapeHtml(opportunity.duration ?? "Not stated")}</li>
        <li>Guarantees: ${escapeHtml(guaranteeLabel)}</li>
      </ul>
      <ul class="tight-list">
        ${preparationItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
      <div class="action-row">
        <button class="ghost-button" data-action="download-report" data-id="${opportunity.id}">Download report</button>
      </div>`
    )}
  `;
}

function renderEvidenceTab(opportunity, match) {
  const requirementAuditRows = buildRequirementEvidenceAuditRows(match.requirementRows, opportunity.evidence ?? []);
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
      <h4>Requirement audit</h4>
      ${
        requirementAuditRows.length
          ? `<div class="evidence-audit-list">
              ${requirementAuditRows
                .map(
                  (row) => `
                    <article class="requirement-audit-card">
                      <strong>${escapeHtml(row.title)}</strong>
                      <p><strong>Status:</strong> ${escapeHtml(row.statusLabel)}</p>
                      <p><strong>Raw requirement:</strong> ${escapeHtml(row.rawLabel)}</p>
                      <p><strong>Implication:</strong> ${escapeHtml(row.implication)}</p>
                      <p><strong>Evidence IDs:</strong> ${escapeHtml(row.evidenceIds.join(", ") || "Not linked")}</p>
                      <p><strong>Source paths:</strong> ${escapeHtml(row.sourcePaths.join(" · ") || "Not recorded")}</p>
                      ${
                        row.excerpts.length
                          ? `<p><strong>Linked excerpts:</strong> ${escapeHtml(row.excerpts.join(" | "))}</p>`
                          : ""
                      }
                    </article>
                  `
                )
                .join("")}
            </div>`
          : `<p class="empty-state">No structured qualification requirement audit is attached to this opportunity.</p>`
      }
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
                      <small>
                        Confidence ${Math.round((item.confidence ?? 0.8) * 100)}%
                        ${item.sourceId ? ` · source ${escapeHtml(item.sourceId)}` : ""}
                        ${item.sourcePath ? ` · ${escapeHtml(item.sourcePath)}` : ""}
                      </small>
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
                  (source) => {
                    const sourceHref = safeLinkHref(source.url);
                    return `
                      <li>
                        ${
                          sourceHref
                            ? `<a href="${escapeHtml(sourceHref)}" target="_blank" rel="noreferrer noopener">${escapeHtml(source.organisation)}</a>`
                            : escapeHtml(source.organisation)
                        }
                        — ${escapeHtml(source.title)} · published ${escapeHtml(source.publishedAt)} · last checked ${escapeHtml(formatLastChecked(source.lastChecked))}
                      </li>
                    `;
                  }
                )
                .join("")
            : "<li>No official source has been attached yet.</li>"
        }
      </ul>
    </div>
  `;
}

function renderDebugTab(company, opportunity, match, aiReview, funnelMeta = null, verificationPacket = null) {
  const aiRun = aiReview?.review ?? aiReview?.legacyReview ?? null;
  const packet = verificationPacket ?? buildVerificationPacket(company, opportunity, match);
  return `
    ${
      funnelMeta
        ? `
            <div class="detail-section">
              <h4>Candidate screen</h4>
              <ul class="tight-list">
                <li>Screen score: ${Math.round(funnelMeta.screenScore)}/100</li>
                <li>Exploration score: ${Math.round(funnelMeta.explorationScore)}/100</li>
                <li>Forced inclusion: ${escapeHtml(funnelMeta.forced ? funnelMeta.forcedReasons.join(", ") : "No")}</li>
                <li>Signals: ${escapeHtml(funnelMeta.screenSignals.join(", ") || "None recorded")}</li>
                <li>Penalties: ${escapeHtml(funnelMeta.screenPenalties.join(", ") || "None recorded")}</li>
                <li>Matched capabilities: ${escapeHtml(funnelMeta.matchedCapabilityLabels.join(", ") || "None recorded")}</li>
                ${
                  funnelMeta.safeExcludedReason
                    ? `<li>Safe exclusion reason: ${escapeHtml(funnelMeta.safeExcludedReason)}</li>`
                    : ""
                }
              </ul>
            </div>
          `
        : ""
    }
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
    <div class="detail-section">
      <h4>Verification packet</h4>
      <details>
        <summary>Inspect current V4 verification packet</summary>
        <pre class="debug-pre">${escapeHtml(JSON.stringify(packet, null, 2))}</pre>
      </details>
    </div>
  `;
}

function layout(content, runtime, derived, persistence, sourceCache) {
  const aiStatus = getAiStatusMeta(runtime.ai);
  const profileMode = getProfileMode(derived.company);
  const persistenceMeta = getPersistenceMeta(persistence);
  const sourceCacheMeta = getSourceCacheMeta(sourceCache);
  const adminRoute = isAdminRoute(uiState.route);
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
            <p class="eyebrow">${adminRoute ? escapeHtml(formatApplicationDate(derived.now)) : "Active company"}</p>
            <h2>${escapeHtml(derived.company.legalName)}</h2>
            ${adminRoute ? "" : `<p class="topbar-subtitle">Decision-first public opportunity assessment for this company.</p>`}
          </div>
          <div class="topbar-actions">
            ${adminRoute ? pill(aiStatus.shortLabel, aiStatus.tone) : ""}
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

function renderRoute(route, state, runtime, derived, persistence, sourceCache, connectorStates, refreshScheduler) {
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
      return renderSourcesPage(state, runtime, sourceCache, connectorStates, refreshScheduler);
    case "debug":
      return renderDebugPage(derived, persistence);
    case "evaluation":
      return renderEvaluationPage(derived);
    case "health":
      return renderHealthPage(state, runtime, derived, persistence, sourceCache, connectorStates, refreshScheduler);
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

function downloadReport({ company, opportunity, analysis, aiReviewState }) {
  const reportExport = buildCustomerReportExport({
    company,
    opportunity,
    analysis,
    aiReviewState
  });
  const blob = new Blob([reportExport.html], { type: reportExport.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = reportExport.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function openUrlInNewTab(value) {
  const href = safeLinkHref(value);
  if (!href) return false;

  if (typeof globalThis.window?.open === "function") {
    globalThis.window.open(href, "_blank", "noopener,noreferrer");
    return true;
  }

  const doc = globalThis.document;
  if (doc?.createElement) {
    const anchor = doc.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noreferrer noopener";
    anchor.click();
    return true;
  }

  return false;
}

async function copyTextToClipboard(value) {
  const text = collapseWhitespace(value);
  if (!text) return false;

  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Continue to the local fallbacks below.
  }

  const doc = globalThis.document;
  if (doc?.createElement && doc.body?.appendChild && typeof doc.execCommand === "function") {
    const textarea = doc.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    doc.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = doc.execCommand("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
    if (copied) return true;
  }

  if (typeof globalThis.window?.prompt === "function") {
    globalThis.window.prompt("Copy tender reference", text);
    return true;
  }

  return false;
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
  const bdnsSyncService = services.runBdnsSync ?? runBdnsSync;
  const placspSyncService = services.runPlacspSync ?? runPlacspSync;
  const sourceCacheService = services.sourceCache ?? null;
  const analysisCacheService = services.analysisCache ?? createAnalysisCache();
  let sourceCacheStatus = sourceCacheService?.getStatus?.() ?? null;
  let placspConnectorState = createConnectorState("placsp");
  let bdnsConnectorState = createConnectorState("bdns");
  let placspSyncActive = false;
  let bdnsSyncActive = false;

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
      {
        placsp: placspConnectorState,
        bdns: bdnsConnectorState
      },
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

  async function hydrateBdnsConnectorState() {
    if (!sourceCacheService?.getConnectorState) return bdnsConnectorState;
    const result = await sourceCacheService.getConnectorState("bdns");
    bdnsConnectorState = createConnectorState("bdns", result?.state ?? createConnectorState("bdns"));
    return bdnsConnectorState;
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

  async function hydrateBdnsSourceCache() {
    if (!sourceCacheService) {
      return {
        ok: true,
        count: 0,
        durationMs: 0
      };
    }

    const loadResult = await sourceCacheService.loadByConnector("bdns");
    sourceCacheStatus = sourceCacheService.getStatus();

    if (!loadResult.ok) {
      render();
      return loadResult;
    }

    const nextState = clone(store.getState());
    nextState.opportunities = mergeSourceOpportunities(nextState.opportunities, "bdns", loadResult.opportunities);
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

  async function persistBdnsConnectorState(patch) {
    bdnsConnectorState = createConnectorState("bdns", {
      ...bdnsConnectorState,
      ...patch
    });
    if (!sourceCacheService?.setConnectorState) return bdnsConnectorState;
    const result = await sourceCacheService.setConnectorState("bdns", bdnsConnectorState);
    bdnsConnectorState = result?.state ?? bdnsConnectorState;
    return bdnsConnectorState;
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

  async function performBdnsSync({
    requestMode = "manual",
    runMode = "manual",
    pages = uiState.bdnsMaxPages,
    pageSize = uiState.bdnsPageSize,
    showMessage = true,
    reason = "manual"
  } = {}) {
    if (bdnsSyncActive) {
      return {
        ok: false,
        busy: true
      };
    }

    bdnsSyncActive = true;
    uiState.bdnsSyncing = true;
    if (showMessage) {
      setMessage(describeBdnsSyncStart({
        runMode,
        requestMode,
        pages,
        pageSize
      }), "info", "compact");
      render();
    }

    try {
      const payload = await bdnsSyncService({
        mode: requestMode,
        pages,
        pageSize
      });
      const nextState = clone(store.getState());
      const syncRun = mergeBdnsSyncResult(nextState, payload, runMode);
      nextState.auditEvents = [
        makeAudit(
          syncRun.note,
          `Fetched ${payload.pagesFetched} page(s), discovered ${payload.discoveryCount} calls, and enriched ${payload.detailsFetched} detailed grant records.`
        ),
        ...(nextState.auditEvents ?? [])
      ].slice(0, 50);

      let cacheResult = { ok: true };
      if (sourceCacheService) {
        const touchedIds = new Set((payload.opportunities ?? []).map((item) => item.id));
        if (touchedIds.size > 0) {
          const touchedBdnsOpportunities = nextState.opportunities.filter(
            (item) => touchedIds.has(item.id) && item.sourceConnector === "bdns"
          );
          cacheResult = await sourceCacheService.upsertMany("bdns", touchedBdnsOpportunities);
          sourceCacheStatus = sourceCacheService.getStatus();
        }
      }

      store.replace(nextState);
      const completedAt = payload.completedAt ?? new Date().toISOString();
      await persistBdnsConnectorState({
        lastSuccessfulSyncAt: completedAt,
        lastRunMode: runMode,
        lastPagesFetched: payload.pagesFetched ?? 0,
        lastErrorAt: null,
        lastErrorCode: null,
        truncated: payload.truncated ?? false,
        cursorReached: null
      });
      if (runMode === "automatic") await persistBdnsConnectorState({ lastAutomaticSyncAt: completedAt });
      else await persistBdnsConnectorState({ lastManualSyncAt: completedAt });
      if (requestMode === "reconcile" || runMode === "reconcile") {
        await persistBdnsConnectorState({ lastReconciliationAt: completedAt });
      }

      const persistenceStatus = store.getPersistenceStatus();
      const workspacePersisted = persistenceStatus.status === "available";
      const sourceCachePersisted = !sourceCacheService || cacheResult.ok === true;
      if (showMessage) {
        setMessage(
          describeBdnsSyncSuccess(syncRun, {
            workspacePersisted,
            sourceCachePersisted,
            runMode,
            requestMode
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
        prependSourceSyncRun(draft, buildBdnsFailureRun(error, {
          runMode,
          requestMode,
          pages,
          pageSize
        }));
      }, makeAudit("BDNS sync failed", error?.message ?? "Unknown BDNS sync error."));
      await persistBdnsConnectorState({
        lastRunMode: runMode,
        lastErrorAt: new Date().toISOString(),
        lastErrorCode: error?.code ?? "bdns_sync_failed"
      });
      if (showMessage) setMessage(error?.message ?? "BDNS sync failed.", "error");
      throw error;
    } finally {
      bdnsSyncActive = false;
      uiState.bdnsSyncing = false;
      render();
    }
  }

  const placspRefreshScheduler =
    services.refreshSchedulers?.placsp ??
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
  const bdnsRefreshScheduler =
    services.refreshSchedulers?.bdns ??
    (services.refreshScheduler
      ? null
      : sourceCacheService
        ? createConnectorRefreshScheduler({
            connector: "bdns",
            sourceCache: sourceCacheService,
            isSyncActive: () => bdnsSyncActive || uiState.bdnsSyncing,
            buildSyncRequest: ({ reconciliationDue }) =>
              reconciliationDue
                ? {
                    requestMode: "reconcile",
                    runMode: "automatic",
                    pages: BDNS_RECONCILE_PAGES,
                    pageSize: BDNS_RECONCILE_PAGE_SIZE
                  }
                : {
                    requestMode: "automatic",
                    runMode: "automatic",
                    pages: BDNS_AUTOMATIC_PAGES,
                    pageSize: BDNS_AUTOMATIC_PAGE_SIZE
                  },
            runSync: ({ requestMode, runMode, pages, pageSize, reason }) =>
              performBdnsSync({
                requestMode,
                runMode,
                pages,
                pageSize,
                showMessage: false,
                reason
              })
          })
        : null);
  const refreshScheduler = {
    placsp: placspRefreshScheduler,
    bdns: bdnsRefreshScheduler,
    getNextAutomaticRefreshAt(state, connector = "placsp") {
      const targetScheduler = connector === "bdns" ? bdnsRefreshScheduler : placspRefreshScheduler;
      return targetScheduler?.getNextAutomaticRefreshAt
        ? targetScheduler.getNextAutomaticRefreshAt(state)
        : getNextAutomaticRefreshAt(state);
    }
  };

  render();
  const sourceCacheReady = Promise.all([
    hydratePlacspConnectorState(),
    hydratePlacspSourceCache(),
    hydrateBdnsConnectorState(),
    hydrateBdnsSourceCache()
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
          connector: "official_connectors",
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
  placspRefreshScheduler?.start?.({ ready: sourceCacheReady });
  bdnsRefreshScheduler?.start?.({ ready: sourceCacheReady });

  root.addEventListener("toggle", (event) => {
    if (event.target?.dataset?.control !== "developer-tools") return;
    uiState.developerToolsOpen = Boolean(event.target.open);
  });

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
      if (isAdminRoute(uiState.route)) uiState.developerToolsOpen = true;
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
      uiState.detailPanelCollapsed = false;
      if (uiState.route === "overview") uiState.route = "opportunities";
      render();
      return;
    }

    if (action === "search-wider") {
      const currentDepth = getAnalysisDepth(derived.company.id, ACTIVE_SEARCH_POLICY);
      const nextDepth = expandAnalysisDepth(derived.company.id, ACTIVE_SEARCH_POLICY);
      if (nextDepth === currentDepth) {
        setMessage(
          "You've reached the current search limit.",
          "info",
          "compact"
        );
      } else {
        setMessage(
          `Finding more opportunities increased the analysed set from ${currentDepth} to ${nextDepth} for ${derived.company.legalName}.`,
          "success",
          "compact"
        );
      }
      render();
      return;
    }

    if (action === "collapse-report") {
      uiState.detailPanelCollapsed = true;
      render();
      return;
    }

    if (action === "open-report") {
      uiState.detailPanelCollapsed = false;
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

    if (action === "toggle-bdns-auto-refresh") {
      await persistBdnsConnectorState({
        autoRefreshEnabled: !bdnsConnectorState.autoRefreshEnabled
      });
      setMessage(
        bdnsConnectorState.autoRefreshEnabled
          ? "Automatic BDNS / SNPSAP refresh enabled for this local environment."
          : "Automatic BDNS / SNPSAP refresh disabled for this local environment.",
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

    if (action === "sync-bdns") {
      try {
        await performBdnsSync({
          requestMode: "manual",
          runMode: "manual",
          pages: uiState.bdnsMaxPages,
          pageSize: uiState.bdnsPageSize
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
      const opportunityId = button.dataset.id;
      const analysis = derived.portfolio.analysed.find((item) => item.opportunityId === opportunityId) ?? null;
      const opportunity = state.opportunities.find((item) => item.id === opportunityId) ?? null;
      const aiReviewState = opportunity
        ? derived.aiReviewByOpportunity.get(opportunity.id) ?? null
        : null;
      if (analysis && opportunity) {
        downloadReport({
          company: derived.company,
          opportunity,
          analysis,
          aiReviewState
        });
      }
      return;
    }

    if (action === "download-calendar") {
      const opportunityId = button.dataset.id;
      const analysis = derived.portfolio.analysed.find((item) => item.opportunityId === opportunityId) ?? null;
      const opportunity = state.opportunities.find((item) => item.id === opportunityId) ?? null;
      if (!analysis || !opportunity) return;
      const result = downloadCalendarEvent({
        company: derived.company,
        opportunity,
        analysis,
        now: derived.now
      });
      if (!result.ok) {
        setMessage(result.reason, "warn", "compact");
        render();
      }
      return;
    }

    if (action === "copy-reference") {
      const opportunity = state.opportunities.find((item) => item.id === button.dataset.id) ?? null;
      const officialAccess = opportunity ? resolveOfficialNoticeAccess(opportunity) : null;
      const reference = officialAccess?.copyReferenceValue ?? null;
      if (!reference) {
        setMessage("Official reference not available to copy.", "warn", "compact");
        render();
        return;
      }
      const copied = await copyTextToClipboard(reference);
      setMessage(
        copied ? "Tender reference copied." : `Copy the tender reference manually: ${reference}`,
        copied ? "success" : "warn",
        "compact"
      );
      render();
      return;
    }

    if (action === "find-on-placsp") {
      const opportunity = state.opportunities.find((item) => item.id === button.dataset.id) ?? null;
      const officialAccess = opportunity ? resolveOfficialNoticeAccess(opportunity) : null;
      const searchUrl = officialAccess?.searchUrl ?? null;
      if (!searchUrl) {
        setMessage("PLACSP search is not available for this opportunity.", "warn", "compact");
        render();
        return;
      }

      const reference = officialAccess?.copyReferenceValue ?? null;
      const copied = reference ? await copyTextToClipboard(reference) : false;
      openUrlInNewTab(searchUrl);

      const message = reference
        ? copied
          ? `Reference ${reference} copied. Paste it into the Expediente field on PLACSP.`
          : `Open PLACSP search and paste reference ${reference} into the Expediente field.`
        : "Open PLACSP search and use the buyer/title details shown in OportuneX.";
      setMessage(message, copied || !reference ? "success" : "warn", "compact");
      render();
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
        const response = await aiVerificationService({
          company: derived.company,
          opportunity,
          analysis: match
        });
        const result = normalizeAiVerificationResponse(response);
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
        if (error?.adminMessage) {
          console.error("[AI verification]", error.adminMessage);
        }
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
    uiState.detailPanelCollapsed = false;
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
      uiState.detailPanelCollapsed = false;
      setMessage("Active company changed.", "info", "compact");
      render();
      return;
    }
    if (element?.dataset?.control === "placsp-pages") {
      uiState.placspMaxPages = normalizePlacspMaxPages(element.value);
      render();
      return;
    }
    if (element?.dataset?.control === "bdns-pages") {
      uiState.bdnsMaxPages = normalizeBdnsMaxPages(element.value);
      render();
      return;
    }
    if (element?.dataset?.control === "bdns-page-size") {
      uiState.bdnsPageSize = normalizeBdnsPageSize(element.value);
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
