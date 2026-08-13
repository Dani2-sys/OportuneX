const SOURCE_CACHE_DB_NAME = "oportunex-source-cache";
const SOURCE_CACHE_DB_VERSION = 1;
const SOURCE_CACHE_STORE = "opportunities";
const SOURCE_CACHE_CONNECTOR_INDEX = "connector";
const SOURCE_CACHE_SOURCE_OPPORTUNITY_INDEX = "sourceOpportunityId";

const SOURCE_CACHE_AVAILABLE_DETAIL =
  "Source cache persistence is active for official connector opportunities.";
const SOURCE_CACHE_UNAVAILABLE_DETAIL =
  "Source cache persistence is unavailable. PLACSP opportunities can still work for this session but may be lost after reload.";
const SOURCE_CACHE_LOAD_ERROR_DETAIL =
  "Stored source opportunities could not be loaded. OportuneX continued with the local workspace state for this session.";
const SOURCE_CACHE_SAVE_ERROR_DETAIL =
  "Source cache persistence failed. Current PLACSP opportunities still work in memory for this session.";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function serializeError(error) {
  return error instanceof Error ? error.message : String(error ?? "Unknown source cache error");
}

function createSourceCacheError(result, operation, connector = "placsp") {
  return {
    code: result?.code ?? `SOURCE_CACHE_${operation.toUpperCase()}_FAILED`,
    message: result?.message ?? "Unknown source cache error.",
    operation,
    connector,
    at: new Date().toISOString()
  };
}

function createSourceCacheStatus(overrides = {}) {
  return {
    status: "available",
    mode: "indexeddb",
    detail: SOURCE_CACHE_AVAILABLE_DETAIL,
    lastHydratedAt: null,
    lastSavedAt: null,
    lastError: null,
    counts: {},
    hydrationMs: null,
    ...overrides
  };
}

function sourceCacheAvailable(overrides = {}) {
  return createSourceCacheStatus({
    status: "available",
    mode: "indexeddb",
    detail: SOURCE_CACHE_AVAILABLE_DETAIL,
    ...overrides
  });
}

function sourceCacheUnavailable(result, operation, connector = "placsp", overrides = {}) {
  return createSourceCacheStatus({
    status: "unavailable",
    mode: "memory_only",
    detail: SOURCE_CACHE_UNAVAILABLE_DETAIL,
    lastError: createSourceCacheError(result, operation, connector),
    ...overrides
  });
}

function sourceCacheLoadError(result, connector = "placsp", overrides = {}) {
  return createSourceCacheStatus({
    status: "error",
    mode: "indexeddb",
    detail: SOURCE_CACHE_LOAD_ERROR_DETAIL,
    lastError: createSourceCacheError(result, "load", connector),
    ...overrides
  });
}

function sourceCacheSaveError(result, connector = "placsp", overrides = {}) {
  return createSourceCacheStatus({
    status: "error",
    mode: "indexeddb",
    detail: SOURCE_CACHE_SAVE_ERROR_DETAIL,
    lastError: createSourceCacheError(result, "save", connector),
    ...overrides
  });
}

function normalizeConnector(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim().toLowerCase();
}

function normalizeOpportunityForConnector(opportunity, connector) {
  if (!isPlainObject(opportunity)) return opportunity;
  return {
    ...opportunity,
    sourceConnector: opportunity.sourceConnector ?? connector
  };
}

export function isSourceOpportunityForConnector(opportunity, connector) {
  const normalizedConnector = normalizeConnector(connector);
  if (!normalizedConnector || !isPlainObject(opportunity)) return false;

  const directConnector = normalizeConnector(opportunity.sourceConnector);
  if (directConnector === normalizedConnector) return true;

  if (normalizedConnector !== "placsp") return false;

  return sanitizeArray(opportunity.sources).some((source) => {
    const sourceType = normalizeConnector(source?.metadata?.sourceType);
    const organisation = source?.organisation?.toString?.() ?? "";
    return (
      sourceType === "official_open_data_atom" ||
      /plataforma de contratacion del sector publico/i.test(organisation)
    );
  });
}

export function isPlacspSourceOpportunity(opportunity) {
  return isSourceOpportunityForConnector(opportunity, "placsp");
}

export function filterOutSourceOpportunities(opportunities = [], connector = "placsp") {
  return sanitizeArray(opportunities).filter((item) => !isSourceOpportunityForConnector(item, connector));
}

export function mergeSourceOpportunities(opportunities = [], connector = "placsp", cachedOpportunities = []) {
  const retained = filterOutSourceOpportunities(opportunities, connector);
  const normalizedCached = sanitizeArray(cachedOpportunities).map((item) =>
    normalizeOpportunityForConnector(item, connector)
  );
  return [...normalizedCached, ...retained];
}

function buildSourceCacheRecord(connector, opportunity, cachedAt) {
  const normalizedOpportunity = normalizeOpportunityForConnector(opportunity, connector);
  return {
    id: normalizedOpportunity.id,
    connector,
    sourceOpportunityId: normalizedOpportunity.sourceOpportunityId ?? normalizedOpportunity.id,
    sourceNoticeVersionId: normalizedOpportunity.sourceNoticeVersionId ?? null,
    cachedAt,
    opportunity: normalizedOpportunity
  };
}

