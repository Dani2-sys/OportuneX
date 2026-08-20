import { hasMeaningfulOpenAiKey } from "./runtime-config.mjs";
import {
  buildOpenAiVerificationRequest,
  calibrateVerificationResult,
  classifyOpenAi429,
  extractResponseText,
  validateVerificationResult
} from "./openai-verification.mjs";
import {
  buildVerificationResultEvidenceRefCatalog,
  buildMockVerificationResult,
  buildVerificationPacket,
  deriveVerificationStatusV4
} from "../src/domain/verification-protocol.js";
import {
  buildAiVerificationSuccessResponse,
  normalizeAiVerificationResponse
} from "../src/domain/ai-verification-response.js";

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 60000;
const MIN_VERIFICATION_TIMEOUT_MS = 5000;
const MAX_VERIFICATION_TIMEOUT_MS = 120000;

export class VerificationApiError extends Error {
  constructor(statusCode, code, message, adminMessage, aiStatus = "error") {
    super(message);
    this.name = "VerificationApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.adminMessage = adminMessage;
    this.aiStatus = aiStatus;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function snapshotAiRuntime(runtimeConfig) {
  return JSON.parse(JSON.stringify(runtimeConfig.ai));
}

function updateAiRuntime(runtimeConfig, status, { checked = false, lastError = null } = {}) {
  runtimeConfig.ai.status = status;
  runtimeConfig.ai.lastError = lastError;
  if (checked) runtimeConfig.ai.lastChecked = new Date().toISOString();
}

function emitLog(logger, level, message) {
  const prefix = `[V4 verification] ${message}`;
  const method = typeof logger?.[level] === "function"
    ? logger[level].bind(logger)
    : typeof logger?.log === "function"
      ? logger.log.bind(logger)
      : null;
  if (method) method(prefix);
}

function logInfo(logger, message) {
  emitLog(logger, "info", message);
}

function logError(logger, message) {
  emitLog(logger, "error", message);
}

function failVerification(runtimeConfig, statusCode, code, message, adminMessage, aiStatus = "error") {
  updateAiRuntime(runtimeConfig, aiStatus, { checked: true, lastError: adminMessage });
  throw new VerificationApiError(statusCode, code, message, adminMessage, aiStatus);
}

export function resolveVerificationTimeoutMs(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_VERIFICATION_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VERIFICATION_TIMEOUT_MS;
  return Math.min(MAX_VERIFICATION_TIMEOUT_MS, Math.max(MIN_VERIFICATION_TIMEOUT_MS, Math.round(parsed)));
}

export function summarizeVerificationPacket(packet = {}, requestBody = null) {
  const prompt = typeof requestBody?.input === "string" ? requestBody.input : "";
  return {
    protocolVersion: packet?.protocol_version ?? null,
    lots: sanitizeArray(packet?.lot_comparison).length,
    evidenceRefs: sanitizeArray(packet?.allowed_evidence_refs).length,
    schemaEvidenceEnums:
      requestBody?.text?.format?.schema?.properties?.findings?.items?.properties?.evidence_refs?.items?.enum?.length ??
      0,
    promptChars: prompt.length
  };
}

function buildVerificationErrorResponse(error, runtimeConfig) {
  return {
    error: {
      code: error.code ?? "server_error",
      message: error.message ?? "Unexpected server error.",
      adminMessage: error.adminMessage ?? error.message ?? "Unexpected server error."
    },
    aiRuntime: snapshotAiRuntime(runtimeConfig)
  };
}

async function readUpstreamError(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return {
      code: parsed?.error?.code ?? null,
      message: parsed?.error?.message ?? text ?? response.statusText
    };
  } catch {
    return {
      code: null,
      message: text || response.statusText
    };
  }
}

async function requestOpenAi({ body, openAiApiKey, timeoutMs, fetchImpl = fetch, logger = console }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  logInfo(logger, "request started");

  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    logInfo(logger, `upstream responded in ${Date.now() - startedAt} ms`);
    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      logInfo(logger, `timed out after ${timeoutMs} ms`);
      throw new VerificationApiError(
        504,
        "timeout",
        "AI verification took too long to complete. Please try again.",
        `OpenAI Responses request exceeded ${timeoutMs} ms.`,
        "error"
      );
    }

