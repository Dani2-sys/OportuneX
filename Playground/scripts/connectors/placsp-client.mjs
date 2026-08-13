import { parsePlacspAtom } from "./placsp-parser.mjs";
import {
  PLACSP_ALLOWED_HOSTS,
  PLACSP_FEED_URL,
  normalizePlacspDataset
} from "../../src/connectors/placsp-normalizer.js";

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESPONSE_BYTES = 25_000_000;
const DEFAULT_MAX_TOTAL_RESPONSE_BYTES = 100_000_000;
const DEFAULT_MAX_ELAPSED_MS = 60000;
const DEFAULT_MAX_PAGES = 1;
const MANUAL_HARD_MAX_PAGES = 5;
const INCREMENTAL_HARD_MAX_PAGES = 10;
const RECONCILE_HARD_MAX_PAGES = 5;
const DEFAULT_RECONCILE_MAX_PAGES = 5;
const OVERLAP_PAGES = 1;
const PLACSP_SYNC_MODES = new Set(["manual", "incremental", "reconcile"]);

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
  return Math.min(MANUAL_HARD_MAX_PAGES, Math.max(1, Math.round(parsed)));
}

function sanitizeSyncMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!mode) return "manual";
  if (!PLACSP_SYNC_MODES.has(mode)) {
    throw new PlacspSyncError(
      400,
      "invalid_placsp_sync_mode",
      "The requested PLACSP sync mode is not supported.",
      `Unsupported PLACSP sync mode: ${value}`
    );
  }
  return mode;
}

function sanitizeTimestamp(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new PlacspSyncError(
      400,
      "invalid_placsp_cursor",
      `${label} is invalid.`,
      `${label} must be an ISO-like timestamp string.`
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PlacspSyncError(
      400,
      "invalid_placsp_cursor",
      `${label} is invalid.`,
      `${label} could not be parsed: ${value}`
    );
  }
  return new Date(parsed).toISOString();
}

function sanitizeCursor(cursor) {
  if (cursor == null) {
    return {
      lastFeedUpdated: null,
      entryUpdatedWatermark: null
    };
  }

  if (typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new PlacspSyncError(
      400,
      "invalid_placsp_cursor",
      "The requested PLACSP cursor is invalid.",
      "PLACSP cursor must be an object when provided."
    );
  }

  return {
    lastFeedUpdated: sanitizeTimestamp(cursor.lastFeedUpdated, "Cursor lastFeedUpdated"),
    entryUpdatedWatermark: sanitizeTimestamp(cursor.entryUpdatedWatermark, "Cursor entryUpdatedWatermark")
  };
}

function resolveMaxPages(mode, requestedValue) {
  const parsed = Number(requestedValue);
  if (mode === "incremental") {
    if (!Number.isFinite(parsed)) return INCREMENTAL_HARD_MAX_PAGES;
    return Math.min(INCREMENTAL_HARD_MAX_PAGES, Math.max(1, Math.round(parsed)));
  }
  if (mode === "reconcile") {
    if (!Number.isFinite(parsed)) return DEFAULT_RECONCILE_MAX_PAGES;
    return Math.min(RECONCILE_HARD_MAX_PAGES, Math.max(1, Math.round(parsed)));
  }
  return sanitizeMaxPages(requestedValue);
}

function timestampEquals(left, right) {
  const leftTs = Date.parse(left ?? "");
  const rightTs = Date.parse(right ?? "");
  if (Number.isFinite(leftTs) && Number.isFinite(rightTs)) return leftTs === rightTs;
  return String(left ?? "").trim() === String(right ?? "").trim();
}

function pageTimestamps(page) {
  return [
    ...page.parsed.entries.map((entry) => Date.parse(entry.updated ?? "")).filter(Number.isFinite),
    ...page.parsed.deletedEntries.map((entry) => Date.parse(entry.when ?? "")).filter(Number.isFinite)
  ];
}

function pageCrossesWatermark(page, watermark) {
  const watermarkTs = Date.parse(watermark ?? "");
  if (!Number.isFinite(watermarkTs)) return false;
  const timestamps = pageTimestamps(page);
  if (!timestamps.length) return false;
  return Math.min(...timestamps) <= watermarkTs;
}

