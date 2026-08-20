import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { startApp } from "../src/app.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import {
  createConnectorState,
  createInMemorySourceCacheAdapter,
  createSourceOpportunityCache
} from "../src/services/source-opportunity-cache.js";
import { createStore } from "../src/state/store.js";
import { parsePlacspAtom } from "../scripts/connectors/placsp-parser.mjs";
import {
  deterministicPlacspOpportunityId,
  normalizePlacspDataset
} from "../src/connectors/placsp-normalizer.js";

async function fixture(name) {
  return readFile(new URL(`./fixtures/placsp/${name}`, import.meta.url), "utf8");
}

async function syncPayload(name, fetchedAt = "2026-08-12T10:00:00.000Z") {
  const parsed = parsePlacspAtom(await fixture(name), {
    sourceUrl: "https://contrataciondelsectorpublico.gob.es/sindicacion/test.atom"
  });
  const normalized = normalizePlacspDataset({
    feed: parsed.feed,
    entries: parsed.entries,
    deletedEntries: parsed.deletedEntries,
    fetchedAt
  });

  return {
    connector: "placsp",
    mode: "manual",
    startedAt: fetchedAt,
    completedAt: fetchedAt,
    fetchedAt,
    feedUpdated: parsed.feed.updated,
    sourceFeedUpdated: parsed.feed.updated,
    previousFeedUpdated: null,
    previousEntryWatermark: null,
    nextEntryWatermark: parsed.entries[0]?.updated ?? null,
    feedChanged: true,
    cursorReached: null,
    truncated: false,
    truncationReason: null,
    pagesFetched: 1,
    entriesSeen: parsed.entries.length,
    uniqueEntries: normalized.stats.uniqueEntries,
    tombstonesSeen: parsed.deletedEntries.length,
    parserErrors: parsed.entryErrors,
    opportunities: normalized.opportunities,
    tombstones: normalized.tombstones
  };
}

function createMockStorageAdapter() {
  let raw = null;
  return {
    load() {
      return { ok: true, value: raw };
    },
    save(snapshot) {
      raw = JSON.stringify(snapshot);
      return { ok: true };
    }
  };
}

function createRoot() {
  const listeners = new Map();
  let html = "";
  const root = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event) {
      const handler = listeners.get(type);
      if (handler) return handler(event);
      return undefined;
    }
  };
  Object.defineProperty(root, "innerHTML", {
    get() {
      return html;
    },
    set(value) {
      html = value;
    }
  });
  return root;
}

function createActionTarget(dataset) {
  return {
    closest(selector) {
      if (selector === "[data-action]") return { dataset };
      return null;
    }
  };
}

function clickAction(root, dataset) {
  return root.dispatch("click", {
    preventDefault() {},
    target: createActionTarget(dataset)
  });
}

async function nextTick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("PLACSP sync inserts new opportunities and identical re-syncs remain unchanged without duplicates", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const payload = await syncPayload("open-tender.atom.xml");
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        async runPlacspSync() {
          return payload;
        }
      }
    });

    await clickAction(root, { action: "sync-placsp" });

    const opportunityId = payload.opportunities[0].id;
    assert.equal(store.getState().opportunities.filter((item) => item.id === opportunityId).length, 1);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesInserted, 1);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesUpdated, 0);
    assert.equal(store.getState().sourceSyncRuns[0].unchanged, 0);

    await clickAction(root, { action: "sync-placsp" });

    assert.equal(store.getState().opportunities.filter((item) => item.id === opportunityId).length, 1);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesInserted, 0);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesUpdated, 0);
    assert.equal(store.getState().sourceSyncRuns[0].unchanged, 1);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("PLACSP tombstones patch existing local source records without deleting them", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const payload = await syncPayload("awarded-and-tombstones.atom.xml");
    const state = createDemoState();
    state.opportunities.unshift({
      id: deterministicPlacspOpportunityId("https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/entry-cancelled-001"),
      sourceOpportunityId: "https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/entry-cancelled-001",
      sourceNoticeVersionId: "placsp-version:seed",
      type: "contract",
      noticeType: "active_contract_notice",
      status: "open",
      title: "Previously imported cancelled tender",
      description: "Existing local copy",
      location: { display: "Tarragona" },
      cpvCodes: [],
      keywords: [],
      relevantValue: null,
      estimatedValue: null,
      baseBudget: null,
      wholeProcedureValue: null,
      annualValue: null,
      multiYearValue: null,
      maximumAidPerBeneficiary: null,
      programmeBudget: null,
      eligibleProjectCost: null,
      aidIntensity: "",
      duration: "",
      guarantees: "",
      submissionMechanism: "",
      applicationUrl: "",
      noticeUrl: "",
      referenceNumber: "REF-SEED-CANCELLED",
      requiredDocuments: [],
      documents: [],
      contacts: [],
      sources: [],
      evidence: [],
      requirements: [],
      lots: [],
      lastChecked: null
    });

    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    store.replace(state);
    const root = createRoot();

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        async runPlacspSync() {
          return payload;
        }
      }
    });

    await clickAction(root, { action: "sync-placsp" });

    const cancelled = store.getState().opportunities.find(
      (item) =>
        item.id ===
        deterministicPlacspOpportunityId("https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/entry-cancelled-001")
    );

    assert.ok(cancelled);
    assert.equal(cancelled.title, "Previously imported cancelled tender");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancellationStatus, "anulada");
  } finally {
    globalThis.window = previousWindow;
  }
});

