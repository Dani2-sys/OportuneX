import { createConnectorState } from "./source-opportunity-cache.js";

const DEFAULT_DUE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_FAILURE_BACKOFF_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RECONCILE_MAX_PAGES = 5;
const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_LEASE_KEY = "oportunex.placsp.auto-sync-lock.v1";
const BDNS_LEASE_KEY = "oportunex.bdns.auto-sync-lock.v1";

function normalizeDate(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function nextIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function normalizeConnectorName(connector) {
  return createConnectorState(connector)?.connector ?? "placsp";
}

export function getRefreshLeaseKey(connector = "placsp") {
  return normalizeConnectorName(connector) === "bdns" ? BDNS_LEASE_KEY : DEFAULT_LEASE_KEY;
}

function defaultBuildSyncRequest({ connector, reconciliationDue, reconcileMaxPages }) {
  if (normalizeConnectorName(connector) === "bdns") {
    return reconciliationDue
      ? {
          requestMode: "reconcile",
          runMode: "automatic"
        }
      : {
          requestMode: "automatic",
          runMode: "automatic"
        };
  }

  return reconciliationDue
    ? {
        requestMode: "reconcile",
        runMode: "automatic",
        maxPages: reconcileMaxPages
      }
    : {
        requestMode: "incremental",
        runMode: "automatic"
      };
}

export function isRefreshFresh(lastSuccessfulSyncAt, nowMs, dueIntervalMs = DEFAULT_DUE_INTERVAL_MS) {
  const lastSuccess = normalizeDate(lastSuccessfulSyncAt);
  if (!Number.isFinite(lastSuccess)) return false;
  return nowMs - lastSuccess < dueIntervalMs;
}

export function isReconciliationDue(lastReconciliationAt, nowMs, intervalMs = DEFAULT_RECONCILIATION_INTERVAL_MS) {
  const lastReconciliation = normalizeDate(lastReconciliationAt);
  if (!Number.isFinite(lastReconciliation)) return true;
  return nowMs - lastReconciliation >= intervalMs;
}

export function isFailureBackoffActive(state, nowMs, backoffMs = DEFAULT_FAILURE_BACKOFF_MS) {
  if (!state?.lastErrorCode || !state?.lastErrorAt) return false;
  const lastErrorAt = normalizeDate(state.lastErrorAt);
  if (!Number.isFinite(lastErrorAt)) return false;
  return nowMs - lastErrorAt < backoffMs;
}

export function getNextAutomaticRefreshAt(
  state,
  {
    nowMs,
    dueIntervalMs = DEFAULT_DUE_INTERVAL_MS,
    failureBackoffMs = DEFAULT_FAILURE_BACKOFF_MS,
    reconciliationIntervalMs = DEFAULT_RECONCILIATION_INTERVAL_MS
  } = {}
) {
  const currentNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const lastSuccess = normalizeDate(state?.lastSuccessfulSyncAt);
  const lastError = normalizeDate(state?.lastErrorAt);
  const lastReconciliation = normalizeDate(state?.lastReconciliationAt);
  const dueAt = Number.isFinite(lastSuccess) ? lastSuccess + dueIntervalMs : currentNow;
  const reconcileAt = Number.isFinite(lastReconciliation) ? lastReconciliation + reconciliationIntervalMs : currentNow;
  const backoffUntil =
    state?.lastErrorCode && Number.isFinite(lastError) ? lastError + failureBackoffMs : null;
  let nextAt = Math.min(dueAt, reconcileAt);
  if (Number.isFinite(backoffUntil) && backoffUntil > nextAt) {
    nextAt = backoffUntil;
  }
  return nextIso(nextAt);
}

export function createRefreshLease({
  key = DEFAULT_LEASE_KEY,
  storage = globalThis.localStorage,
  ownerId = `lease-${Math.random().toString(36).slice(2, 10)}`,
  nowImpl = () => Date.now(),
  leaseMs = DEFAULT_LEASE_MS
} = {}) {
  let inMemoryLease = null;

  function nextLease() {
    const acquiredAt = nowImpl();
    return {
      ownerId,
      acquiredAt: nextIso(acquiredAt),
      expiresAt: nextIso(acquiredAt + leaseMs)
    };
  }

  function parseLease(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function isExpired(lease) {
    const expiresAt = normalizeDate(lease?.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= nowImpl();
  }

  function fallbackAcquire() {
    if (inMemoryLease && !isExpired(inMemoryLease)) {
      return {
        acquired: inMemoryLease.ownerId === ownerId,
        lease: inMemoryLease
      };
    }
    inMemoryLease = nextLease();
    return {
      acquired: true,
      lease: inMemoryLease
    };
  }

  return {
    ownerId,
    async acquire() {
      if (!storage) return fallbackAcquire();

      try {
        const existing = parseLease(storage.getItem(key));
        if (existing && !isExpired(existing) && existing.ownerId !== ownerId) {
          return {
            acquired: false,
            lease: existing
          };
        }

        const lease = nextLease();
        storage.setItem(key, JSON.stringify(lease));
        const stored = parseLease(storage.getItem(key));
        if (stored?.ownerId === ownerId) {
          inMemoryLease = stored;
          return {
            acquired: true,
            lease: stored
          };
        }
        return {
          acquired: false,
          lease: stored
        };
      } catch {
        return fallbackAcquire();
      }
    },
    async release() {
      inMemoryLease = null;
      if (!storage) return;
      try {
        const existing = parseLease(storage.getItem(key));
        if (!existing || existing.ownerId === ownerId || isExpired(existing)) {
          storage.removeItem(key);
        }
      } catch {
        // Ignore storage failures and fall back to current-tab protection only.
      }
    }
  };
}

function defaultVisibilityApi(documentRef = globalThis.document) {
  return {
    isVisible() {
      return !documentRef || documentRef.visibilityState !== "hidden";
    },
    subscribe(listener) {
      if (!documentRef?.addEventListener) return () => {};
      const handler = () => listener("visibility");
      documentRef.addEventListener("visibilitychange", handler);
      return () => documentRef.removeEventListener("visibilitychange", handler);
    }
  };
}

function defaultNetworkApi(windowRef = globalThis.window, navigatorRef = globalThis.navigator) {
  return {
    isOnline() {
      return navigatorRef?.onLine !== false;
    },
    subscribe(listener) {
      if (!windowRef?.addEventListener) return () => {};
      const online = () => listener("online");
      const offline = () => listener("offline");
      windowRef.addEventListener("online", online);
      windowRef.addEventListener("offline", offline);
      return () => {
        windowRef.removeEventListener("online", online);
        windowRef.removeEventListener("offline", offline);
      };
    }
  };
}

export function createConnectorRefreshScheduler({
  connector = "placsp",
  sourceCache,
  runSync,
  isSyncActive = () => false,
  dueIntervalMs = DEFAULT_DUE_INTERVAL_MS,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  failureBackoffMs = DEFAULT_FAILURE_BACKOFF_MS,
  reconciliationIntervalMs = DEFAULT_RECONCILIATION_INTERVAL_MS,
  reconcileMaxPages = DEFAULT_RECONCILE_MAX_PAGES,
  buildSyncRequest = defaultBuildSyncRequest,
  nowImpl = () => new Date(),
  timerApi = globalThis,
  visibilityApi = defaultVisibilityApi(),
  networkApi = defaultNetworkApi(),
  lease = null
} = {}) {
  let intervalId = null;
  let started = false;
  let hydrationReady = false;
  let currentRun = null;
  let readyPromise = Promise.resolve();
  const refreshLease = lease ?? createRefreshLease({
    key: getRefreshLeaseKey(connector)
  });
  const unsubscribe = [];
  const status = {
    lastCheckAt: null,
    lastDecision: "idle",
    lastMode: null
  };

  async function readConnectorState() {
    if (!sourceCache?.getConnectorState) return createConnectorState(connector);
    const result = await sourceCache.getConnectorState(connector);
    return result?.state ?? createConnectorState(connector);
  }

  async function runDueCheck(reason = "manual_check") {
    const now = nowImpl();
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    status.lastCheckAt = new Date(nowMs).toISOString();

    if (!started) {
      status.lastDecision = "stopped";
      return { ran: false, reason: "stopped" };
    }
    if (!hydrationReady) {
      status.lastDecision = "waiting_for_hydration";
      return { ran: false, reason: "waiting_for_hydration" };
    }
    if (currentRun) {
      status.lastDecision = "active_sync";
      return { ran: false, reason: "active_sync" };
    }

    const connectorState = await readConnectorState();
    if (connectorState.autoRefreshEnabled === false) {
      status.lastDecision = "disabled";
      return { ran: false, reason: "disabled" };
    }
    if (!visibilityApi.isVisible()) {
      status.lastDecision = "hidden";
      return { ran: false, reason: "hidden" };
    }
    if (!networkApi.isOnline()) {
      status.lastDecision = "offline";
      return { ran: false, reason: "offline" };
    }
    if (isSyncActive()) {
      status.lastDecision = "active_sync";
      return { ran: false, reason: "active_sync" };
    }
    if (isFailureBackoffActive(connectorState, nowMs, failureBackoffMs)) {
      status.lastDecision = "backoff";
      return { ran: false, reason: "backoff" };
    }

    const reconciliationDue = isReconciliationDue(
      connectorState.lastReconciliationAt,
      nowMs,
      reconciliationIntervalMs
    );
    const refreshFresh = isRefreshFresh(
      connectorState.lastSuccessfulSyncAt,
      nowMs,
      dueIntervalMs
    );

    if (!reconciliationDue && refreshFresh) {
      status.lastDecision = "fresh";
      return { ran: false, reason: "fresh" };
    }

    const leaseResult = await refreshLease.acquire();
    if (!leaseResult.acquired) {
      status.lastDecision = "lease_busy";
      return { ran: false, reason: "lease_busy" };
    }

    const syncRequest = buildSyncRequest({
      connector,
      reconciliationDue,
      reconcileMaxPages
    }) ?? defaultBuildSyncRequest({
      connector,
      reconciliationDue,
      reconcileMaxPages
    });
    const mode = syncRequest.requestMode ?? (reconciliationDue ? "reconcile" : "incremental");
    status.lastDecision = "running";
    status.lastMode = mode;
    currentRun = Promise.resolve(
      runSync({
        reason,
        ...syncRequest
      })
    );

    try {
      await currentRun;
      status.lastDecision = "completed";
      return {
        ran: true,
        mode
      };
    } finally {
      currentRun = null;
      await refreshLease.release();
    }
  }

  function start({ ready = Promise.resolve() } = {}) {
    if (started) return;
    started = true;
    readyPromise = Promise.resolve(ready)
      .catch(() => {})
      .finally(() => {
        hydrationReady = true;
        void runDueCheck("startup").catch(() => {});
      });

    intervalId = timerApi.setInterval(() => {
      if (!hydrationReady) return;
      void runDueCheck("interval").catch(() => {});
    }, checkIntervalMs);
    if (typeof intervalId?.unref === "function") intervalId.unref();

    unsubscribe.push(visibilityApi.subscribe(() => {
      if (!hydrationReady) return;
      void runDueCheck("visibility").catch(() => {});
    }));
    unsubscribe.push(networkApi.subscribe(() => {
      if (!hydrationReady) return;
      void runDueCheck("network").catch(() => {});
    }));
  }

  function stop() {
    started = false;
    hydrationReady = false;
    if (intervalId != null) {
      timerApi.clearInterval(intervalId);
      intervalId = null;
    }
    while (unsubscribe.length) {
      const dispose = unsubscribe.pop();
      dispose?.();
    }
  }

  return {
    start,
    stop,
    runDueCheck,
    getStatus() {
      return {
        ...status
      };
    },
    getNextAutomaticRefreshAt(state, nowMs = Date.now()) {
      return getNextAutomaticRefreshAt(state, {
        nowMs,
        dueIntervalMs,
        failureBackoffMs,
        reconciliationIntervalMs
      });
    }
  };
}