function normalizeAdapterResult(result, fallbackCode, fallbackMessage) {
  if (result?.ok === true) return result;
  if (result?.ok === false) {
    return {
      ok: false,
      code: result.code ?? fallbackCode,
      message: result.message ?? fallbackMessage
    };
  }
  return {
    ok: false,
    code: fallbackCode,
    message: fallbackMessage
  };
}

function createUnavailableResult() {
  return {
    ok: false,
    code: "SOURCE_CACHE_UNAVAILABLE",
    message: "IndexedDB is not available in this environment."
  };
}

function requestToPromise(request, transform = (value) => value?.result) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(transform(request));
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}

export function createIndexedDbSourceCacheAdapter({
  indexedDB = globalThis.indexedDB
} = {}) {
  let dbPromise = null;

  async function openDatabase() {
    if (!indexedDB) throw new Error(createUnavailableResult().message);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(SOURCE_CACHE_DB_NAME, SOURCE_CACHE_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.objectStoreNames.contains(SOURCE_CACHE_STORE)
          ? request.transaction.objectStore(SOURCE_CACHE_STORE)
          : db.createObjectStore(SOURCE_CACHE_STORE, { keyPath: "id" });

        if (!store.indexNames.contains(SOURCE_CACHE_CONNECTOR_INDEX)) {
          store.createIndex(SOURCE_CACHE_CONNECTOR_INDEX, "connector", { unique: false });
        }
        if (!store.indexNames.contains(SOURCE_CACHE_SOURCE_OPPORTUNITY_INDEX)) {
          store.createIndex(SOURCE_CACHE_SOURCE_OPPORTUNITY_INDEX, "sourceOpportunityId", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another tab."));
    });

    return dbPromise;
  }

  async function getAllRecords() {
    const db = await openDatabase();
    const transaction = db.transaction(SOURCE_CACHE_STORE, "readonly");
    const store = transaction.objectStore(SOURCE_CACHE_STORE);
    const records = await requestToPromise(store.getAll());
    await transactionDone(transaction);
    return sanitizeArray(records);
  }

  return {
    kind: "indexeddb",
    async loadByConnector(connector) {
      if (!indexedDB) return createUnavailableResult();
      try {
        const records = await getAllRecords();
        return {
          ok: true,
          records: records.filter((item) => item?.connector === connector)
        };
      } catch (error) {
        return {
          ok: false,
          code: "SOURCE_CACHE_LOAD_FAILED",
          message: serializeError(error)
        };
      }
    },
    async upsertMany(connector, opportunities) {
      if (!indexedDB) return createUnavailableResult();
      try {
        const db = await openDatabase();
        const transaction = db.transaction(SOURCE_CACHE_STORE, "readwrite");
        const store = transaction.objectStore(SOURCE_CACHE_STORE);
        const cachedAt = new Date().toISOString();
        sanitizeArray(opportunities).forEach((opportunity) => {
          store.put(buildSourceCacheRecord(connector, opportunity, cachedAt));
        });
        await transactionDone(transaction);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: "SOURCE_CACHE_SAVE_FAILED",
          message: serializeError(error)
        };
      }
    },
    async count(connector) {
      if (!indexedDB) return createUnavailableResult();
      try {
        const records = await getAllRecords();
        return {
          ok: true,
          count: records.filter((item) => item?.connector === connector).length
        };
      } catch (error) {
        return {
          ok: false,
          code: "SOURCE_CACHE_COUNT_FAILED",
          message: serializeError(error)
        };
      }
    },
    async clearConnector(connector) {
      if (!indexedDB) return createUnavailableResult();
      try {
        const db = await openDatabase();
        const existing = await getAllRecords();
        const transaction = db.transaction(SOURCE_CACHE_STORE, "readwrite");
        const store = transaction.objectStore(SOURCE_CACHE_STORE);
        existing
          .filter((item) => item?.connector === connector)
          .forEach((record) => {
            store.delete(record.id);
          });
        await transactionDone(transaction);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: "SOURCE_CACHE_CLEAR_FAILED",
          message: serializeError(error)
        };
      }
    }
  };
}

export function createInMemorySourceCacheAdapter(initialRecords = []) {
  const records = new Map();
  sanitizeArray(initialRecords).forEach((record) => {
    if (!record?.id) return;
    records.set(record.id, structuredClone(record));
  });

  return {
    kind: "memory_test",
    async loadByConnector(connector) {
      return {
        ok: true,
        records: [...records.values()]
          .filter((item) => item?.connector === connector)
          .map((item) => structuredClone(item))
      };
    },
    async upsertMany(connector, opportunities) {
      const cachedAt = new Date().toISOString();
      sanitizeArray(opportunities).forEach((opportunity) => {
        const record = buildSourceCacheRecord(connector, opportunity, cachedAt);
        records.set(record.id, record);
      });
      return { ok: true };
    },
    async count(connector) {
      return {
        ok: true,
        count: [...records.values()].filter((item) => item?.connector === connector).length
      };
    },
    async clearConnector(connector) {
      [...records.values()]
        .filter((item) => item?.connector === connector)
        .forEach((record) => {
          records.delete(record.id);
        });
      return { ok: true };
    },
    dump() {
      return [...records.values()].map((item) => structuredClone(item));
    }
  };
}