test("PLACSP sync still succeeds in memory when source cache persistence is unavailable", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const payload = await syncPayload("open-tender.atom.xml");
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    const sourceCache = createSourceOpportunityCache({
      adapter: {
        kind: "indexeddb",
        async loadByConnector() {
          return {
            ok: false,
            code: "SOURCE_CACHE_UNAVAILABLE",
            message: "IndexedDB unavailable"
          };
        },
        async upsertMany() {
          return {
            ok: false,
            code: "SOURCE_CACHE_UNAVAILABLE",
            message: "IndexedDB unavailable"
          };
        },
        async count() {
          return {
            ok: false,
            code: "SOURCE_CACHE_UNAVAILABLE",
            message: "IndexedDB unavailable"
          };
        },
        async clearConnector() {
          return { ok: true };
        },
        async getConnectorState() {
          return {
            ok: true,
            state: createConnectorState("placsp", {
              autoRefreshEnabled: false
            })
          };
        },
        async setConnectorState(_connector, state) {
          return {
            ok: true,
            state
          };
        }
      }
    });

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        async runPlacspSync() {
          return payload;
        }
      }
    });

    await clickAction(root, { action: "sync-placsp" });

    const opportunityId = payload.opportunities[0].id;
    assert.equal(store.getState().opportunities.filter((item) => item.id === opportunityId).length, 1);
    assert.match(root.innerHTML, /Source cache persistence is unavailable/i);
    assert.equal(sourceCache.getStatus().status, "unavailable");
  } finally {
    globalThis.window = previousWindow;
  }
});

