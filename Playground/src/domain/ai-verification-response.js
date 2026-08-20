import {
  VERIFICATION_DERIVED_STATUSES,
  isVerificationResultV4,
  validateVerificationResultSemantics
} from "./verification-protocol.js";

const derivedStatusSet = new Set(VERIFICATION_DERIVED_STATUSES);

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

function cloneValue(value) {
  return value == null ? value : structuredClone(value);
}

function normalizeEvidenceRefCatalog(value) {
  return sanitizeArray(value)
    .filter((item) => isPlainObject(item))
    .map((item) => ({
      ref: normalizeText(item.ref, null),
      kind: normalizeText(item.kind, null),
      display_label: normalizeText(item.display_label, null),
      canonical_ref: normalizeText(item.canonical_ref, null)
    }))
    .filter((item) => item.ref);
}

function isLegacyAiVerificationResult(value) {
  return isPlainObject(value) && (
    normalizeText(value.review_status, null) !== null ||
    Array.isArray(value.warnings) ||
    Array.isArray(value.disagreements) ||
    normalizeText(value.notes, null) !== null ||
    normalizeText(value.corrected_action, null) !== null ||
    normalizeText(value.corrected_fit_band, null) !== null
  );
}

function extractVerificationPayload(payload = {}) {
  if (!isPlainObject(payload)) return null;
  if (isVerificationResultV4(payload) || isLegacyAiVerificationResult(payload)) {
    return {
      envelope: payload,
      verification: payload
    };
  }
  if (isPlainObject(payload.result) && (isVerificationResultV4(payload.result) || isLegacyAiVerificationResult(payload.result))) {
    return {
      envelope: payload,
      verification: payload.result
    };
  }
  return null;
}

function normalizeV4Response(envelope, verification) {
  if ("review_status" in verification) {
    throw new Error("V4 AI verification response must not include review_status.");
  }

  const semanticError = validateVerificationResultSemantics(verification);
  if (semanticError) {
    throw new Error(`V4 AI verification response is invalid: ${semanticError}`);
  }

  const derivedReviewStatus = normalizeText(
    envelope.derived_review_status ?? verification.derived_review_status,
    null
  );
  if (!derivedStatusSet.has(derivedReviewStatus)) {
    throw new Error("V4 AI verification response is missing a valid derived_review_status.");
  }

  return {
    provider: normalizeText(envelope.provider ?? verification.provider, null),
    model: normalizeText(envelope.model ?? verification.model, null),
    protocol_version: verification.protocol_version,
    findings: cloneValue(sanitizeArray(verification.findings)),
    strongest_counterfactual: cloneValue(verification.strongest_counterfactual),
    suggested_corrections: cloneValue(verification.suggested_corrections),
    advisory_summary: verification.advisory_summary,
    next_actions: cloneValue(sanitizeArray(verification.next_actions)),
    confidence: verification.confidence,
    derived_review_status: derivedReviewStatus,
    evidence_ref_catalog: cloneValue(
      normalizeEvidenceRefCatalog(envelope.evidence_ref_catalog ?? verification.evidence_ref_catalog)
    ),
    aiRuntime: cloneValue(envelope.aiRuntime ?? verification.aiRuntime ?? null)
  };
}

function normalizeLegacyResponse(envelope, verification) {
  const reviewStatus = normalizeText(envelope.review_status ?? verification.review_status, null);
  if (!reviewStatus) {
    throw new Error("Legacy AI verification response is missing review_status.");
  }

  return {
    provider: normalizeText(envelope.provider ?? verification.provider, null),
    model: normalizeText(envelope.model ?? verification.model, null),
    review_status: reviewStatus,
    warnings: cloneValue(sanitizeArray(verification.warnings)),
    disagreements: cloneValue(sanitizeArray(verification.disagreements)),
    corrected_action: normalizeText(verification.corrected_action, null),
    corrected_fit_band: normalizeText(verification.corrected_fit_band, null),
    confidence: normalizeText(verification.confidence, null),
    notes: normalizeText(verification.notes, ""),
    aiRuntime: cloneValue(envelope.aiRuntime ?? verification.aiRuntime ?? null)
  };
}

export function normalizeAiVerificationResponse(payload = {}) {
  const extracted = extractVerificationPayload(payload);
  if (!extracted) {
    throw new Error("AI verification returned an invalid success response.");
  }

  const { envelope, verification } = extracted;
  return isVerificationResultV4(verification)
    ? normalizeV4Response(envelope, verification)
    : normalizeLegacyResponse(envelope, verification);
}

export function buildAiVerificationSuccessResponse({
  provider = null,
  model = null,
  aiRuntime = null,
  evidence_ref_catalog = null,
  result = null,
  derived_review_status = null,
  review_status = null
} = {}) {
  const envelope = {
    provider,
    model,
    aiRuntime,
    evidence_ref_catalog,
    result
  };
  if (derived_review_status != null) envelope.derived_review_status = derived_review_status;
  if (review_status != null) envelope.review_status = review_status;
  return normalizeAiVerificationResponse(envelope);
}
