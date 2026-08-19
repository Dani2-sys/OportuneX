import {
  ACTION_COPY,
  CONFIDENCE_COPY,
  OPPORTUNITY_TYPES,
  RECOMMENDATION_COPY
} from "../config.js";
import { formatDeadline } from "./deadline.js";
import { escapeHtml, formatDate, toSlug } from "../utils.js";

export const CUSTOMER_AI_REVIEW_LABELS = {
  accepted: "Assessment confirmed",
  needs_review: "Follow-up required",
  rejected: "Assessment challenged"
};

export const OFFICIAL_PLACSP_HOSTS = new Set([
  "contrataciondelestado.es",
  "contrataciondelsectorpublico.gob.es"
]);

export const PLACSP_SEARCH_URL = "https://contrataciondelestado.es/wps/portal/plataforma/buscador/";
export const PLACSP_PLATFORM_LABEL = "Plataforma de Contratación del Sector Público";
export const PLACSP_SEARCH_HELP_WITH_REFERENCE =
  "Find on PLACSP copies the tender reference and opens the official search page. Paste the reference into the Expediente field.";
export const PLACSP_SEARCH_HELP_WITHOUT_REFERENCE =
  "Open PLACSP search and use the buyer/title details shown in OportuneX.";

const TECHNICAL_REQUIREMENT_URL_RE = /https?:\/\/[^\s)]+/i;
const TECHNICAL_REQUIREMENT_URL_GLOBAL_RE = /https?:\/\/[^\s)]+/gi;
const TECHNICAL_REQUIREMENT_PART_RE =
  /^(specific tenderer requirement|qualification requirement|technical qualification|financial qualification)$/i;
const TECHNICAL_REQUIREMENT_PREFIX_RE =
  /\b(specific tenderer requirement|qualification requirement|technical qualification|financial qualification)\b/i;
const PUBLISHED_REQUIREMENT_PREFIX_RE =
  /^please verify whether the company satisfies the published requirement:\s*/i;
const REQUIREMENT_XML_ARTIFACT_RE = /&#x0*D;?|&#13;?/gi;
const REQUIREMENT_TECHNICAL_TOKEN_RE =
  /\b(?:TechnicalCapabilityTypeCode|FinancialCapabilityTypeCode|DeclarationTypeCode|GuaranteeTypeCode)(?:-\d+(?:\.\d+)*)?(?:\.gc)?\b/gi;
const REQUIREMENT_TECHNICAL_TOKEN_TEST_RE =
  /\b(?:TechnicalCapabilityTypeCode|FinancialCapabilityTypeCode|DeclarationTypeCode|GuaranteeTypeCode)(?:-\d+(?:\.\d+)*)?(?:\.gc)?\b/i;
const REQUIREMENT_GC_TOKEN_RE = /\b\d+(?:\.\d+)*\.gc\b/gi;
const REQUIREMENT_GC_TOKEN_TEST_RE = /\b\d+(?:\.\d+)*\.gc\b/i;
const REQUIREMENT_SCHEMA_TOKEN_RE = /\bschema\/control tokens?\b/gi;
const REQUIREMENT_SCHEMA_TOKEN_TEST_RE = /\bschema\/control tokens?\b/i;
const REQUIREMENT_GENERIC_TITLE_RE =
  /^(qualification requirement|technical qualification|financial qualification|specific tenderer requirement)$/i;
const SECTION_REFERENCE_RE =
  /^(?:(?:see|tal y como se detalla en|de acuerdo(?: a)?(?: lo establecido en)?|de acuerdo con lo establecido en|seg[uú]n|conforme(?: a)?(?: lo establecido en)?)\s+)?(?:el|la)?\s*(?:apartado|punto|cl[aá]usula|section)\s+([A-Za-z0-9][A-Za-z0-9./-]*)\s+(?:del|de la|of the)\s+(PCAP|PPT)\.?$/i;
const GUARANTEE_SECTION_ONLY_RE = /^See section [A-Za-z0-9./-]+ of the (?:PCAP|PPT)\.$/i;
const GUARANTEE_GENERIC_RE =
  /^(?:guarantee|guarantees|definitive guarantee|provisional guarantee|financial guarantee)$/i;