test("automatic PLACSP refresh waits for hydration, records automatic timestamps, and never calls AI", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const payload = await syncPayload("open-tender.atom.xml", "2026-08-13T10:00:00.000Z");
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    const loadResolvers = [];
    const syncCalls = [];
    let aiCalls = 0;
    const nowMs = Date.now();
    let connectorState = createConnectorState("placsp", {
      lastSuccessfulSyncAt: new Date(nowMs - 13 * 60 * 60 * 1000).toISOString(),
      lastFeedUpdated: new Date(nowMs - 13 * 60 * 60 * 1000).toISOString(),
      entryUpdatedWatermark: new Date(nowMs - 13 * 60 * 60 * 1000).toISOString(),
      lastReconciliationAt: new Date(nowMs - 6 * 24 * 60 * 60 * 1000).toISOString(),
      autoRefreshEnabled: true
    });
    const sourceCache = createSourceOpportunityCache({
      adapter: {
        kind: "memory_test",
        async loadByConnector() {
          await new Promise((resolve) => {
            loadResolvers.push(resolve);
          });
          return {
            ok: true,
            records: []
          };
        },
        async upsertMany() {
          return { ok: true };
        },
        async count() {
          return { ok: true, count: 0 };
        },
        async clearConnector() {
          return { ok: true };
        },
        async getConnectorState() {
          return {
            ok: true,
            state: connectorState
          };
        },
        async setConnectorState(_connector, state) {
          connectorState = state;
          return {
            ok: true,
            state
          };
        }
      }
    });

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        async runPlacspSync(request) {
          syncCalls.push(request);
          return {
            ...payload,
            mode: request.mode,
            cursorReached: true,
            truncated: false,
            truncationReason: null,
            previousFeedUpdated: connectorState.lastFeedUpdated,
            previousEntryWatermark: connectorState.entryUpdatedWatermark
          };
        },
        async runAiVerification() {
          aiCalls += 1;
          throw new Error("AI should never run during automatic PLACSP refresh.");
        }
      }
    });

    await nextTick();
    assert.equal(syncCalls.length, 0);

    loadResolvers.splice(0).forEach((resolve) => resolve());
    await nextTick();
    await nextTick();

    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].mode, "incremental");
    assert.equal(aiCalls, 0);

    const persistedState = await sourceCache.getConnectorState("placsp");
    assert.equal(persistedState.state.lastRunMode, "automatic");
    assert.equal(persistedState.state.lastAutomaticSyncAt, payload.completedAt);
    assert.equal(
      persistedState.state.lastFeedUpdated,
      new Date(Date.parse(payload.sourceFeedUpdated)).toISOString()
    );
    assert.equal(
      persistedState.state.entryUpdatedWatermark,
      new Date(Date.parse(payload.nextEntryWatermark)).toISOString()
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("failed PLACSP sync does not advance the stored incremental cursor", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    const sourceCache = createSourceOpportunityCache({
      adapter: createInMemorySourceCacheAdapter({
        connectorStates: {
          placsp: createConnectorState("placsp", {
            lastSuccessfulSyncAt: "2026-08-13T07:00:00.000Z",
            lastFeedUpdated: "2026-08-13T06:30:00.000Z",
            entryUpdatedWatermark: "2026-08-13T06:00:00.000Z",
            autoRefreshEnabled: false
          })
        }
      })
    });

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        async runPlacspSync() {
          const error = new Error("PLACSP timeout");
          error.code = "placsp_timeout";
          throw error;
        }
      }
    });

    await nextTick();
    await clickAction(root, { action: "sync-placsp" });

    const persistedState = await sourceCache.getConnectorState("placsp");
    assert.equal(persistedState.state.lastFeedUpdated, "2026-08-13T06:30:00.000Z");
    assert.equal(persistedState.state.entryUpdatedWatermark, "2026-08-13T06:00:00.000Z");
    assert.equal(persistedState.state.lastErrorCode, "placsp_timeout");
  } finally {
    globalThis.window = previousWindow;
  }
});

