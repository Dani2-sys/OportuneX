import test from "node:test";
import assert from "node:assert/strict";

import {
  createConnectorRefreshScheduler,
  createRefreshLease
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
  state = {},
  now = "2026-08-13T12:00:00.000Z",
  isSyncActive = () => false,
  runSync = async () => {}
} = {}) {
  let connectorState = createConnectorState("placsp", state);
  const syncCalls = [];
  const timerApi = createTimerApi();
  const visibilityApi = createVisibilityApi(true);
  const networkApi = createNetworkApi(true);
  const storage = createMemoryStorage();
  const scheduler = createConnectorRefreshScheduler({
    connector: "placsp",
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
    lease: createRefreshLease({
      storage,
      nowImpl: () => Date.parse(now)
    })
  });

  return {
    scheduler,
    syncCalls,
    timerApi,
    visibilityApi,
    networkApi,
    setState(nextState) {
      connectorState = createConnectorState("placsp", {
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