const GUARANTEE_MEANINGFUL_SIGNAL_RE =
  /\b(?:\d+(?:[.,]\d+)?\s*%|€|eur|no guarantee|required guarantee|definitive guarantee|provisional guarantee|waived|without guarantee|sin garant[ií]a)\b/i;

function normalizeRequirementCategory(part) {
  if (/^technical qualification$/i.test(part)) return "Technical qualification";
  if (/^financial qualification$/i.test(part)) return "Financial qualification";
  if (/^qualification requirement$/i.test(part)) return "Qualification requirement";
  if (/^specific tenderer requirement$/i.test(part)) return "Specific tenderer requirement";
  return part;
}

function collapseRequirementArtifacts(text) {
  return collapseWhitespace(
    String(text ?? "")
      .replace(REQUIREMENT_XML_ARTIFACT_RE, " ")
      .replace(REQUIREMENT_TECHNICAL_TOKEN_RE, " ")
      .replace(REQUIREMENT_GC_TOKEN_RE, " ")
      .replace(REQUIREMENT_SCHEMA_TOKEN_RE, " ")
      .replace(/\bZZZ:\s*/gi, " ")
  );
}

function trimPresentationText(text) {
  return collapseWhitespace(text).replace(/^[\s:;,.()-]+|[\s:;,.()-]+$/g, "");
}

function normalizeSectionReferenceText(text) {
  const cleaned = trimPresentationText(text);
  if (!cleaned) return "";
  const match = cleaned.match(SECTION_REFERENCE_RE);
  if (!match) return cleaned;
  return `See section ${match[1]} of the ${match[2].toUpperCase()}.`;
}

function capitalize(value = "") {
  return value ? value[0].toUpperCase() + value.slice(1) : "";
}

function fitBandLabel(analysis = {}) {
  const fitBand = analysis.fitBand ?? analysis.recommendationClass ?? null;
  return fitBand ? RECOMMENDATION_COPY[fitBand] ?? fitBand : "Not stated";
}

function actionLabel(analysis = {}) {
  const code = analysis.decision?.recommendedAction?.code ?? null;
  return code ? ACTION_COPY[code] ?? code : analysis.decision?.recommendedAction?.label ?? "Not stated";
}

function confidenceLabel(value = "") {
  const normalized = String(value ?? "").trim().toUpperCase();
  return CONFIDENCE_COPY[normalized] ?? capitalize(String(value ?? "").trim()) ?? "Not stated";
}

function detailDisclosure(summary, body) {
  return `
    <details>
      <summary>${escapeHtml(summary)}</summary>
      ${body}
    </details>
  `;
}

