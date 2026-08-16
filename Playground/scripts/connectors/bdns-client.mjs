import {
  BDNS_ALLOWED_HOSTS,
  BDNS_API_BASE,
  extractBdnsCode,
  normalizeBdnsDataset
} from "../../src/connectors/bdns-normalizer.js";

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;
const DEFAULT_MAX_TOTAL_RESPONSE_BYTES = 20_000_000;
const DEFAULT_MAX_ELAPSED_MS = 180000;
const DEFAULT_PAGES = 1;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_AUTOMATIC_PAGES = 1;
const DEFAULT_AUTOMATIC_PAGE_SIZE = 20;
const DEFAULT_RECONCILE_PAGES = 3;
const DEFAULT_RECONCILE_PAGE_SIZE = 50;
const HARD_MAX_PAGES = 3;
const HARD_MAX_PAGE_SIZE = 50;
const DEFAULT_DETAIL_CONCURRENCY = 1;
const HARD_MAX_DETAIL_CALLS = 150;
const DETAIL_REQUEST_POLICY = Object.freeze({
  manual: Object.freeze({
    concurrency: 1,
    spacingMs: 400
  }),
  automatic: Object.freeze({
    concurrency: 1,
    spacingMs: 600
  }),
  reconcile: Object.freeze({
    concurrency: 1,
    spacingMs: 600
  })
});
const DETAIL_RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const DETAIL_RETRY_DELAYS_MS = Object.freeze([1500, 3000]);
const DETAIL_MAX_RETRIES = 2;
const MAX_REASONABLE_RETRY_AFTER_MS = 15000;

export class BdnsSyncError extends Error {
  constructor(statusCode, code, message, adminMessage = message) {
    super(message);
    this.name = "BdnsSyncError";
    this.statusCode = statusCode;
    this.code = code;
    this.adminMessage = adminMessage;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertAllowedBdnsUrl(value, label = "BDNS URL") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BdnsSyncError(400, "invalid_bdns_url", `${label} is invalid.`, `${label} could not be parsed: ${value}`);
  }

  if (parsed.protocol !== "https:") {
    throw new BdnsSyncError(400, "invalid_bdns_url", `${label} must use HTTPS.`, `${label} used ${parsed.protocol}`);
  }

  if (!BDNS_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new BdnsSyncError(
      400,
      "bdns_host_rejected",
      `${label} is not an allowed official BDNS / SNPSAP host.`,
      `${label} resolved to disallowed host ${parsed.hostname}.`
    );
  }

  return parsed.toString();
}

function sanitizePages(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGES;
  return Math.min(HARD_MAX_PAGES, Math.max(1, Math.round(parsed)));
}

function sanitizePageSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(HARD_MAX_PAGE_SIZE, Math.max(10, Math.round(parsed)));
}

function sanitizeDetailConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_DETAIL_CONCURRENCY;
  return Math.min(DEFAULT_DETAIL_CONCURRENCY, Math.max(1, Math.round(parsed)));
}

function sanitizeSpacingMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.round(parsed));
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    const milliseconds = Math.round(seconds * 1000);
    return milliseconds > 0 ? milliseconds : null;
  }

  const absoluteMs = Date.parse(trimmed);
  if (!Number.isFinite(absoluteMs)) return null;
  const milliseconds = absoluteMs - nowMs;
  return milliseconds > 0 ? milliseconds : null;
}

function shouldRetryDetailError(error) {
  if (!(error instanceof BdnsSyncError)) return false;
  const status = Number(error.httpStatus ?? error.statusCode ?? NaN);
  return DETAIL_RETRYABLE_STATUS_CODES.has(status);
}

function resolveRetryDelayMs(error, retryIndex) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0 && error.retryAfterMs <= MAX_REASONABLE_RETRY_AFTER_MS) {
    return error.retryAfterMs;
  }
  return DETAIL_RETRY_DELAYS_MS[retryIndex] ?? null;
}

function createDetailStartPacer({ spacingMs, sleepImpl, nowMsImpl }) {
  let nextAllowedStartAtMs = nowMsImpl();

  return {
    async waitForNextStart() {
      const waitMs = Math.max(0, nextAllowedStartAtMs - nowMsImpl());
      if (waitMs > 0) {
        await sleepImpl(waitMs);
      }
      nextAllowedStartAtMs = Math.max(nextAllowedStartAtMs, nowMsImpl()) + spacingMs;
      return waitMs;
    }
  };
}