    logError(logger, `network failure after ${Date.now() - startedAt} ms: ${error?.message ?? "Unknown error."}`);
    throw new VerificationApiError(
      503,
      "network_failure",
      "AI verification is unavailable because the OpenAI request could not be completed.",
      `OpenAI Responses request failed before a response was received: ${error?.message ?? "Unknown error."}`,
      "error"
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleOpenAiFailure(response, runtimeConfig) {
  const details = await readUpstreamError(response);
  const modelHint = /model|does not exist|not found|unsupported/i.test(details.message);

  if (response.status === 401) {
    failVerification(
      runtimeConfig,
      401,
      "invalid_api_key",
      "AI verification is unavailable because OpenAI rejected the configured API key.",
      "OpenAI Responses returned 401. Check OPENAI_API_KEY for a valid server-side key.",
      "unavailable"
    );
  }

  if (response.status === 403) {
    failVerification(
      runtimeConfig,
      403,
      "permission_denied",
      "AI verification is unavailable because the configured OpenAI project cannot use this request.",
      `OpenAI Responses returned 403: ${details.message}`,
      "unavailable"
    );
  }

  if (response.status === 429) {
    const quotaClassification = classifyOpenAi429(details.message);
    failVerification(
      runtimeConfig,
      429,
      quotaClassification,
      quotaClassification === "insufficient_quota"
        ? "AI verification is unavailable because the configured OpenAI project has insufficient quota or credits."
        : "AI verification is temporarily unavailable because the OpenAI rate limit was reached.",
      `OpenAI Responses returned 429: ${details.message}`,
      quotaClassification === "insufficient_quota" ? "unavailable" : "error"
    );
  }

  if (response.status === 400 || response.status === 404) {
    failVerification(
      runtimeConfig,
      response.status,
      modelHint ? "unsupported_model" : "bad_openai_request",
      modelHint
        ? "AI verification is unavailable because the configured verification model is not supported."
        : "AI verification is unavailable because the OpenAI request was rejected.",
      `OpenAI Responses returned ${response.status}: ${details.message}`,
      modelHint ? "unavailable" : "error"
    );
  }

  failVerification(
    runtimeConfig,
    502,
    "openai_server_error",
    "AI verification is unavailable because the upstream OpenAI request failed.",
    `OpenAI Responses returned ${response.status}: ${details.message}`,
    "error"
  );
}

function buildMockSuccess({ payload, packet, runtimeConfig, logger }) {
  logInfo(logger, "request received (mock)");
  const result = calibrateVerificationResult(buildMockVerificationResult(packet), { packet });
  const validationError = validateVerificationResult(result, {
    packet,
    analysis: payload.analysis
  });
  if (validationError) {
    logError(logger, `mock validation failed: ${validationError}`);
    failVerification(
      runtimeConfig,
      500,
      "mock_verification_invalid",
      "Mock AI verification failed because the V4 protocol result was invalid.",
      `Mock verification payload failed V4 validation: ${validationError}`,
      "error"
    );
  }

  const derivedReviewStatus = deriveVerificationStatusV4(result, payload.analysis);
  updateAiRuntime(runtimeConfig, "mock", { checked: true, lastError: null });
  const response = buildAiVerificationSuccessResponse({
    provider: "mock",
    model: runtimeConfig.ai.verificationModel,
    derived_review_status: derivedReviewStatus,
    aiRuntime: snapshotAiRuntime(runtimeConfig),
    evidence_ref_catalog: buildVerificationResultEvidenceRefCatalog(result, packet),
    result
  });
  logInfo(logger, `derived status: ${derivedReviewStatus}`);
  logInfo(logger, "success response sent (mock)");
  return response;
}

async function buildOpenAiSuccess({
  payload,
  packet,
  runtimeConfig,
  openAiApiKey,
  timeoutMs,
  fetchImpl,
  logger
}) {
  logInfo(logger, "request received");
  if (runtimeConfig.ai.provider !== "openai") {
    failVerification(
      runtimeConfig,
      503,
      "unsupported_provider",
      "AI verification is unavailable because the configured AI provider is not supported.",
      `Unsupported AI provider: ${runtimeConfig.ai.provider}.`,
      "unavailable"
    );
  }

  if (!hasMeaningfulOpenAiKey(openAiApiKey)) {
    failVerification(
      runtimeConfig,
      503,
      "missing_api_key",
      "AI verification is unavailable because no usable OpenAI API key is configured.",
      "OPENAI_API_KEY is missing, blank, or still set to a placeholder value.",
      "unavailable"
    );
  }

  const requestBody = buildOpenAiVerificationRequest(packet, runtimeConfig);
  const summary = summarizeVerificationPacket(packet, requestBody);
  logInfo(
    logger,
    `packet summary: lots=${summary.lots} evidenceRefs=${summary.evidenceRefs} schemaEvidenceEnums=${summary.schemaEvidenceEnums} promptChars=${summary.promptChars}`
  );

  const startedAt = Date.now();
  const response = await requestOpenAi({
    body: requestBody,
    openAiApiKey,
    timeoutMs,
    fetchImpl,
    logger
  });

  if (!response.ok) {
    await handleOpenAiFailure(response, runtimeConfig);
  }

  const data = await response.json();
  if (data?.status && data.status !== "completed") {
    failVerification(
      runtimeConfig,
      502,
      "response_incomplete",
      "AI verification failed before a complete structured response was produced.",
      `OpenAI Responses returned a non-completed status: ${data.status}.`,
      "error"
    );
  }

  const rawOutput = extractResponseText(data);
  if (!rawOutput) {
    failVerification(
      runtimeConfig,
      502,
      "invalid_structured_output",
      "AI verification failed because no structured output was returned.",
      "OpenAI Responses completed without any structured verification payload.",
      "error"
    );
  }

  let parsedOutput;
  try {
    parsedOutput = JSON.parse(rawOutput);
  } catch {
    failVerification(
      runtimeConfig,
      502,
      "invalid_structured_output",
      "AI verification failed because the structured output was not valid JSON.",
      "OpenAI Responses returned text that could not be parsed as JSON despite the requested schema.",
      "error"
    );
  }

  parsedOutput = calibrateVerificationResult(parsedOutput, { packet });

  const validationError = validateVerificationResult(parsedOutput, {
    packet,
    analysis: payload.analysis
  });
  if (validationError) {
    logError(logger, `semantic validation failed: ${validationError}`);
    failVerification(
      runtimeConfig,
      502,
      "verification_semantic_error",
      "AI verification failed because the structured output did not match the required schema.",
      `Structured verification payload validation failed: ${validationError}`,
      "error"
    );
  }

  updateAiRuntime(runtimeConfig, "connected", { checked: true, lastError: null });
  const derivedReviewStatus = deriveVerificationStatusV4(parsedOutput, payload.analysis);
  logInfo(logger, "OpenAI response parsed");
  logInfo(logger, "semantic validation passed");
  logInfo(logger, `derived status: ${derivedReviewStatus}`);
  const result = buildAiVerificationSuccessResponse({
    provider: "openai",
    model: runtimeConfig.ai.verificationModel,
    derived_review_status: derivedReviewStatus,
    aiRuntime: snapshotAiRuntime(runtimeConfig),
    evidence_ref_catalog: buildVerificationResultEvidenceRefCatalog(parsedOutput, packet),
    result: parsedOutput
  });
  logInfo(logger, `completed in ${Date.now() - startedAt} ms`);
  logInfo(logger, "success response sent");
  return result;
}

export async function handleVerificationAnalyze({
  payload,
  runtimeConfig,
  openAiApiKey,
  fetchImpl = fetch,
  logger = console,
  timeoutValue = null
}) {
  const timeoutMs = resolveVerificationTimeoutMs(timeoutValue);

  try {
    const packet = buildVerificationPacket(payload.company, payload.opportunity, payload.analysis);
    const result =
      runtimeConfig.ai.provider === "mock"
        ? buildMockSuccess({ payload, packet, runtimeConfig, logger })
        : await buildOpenAiSuccess({
            payload,
            packet,
            runtimeConfig,
            openAiApiKey,
            timeoutMs,
            fetchImpl,
            logger
          });
    normalizeAiVerificationResponse(result);
    return {
      statusCode: 200,
      body: result
    };
  } catch (error) {
    if (error instanceof VerificationApiError) {
      updateAiRuntime(runtimeConfig, error.aiStatus ?? "error", {
        checked: true,
        lastError: error.adminMessage ?? error.message ?? null
      });
    }
    const statusCode = error.statusCode ?? 500;
    logError(logger, `sending error response: ${statusCode} ${error.code ?? "server_error"}`);
    return {
      statusCode,
      body: buildVerificationErrorResponse(error, runtimeConfig)
    };
  }
}
