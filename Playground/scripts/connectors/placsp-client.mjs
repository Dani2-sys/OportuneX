import { parsePlacspAtom } from "./placsp-parser.mjs";
import {
  PLACSP_ALLOWED_HOSTS,
  PLACSP_FEED_URL,
  normalizePlacspDataset
} from "../../src/connectors/placsp-normalizer.js";

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESPONSE_BYTES = 25_000_000;
const DEFAULT_MAX_PAGES = 1;
const HARD_MAX_PAGES = 5;

export class PlacspSyncError extends Error {
  constructor(statusCode, code, message, adminMessage = message) {
    super(message);
    this.name = "PlacspSyncError";
    this.statusCode = statusCode;
    this.code = code;
    this.adminMessage = adminMessage;
  }
}

function assertAllowedPlacspUrl(value, label = "PLACSP URL") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new PlacspSyncError(400, "invalid_placsp_url", `${label} is invalid.`, `${label} could not be parsed: ${value}`);
  }

  if (parsed.protocol !== "https:") {
    throw new PlacspSyncError(400, "invalid_placsp_url", `${label} must use HTTPS.`, `${label} used ${parsed.protocol}`);
  }

  if (!PLACSP_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new PlacspSyncError(
      400,
      "placsp_host_rejected",
      `${label} is not an allowed official PLACSP host.`,
      `${label} resolved to disallowed host ${parsed.hostname}.`
    );
  }

  return parsed.toString();
}

function sanitizeMaxPages(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_PAGES;
  return Math.min(HARD_MAX_PAGES, Math.max(1, Math.round(parsed)));
}

async function readResponseText(response, maxResponseBytes) {
  const contentLength = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new PlacspSyncError(
      502,
      "placsp_response_too_large",
      "PLACSP returned more data than the connector is allowed to process safely.",
      `PLACSP response announced ${contentLength} bytes, above the ${maxResponseBytes} byte guard.`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxResponseBytes) {
    throw new PlacspSyncError(
      502,
      "placsp_response_too_large",
      "PLACSP returned more data than the connector is allowed to process safely.",
      `PLACSP response contained ${buffer.byteLength} bytes, above the ${maxResponseBytes} byte guard.`
    );
  }

  return buffer.toString("utf8");
}

async function fetchPlacspPage(
  pageUrl,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
  } = {}
) {
  const safeUrl = assertAllowedPlacspUrl(pageUrl, "PLACSP page URL");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(safeUrl, {
      method: "GET",
      headers: {
        accept: "application/atom+xml, application/xml, text/xml;q=0.9,*/*;q=0.1"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new PlacspSyncError(
        502,
        "placsp_http_error",
        "The official PLACSP feed could not be retrieved.",
        `PLACSP returned HTTP ${response.status} for ${safeUrl}.`
      );
    }

    const xmlText = await readResponseText(response, maxResponseBytes);
    let parsed;
    try {
      parsed = parsePlacspAtom(xmlText, { sourceUrl: safeUrl });
    } catch (error) {
      throw new PlacspSyncError(
        502,
        "placsp_parse_failed",
        "The official PLACSP feed could not be parsed safely.",
        `PLACSP XML parsing failed for ${safeUrl}: ${error.message}`
      );
    }
    return {
      url: safeUrl,
      xmlText,
      parsed
    };
  } catch (error) {
    if (error instanceof PlacspSyncError) throw error;
    if (error?.name === "AbortError") {
      throw new PlacspSyncError(
        504,
        "placsp_timeout",
        "The official PLACSP feed did not respond in time.",
        `PLACSP request to ${safeUrl} exceeded ${timeoutMs} ms.`
      );
    }
    throw new PlacspSyncError(
      503,
      "placsp_unavailable",
      "The official PLACSP feed is currently unavailable.",
      `PLACSP request to ${safeUrl} failed: ${error.message}`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function syncPlacspFeed(options = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    feedUrl = PLACSP_FEED_URL
  } = options;

  const maxPages = sanitizeMaxPages(options.maxPages);
  const startedAt = new Date().toISOString();
  const fetchedAt = new Date().toISOString();
  const pages = [];
  const allEntries = [];
  const allDeletedEntries = [];
  const entryErrors = [];
  let nextUrl = assertAllowedPlacspUrl(feedUrl, "PLACSP feed URL");

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchPlacspPage(nextUrl, {
      fetchImpl,
      timeoutMs,
      maxResponseBytes
    });
    pages.push(page);
    allEntries.push(...page.parsed.entries);
    allDeletedEntries.push(...page.parsed.deletedEntries);
    entryErrors.push(...page.parsed.entryErrors);

    const candidateNextUrl = page.parsed.feed.nextUrl;
    if (!candidateNextUrl) break;
    nextUrl = assertAllowedPlacspUrl(candidateNextUrl, "PLACSP next-page URL");
  }

  if (!pages.length) {
    throw new PlacspSyncError(
      502,
      "placsp_empty_sync",
      "No PLACSP pages were retrieved.",
      "PLACSP sync completed without any fetched pages."
    );
  }

  const normalized = normalizePlacspDataset({
    feed: pages[0].parsed.feed,
    entries: allEntries,
    deletedEntries: allDeletedEntries,
    fetchedAt
  });

  return {
    connector: "placsp",
    startedAt,
    completedAt: new Date().toISOString(),
    fetchedAt,
    feedUrl: assertAllowedPlacspUrl(feedUrl, "PLACSP feed URL"),
    feedUpdated: pages[0].parsed.feed.updated ?? null,
    pagesFetched: pages.length,
    entriesSeen: allEntries.length,
    uniqueEntries: normalized.stats.uniqueEntries,
    tombstonesSeen: allDeletedEntries.length,
    parserErrors: entryErrors,
    opportunities: normalized.opportunities,
    tombstones: normalized.tombstones
  };
}
