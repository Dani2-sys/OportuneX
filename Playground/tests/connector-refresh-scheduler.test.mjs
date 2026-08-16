import test from "node:test";
import assert from "node:assert/strict";

import {
  createConnectorRefreshScheduler,
  createRefreshLease,
  getRefreshLeaseKey
} from "../src/services/connector-refresh-scheduler.js";
import { createConnectorState } from "../src/services/source-opportunity-cache.js";

function createTimerApi() {
  const callbacks = [];
  return {
    callbacks,
    setInterval(callback) {
      const handle = {
        callback,
        unref() {}
      };
      callbacks.push(handle);
      return handle;
    },
    clearInterval(handle) {
      const index = callbacks.indexOf(handle);
      if (index >= 0) callbacks.splice(index, 1);
    }
  };
}

function createVisibilityApi(initialVisible = true) {
  let visible = initialVisible;
  const listeners = new Set();
  return {
    isVisible() {
      return visible;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVisible(nextVisible) {
      visible = nextVisible;
      listeners.forEach((listener) => listener("visibility"));
    }
  };
}

function createNetworkApi(initialOnline = true) {
  let online = initialOnline;
  const listeners = new Set();
  return {
    isOnline() {
      return online;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOnline(nextOnline) {
      online = nextOnline;
      listeners.forEach((listener) => listener("network"));
    }
  };
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function createHarness({
  connector = "placsp",
  state = {},
  now = "2026-08-13T12:00:00.000Z",
  isSyncActive = () => false,
  runSync = async () => {},
  storage = globalThis.localStorage ?? createMemoryStorage(),
  buildSyncRequest = undefined,
  lease = undefined
} = {}) {
  let connectorState = createConnectorState(connector, state);
  const syncCalls = [];
  const timerApi = createTimerApi();
  const visibilityApi = createVisibilityApi(true);
  const networkApi = createNetworkApi(true);
  const scheduler = createConnectorRefreshScheduler({
    connector,
    sourceCache: {
      async getConnectorState() {
        return {
          ok: true,
          state: connectorState
        };
      }
    },
    runSync: async (request) => {
      syncCalls.push(request);
      return runSync(request);
    },
    isSyncActive,
    nowImpl: () => new Date(now),
    timerApi,
    visibilityApi,
    networkApi,
    buildSyncRequest,
    lease: lease ?? createRefreshLease({
      key: getRefreshLeaseKey(connector),
      storage,
      nowImpl: () => Date.parse(now)
    })
  });

  return {
    connector,
    scheduler,
    syncCalls,
    timerApi,
    visibilityApi,
    networkApi,
    setState(nextState) {
      connectorState = createConnectorState(connector, {
        ...connectorState,
        ...nextState
      });
    }
  };
}

async function nextTick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("fresh last sync skips automatic network refresh", async () => {
  const harness = createHarness({
    state: {
      lastSuccessfulSyncAt: "2026-08-13T08:30:00.000Z",
      lastReconciliationAt: "2026-08-13T06:00:00.000Z"
    }
  });

  harness.scheduler.start({ ready: Promise.resolve() });
  await nextTick();

  assert.equal(harness.syncCalls.length, 0);
  assert.equal(harness.scheduler.getStatus().lastDecision, "fresh");
});

test("overdue refresh triggers one automatic incremental request", async () => {
  const harness = createHarness({
    state: {
      lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
      lastReconciliationAt: "2026-08-13T06:00:00.000Z"
    }
  });

  await harness.scheduler.runDueCheck("manual");

  assert.equal(harness.syncCalls.length, 0);

  harness.scheduler.start({ ready: Promise.resolve() });
  await nextTick();

  assert.equal(harness.syncCalls.length, 1);
  assert.equal(harness.syncCalls[0].requestMode, "incremental");
  assert.equal(harness.syncCalls[0].runMode, "automatic");
});

test("automatic refresh stays off when disabled, hidden, offline, or inside failure backoff", async () => {
  const disabled = createHarness({
    state: {
      autoRefreshEnabled: false,
      lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z"
    }
  });
  disabled.scheduler.start({ ready: Promise.resolve() });
  await nextTick();
  assert.equal(disabled.syncCalls.length, 0);

  const hidden = createHarness({
    state: {
      lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z"
    }
  });
  hidden.visibilityApi.setVisible(false);
  hidden.scheduler.start({ ready: Promise.resolve() });
  await nextTick();
  assert.equal(hidden.syncCalls.length, 0);

  const offline = createHarness({
    state: {
      lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z"
    }
  });
  offline.networkApi.setOnline(false);
  offline.scheduler.start({ ready: Promise.resolve() });
  await nextTick();
  assert.equal(offline.syncCalls.length, 0);

  const backoff = createHarness({
    state: {
      lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
      lastErrorAt: "2026-08-13T11:00:00.000Z",
      lastErrorCode: "placsp_timeout"
    }
  });
  backoff.scheduler.start({ ready: Promise.resolve() });
  await nextTick();
  assert.equal(backoff.syncCalls.length, 0);
});

test("automatic refresh retries after the conservative backoff window passes", async () => {
  const harness = createHarness({
    state: {
      lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
      lastReconciliationAt: "2026-08-13T07:00:00.000Z",
      lastErrorAt: "2026-08-13T08:00:00.000Z",
      lastErrorCode: "placsp_timeout"
    }
  });

  harness.scheduler.start({ ready: Promise.resolve() });
  await nextTick();

  assert.equal(harness.syncCalls.length, 1);
  assert.equal(harness.syncCalls[0].requestMode, "incremental");
});

test("startup waits for hydration and active sync protection blocks duplicates", async () => {
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  let resolveSync;
  const activeSync = new Promise((resolve) => {
    resolveSync = resolve;
  });
  const harness = createHarness({
    state: {
      lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
      lastReconciliationAt: "2026-08-13T06:00:00.000Z"
    },
    runSync: async () => activeSync
  });

  harness.scheduler.start({ ready });
  await nextTick();
  assert.equal(harness.syncCalls.length, 0);

  readyResolve();
  await nextTick();
  assert.equal(harness.syncCalls.length, 1);

  const duplicateAttempt = await harness.scheduler.runDueCheck("duplicate");
  assert.equal(duplicateAttempt.ran, false);
  assert.equal(duplicateAttempt.reason, "active_sync");

  resolveSync();
  await nextTick();
});

test("scheduler chooses reconciliation when the bounded reconcile window is overdue", async () => {
  const harness = createHarness({
    state: {
      lastSuccessfulSyncAt: "2026-08-13T08:30:00.000Z",
      lastReconciliationAt: "2026-08-01T08:30:00.000Z"
    }
  });

  harness.scheduler.start({ ready: Promise.resolve() });
  await nextTick();

  assert.equal(harness.syncCalls.length, 1);
  assert.equal(harness.syncCalls[0].requestMode, "reconcile");
  assert.equal(harness.syncCalls[0].maxPages, 5);
});

test("refresh lease allows one owner, expires cleanly, and releases on completion", async () => {
  let nowMs = Date.parse("2026-08-13T12:00:00.000Z");
  const storage = createMemoryStorage();
  const first = createRefreshLease({
    storage,
    ownerId: "tab-1",
    nowImpl: () => nowMs
  });
  const second = createRefreshLease({
    storage,
    ownerId: "tab-2",
    nowImpl: () => nowMs
  });

  const acquiredFirst = await first.acquire();
  assert.equal(acquiredFirst.acquired, true);

  const blockedSecond = await second.acquire();
  assert.equal(blockedSecond.acquired, false);

  nowMs += 3 * 60 * 1000;
  const recoveredSecond = await second.acquire();
  assert.equal(recoveredSecond.acquired, true);

  await second.release();
  const recoveredFirst = await first.acquire();
  assert.equal(recoveredFirst.acquired, true);
});

test("BDNS overdue refresh triggers one automatic bounded request without PLACSP cursor semantics", async () => {
  const harness = createHarness({
    connector: "bdns",
    state: {
      lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
      lastReconciliationAt: "2026-08-13T07:00:00.000Z"
    },
    buildSyncRequest: ({ reconciliationDue }) =>
      reconciliationDue
        ? {
            requestMode: "reconcile",
            runMode: "automatic",
            pages: 3,
            pageSize: 50
          }
        : {
            requestMode: "automatic",
            runMode: "automatic",
            pages: 1,
            pageSize: 20
          }
  });

  harness.scheduler.start({ ready: Promise.resolve() });
  await nextTick();

  assert.equal(harness.syncCalls.length, 1);
  assert.deepEqual(harness.syncCalls[0], {
    requestMode: "automatic",
    runMode: "automatic",
    pages: 1,
    pageSize: 20,
    reason: "startup"
  });
});

test("BDNS scheduler chooses recent reconciliation with bounded 3x50 discovery window", async () => {
  const harness = createHarness({
    connector: "bdns",
    state: {
      lastSuccessfulSyncAt: "2026-08-13T08:30:00.000Z",
      lastReconciliationAt: "2026-08-01T08:30:00.000Z"
    },
    buildSyncRequest: ({ reconciliationDue }) =>
      reconciliationDue
        ? {
            requestMode: "reconcile",
            runMode: "automatic",
            pages: 3,
            pageSize: 50
          }
        : {
            requestMode: "automatic",
            runMode: "automatic",
            pages: 1,
            pageSize: 20
          }
  });

  harness.scheduler.start({ ready: Promise.resolve() });
  await nextTick();

  assert.equal(harness.syncCalls.length, 1);
  assert.equal(harness.syncCalls[0].requestMode, "reconcile");
  assert.equal(harness.syncCalls[0].runMode, "automatic");
  assert.equal(harness.syncCalls[0].pages, 3);
  assert.equal(harness.syncCalls[0].pageSize, 50);
});

test("active PLACSP lease does not block BDNS refresh and active BDNS lease does not block PLACSP refresh", async () => {
  const previousLocalStorage = globalThis.localStorage;
  const storage = createMemoryStorage();
  globalThis.localStorage = storage;

  try {
    const placsp = createHarness({
      connector: "placsp",
      state: {
        lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
        lastReconciliationAt: "2026-08-13T07:00:00.000Z"
      },
      lease: null
    });
    const bdns = createHarness({
      connector: "bdns",
      state: {
        lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
        lastReconciliationAt: "2026-08-13T07:00:00.000Z"
      },
      buildSyncRequest: () => ({
        requestMode: "automatic",
        runMode: "automatic",
        pages: 1,
        pageSize: 20
      }),
      lease: null
    });

    const placspLease = createRefreshLease({
      key: getRefreshLeaseKey("placsp"),
      storage,
      ownerId: "placsp-tab",
      nowImpl: () => Date.parse("2026-08-13T12:00:00.000Z")
    });
    const bdnsLease = createRefreshLease({
      key: getRefreshLeaseKey("bdns"),
      storage,
      ownerId: "bdns-tab",
      nowImpl: () => Date.parse("2026-08-13T12:00:00.000Z")
    });

    assert.equal((await placspLease.acquire()).acquired, true);
    bdns.scheduler.start({ ready: Promise.resolve() });
    await nextTick();
    assert.equal(bdns.syncCalls.length, 1);

    await placspLease.release();
    assert.equal((await bdnsLease.acquire()).acquired, true);
    placsp.scheduler.start({ ready: Promise.resolve() });
    await nextTick();
    assert.equal(placsp.syncCalls.length, 1);
  } finally {
    globalThis.localStorage = previousLocalStorage;
  }
});

test("two BDNS tabs contend for the same BDNS lease and only one runs", async () => {
  const previousLocalStorage = globalThis.localStorage;
  const storage = createMemoryStorage();
  globalThis.localStorage = storage;

  try {
    const first = createHarness({
      connector: "bdns",
      state: {
        lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
        lastReconciliationAt: "2026-08-13T07:00:00.000Z"
      },
      buildSyncRequest: () => ({
        requestMode: "automatic",
        runMode: "automatic",
        pages: 1,
        pageSize: 20
      }),
      lease: null
    });
    const second = createHarness({
      connector: "bdns",
      state: {
        lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
        lastReconciliationAt: "2026-08-13T07:00:00.000Z"
      },
      buildSyncRequest: () => ({
        requestMode: "automatic",
        runMode: "automatic",
        pages: 1,
        pageSize: 20
      }),
      lease: null
    });

    let releaseFirst;
    first.scheduler = createConnectorRefreshScheduler({
      connector: "bdns",
      sourceCache: {
        async getConnectorState() {
          return {
            ok: true,
            state: createConnectorState("bdns", {
              lastSuccessfulSyncAt: "2026-08-12T00:00:00.000Z",
              lastReconciliationAt: "2026-08-13T07:00:00.000Z"
            })
          };
        }
      },
      nowImpl: () => new Date("2026-08-13T12:00:00.000Z"),
      buildSyncRequest: () => ({
        requestMode: "automatic",
        runMode: "automatic",
        pages: 1,
        pageSize: 20
      }),
      runSync: async (request) => {
        first.syncCalls.push(request);
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
    });

    first.scheduler.start({ ready: Promise.resolve() });
    await nextTick();

    second.scheduler.start({ ready: Promise.resolve() });
    await nextTick();
    const secondResult = await second.scheduler.runDueCheck("manual");

    assert.equal(first.syncCalls.length, 1);
    assert.equal(second.syncCalls.length, 0);
    assert.equal(secondResult.ran, false);
    assert.equal(secondResult.reason, "lease_busy");

    releaseFirst();
    await nextTick();
  } finally {
    globalThis.localStorage = previousLocalStorage;
  }
});