function renderList(items = [], fallback) {
  if (!items.length) return `<p>${escapeHtml(fallback)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderHtmlAiSummary(aiReviewState, analysis, companyName) {
  const record = aiReviewState?.status === "current" ? aiReviewState.review ?? null : null;
  if (!record) {
    if (aiReviewState?.status === "stale" && aiReviewState.review) {
      return `
        <section>
          <h2>AI verification</h2>
          <p>A saved AI verification exists for this opportunity, but it is outdated and was not treated as current for this export.</p>
        </section>
      `;
    }
    return "";
  }

  const result = record.result ?? {};
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
  const disagreements = Array.isArray(result.disagreements) ? result.disagreements.filter(Boolean) : [];
  const notePreview =
    collapseWhitespace(result.notes ?? "").match(/[^.!?]+[.!?]?/g)?.slice(0, 3).join(" ").trim() ??
    collapseWhitespace(result.notes ?? "");
  const changes = [];
  const currentAction = analysis.decision?.recommendedAction?.code ?? null;
  const currentFitBand = analysis.fitBand ?? analysis.recommendationClass ?? null;

  if (result.corrected_fit_band && result.corrected_fit_band !== currentFitBand) {
    changes.push(`Fit: ${fitBandLabel(analysis)} → ${RECOMMENDATION_COPY[result.corrected_fit_band] ?? result.corrected_fit_band}`);
  }
  if (result.corrected_action && result.corrected_action !== currentAction) {
    changes.push(`Action: ${actionLabel(analysis)} → ${ACTION_COPY[result.corrected_action] ?? result.corrected_action}`);
  }
  disagreements.forEach((item) => changes.push(item));
  const previewWarnings = warnings.slice(0, 4);
  const previewChanges = changes.slice(0, 3);

  return `
    <section>
      <h2>AI verification</h2>
      <p><strong>${escapeHtml(CUSTOMER_AI_REVIEW_LABELS[result.review_status] ?? "Verification completed")}</strong> · ${escapeHtml(confidenceLabel(result.confidence))} confidence</p>
      <h3>What this means for ${escapeHtml(companyName)}</h3>
      <p>${escapeHtml(notePreview || "No additional AI advisory note was recorded.")}</p>
      <h3>What ${escapeHtml(companyName)} should verify next</h3>
      ${renderList(previewWarnings, "No new material warning was identified.")}
      ${warnings.length > previewWarnings.length ? `<p class="meta-note">+ ${escapeHtml(String(warnings.length - previewWarnings.length))} more in Detailed AI reasoning.</p>` : ""}
      <h3>What changed after verification</h3>
      ${renderList(previewChanges, "No material change to the OportuneX assessment.")}
      ${changes.length > previewChanges.length ? `<p class="meta-note">+ ${escapeHtml(String(changes.length - previewChanges.length))} more in Detailed AI reasoning.</p>` : ""}
      ${detailDisclosure(
        "Detailed AI reasoning",
        `
          <p>${escapeHtml(collapseWhitespace(result.notes ?? "") || "No additional AI advisory note was recorded.")}</p>
          <h3>Warnings</h3>
          ${renderList(warnings, "No warning was recorded.")}
          <h3>Disagreements</h3>
          ${renderList(disagreements, "No disagreement was recorded.")}
        `
      )}
      <p class="trust-note">Use this verification to focus your review. Confirm final eligibility, documents and submission details in the official notice before acting.</p>
    </section>
  `;
}

function safeHttpUrl(value) {
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

function maybeUpgradePlacspUrl(urlValue) {
  const safe = safeHttpUrl(urlValue);
  if (!safe) return null;
  const url = new URL(safe);
  if (!OFFICIAL_PLACSP_HOSTS.has(url.hostname)) return safe;
  if (url.protocol === "http:") url.protocol = "https:";
  return url.toString();
}

export function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function stripTechnicalRequirementBoilerplate(text) {
  const original = collapseRequirementArtifacts(text);
  if (!original) return "";

  const cleaned = original.replace(TECHNICAL_REQUIREMENT_URL_GLOBAL_RE, " ");
  const filteredParts = cleaned
    .split(/\s*:\s*/)
    .map((part) => collapseRequirementArtifacts(part))
    .filter(Boolean)
    .filter((part) => !TECHNICAL_REQUIREMENT_PART_RE.test(part))
    .filter((part) => !/^\d+$/.test(part));

  const candidate = normalizeSectionReferenceText(filteredParts.join(": "));
  return candidate || original;
}

export function hasTechnicalRequirementBoilerplate(text) {
  const raw = String(text ?? "");
  const value = collapseRequirementArtifacts(text);
  return (
    Boolean(value || raw.trim()) &&
    (TECHNICAL_REQUIREMENT_URL_RE.test(raw) ||
      TECHNICAL_REQUIREMENT_PREFIX_RE.test(raw) ||
      PUBLISHED_REQUIREMENT_PREFIX_RE.test(raw) ||
      REQUIREMENT_TECHNICAL_TOKEN_TEST_RE.test(raw) ||
      REQUIREMENT_GC_TOKEN_TEST_RE.test(raw) ||
      REQUIREMENT_SCHEMA_TOKEN_TEST_RE.test(raw) ||
      /\bZZZ:\s*/i.test(raw))
  );
}

function normalizeCustomerComparisonText(text) {
  return stripTechnicalRequirementBoilerplate(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function isDuplicateHighLevelText(candidate, references = []) {
  const normalizedCandidate = normalizeCustomerComparisonText(candidate);
  if (!normalizedCandidate) return true;
  return references.some((reference) => {
    const normalizedReference = normalizeCustomerComparisonText(reference);
    if (!normalizedReference) return false;
    return (
      normalizedReference === normalizedCandidate ||
      normalizedReference.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedReference)
    );
  });
}

export function presentCustomerDecisionText(text, { issueTitle = "", verificationFallback = false } = {}) {
  const original = collapseWhitespace(text);
  if (!original) return "";

  const cleanedTitle = stripTechnicalRequirementBoilerplate(issueTitle);
  const hadTechnicalBoilerplate = hasTechnicalRequirementBoilerplate(original);

  if (!hadTechnicalBoilerplate && !/^potential hard blocker:\s*/i.test(original)) {
    return original;
  }

  const withoutPublishedPrefix = collapseWhitespace(original.replace(PUBLISHED_REQUIREMENT_PREFIX_RE, ""));
  const cleaned = stripTechnicalRequirementBoilerplate(withoutPublishedPrefix);

  if (/^potential hard blocker:\s*/i.test(original) && cleanedTitle) {
    return `Potential hard blocker: ${cleanedTitle} not yet verified.`;
  }

  if (verificationFallback && cleanedTitle && hadTechnicalBoilerplate) {
    return `${cleanedTitle} has not yet been verified.`;
  }

  if (cleaned && cleaned !== cleanedTitle) return cleaned;
  if (cleanedTitle && hadTechnicalBoilerplate) return `${cleanedTitle} has not yet been verified.`;
  return cleaned || original;
}

export function getCompanyDisplayName(company = {}) {
  return collapseWhitespace(company.tradingName || company.legalName || "the active company");
}

export function getCustomerAiReviewLabel(reviewStatus) {
  return CUSTOMER_AI_REVIEW_LABELS[reviewStatus] ?? "Verification completed";
}

export function getCustomerAiReviewTone(reviewStatus) {
  if (reviewStatus === "accepted") return "good";
  if (reviewStatus === "needs_review") return "warn";
  if (reviewStatus === "rejected") return "bad";
  return "neutral";
}

export function requirementStatusLabel(row) {
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

export function humanizeRequirementLabel(rawLabel = "") {
  const original = collapseRequirementArtifacts(rawLabel);
  if (!original) {
    return {
      title: "",
      detail: "",
      rawLabel: ""
    };
  }

  const parts = original
    .replace(TECHNICAL_REQUIREMENT_URL_GLOBAL_RE, " ")
    .split(/\s*:\s*/)
    .map((part) =>
      normalizeSectionReferenceText(
        collapseRequirementArtifacts(
          part
          .replace(REQUIREMENT_TECHNICAL_TOKEN_RE, " ")
        )
      )
    )
    .filter(Boolean)
    .filter((part) => !/^\d+$/.test(part));

  let category = "";
  const meaningfulParts = [];

  parts.forEach((part) => {
    if (REQUIREMENT_GENERIC_TITLE_RE.test(part)) {
      category = normalizeRequirementCategory(part);
      return;
    }
    meaningfulParts.push(part);
  });

  const specificTitle =
    meaningfulParts.find((part) => /capacidad de obrar|no estar incurso en incompatibilidades/i.test(part)) ??
    "";

  if (specificTitle) {
    return {
      title: specificTitle,
      detail: meaningfulParts.filter((part) => part !== specificTitle).map(normalizeSectionReferenceText).join(": "),
      rawLabel: original
    };
  }

  const detailText = meaningfulParts.map(normalizeSectionReferenceText).join(": ");

  if (
    category &&
    detailText &&
    (
      detailText.length > 60 ||
      /\b(?:pcap|ppt|cl[aá]usula|apartado|section|seg[uú]n|conforme|de acuerdo)\b/i.test(detailText)
    )
  ) {
    return {
      title: category,
      detail: detailText,
      rawLabel: original
    };
  }

  if (meaningfulParts.length) {
    return {
      title: meaningfulParts[0],
      detail: meaningfulParts.slice(1).map(normalizeSectionReferenceText).join(": "),
      rawLabel: original
    };
  }

  return {
    title: category || original,
    detail: "",
    rawLabel: original
  };
}

export function buildRequirementPresentationRows(requirementRows = []) {
  return requirementRows.map((row) => {
    const humanized = humanizeRequirementLabel(row.label);
    const questionImplication = row.question
      ? presentCustomerDecisionText(row.question, {
          issueTitle: humanized.title || row.label,
          verificationFallback: true
        })
      : "";
    const implication =
      humanized.detail ||
      row.failureReason ||
      row.why ||
      questionImplication ||
      (
        row.status === "needs_verification" && row.mandatory
          ? "This mandatory point still needs verification."
          : "No short implication was recorded."
      );

    return {
      ...row,
      title: humanized.title || row.label,
      detail: humanized.detail,
      rawLabel: humanized.rawLabel || row.label,
      implication: normalizeSectionReferenceText(collapseRequirementArtifacts(implication)),
      statusLabel: requirementStatusLabel(row)
    };
  });
}

export function presentCustomerGuaranteeText(value, { evidenced = false, fallback = "Not stated" } = {}) {
  const original = collapseRequirementArtifacts(value);
  if (!original) return fallback;

  const cleaned = normalizeSectionReferenceText(stripTechnicalRequirementBoilerplate(original));
  if (!cleaned) return fallback;
  if (GUARANTEE_SECTION_ONLY_RE.test(cleaned) || GUARANTEE_GENERIC_RE.test(cleaned)) {
    return "Published guarantee information requires source verification.";
  }
  if (!evidenced && hasTechnicalRequirementBoilerplate(original) && !GUARANTEE_MEANINGFUL_SIGNAL_RE.test(cleaned)) {
    return "Published guarantee information requires source verification.";
  }
  if (!evidenced && GUARANTEE_MEANINGFUL_SIGNAL_RE.test(cleaned)) {
    return `${cleaned} (published value still needs source verification)`;
  }
  return cleaned;
}

export function buildRequirementEvidenceAuditRows(requirementRows = [], evidence = []) {
  const evidenceById = new Map(
    (Array.isArray(evidence) ? evidence : []).map((item) => [item.id, item])
  );

  return buildRequirementPresentationRows(requirementRows).map((row) => {
    const linkedEvidence = (row.evidenceIds ?? [])
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter(Boolean);

    return {
      ...row,
      linkedEvidence,
      sourcePaths: linkedEvidence.map((item) => item.sourcePath).filter(Boolean),
      excerpts: linkedEvidence.map((item) => item.excerpt).filter(Boolean)
    };
  });
}

export function isPlacspOpportunity(opportunity = {}) {
  if (opportunity.sourceConnector === "placsp") return true;
  return Array.isArray(opportunity.sources)
    ? opportunity.sources.some((source) => source?.metadata?.sourceType === "official_open_data_atom")
    : false;
}

export function resolveOfficialNoticeAccess(opportunity = {}) {
  const placsp = isPlacspOpportunity(opportunity);
  const sources = Array.isArray(opportunity.sources) ? opportunity.sources : [];
  const officialPlacspSource = placsp
    ? sources.find((source) => source?.metadata?.sourceType === "official_open_data_atom") ?? null
    : null;
  const candidates = [
    officialPlacspSource?.metadata?.entryLinkUrl ?? null,
    opportunity.noticeUrl ?? null
  ].filter(Boolean);
  const referenceNumber = collapseWhitespace(opportunity.referenceNumber);
  let primaryUrl = null;
  let preservedDirectUrl = null;

  candidates.forEach((candidate) => {
    const safe = safeHttpUrl(candidate);
    if (!safe) return;
    if (!preservedDirectUrl) preservedDirectUrl = safe;
    const resolved = placsp ? maybeUpgradePlacspUrl(safe) : safe;
    if (!primaryUrl) primaryUrl = resolved;
  });

  return {
    connector: opportunity.sourceConnector ?? null,
    isPlacsp: placsp,
    referenceNumber: referenceNumber || null,
    primaryUrl,
    preservedDirectUrl,
    searchUrl: placsp ? PLACSP_SEARCH_URL : null,
    platformLabel: placsp ? PLACSP_PLATFORM_LABEL : null,
    helpNote: placsp
      ? referenceNumber
        ? PLACSP_SEARCH_HELP_WITH_REFERENCE
        : PLACSP_SEARCH_HELP_WITHOUT_REFERENCE
      : "",
    searchInstruction: placsp
      ? referenceNumber
        ? "Search PLACSP using the official reference above."
        : "Search PLACSP using the buyer/title details shown above."
      : "",
    copyReferenceValue: referenceNumber || null
  };
}

export function buildCustomerReportExport({
  company,
  opportunity,
  analysis,
  aiReviewState = null
}) {
  const companyName = getCompanyDisplayName(company);
  const requirementRows = buildRequirementPresentationRows(analysis.requirementRows ?? []);
  const officialAccess = resolveOfficialNoticeAccess(opportunity);
  const fit = fitBandLabel(analysis);
  const action = actionLabel(analysis);
  const primaryIssue = analysis.potentialHardBlockers?.[0] ?? analysis.unknowns?.[0] ?? analysis.blockers?.[0] ?? null;
  const decisionReason = presentCustomerDecisionText(
    analysis.decision?.mainReason ?? analysis.executiveVerdict ?? "No summary recorded.",
    {
      issueTitle: primaryIssue?.title ?? ""
    }
  );
  const decisionBlocker = presentCustomerDecisionText(
    analysis.decision?.mainQuestion ?? primaryIssue?.detail ?? "No blocking question is currently recorded.",
    {
      issueTitle: primaryIssue?.title ?? "",
      verificationFallback: true
    }
  );
  const deadlineNote = opportunity.deadline?.date
    ? opportunity.deadline.time
      ? !opportunity.deadline.sourceTimezone && opportunity.deadline.timezone
        ? `Deadline time interpreted by OportuneX as ${opportunity.deadline.timezone} because the official source did not state an explicit timezone. Verify the official notice.`
        : ""
      : "Exact submission time has not been verified. Check the official notice."
    : "";
  const filename = `${toSlug(companyName)}-${toSlug(analysis.displayTitle || opportunity.title || "oportunex-report")}.html`;
  const generatedAt = formatDate(new Date().toISOString(), { includeTime: true });

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(`OportuneX report — ${analysis.displayTitle || opportunity.title}`)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --surface: #ffffff;
        --ink: #122033;
        --ink-soft: #4c5f78;
        --border: #d9e2ef;
        --primary: #2f6dd3;
        --good: #1c7a43;
        --warn: #a76708;
        --bad: #bc2f2a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 32px;
        background: var(--bg);
        color: var(--ink);
        font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        display: grid;
        gap: 18px;
      }
      section, header {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 22px 24px;
      }
      h1, h2, h3, p { margin: 0; }
      h1 { font-size: 2rem; line-height: 1.2; margin-top: 8px; }
      h2 { font-size: 1.15rem; margin-bottom: 12px; }
      h3 { font-size: 0.95rem; margin-bottom: 8px; }
      .eyebrow {
        color: var(--ink-soft);
        font-size: 0.76rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .lead {
        margin-top: 10px;
        color: var(--ink-soft);
      }
      .pill-row, .facts {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid var(--border);
        font-size: 0.82rem;
        font-weight: 700;
      }
      .pill.good { border-color: rgba(28,122,67,0.18); color: var(--good); background: rgba(28,122,67,0.10); }
      .pill.warn { border-color: rgba(167,103,8,0.18); color: var(--warn); background: rgba(167,103,8,0.12); }
      .pill.bad { border-color: rgba(188,47,42,0.18); color: var(--bad); background: rgba(188,47,42,0.10); }
      .pill.neutral { background: #eef3fb; }
      .facts {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin-top: 14px;
      }
      .fact {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px 16px;
      }
      .fact span {
        display: block;
        color: var(--ink-soft);
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 6px;
      }
      .fact strong {
        display: block;
        font-size: 1rem;
        overflow-wrap: anywhere;
      }
      .summary {
        display: grid;
        gap: 12px;
      }
      .summary p, li {
        overflow-wrap: anywhere;
      }
      ul {
        margin: 0;
        padding-left: 18px;
      }
      .requirement-list {
        display: grid;
        gap: 12px;
      }
      .requirement-item {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px 16px;
      }
      .requirement-item p + p {
        margin-top: 6px;
        color: var(--ink-soft);
      }
      .trust-note, .meta-note {
        color: var(--ink-soft);
        font-size: 0.95rem;
      }
      a {
        color: var(--primary);
        overflow-wrap: anywhere;
      }
      details {
        border-top: 1px solid var(--border);
        padding-top: 12px;
      }
      summary {
        cursor: pointer;
        font-weight: 700;
      }
      @media print {
        body {
          padding: 0;
          background: #ffffff;
        }
        main {
          max-width: none;
          gap: 12px;
        }
        section, header {
          border-radius: 0;
          box-shadow: none;
          break-inside: avoid;
        }
      }
      @media (max-width: 720px) {
        body { padding: 16px; }
        .facts { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="eyebrow">OportuneX</p>
        <h1>${escapeHtml(analysis.displayTitle || opportunity.title || "Opportunity report")}</h1>
        <p class="lead">${escapeHtml(companyName)} · ${escapeHtml(OPPORTUNITY_TYPES[opportunity.type] ?? "Opportunity")}</p>
        <div class="pill-row" style="margin-top: 14px;">
          <span class="pill ${escapeHtml(analysis.decision?.recommendedAction?.code === "DO_NOT_PURSUE" ? "bad" : analysis.decision?.recommendedAction?.code === "VERIFY_BEFORE_DECIDING" ? "warn" : "good")}">${escapeHtml(action)}</span>
          <span class="pill neutral">${escapeHtml(fit)} · ${escapeHtml(String(analysis.matchScore ?? analysis.priorityScore ?? 0))}% match</span>
          ${
            analysis.hasPublishedLot && analysis.lotLabel
              ? `<span class="pill neutral">${escapeHtml(
                  analysis.publishedLotCount > 1
                    ? `Assessment shown for ${analysis.lotLabel} · ${analysis.publishedLotCount} published lots in this contract`
                    : `Assessment shown for ${analysis.lotLabel}`
                )}</span>`
              : ""
          }
        </div>
        <div class="facts">
          <div class="fact"><span>Buyer / issuer</span><strong>${escapeHtml(opportunity.contractingAuthority || opportunity.issuingOrganisation || analysis.primaryContact?.name || "Not stated")}</strong></div>
          <div class="fact"><span>Published value</span><strong>${escapeHtml(analysis.displayValueLabel || "Not published")}</strong></div>
          <div class="fact"><span>Deadline</span><strong>${escapeHtml(formatDeadline(opportunity.deadline))}</strong></div>
          <div class="fact"><span>Location</span><strong>${escapeHtml(analysis.locationLabel || "Not stated")}</strong></div>
        </div>
      </header>

      <section class="summary">
        <h2>Decision summary</h2>
        <p><strong>Why this stands out:</strong> ${escapeHtml(decisionReason)}</p>
        <p><strong>Before proceeding:</strong> ${escapeHtml(decisionBlocker)}</p>
        ${deadlineNote ? `<p><strong>Deadline note:</strong> ${escapeHtml(deadlineNote)}</p>` : ""}
      </section>

      <section>
        <h2>Requirements</h2>
        <div class="requirement-list">
          ${
            requirementRows.length
              ? requirementRows
                  .map(
                    (row) => `
                      <article class="requirement-item">
                        <p><strong>${escapeHtml(row.title)}</strong></p>
                        <p>${escapeHtml(row.statusLabel)}</p>
                        <p>${escapeHtml(row.implication)}</p>
                      </article>
                    `
                  )
                  .join("")
              : `<p>No mandatory requirement is currently recorded from the reviewed source set.</p>`
          }
        </div>
      </section>

      <section>
        <h2>Evidence & confidence</h2>
        <ul>
          <li>Decision confidence: ${escapeHtml(CONFIDENCE_COPY[analysis.confidenceShield?.label] ?? analysis.confidenceShield?.label ?? "Not stated")}</li>
          <li>Source confidence: ${escapeHtml(analysis.confidenceShield?.dataConfidence ?? "Not stated")}</li>
          <li>Eligibility confidence: ${escapeHtml(analysis.confidenceShield?.eligibilityConfidence ?? "Not stated")}</li>
          <li>Company-fact confidence: ${escapeHtml(analysis.confidenceShield?.companyFactConfidence ?? "Not stated")}</li>
          <li>Critical field summary: ${escapeHtml(analysis.confidenceShield?.criticalFieldSummary ?? "Not stated")}</li>
        </ul>
      </section>

      <section>
        <h2>Official source</h2>
        <ul>
          ${
            officialAccess.isPlacsp
              ? `
                <li>Official reference: ${escapeHtml(officialAccess.referenceNumber || opportunity.referenceNumber || "Not stated")}</li>
                <li>Official platform: ${escapeHtml(officialAccess.platformLabel || "PLACSP")}</li>
                ${
                  officialAccess.searchUrl
                    ? `<li>PLACSP search: <a href="${escapeHtml(officialAccess.searchUrl)}">${escapeHtml(officialAccess.searchUrl)}</a></li>`
                    : ""
                }
              `
              : `
                <li>Reference: ${escapeHtml(officialAccess.referenceNumber || opportunity.referenceNumber || "Not stated")}</li>
                ${
                  officialAccess.primaryUrl
                    ? `<li>Official notice: <a href="${escapeHtml(officialAccess.primaryUrl)}">${escapeHtml(officialAccess.primaryUrl)}</a></li>`
                    : `<li>Official notice: Not yet verified.</li>`
                }
              `
          }
        </ul>
        ${
          officialAccess.isPlacsp && officialAccess.searchInstruction
            ? `<p class="meta-note">${escapeHtml(officialAccess.searchInstruction)}</p>`
            : officialAccess.helpNote
              ? `<p class="meta-note">${escapeHtml(officialAccess.helpNote)}</p>`
              : ""
        }
        ${
          officialAccess.isPlacsp && officialAccess.preservedDirectUrl
            ? detailDisclosure(
                "Source provenance",
                `<ul><li>Source-provided PLACSP URL: <a href="${escapeHtml(officialAccess.preservedDirectUrl)}">${escapeHtml(
                  officialAccess.preservedDirectUrl
                )}</a></li></ul>`
              )
            : ""
        }
      </section>

      ${renderHtmlAiSummary(aiReviewState, analysis, companyName)}

      <section>
        <h2>Before submission</h2>
        <p class="trust-note">Use this report to focus your review. Confirm final eligibility, documents and submission details in the official notice before acting.</p>
        <p class="meta-note">Generated ${escapeHtml(generatedAt)}.</p>
        ${
          detailDisclosure(
            "Detailed OportuneX assessment",
            `
              <ul>
                <li>Recommended action: ${escapeHtml(action)}</li>
                <li>Fit: ${escapeHtml(fit)}</li>
                <li>Match score: ${escapeHtml(String(analysis.matchScore ?? analysis.priorityScore ?? 0))}%</li>
                <li>Main reason: ${escapeHtml(analysis.decision?.mainReason ?? "Not stated")}</li>
                <li>Main blocker / next question: ${escapeHtml(analysis.decision?.mainQuestion ?? "Not stated")}</li>
              </ul>
            `
          )
        }
      </section>
    </main>
  </body>
</html>`;

  return {
    filename,
    mimeType: "text/html;charset=utf-8",
    html
  };
}
