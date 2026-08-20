import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntimeConfig,
  loadLocalEnv,
  sanitizeRuntimeConfig,
  serializeBrowserRuntimeConfig
} from "./runtime-config.mjs";
import {
  handleVerificationAnalyze,
  resolveVerificationTimeoutMs
} from "./verification-api.mjs";
import { BdnsSyncError, syncBdnsCalls } from "./connectors/bdns-client.mjs";
import { PlacspSyncError, syncPlacspFeed } from "./connectors/placsp-client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
await loadLocalEnv(root);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const verificationTimeoutMs = resolveVerificationTimeoutMs(process.env.OPORTUNEX_AI_TIMEOUT_MS);

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
      const result = await handleVerificationAnalyze({
        payload,
        runtimeConfig,
        openAiApiKey,
        logger: console,
        timeoutValue: verificationTimeoutMs
      });
      return sendJson(response, result.statusCode, result.body);
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