function assertElapsedWithinLimit(startedAtMs, maxElapsedMs, nowMsImpl, label) {
  if (nowMsImpl() - startedAtMs > maxElapsedMs) {
    throw new BdnsSyncError(
      504,
      "bdns_timeout",
      "The official BDNS API did not respond in time.",
      `BDNS ${label} exceeded the ${maxElapsedMs} ms total elapsed guard.`
    );
  }
}

function assertTotalBytesWithinLimit(totalBytes, maxTotalResponseBytes, label) {
  if (totalBytes > maxTotalResponseBytes) {
    throw new BdnsSyncError(
      502,
      "bdns_response_too_large",
      "BDNS returned more data than the connector is allowed to process safely.",
      `BDNS ${label} exceeded the ${maxTotalResponseBytes} byte total guard.`
    );
  }
}

function createSleepImpl() {
  return (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readResponseText(response, maxResponseBytes) {
  const contentLength = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new BdnsSyncError(
      502,
      "bdns_response_too_large",
      "BDNS returned more data than the connector is allowed to process safely.",
      `BDNS response announced ${contentLength} bytes, above the ${maxResponseBytes} byte guard.`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxResponseBytes) {
    throw new BdnsSyncError(
      502,
      "bdns_response_too_large",
      "BDNS returned more data than the connector is allowed to process safely.",
      `BDNS response contained ${buffer.byteLength} bytes, above the ${maxResponseBytes} byte guard.`
    );
  }

  return buffer.toString("utf8");
}

function normalizeArrayPayload(payload, label) {
  if (Array.isArray(payload)) return payload;

  const candidates = [
    payload?.items,
    payload?.content,
    payload?.data,
    payload?.rows,
    payload?.resultados,
    payload?.convocatorias,
    payload?.results
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  if (isPlainObject(payload)) {
    const values = Object.values(payload);
    if (values.length === 1 && Array.isArray(values[0])) return values[0];
  }

  throw new BdnsSyncError(
    502,
    "bdns_invalid_payload",
    `The official BDNS payload for ${label} did not contain the expected JSON record list.`,
    `Unexpected BDNS ${label} payload shape.`
  );
}

function normalizeDetailPayload(payload, code) {
  if (Array.isArray(payload)) {
    const record = payload.find((item) => extractBdnsCode(item) === code) ?? payload[0] ?? null;
    if (record && isPlainObject(record)) return record;
  }

  if (isPlainObject(payload)) {
    const candidateArrays = [
      payload?.items,
      payload?.content,
      payload?.data,
      payload?.resultados,
      payload?.convocatorias
    ];
    for (const candidate of candidateArrays) {
      if (!Array.isArray(candidate) || candidate.length === 0) continue;
      const record = candidate.find((item) => extractBdnsCode(item) === code) ?? candidate[0];
      if (record && isPlainObject(record)) return record;
    }

    if (extractBdnsCode(payload) === code || extractBdnsCode(payload)) {
      return payload;
    }
  }

  throw new BdnsSyncError(
    502,
    "bdns_invalid_payload",
    "The official BDNS detail payload could not be interpreted safely.",
    `Unexpected BDNS detail payload shape for code ${code}.`
  );
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  const safeUrl = assertAllowedBdnsUrl(url, "BDNS request URL");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(safeUrl, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const error = new BdnsSyncError(
        response.status === 429 ? 429 : 502,
        "bdns_http_error",
        response.status === 429
          ? "The official BDNS API rate-limited this request."
          : "The official BDNS API could not be retrieved.",
        `BDNS returned HTTP ${response.status} for ${safeUrl}.`
      );
      error.httpStatus = response.status;
      error.retryAfterMs = retryAfterMs;
      error.url = safeUrl;
      throw error;
    }

    const text = await readResponseText(response, maxResponseBytes);
    try {
      return {
        url: safeUrl,
        byteLength: Buffer.byteLength(text, "utf8"),
        payload: JSON.parse(text)
      };
    } catch (error) {
      throw new BdnsSyncError(
        502,
        "bdns_parse_failed",
        "The official BDNS API returned malformed JSON.",
        `BDNS JSON parsing failed for ${safeUrl}: ${error.message}`
      );
    }
  } catch (error) {
    if (error instanceof BdnsSyncError) throw error;
    if (error?.name === "AbortError") {
      const timeoutError = new BdnsSyncError(
        504,
        "bdns_timeout",
        "The official BDNS API did not respond in time.",
        `BDNS request to ${safeUrl} exceeded ${timeoutMs} ms.`
      );
      timeoutError.httpStatus = 504;
      timeoutError.url = safeUrl;
      throw timeoutError;
    }
    const availabilityError = new BdnsSyncError(
      503,
      "bdns_unavailable",
      "The official BDNS API is currently unavailable.",
      `BDNS request to ${safeUrl} failed: ${error.message}`
    );
    availabilityError.httpStatus = 503;
    availabilityError.url = safeUrl;
    throw availabilityError;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildDiscoveryUrl(apiBase, { page, pageSize }) {
  const safeBase = assertAllowedBdnsUrl(apiBase, "BDNS API base");
  const url = new URL("convocatorias/ultimas", safeBase.endsWith("/") ? safeBase : `${safeBase}/`);
  url.searchParams.set("vpd", "GE");
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("order", "fechaRecepcion");
  url.searchParams.set("direccion", "desc");
  return url.toString();
}

function buildDetailUrl(apiBase, code) {
  const safeBase = assertAllowedBdnsUrl(apiBase, "BDNS API base");
  const url = new URL("convocatorias", safeBase.endsWith("/") ? safeBase : `${safeBase}/`);
  url.searchParams.set("numConv", code);
  url.searchParams.set("vpd", "GE");
  return url.toString();
}

async function fetchDetailWithRetry(code, context) {
  const {
    safeApiBase,
    fetchImpl,
    timeoutMs,
    maxResponseBytes,
    sleepImpl,
    pacer,
    startedAtMs,
    maxElapsedMs,
    nowMsImpl
  } = context;

  let attempts = 0;
  while (attempts <= DETAIL_MAX_RETRIES) {
    await pacer.waitForNextStart();
    assertElapsedWithinLimit(startedAtMs, maxElapsedMs, nowMsImpl, "detail enrichment");
    attempts += 1;

    try {
      const detailResult = await fetchJson(buildDetailUrl(safeApiBase, code), {
        fetchImpl,
        timeoutMs,
        maxResponseBytes
      });
      return {
        ok: true,
        code,
        detailResult,
        attempts
      };
    } catch (error) {
      if (!(error instanceof BdnsSyncError)) throw error;
      if (!shouldRetryDetailError(error) || attempts > DETAIL_MAX_RETRIES) {
        return {
          ok: false,
          code,
          error,
          attempts
        };
      }

      const retryDelayMs = resolveRetryDelayMs(error, attempts - 1);
      if (retryDelayMs > 0) {
        await sleepImpl(retryDelayMs);
      }
    }
  }

  throw new BdnsSyncError(
    502,
    "bdns_detail_enrichment_failed",
    "The official BDNS call details could not be enriched safely.",
    `Detail enrichment exhausted retries unexpectedly for code ${code}.`
  );
}

export async function syncBdnsCalls(options = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxTotalResponseBytes = DEFAULT_MAX_TOTAL_RESPONSE_BYTES,
    maxElapsedMs = DEFAULT_MAX_ELAPSED_MS,
    detailConcurrency = DEFAULT_DETAIL_CONCURRENCY,
    detailStartSpacingMs,
    apiBase = BDNS_API_BASE,
    now = new Date(),
    sleepImpl = createSleepImpl(),
    nowMsImpl = Date.now
  } = options;
  const mode = options.mode === "automatic" || options.mode === "reconcile" ? options.mode : "manual";
  const detailPolicy = DETAIL_REQUEST_POLICY[mode] ?? DETAIL_REQUEST_POLICY.manual;
  const pages = sanitizePages(
    mode === "reconcile"
      ? options.pages ?? DEFAULT_RECONCILE_PAGES
      : mode === "automatic"
        ? options.pages ?? DEFAULT_AUTOMATIC_PAGES
        : options.pages
  );
  const pageSize = sanitizePageSize(
    mode === "reconcile"
      ? options.pageSize ?? DEFAULT_RECONCILE_PAGE_SIZE
      : mode === "automatic"
        ? options.pageSize ?? DEFAULT_AUTOMATIC_PAGE_SIZE
      : options.pageSize
  );
  const concurrency = Math.min(detailPolicy.concurrency, sanitizeDetailConcurrency(detailConcurrency));
  const resolvedDetailSpacingMs = sanitizeSpacingMs(detailStartSpacingMs, detailPolicy.spacingMs);
  const startedAtMs = nowMsImpl();
  const startedAt = new Date(startedAtMs).toISOString();
  const fetchedAt = new Date(startedAtMs).toISOString();
  const safeApiBase = assertAllowedBdnsUrl(apiBase, "BDNS API base");
  const discoveryRecords = [];
  let totalBytes = 0;

  for (let page = 1; page <= pages; page += 1) {
    const pageResult = await fetchJson(buildDiscoveryUrl(safeApiBase, { page, pageSize }), {
      fetchImpl,
      timeoutMs,
      maxResponseBytes
    });
    discoveryRecords.push(...normalizeArrayPayload(pageResult.payload, "discovery"));
    totalBytes += pageResult.byteLength ?? 0;
    assertTotalBytesWithinLimit(totalBytes, maxTotalResponseBytes, "discovery");
    assertElapsedWithinLimit(startedAtMs, maxElapsedMs, nowMsImpl, "discovery");
  }

  const allCodes = discoveryRecords.map((record) => extractBdnsCode(record)).filter(Boolean);
  const uniqueCodes = [...new Set(allCodes)];
  const detailCodes = uniqueCodes.slice(0, HARD_MAX_DETAIL_CALLS);
  const truncated = detailCodes.length < uniqueCodes.length;
  const detailFailures = [];
  const successfulDetails = [];
  const pacer = createDetailStartPacer({
    spacingMs: resolvedDetailSpacingMs,
    sleepImpl,
    nowMsImpl
  });
  const detailResults = [];
  const detailContext = {
    safeApiBase,
    fetchImpl,
    timeoutMs,
    maxResponseBytes,
    sleepImpl,
    pacer,
    startedAtMs,
    maxElapsedMs,
    nowMsImpl
  };

  for (const code of detailCodes) {
    const result = await fetchDetailWithRetry(code, detailContext);
    detailResults.push(result);

    if (result.ok) {
      totalBytes += result.detailResult.byteLength ?? 0;
      assertTotalBytesWithinLimit(totalBytes, maxTotalResponseBytes, "discovery and detail enrichment");
      assertElapsedWithinLimit(startedAtMs, maxElapsedMs, nowMsImpl, "sync");
      const record = normalizeDetailPayload(result.detailResult.payload, code);
      successfulDetails.push(record);
      continue;
    }

    detailFailures.push({
      code,
      message: result.error.message,
      adminMessage: result.error.adminMessage,
      attempts: result.attempts
    });
  }

  if (detailFailures.length && successfulDetails.length === 0 && detailCodes.length > 0) {
    throw new BdnsSyncError(
      502,
      "bdns_detail_enrichment_failed",
      "The official BDNS call details could not be enriched safely.",
      `All ${detailFailures.length} BDNS detail requests failed during this synchronization.`
    );
  }

  const normalized = normalizeBdnsDataset({
    details: successfulDetails,
    fetchedAt,
    now
  });

  return {
    connector: "bdns",
    mode,
    startedAt,
    completedAt: new Date(nowMsImpl()).toISOString(),
    fetchedAt,
    apiBase: safeApiBase,
    pagesRequested: pages,
    pageSizeRequested: pageSize,
    pagesFetched: pages,
    pageSize,
    detailConcurrency: concurrency,
    detailStartSpacingMs: resolvedDetailSpacingMs,
    discoveryCount: discoveryRecords.length,
    uniqueCodes: uniqueCodes.length,
    detailsRequested: detailCodes.length,
    detailsFetched: successfulDetails.length,
    detailFailures,
    truncated,
    truncationReason: truncated ? "detail_cap" : null,
    opportunities: normalized.opportunities,
    stats: normalized.stats,
    requests: detailResults
  };
}