export function createSourceOpportunityCache({
  adapter = createIndexedDbSourceCacheAdapter()
} = {}) {
  let status =
    adapter?.kind === "indexeddb"
      ? sourceCacheAvailable()
      : adapter?.kind
        ? createSourceCacheStatus({
            status: "available",
            mode: adapter.kind,
            detail: SOURCE_CACHE_AVAILABLE_DETAIL
          })
        : sourceCacheUnavailable(createUnavailableResult(), "load");
  const listeners = new Set();

  function notify() {
    listeners.forEach((listener) => listener(status));
  }

  function setStatus(nextStatus) {
    status = nextStatus;
    notify();
  }

  async function loadByConnector(connector) {
    const startedAt = Date.now();
    const result = normalizeAdapterResult(
      await adapter.loadByConnector(connector),
      "SOURCE_CACHE_LOAD_FAILED",
      "Source cache load failed."
    );

    if (!result.ok) {
      setStatus(
        result.code === "SOURCE_CACHE_UNAVAILABLE"
          ? sourceCacheUnavailable(result, "load", connector, {
              counts: {
                ...status.counts,
                [connector]: 0
              },
              hydrationMs: Date.now() - startedAt
            })
          : sourceCacheLoadError(result, connector, {
              counts: {
                ...status.counts,
                [connector]: 0
              },
              hydrationMs: Date.now() - startedAt
            })
      );
      return {
        ok: false,
        code: result.code,
        message: result.message,
        opportunities: [],
        count: 0,
        durationMs: Date.now() - startedAt
      };
    }

    const opportunities = sanitizeArray(result.records)
      .map((record) => normalizeOpportunityForConnector(record?.opportunity, connector))
      .filter(Boolean);
    setStatus(
      sourceCacheAvailable({
        mode: adapter.kind === "indexeddb" ? "indexeddb" : adapter.kind ?? "memory_test",
        lastHydratedAt: new Date().toISOString(),
        counts: {
          ...status.counts,
          [connector]: opportunities.length
        },
        hydrationMs: Date.now() - startedAt,
        lastSavedAt: status.lastSavedAt
      })
    );
    return {
      ok: true,
      opportunities,
      count: opportunities.length,
      durationMs: Date.now() - startedAt
    };
  }

  async function upsertMany(connector, opportunities) {
    const result = normalizeAdapterResult(
      await adapter.upsertMany(connector, sanitizeArray(opportunities).map((item) => normalizeOpportunityForConnector(item, connector))),
      "SOURCE_CACHE_SAVE_FAILED",
      "Source cache save failed."
    );

    if (!result.ok) {
      setStatus(
        result.code === "SOURCE_CACHE_UNAVAILABLE"
          ? sourceCacheUnavailable(result, "save", connector, {
              counts: {
                ...status.counts
              },
              lastHydratedAt: status.lastHydratedAt,
              hydrationMs: status.hydrationMs
            })
          : sourceCacheSaveError(result, connector, {
              counts: {
                ...status.counts
              },
              lastHydratedAt: status.lastHydratedAt,
              hydrationMs: status.hydrationMs
            })
      );
      return result;
    }

    const countResult = await count(connector);
    setStatus(
      sourceCacheAvailable({
        mode: adapter.kind === "indexeddb" ? "indexeddb" : adapter.kind ?? "memory_test",
        lastHydratedAt: status.lastHydratedAt,
        lastSavedAt: new Date().toISOString(),
        counts: {
          ...status.counts,
          [connector]: countResult.ok ? countResult.count : sanitizeArray(opportunities).length
        },
        hydrationMs: status.hydrationMs
      })
    );
    return { ok: true };
  }

  async function count(connector) {
    const result = normalizeAdapterResult(
      await adapter.count(connector),
      "SOURCE_CACHE_COUNT_FAILED",
      "Source cache count failed."
    );

    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message
      };
    }

    return {
      ok: true,
      count: result.count ?? 0
    };
  }

  async function clearConnector(connector) {
    const result = normalizeAdapterResult(
      await adapter.clearConnector(connector),
      "SOURCE_CACHE_CLEAR_FAILED",
      "Source cache clear failed."
    );

    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message
      };
    }

    setStatus(
      sourceCacheAvailable({
        mode: adapter.kind === "indexeddb" ? "indexeddb" : adapter.kind ?? "memory_test",
        lastHydratedAt: status.lastHydratedAt,
        lastSavedAt: new Date().toISOString(),
        counts: {
          ...status.counts,
          [connector]: 0
        },
        hydrationMs: status.hydrationMs
      })
    );
    return { ok: true };
  }

  return {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadByConnector,
    upsertMany,
    count,
    clearConnector
  };
}
