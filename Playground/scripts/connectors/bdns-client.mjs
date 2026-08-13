import {
  BDNS_ALLOWED_HOSTS,
  BDNS_API_BASE,
  extractBdnsCode,
  normalizeBdnsDataset
} from "../../src/connectors/bdns-normalizer.js";

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;
const DEFAULT_MAX_TOTAL_RESPONSE_BYTES = 20_000_000;
const DEFAULT_MAX_ELAPSED_MS = 60000;
const DEFAULT_PAGES = 1;
const DEFAULT_PAGE_SIZE = 20;
const HARD_MAX_PAGES = 3;
const HARD_MAX_PAGE_SIZE = 50;
const DEFAULT_DETAIL_CONCURRENCY = 3;
const HARD_MAX_DETAIL_CALLS = 120;

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
  return Math.min(4, Math.max(1, Math.round(parsed)));
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
      throw new BdnsSyncError(
        502,
        "bdns_http_error",
        "The official BDNS API could not be retrieved.",
        `BDNS returned HTTP ${response.status} for ${safeUrl}.`
      );
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
      throw new BdnsSyncError(
        504,
        "bdns_timeout",
        "The official BDNS API did not respond in time.",
        `BDNS request to ${safeUrl} exceeded ${timeoutMs} ms.`
      );
    }
    throw new BdnsSyncError(
      503,
      "bdns_unavailable",
      "The official BDNS API is currently unavailable.",
      `BDNS request to ${safeUrl} failed: ${error.message}`
    );
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

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function consume() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume()));
  return results;
}

export async function syncBdnsCalls(options = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxTotalResponseBytes = DEFAULT_MAX_TOTAL_RESPONSE_BYTES,
    maxElapsedMs = DEFAULT_MAX_ELAPSED_MS,
    detailConcurrency = DEFAULT_DETAIL_CONCURRENCY,
    apiBase = BDNS_API_BASE,
    now = new Date()
  } = options;
  const pages = sanitizePages(options.pages);
  const pageSize = sanitizePageSize(options.pageSize);
  const concurrency = sanitizeDetailConcurrency(detailConcurrency);
  const startedAt = new Date().toISOString();
  const fetchedAt = new Date().toISOString();
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

    if (totalBytes > maxTotalResponseBytes) {
      throw new BdnsSyncError(
        502,
        "bdns_response_too_large",
        "BDNS returned more data than the connector is allowed to process safely.",
        `BDNS discovery exceeded the ${maxTotalResponseBytes} byte total guard.`
      );
    }

    if (Date.now() - Date.parse(startedAt) > maxElapsedMs) {
      throw new BdnsSyncError(
        504,
        "bdns_timeout",
        "The official BDNS API did not respond in time.",
        `BDNS discovery exceeded the ${maxElapsedMs} ms total elapsed guard.`
      );
    }
  }

  const allCodes = discoveryRecords.map((record) => extractBdnsCode(record)).filter(Boolean);
  const uniqueCodes = [...new Set(allCodes)];
  const detailCodes = uniqueCodes.slice(0, HARD_MAX_DETAIL_CALLS);
  const truncated = detailCodes.length < uniqueCodes.length;
  const detailFailures = [];
  const successfulDetails = [];

  const detailResults = await mapWithConcurrency(detailCodes, concurrency, async (code) => {
    try {
      const detailResult = await fetchJson(buildDetailUrl(safeApiBase, code), {
        fetchImpl,
        timeoutMs,
        maxResponseBytes
      });
      totalBytes += detailResult.byteLength ?? 0;
      if (totalBytes > maxTotalResponseBytes) {
        throw new BdnsSyncError(
          502,
          "bdns_response_too_large",
          "BDNS returned more data than the connector is allowed to process safely.",
          `BDNS discovery and detail enrichment exceeded the ${maxTotalResponseBytes} byte total guard.`
        );
      }
      if (Date.now() - Date.parse(startedAt) > maxElapsedMs) {
        throw new BdnsSyncError(
          504,
          "bdns_timeout",
          "The official BDNS API did not respond in time.",
          `BDNS sync exceeded the ${maxElapsedMs} ms total elapsed guard.`
        );
      }

      const record = normalizeDetailPayload(detailResult.payload, code);
      successfulDetails.push(record);
      return { ok: true, code };
    } catch (error) {
      if (error instanceof BdnsSyncError) {
        detailFailures.push({
          code,
          message: error.message,
          adminMessage: error.adminMessage
        });
        return { ok: false, code, error };
      }

      throw error;
    }
  });

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
    mode: "manual",
    startedAt,
    completedAt: new Date().toISOString(),
    fetchedAt,
    apiBase: safeApiBase,
    pagesRequested: pages,
    pageSizeRequested: pageSize,
    pagesFetched: pages,
    pageSize,
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
