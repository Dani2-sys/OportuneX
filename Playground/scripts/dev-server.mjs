import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntimeConfig,
  hasMeaningfulOpenAiKey,
  loadLocalEnv,
  sanitizeRuntimeConfig,
  serializeBrowserRuntimeConfig
} from "./runtime-config.mjs";
import {
  buildOpenAiVerificationRequest,
  classifyOpenAi429,
  extractResponseText,
  validateVerificationResult
} from "./openai-verification.mjs";
import { BdnsSyncError, syncBdnsCalls } from "./connectors/bdns-client.mjs";
import { PlacspSyncError, syncPlacspFeed } from "./connectors/placsp-client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
await loadLocalEnv(root);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const verificationTimeoutMs = Number(process.env.OPORTUNEX_AI_TIMEOUT_MS || 15000);

const openAiApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const runtimeConfig = createRuntimeConfig(process.env);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

class ApiError extends Error {
  constructor(statusCode, code, message, adminMessage, aiStatus = "error") {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.adminMessage = adminMessage;
    this.aiStatus = aiStatus;
  }
}

function snapshotAiRuntime() {
  return JSON.parse(JSON.stringify(runtimeConfig.ai));
}

function updateAiRuntime(status, { checked = false, lastError = null } = {}) {
  runtimeConfig.ai.status = status;
  runtimeConfig.ai.lastError = lastError;
  if (checked) runtimeConfig.ai.lastChecked = new Date().toISOString();
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function buildErrorResponse(error) {
  return {
    error: {
      code: error.code ?? "server_error",
      message: error.message ?? "Unexpected server error.",
      adminMessage: error.adminMessage ?? error.message ?? "Unexpected server error."
    },
    aiRuntime: snapshotAiRuntime()
  };
}

function mockVerification(payload) {
  const analysis = payload.analysis ?? {};
  const warnings = [];
  if (analysis.unknowns?.length) warnings.push("Critical company confirmation is still missing.");
  if (analysis.blockers?.length) warnings.push("At least one blocker remains visible in the deterministic pass.");

  updateAiRuntime("mock", { checked: true, lastError: null });

  return {
    provider: "mock",
    model: runtimeConfig.ai.verificationModel,
    review_status: warnings.length ? "needs_review" : "accepted",
    warnings,
    disagreements: [],
    corrected_action: analysis.decision?.recommendedAction?.code ?? null,
    corrected_fit_band: analysis.fitBand ?? analysis.recommendationClass ?? null,
    confidence: analysis.confidenceShield?.label?.toLowerCase?.() ?? "medium",
    notes: "Mock verification used because live OpenAI verification is not configured.",
    aiRuntime: snapshotAiRuntime()
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

function failVerification(statusCode, code, message, adminMessage, aiStatus = "error") {
  updateAiRuntime(aiStatus, { checked: true, lastError: adminMessage });
  throw new ApiError(statusCode, code, message, adminMessage, aiStatus);
}

async function requestOpenAi(body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), verificationTimeoutMs);

  try {
    return await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      failVerification(
        504,
        "timeout",
        "AI verification timed out.",
        `OpenAI Responses request exceeded ${verificationTimeoutMs} ms.`,
        "error"
      );
    }

    failVerification(
      503,
      "network_failure",
      "AI verification is unavailable because the OpenAI request could not be completed.",
      `OpenAI Responses request failed before a response was received: ${error.message}`,
      "error"
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleOpenAiFailure(response) {
  const details = await readUpstreamError(response);
  const modelHint = /model|does not exist|not found|unsupported/i.test(details.message);

  if (response.status === 401) {
    failVerification(
      401,
      "invalid_api_key",
      "AI verification is unavailable because OpenAI rejected the configured API key.",
      "OpenAI Responses returned 401. Check OPENAI_API_KEY for a valid server-side key.",
      "unavailable"
    );
  }

  if (response.status === 403) {
    failVerification(
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
    502,
    "openai_server_error",
    "AI verification is unavailable because the upstream OpenAI request failed.",
    `OpenAI Responses returned ${response.status}: ${details.message}`,
    "error"
  );
}

async function callOpenAiVerification(payload) {
  if (runtimeConfig.ai.provider !== "openai") {
    failVerification(
      503,
      "unsupported_provider",
      "AI verification is unavailable because the configured AI provider is not supported.",
      `Unsupported AI provider: ${runtimeConfig.ai.provider}.`,
      "unavailable"
    );
  }

  if (!hasMeaningfulOpenAiKey(openAiApiKey)) {
    failVerification(
      503,
      "missing_api_key",
      "AI verification is unavailable because no usable OpenAI API key is configured.",
      "OPENAI_API_KEY is missing, blank, or still set to a placeholder value.",
      "unavailable"
    );
  }

  const response = await requestOpenAi(buildOpenAiVerificationRequest(payload, runtimeConfig));

  if (!response.ok) {
    await handleOpenAiFailure(response);
  }

  const data = await response.json();
  if (data?.status && data.status !== "completed") {
    failVerification(
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
      502,
      "invalid_structured_output",
      "AI verification failed because the structured output was not valid JSON.",
      "OpenAI Responses returned text that could not be parsed as JSON despite the requested schema.",
      "error"
    );
  }

  const validationError = validateVerificationResult(parsedOutput);
  if (validationError) {
    failVerification(
      502,
      "invalid_structured_output",
      "AI verification failed because the structured output did not match the required schema.",
      `Structured verification payload validation failed: ${validationError}`,
      "error"
    );
  }

  updateAiRuntime("connected", { checked: true, lastError: null });

  return {
    provider: "openai",
    model: runtimeConfig.ai.verificationModel,
    ...parsedOutput,
    aiRuntime: snapshotAiRuntime()
  };
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError(
      400,
      "invalid_json",
      "Request body must be valid JSON.",
      "The API route received malformed JSON."
    );
  }
}

async function handleApi(request, response) {
  if (request.url === "/api/health") {
    return sendJson(response, 200, {
      ok: true,
      runtimeConfig: sanitizeRuntimeConfig(runtimeConfig)
    });
  }

  if (request.url === "/api/ai/analyze" && request.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      return sendJson(response, error.statusCode ?? 400, buildErrorResponse(error));
    }

    try {
      const result =
        runtimeConfig.ai.provider === "mock"
          ? mockVerification(payload)
          : await callOpenAiVerification(payload);
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, error.statusCode ?? 500, buildErrorResponse(error));
    }
  }

  if (request.url === "/api/connectors/placsp/sync" && request.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      return sendJson(response, error.statusCode ?? 400, buildErrorResponse(error));
    }

    try {
      const result = await syncPlacspFeed({
        mode: payload?.mode,
        cursor: payload?.cursor,
        maxPages: payload?.maxPages
      });
      return sendJson(response, 200, result);
    } catch (error) {
      const placspError =
        error instanceof PlacspSyncError
          ? error
          : new PlacspSyncError(
              500,
              "placsp_sync_failed",
              "PLACSP synchronization failed unexpectedly.",
              error.message ?? "Unexpected PLACSP sync failure."
            );
      return sendJson(response, placspError.statusCode ?? 500, {
        error: {
          code: placspError.code,
          message: placspError.message,
          adminMessage: placspError.adminMessage
        }
      });
    }
  }

  if (request.url === "/api/connectors/bdns/sync" && request.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      return sendJson(response, error.statusCode ?? 400, buildErrorResponse(error));
    }

    try {
      const result = await syncBdnsCalls({
        mode: payload?.mode,
        pages: payload?.pages,
        pageSize: payload?.pageSize
      });
      return sendJson(response, 200, result);
    } catch (error) {
      const bdnsError =
        error instanceof BdnsSyncError
          ? error
          : new BdnsSyncError(
              500,
              "bdns_sync_failed",
              "BDNS synchronization failed unexpectedly.",
              error.message ?? "Unexpected BDNS sync failure."
            );
      return sendJson(response, bdnsError.statusCode ?? 500, {
        error: {
          code: bdnsError.code,
          message: bdnsError.message,
          adminMessage: bdnsError.adminMessage
        }
      });
    }
  }

  return sendJson(response, 404, { error: "Not found" });
}

async function serveStatic(request, response) {
  let pathname = request.url === "/" ? "/index.html" : request.url;
  if (pathname === "/runtime-config.js") {
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    response.end(serializeBrowserRuntimeConfig(runtimeConfig));
    return;
  }

  const resolved = path.resolve(root, `.${pathname}`);
  if (!resolved.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(resolved);
    const filePath = fileStat.isDirectory() ? path.join(resolved, "index.html") : resolved;
    const content = await readFile(filePath);
    const extension = path.extname(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extension] || "application/octet-stream" });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  if ((request.url ?? "").startsWith("/api/")) {
    return handleApi(request, response);
  }
  return serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`OportuneX dev server running at http://${host}:${port}`);
});