test("truncated incremental sync keeps the prior authoritative cursor until a later complete retry succeeds", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const previousFeedUpdated = "2026-08-12T08:00:00.000Z";
    const previousWatermark = "2026-08-12T07:30:00.000Z";
    const nextFeedUpdated = "2026-08-13T10:00:00.000Z";
    const nextWatermark = "2026-08-13T09:45:00.000Z";
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    const requests = [];
    let connectorState = createConnectorState("placsp", {
      lastSuccessfulSyncAt: "2026-08-12T08:00:00.000Z",
      lastFeedUpdated: previousFeedUpdated,
      entryUpdatedWatermark: previousWatermark,
      autoRefreshEnabled: false
    });
    const sourceCache = createSourceOpportunityCache({
      adapter: {
        kind: "memory_test",
        async loadByConnector() {
          return {
            ok: true,
            records: []
          };
        },
        async upsertMany() {
          return { ok: true };
        },
        async count() {
          return { ok: true, count: 0 };
        },
        async clearConnector() {
          return { ok: true };
        },
        async getConnectorState() {
          return {
            ok: true,
            state: connectorState
          };
        },
        async setConnectorState(_connector, state) {
          connectorState = state;
          return {
            ok: true,
            state
          };
        }
      }
    });
    const payloads = [
      {
        connector: "placsp",
        mode: "incremental",
        startedAt: "2026-08-13T10:00:00.000Z",
        completedAt: "2026-08-13T10:00:00.000Z",
        fetchedAt: "2026-08-13T10:00:00.000Z",
        feedUpdated: nextFeedUpdated,
        sourceFeedUpdated: nextFeedUpdated,
        previousFeedUpdated,
        previousEntryWatermark: previousWatermark,
        nextEntryWatermark: nextWatermark,
        feedChanged: true,
        cursorReached: false,
        truncated: true,
        truncationReason: "safety_limit",
        pagesFetched: 2,
        entriesSeen: 0,
        uniqueEntries: 0,
        tombstonesSeen: 0,
        parserErrors: [],
        opportunities: [],
        tombstones: []
      },
      {
        connector: "placsp",
        mode: "incremental",
        startedAt: "2026-08-13T10:15:00.000Z",
        completedAt: "2026-08-13T10:15:00.000Z",
        fetchedAt: "2026-08-13T10:15:00.000Z",
        feedUpdated: nextFeedUpdated,
        sourceFeedUpdated: nextFeedUpdated,
        previousFeedUpdated,
        previousEntryWatermark: previousWatermark,
        nextEntryWatermark: nextWatermark,
        feedChanged: true,
        cursorReached: true,
        truncated: false,
        truncationReason: null,
        pagesFetched: 3,
        entriesSeen: 0,
        uniqueEntries: 0,
        tombstonesSeen: 0,
        parserErrors: [],
        opportunities: [],
        tombstones: []
      }
    ];

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        async runPlacspSync(request) {
          requests.push(request);
          return payloads.shift();
        }
      }
    });

    await nextTick();
    await clickAction(root, { action: "sync-placsp" });

    let persistedState = await sourceCache.getConnectorState("placsp");
    assert.deepEqual(requests[0].cursor, {
      lastFeedUpdated: previousFeedUpdated,
      entryUpdatedWatermark: previousWatermark
    });
    assert.equal(persistedState.state.lastFeedUpdated, previousFeedUpdated);
    assert.equal(persistedState.state.entryUpdatedWatermark, previousWatermark);

    await clickAction(root, { action: "sync-placsp" });

    persistedState = await sourceCache.getConnectorState("placsp");
    assert.deepEqual(requests[1].cursor, {
      lastFeedUpdated: previousFeedUpdated,
      entryUpdatedWatermark: previousWatermark
    });
    assert.equal(persistedState.state.lastFeedUpdated, nextFeedUpdated);
    assert.equal(persistedState.state.entryUpdatedWatermark, nextWatermark);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("legacy Phase 0.4 sync history does not fabricate an incremental cursor before bootstrap", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    store.update((draft) => {
      draft.sourceSyncRuns.unshift({
        id: "legacy-placsp-run",
        connector: "placsp",
        source: "PLACSP",
        mode: "manual",
        completedAt: "2026-08-12T08:00:00.000Z",
        sourceFeedUpdated: "2026-08-12T07:30:00.000Z",
        nextEntryWatermark: "2026-08-12T07:15:00.000Z",
        pagesFetched: 1
      });
    });

    const root = createRoot();
    const requests = [];
    const sourceCache = createSourceOpportunityCache({
      adapter: createInMemorySourceCacheAdapter({
        connectorStates: {
          placsp: createConnectorState("placsp", {
            autoRefreshEnabled: false
          })
        }
      })
    });

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        async runPlacspSync(request) {
          requests.push(request);
          return await syncPayload("open-tender.atom.xml");
        }
      }
    });

    await nextTick();

    const persistedState = await sourceCache.getConnectorState("placsp");
    assert.equal(persistedState.state.lastFeedUpdated, null);
    assert.equal(persistedState.state.entryUpdatedWatermark, null);

    await clickAction(root, { action: "sync-placsp" });

    assert.equal(requests[0].mode, "manual");
    assert.equal(requests[0].cursor, null);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("first automatic refresh without a persisted cursor bootstraps with reconciliation and never calls AI", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const payload = {
      ...(await syncPayload("open-tender.atom.xml", "2026-08-13T10:00:00.000Z")),
      mode: "reconcile",
      truncated: true,
      truncationReason: "page_limit",
      pagesFetched: 2
    };
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    store.update((draft) => {
      draft.sourceSyncRuns.unshift({
        id: "legacy-placsp-run",
        connector: "placsp",
        source: "PLACSP",
        mode: "manual",
        completedAt: "2026-08-12T08:00:00.000Z",
        sourceFeedUpdated: "2026-08-12T07:30:00.000Z",
        nextEntryWatermark: "2026-08-12T07:15:00.000Z",
        pagesFetched: 1
      });
    });

    const root = createRoot();
    const requests = [];
    let aiCalls = 0;
    let connectorState = createConnectorState("placsp", {
      autoRefreshEnabled: true
    });
    const sourceCache = createSourceOpportunityCache({
      adapter: {
        kind: "memory_test",
        async loadByConnector() {
          return {
            ok: true,
            records: []
          };
        },
        async upsertMany() {
          return { ok: true };
        },
        async count() {
          return { ok: true, count: 0 };
        },
        async clearConnector() {
          return { ok: true };
        },
        async getConnectorState() {
          return {
            ok: true,
            state: connectorState
          };
        },
        async setConnectorState(_connector, state) {
          connectorState = state;
          return {
            ok: true,
            state
          };
        }
      }
    });

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        async runPlacspSync(request) {
          requests.push(request);
          return {
            ...payload,
            mode: request.mode
          };
        },
        async runAiVerification() {
          aiCalls += 1;
          throw new Error("AI should never run during bootstrap reconciliation.");
        }
      }
    });

    await nextTick();
    await nextTick();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].mode, "reconcile");
    assert.equal(aiCalls, 0);

    const persistedState = await sourceCache.getConnectorState("placsp");
    assert.equal(persistedState.state.lastReconciliationAt, payload.completedAt);
    assert.equal(
      persistedState.state.lastFeedUpdated,
      new Date(Date.parse(payload.sourceFeedUpdated)).toISOString()
    );
    assert.equal(
      persistedState.state.entryUpdatedWatermark,
      new Date(Date.parse(payload.nextEntryWatermark)).toISOString()
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("older PLACSP entries cannot resurrect a newer tombstoned record", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const tombstonePayload = await syncPayload("awarded-and-tombstones.atom.xml");
    const tombstonedSourceOpportunityId =
      "https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/entry-cancelled-001";
    const tombstonedId = deterministicPlacspOpportunityId(tombstonedSourceOpportunityId);
    const olderEntryPayload = {
      connector: "placsp",
      mode: "incremental",
      startedAt: "2026-08-13T11:00:00.000Z",
      completedAt: "2026-08-13T11:00:00.000Z",
      fetchedAt: "2026-08-13T11:00:00.000Z",
      feedUpdated: "2026-08-13T11:00:00.000Z",
      sourceFeedUpdated: "2026-08-13T11:00:00.000Z",
      previousFeedUpdated: "2026-08-13T10:30:00.000Z",
      previousEntryWatermark: "2026-08-13T10:00:00.000Z",
      nextEntryWatermark: "2026-08-12T08:00:00.000Z",
      feedChanged: true,
      cursorReached: true,
      truncated: false,
      truncationReason: null,
      pagesFetched: 1,
      entriesSeen: 1,
      uniqueEntries: 1,
      tombstonesSeen: 0,
      parserErrors: [],
      opportunities: [
        {
          id: tombstonedId,
          sourceConnector: "placsp",
          sourceOpportunityId: tombstonedSourceOpportunityId,
          sourceNoticeVersionId: "placsp-version:older-entry",
          type: "contract",
          noticeType: "active_contract_notice",
          status: "open",
          title: "Older reopened entry",
          description: "Older semantic copy",
          location: { display: "Tarragona" },
          cpvCodes: [],
          keywords: [],
          relevantValue: null,
          estimatedValue: null,
          baseBudget: null,
          wholeProcedureValue: null,
          annualValue: null,
          multiYearValue: null,
          maximumAidPerBeneficiary: null,
          programmeBudget: null,
          eligibleProjectCost: null,
          aidIntensity: "",
          duration: "",
          guarantees: "",
          submissionMechanism: "",
          applicationUrl: "",
          noticeUrl: "",
          referenceNumber: "REF-OLDER-CANCELLED",
          requiredDocuments: [],
          documents: [],
          contacts: [],
          sources: [
            {
              id: "source-older-entry",
              organisation: "Plataforma de Contratacion del Sector Publico",
              title: "Official PLACSP ATOM feed",
              official: true,
              metadata: {
                sourceType: "official_open_data_atom",
                atomUpdated: "2026-08-12T08:00:00.000Z"
              }
            }
          ],
          evidence: [],
          requirements: [],
          lots: [],
          lastChecked: "2026-08-13T11:00:00.000Z"
        }
      ],
      tombstones: []
    };

    const state = createDemoState();
    state.opportunities.unshift({
      id: tombstonedId,
      sourceConnector: "placsp",
      sourceOpportunityId: tombstonedSourceOpportunityId,
      sourceNoticeVersionId: "placsp-version:seed",
      type: "contract",
      noticeType: "active_contract_notice",
      status: "open",
      title: "Previously imported cancelled tender",
      description: "Existing local copy",
      location: { display: "Tarragona" },
      cpvCodes: [],
      keywords: [],
      relevantValue: null,
      estimatedValue: null,
      baseBudget: null,
      wholeProcedureValue: null,
      annualValue: null,
      multiYearValue: null,
      maximumAidPerBeneficiary: null,
      programmeBudget: null,
      eligibleProjectCost: null,
      aidIntensity: "",
      duration: "",
      guarantees: "",
      submissionMechanism: "",
      applicationUrl: "",
      noticeUrl: "",
      referenceNumber: "REF-SEED-CANCELLED",
      requiredDocuments: [],
      documents: [],
      contacts: [],
      sources: [
        {
          id: "source-seed-entry",
          organisation: "Plataforma de Contratacion del Sector Publico",
          title: "Official PLACSP ATOM feed",
          official: true,
          metadata: {
            sourceType: "official_open_data_atom",
            atomUpdated: "2026-08-12T07:00:00.000Z"
          }
        }
      ],
      evidence: [],
      requirements: [],
      lots: [],
      lastChecked: null
    });

    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    store.replace(state);
    const root = createRoot();
    let callCount = 0;

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        async runPlacspSync() {
          callCount += 1;
          return callCount === 1 ? tombstonePayload : olderEntryPayload;
        }
      }
    });

    await clickAction(root, { action: "sync-placsp" });
    await clickAction(root, { action: "sync-placsp" });

    const finalRecord = store.getState().opportunities.find((item) => item.id === tombstonedId);
    assert.ok(finalRecord);
    assert.equal(finalRecord.status, "cancelled");
    assert.equal(finalRecord.cancellationStatus, "anulada");
    assert.notEqual(finalRecord.sourceNoticeVersionId, "placsp-version:older-entry");
  } finally {
    globalThis.window = previousWindow;
  }
});