function newestEntryUpdated(entries) {
  const timestamps = entries
    .map((entry) => {
      const updated = entry?.updated ?? null;
      const parsed = Date.parse(updated ?? "");
      return Number.isFinite(parsed)
        ? {
            raw: updated,
            parsed
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.parsed - left.parsed);

  return timestamps[0]?.raw ?? null;
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
      byteLength: Buffer.byteLength(xmlText, "utf8"),
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
    maxTotalResponseBytes = DEFAULT_MAX_TOTAL_RESPONSE_BYTES,
    maxElapsedMs = DEFAULT_MAX_ELAPSED_MS,
    feedUrl = PLACSP_FEED_URL
  } = options;
  const mode = sanitizeSyncMode(options.mode);
  const cursor = sanitizeCursor(options.cursor);
  const maxPages = resolveMaxPages(mode, options.maxPages);
  const startedAt = new Date().toISOString();
  const fetchedAt = new Date().toISOString();
  const pages = [];
  const allEntries = [];
  const allDeletedEntries = [];
  const entryErrors = [];
  let totalBytes = 0;
  let nextUrl = assertAllowedPlacspUrl(feedUrl, "PLACSP feed URL");
  let truncated = false;
  let truncationReason = null;
  let cursorReached = mode === "incremental" ? !cursor.entryUpdatedWatermark : null;
  let boundaryPageCount = null;
  let stoppedBySafetyLimit = false;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchPlacspPage(nextUrl, {
      fetchImpl,
      timeoutMs,
      maxResponseBytes
    });
    pages.push(page);
    totalBytes += page.byteLength ?? 0;

    if (
      mode === "incremental" &&
      pageIndex === 0 &&
      cursor.lastFeedUpdated &&
      timestampEquals(page.parsed.feed.updated, cursor.lastFeedUpdated)
    ) {
      return {
        connector: "placsp",
        mode,
        startedAt,
        completedAt: new Date().toISOString(),
        fetchedAt,
        feedUrl: assertAllowedPlacspUrl(feedUrl, "PLACSP feed URL"),
        feedUpdated: page.parsed.feed.updated ?? null,
        sourceFeedUpdated: page.parsed.feed.updated ?? null,
        previousFeedUpdated: cursor.lastFeedUpdated,
        previousEntryWatermark: cursor.entryUpdatedWatermark,
        nextEntryWatermark: newestEntryUpdated(page.parsed.entries),
        feedChanged: false,
        cursorReached: true,
        truncated: false,
        truncationReason: null,
        pagesFetched: 1,
        entriesSeen: 0,
        uniqueEntries: 0,
        newEntries: 0,
        changedEntries: 0,
        tombstonesSeen: 0,
        parserErrors: [],
        opportunities: [],
        tombstones: []
      };
    }

    allEntries.push(...page.parsed.entries);
    allDeletedEntries.push(...page.parsed.deletedEntries);
    entryErrors.push(...page.parsed.entryErrors);

    if (mode === "incremental" && cursor.entryUpdatedWatermark && boundaryPageCount == null) {
      if (pageCrossesWatermark(page, cursor.entryUpdatedWatermark)) {
        boundaryPageCount = pages.length;
        cursorReached = true;
      }
    }

    if (totalBytes > maxTotalResponseBytes) {
      truncated = true;
      stoppedBySafetyLimit = true;
      truncationReason = "safety_limit";
      if (mode === "incremental" && boundaryPageCount == null) cursorReached = false;
      break;
    }

    if (Date.now() - Date.parse(startedAt) > maxElapsedMs) {
      truncated = true;
      stoppedBySafetyLimit = true;
      truncationReason = "safety_limit";
      if (mode === "incremental" && boundaryPageCount == null) cursorReached = false;
      break;
    }

    const candidateNextUrl = page.parsed.feed.nextUrl;
    if (!candidateNextUrl) {
      if (mode === "incremental") cursorReached = true;
      break;
    }

    if (mode === "incremental" && boundaryPageCount != null && pages.length >= boundaryPageCount + OVERLAP_PAGES) {
      break;
    }

    if (pageIndex === maxPages - 1) {
      truncated = true;
      truncationReason = "page_limit";
      if (mode === "incremental" && boundaryPageCount == null) cursorReached = false;
      break;
    }

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

  if (mode === "incremental" && boundaryPageCount == null && !truncated && nextUrl === null) {
    cursorReached = true;
  }

  if (stoppedBySafetyLimit && mode !== "incremental") {
    cursorReached = null;
  }

  const headFeedUpdated = pages[0].parsed.feed.updated ?? null;
  const nextEntryWatermark = newestEntryUpdated(pages[0].parsed.entries);
  const feedChanged = cursor.lastFeedUpdated ? !timestampEquals(headFeedUpdated, cursor.lastFeedUpdated) : true;

  return {
    connector: "placsp",
    mode,
    startedAt,
    completedAt: new Date().toISOString(),
    fetchedAt,
    feedUrl: assertAllowedPlacspUrl(feedUrl, "PLACSP feed URL"),
    feedUpdated: headFeedUpdated,
    sourceFeedUpdated: headFeedUpdated,
    previousFeedUpdated: cursor.lastFeedUpdated,
    previousEntryWatermark: cursor.entryUpdatedWatermark,
    nextEntryWatermark,
    feedChanged,
    cursorReached,
    truncated,
    truncationReason,
    pagesFetched: pages.length,
    entriesSeen: allEntries.length,
    uniqueEntries: normalized.stats.uniqueEntries,
    newEntries: normalized.stats.uniqueEntries,
    changedEntries: normalized.opportunities.length + normalized.tombstones.length,
    tombstonesSeen: allDeletedEntries.length,
    parserErrors: entryErrors,
    opportunities: normalized.opportunities,
    tombstones: normalized.tombstones
  };
}