test("manual reconciliation records the reconciliation timestamp and requested page window", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const payload = await syncPayload("open-tender.atom.xml", "2026-08-13T11:00:00.000Z");
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    const requests = [];
    const sourceCache = createSourceOpportunityCache({
      adapter: createInMemorySourceCacheAdapter({
        connectorStates: {
          placsp: createConnectorState("placsp", {
            autoRefreshEnabled: false
          })
        }
      })
    });

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        async runPlacspSync(request) {
          requests.push(request);
          return {
            ...payload,
            mode: request.mode
          };
        }
      }
    });

    await nextTick();
    root.dispatch("change", {
      target: {
        dataset: {
          control: "placsp-pages"
        },
        value: "2"
      }
    });

    await clickAction(root, { action: "sync-placsp-reconcile" });

    assert.equal(requests[0].mode, "reconcile");
    assert.equal(requests[0].maxPages, 2);
    const persistedState = await sourceCache.getConnectorState("placsp");
    assert.equal(persistedState.state.lastRunMode, "reconcile");
    assert.equal(persistedState.state.lastReconciliationAt, payload.completedAt);
    assert.equal(persistedState.state.lastManualSyncAt, payload.completedAt);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("auto-refresh toggle survives a fresh app boot through connector state persistence", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const adapter = createInMemorySourceCacheAdapter({
      connectorStates: {
        placsp: createConnectorState("placsp", {
          autoRefreshEnabled: true,
          lastSuccessfulSyncAt: "2026-08-13T10:30:00.000Z",
          lastReconciliationAt: "2026-08-13T10:30:00.000Z"
        })
      }
    });
    const sourceCache = createSourceOpportunityCache({ adapter });

    const firstRoot = createRoot();
    const firstStore = createStore({ storageAdapter: createMockStorageAdapter() });
    startApp(firstRoot, {
      runtime: DEFAULT_RUNTIME,
      store: firstStore,
      services: {
        sourceCache
      }
    });

    await nextTick();
    await clickAction(firstRoot, { action: "route", route: "sources" });
    await clickAction(firstRoot, { action: "toggle-placsp-auto-refresh" });

    const persistedAfterToggle = await sourceCache.getConnectorState("placsp");
    assert.equal(persistedAfterToggle.state.autoRefreshEnabled, false);

    const secondRoot = createRoot();
    const secondStore = createStore({ storageAdapter: createMockStorageAdapter() });
    startApp(secondRoot, {
      runtime: DEFAULT_RUNTIME,
      store: secondStore,
      services: {
        sourceCache
      }
    });

    await clickAction(secondRoot, { action: "route", route: "sources" });
    await nextTick();
    assert.match(secondRoot.innerHTML, /Automatic refresh OFF/i);
  } finally {
    globalThis.window = previousWindow;
  }
});
