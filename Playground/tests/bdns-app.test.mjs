import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { startApp } from "../src/app.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { getEvaluationNow } from "../src/clock.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import { createAiVerificationContextFingerprint } from "../src/domain/ai-review.js";
import { normalizeBdnsDataset, normalizeBdnsOpportunity } from "../src/connectors/bdns-normalizer.js";
import {
  createInMemorySourceCacheAdapter,
  createSourceOpportunityCache
} from "../src/services/source-opportunity-cache.js";
import { createStore } from "../src/state/store.js";

async function loadCatalog() {
  return JSON.parse(
    await readFile(new URL("./fixtures/bdns/details-catalog.json", import.meta.url), "utf8")
  );
}

function createMockStorageAdapter({ initialRaw = null } = {}) {
  let raw = initialRaw;
  return {
    load() {
      return { ok: true, value: raw };
    },
    save(snapshot) {
      raw = JSON.stringify(snapshot);
      return { ok: true };
    },
    readRaw() {
      return raw;
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

function makePlacspOpportunity(index, overrides = {}) {
  return {
    id: overrides.id ?? `placsp:test-${index}`,
    sourceConnector: "placsp",
    sourceOpportunityId: overrides.sourceOpportunityId ?? `https://contrataciondelestado.es/sindicacion/test-${index}`,
    sourceNoticeVersionId: overrides.sourceNoticeVersionId ?? `placsp-version:${index}`,
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: overrides.title ?? `PLACSP opportunity ${index}`,
    description: "Synthetic PLACSP source record for cache hydration tests.",
    location: { display: "Tarragona" },
    cpvCodes: ["50711000"],
    keywords: ["electrical"],
    estimatedValue: null,
    awardValue: null,
    baseBudget: null,
    relevantValue: null,
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
    noticeUrl: "https://contrataciondelestado.es/wps/poc?uri=test",
    referenceNumber: `REF-${index}`,
    requiredDocuments: [],
    documents: [],
    contacts: [],
    sources: [
      {
        id: `src-placsp-${index}`,
        organisation: "Plataforma de Contratacion del Sector Publico",
        title: "Official PLACSP ATOM feed",
        url: "https://contrataciondelsectorpublico.gob.es/sindicacion/test.atom",
        official: true,
        metadata: {
          sourceType: "official_open_data_atom"
        }
      }
    ],
    evidence: [],
    requirements: [],
    lots: [],
    sourceConflicts: [],
    availabilityWarnings: [],
    cancellationStatus: null,
    ...overrides
  };
}

async function bdnsSyncPayload(names, catalog, fetchedAt = "2026-08-13T10:00:00.000Z") {
  const details = names.map((name) => catalog[name]);
  const normalized = normalizeBdnsDataset({
    details,
    fetchedAt,
    now: new Date(fetchedAt)
  });
  return {
    connector: "bdns",
    mode: "manual",
    startedAt: fetchedAt,
    completedAt: fetchedAt,
    fetchedAt,
    pagesFetched: 1,
    pageSize: 20,
    discoveryCount: details.length,
    uniqueCodes: new Set(details.map((item) => item.codigoBDNS)).size,
    detailsRequested: details.length,
    detailsFetched: details.length,
    detailFailures: [],
    truncated: false,
    truncationReason: null,
    opportunities: normalized.opportunities,
    stats: normalized.stats
  };
}

const TEN_RECORD_BDNS_FIXTURE_NAMES = [
  "normalSmeGrant",
  "fixedWindow",
  "expiredWindow",
  "indefiniteOpen",
  "futureDeadlineAbiertoFalse",
  "descriptiveTextFin",
  "programmeBudgetOnly",
  "multipleBeneficiaryTypes",
  "multipleImpactRegions",
  "sectorCoded"
];

test("BDNS sync inserts new grants, keeps identical re-syncs unchanged, and updates a corrected semantic version once", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const catalog = await loadCatalog();
    const payloads = [
      await bdnsSyncPayload(["normalSmeGrant", "fixedWindow"], catalog),
      await bdnsSyncPayload(["normalSmeGrant", "fixedWindow"], catalog),
      await bdnsSyncPayload(["correctedSemantics", "fixedWindow"], catalog)
    ];
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const sourceCache = createSourceOpportunityCache({
      adapter: createInMemorySourceCacheAdapter()
    });
    const root = createRoot();

    const app = startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        refreshScheduler: {
          start() {},
          getNextAutomaticRefreshAt() {
            return "2026-08-14T00:00:00.000Z";
          }
        },
        async runBdnsSync() {
          return payloads.shift();
        }
      }
    });

    await app.whenSourceCacheReady();

    await clickAction(root, { action: "sync-bdns" });
    assert.equal(store.getState().opportunities.filter((item) => item.sourceConnector === "bdns").length, 2);
    assert.equal(store.getState().sourceSyncRuns[0].connector, "bdns");
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesInserted, 2);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesUpdated, 0);
    assert.equal(store.getState().sourceSyncRuns[0].unchanged, 0);

    await clickAction(root, { action: "sync-bdns" });
    assert.equal(store.getState().opportunities.filter((item) => item.sourceConnector === "bdns").length, 2);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesInserted, 0);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesUpdated, 0);
    assert.equal(store.getState().sourceSyncRuns[0].unchanged, 2);

    await clickAction(root, { action: "sync-bdns" });
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesInserted, 0);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesUpdated, 1);
    assert.equal(store.getState().sourceSyncRuns[0].unchanged, 1);
    assert.match(
      store.getState().opportunities.find((item) => item.sourceOpportunityId === "700001")?.title ?? "",
      /digitalizacion/i
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("BDNS app success path keeps a realistic 10-record sync healthy and identical re-syncs become unchanged", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const catalog = await loadCatalog();
    const firstPayload = await bdnsSyncPayload(TEN_RECORD_BDNS_FIXTURE_NAMES, catalog, "2026-08-13T10:00:00.000Z");
    const secondPayload = await bdnsSyncPayload(TEN_RECORD_BDNS_FIXTURE_NAMES, catalog, "2026-08-13T10:05:00.000Z");
    const storageAdapter = createMockStorageAdapter();
    const store = createStore({ storageAdapter });
    const baseAdapter = createInMemorySourceCacheAdapter();
    const cacheWrites = [];
    const sourceCache = createSourceOpportunityCache({
      adapter: {
        kind: baseAdapter.kind,
        async loadByConnector(connector) {
          return baseAdapter.loadByConnector(connector);
        },
        async upsertMany(connector, opportunities) {
          cacheWrites.push({
            connector,
            ids: opportunities.map((item) => item.id)
          });
          return baseAdapter.upsertMany(connector, opportunities);
        },
        async count(connector) {
          return baseAdapter.count(connector);
        },
        async clearConnector(connector) {
          return baseAdapter.clearConnector(connector);
        },
        async getConnectorState(connector) {
          return baseAdapter.getConnectorState(connector);
        },
        async setConnectorState(connector, state) {
          return baseAdapter.setConnectorState(connector, state);
        }
      }
    });
    const root = createRoot();
    const payloads = [firstPayload, secondPayload];
    const app = startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        refreshScheduler: {
          start() {},
          getNextAutomaticRefreshAt() {
            return "2026-08-14T00:00:00.000Z";
          }
        },
        async runBdnsSync() {
          return payloads.shift();
        }
      }
    });

    await app.whenSourceCacheReady();

    await clickAction(root, { action: "sync-bdns" });

    assert.equal(store.getState().sourceSyncRuns[0].status, "healthy");
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesInserted, 10);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesUpdated, 0);
    assert.equal(store.getState().sourceSyncRuns[0].unchanged, 0);
    assert.equal(store.getState().opportunities.filter((item) => item.sourceConnector === "bdns").length, 10);
    assert.equal(cacheWrites.length, 1);
    assert.equal(cacheWrites[0].connector, "bdns");
    assert.equal(cacheWrites[0].ids.length, 10);
    assert.equal((await sourceCache.count("bdns")).count, 10);
    assert.match(root.innerHTML, /BDNS \/ SNPSAP sync completed: 10 inserted, 0 updated, 0 unchanged\./);
    assert.doesNotMatch(root.innerHTML, /Sync failed/i);

    await clickAction(root, { action: "sync-bdns" });

    assert.equal(store.getState().sourceSyncRuns[0].status, "healthy");
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesInserted, 0);
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesUpdated, 0);
    assert.equal(store.getState().sourceSyncRuns[0].unchanged, 10);
    assert.equal(store.getState().opportunities.filter((item) => item.sourceConnector === "bdns").length, 10);
    assert.equal(cacheWrites.length, 2);
    assert.equal((await sourceCache.count("bdns")).count, 10);
    assert.match(root.innerHTML, /BDNS \/ SNPSAP sync completed: 0 inserted, 0 updated, 10 unchanged\./);
    assert.doesNotMatch(root.innerHTML, /Sync failed/i);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("BDNS cache hydrates on reload, coexists with PLACSP, preserves saved ids, and source updates stale saved AI reviews without auto-running AI", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const catalog = await loadCatalog();
    const oldBdnsOpportunity = normalizeBdnsOpportunity(catalog.normalSmeGrant, {
      fetchedAt: "2026-08-13T08:00:00.000Z",
      now: new Date("2026-08-13T08:00:00.000Z")
    });
    const updatedPayload = await bdnsSyncPayload(
      ["correctedSemantics"],
      catalog,
      "2026-08-13T11:00:00.000Z"
    );
    const placspOpportunity = makePlacspOpportunity(1, {
      id: "placsp:test-coexist",
      title: "Cached saved PLACSP opportunity"
    });
    const state = createDemoState();
    state.opportunities = [];
    state.savedOpportunityIds = [oldBdnsOpportunity.id, placspOpportunity.id];

    const analysis = analyzePortfolio(
      state.companyProfiles[0],
      [oldBdnsOpportunity],
      DEFAULT_RUNTIME,
      getEvaluationNow()
    ).analysed[0];
    state.aiRuns = [
      {
        id: "ai-run-bdns-1",
        companyId: state.companyProfiles[0].id,
        opportunityId: oldBdnsOpportunity.id,
        completedAt: "2026-08-13T08:30:00.000Z",
        result: {
          review_status: "accepted",
          warnings: [],
          disagreements: [],
          corrected_action: analysis.decision.recommendedAction.code,
          corrected_fit_band: analysis.fitBand,
          confidence: "medium",
          notes: "Saved AI review for the original BDNS source version."
        },
        contextFingerprint: createAiVerificationContextFingerprint(
          state.companyProfiles[0],
          oldBdnsOpportunity,
          analysis
        ),
        sourceNoticeVersionId: oldBdnsOpportunity.sourceNoticeVersionId
      }
    ];

    const storageAdapter = createMockStorageAdapter({
      initialRaw: JSON.stringify(state)
    });
    const store = createStore({ storageAdapter });
    const sourceCache = createSourceOpportunityCache({
      adapter: createInMemorySourceCacheAdapter()
    });
    await sourceCache.upsertMany("bdns", [oldBdnsOpportunity]);
    await sourceCache.upsertMany("placsp", [placspOpportunity]);

    const root = createRoot();
    let aiCalls = 0;
    const app = startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        refreshScheduler: {
          start() {},
          getNextAutomaticRefreshAt() {
            return "2026-08-14T00:00:00.000Z";
          }
        },
        async runBdnsSync() {
          return updatedPayload;
        },
        async runAiVerification() {
          aiCalls += 1;
          throw new Error("AI should never auto-run during BDNS source synchronization.");
        }
      }
    });

    await app.whenSourceCacheReady();

    await clickAction(root, { action: "route", route: "saved" });
    assert.ok(store.getState().opportunities.some((item) => item.id === oldBdnsOpportunity.id));
    assert.ok(store.getState().opportunities.some((item) => item.id === placspOpportunity.id));
    assert.match(root.innerHTML, /Cached saved PLACSP opportunity/);
    assert.match(root.innerHTML, /modernizacion de instalaciones electricas/i);

    await clickAction(root, { action: "route", route: "opportunities" });
    await clickAction(root, { action: "select", id: oldBdnsOpportunity.id });
    assert.match(root.innerHTML, /AI reviewed/);

    await clickAction(root, { action: "sync-bdns" });
    await clickAction(root, { action: "route", route: "opportunities" });
    await clickAction(root, { action: "select", id: oldBdnsOpportunity.id });

    assert.equal(aiCalls, 0);
    assert.deepEqual(store.getState().savedOpportunityIds, [oldBdnsOpportunity.id, placspOpportunity.id]);
    assert.match(root.innerHTML, /Saved review may be outdated/);
    assert.match(root.innerHTML, /digitalizacion de instalaciones electricas/i);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("BDNS sync stays successful in memory when the source cache throws unexpectedly and shows a cache warning instead", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const catalog = await loadCatalog();
    const payload = await bdnsSyncPayload(["normalSmeGrant", "fixedWindow"], catalog);
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const sourceCache = createSourceOpportunityCache({
      adapter: {
        kind: "indexeddb",
        async loadByConnector() {
          return { ok: true, records: [] };
        },
        async upsertMany() {
          throw new Error("IndexedDB write failed during BDNS cache persistence");
        },
        async count() {
          return { ok: true, count: 0 };
        },
        async clearConnector() {
          return { ok: true };
        },
        async getConnectorState(connector) {
          return { ok: true, state: { connector } };
        },
        async setConnectorState() {
          throw new Error("IndexedDB connector state write failed");
        }
      }
    });
    const root = createRoot();
    const app = startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        refreshScheduler: {
          start() {},
          getNextAutomaticRefreshAt() {
            return "2026-08-14T00:00:00.000Z";
          }
        },
        async runBdnsSync() {
          return payload;
        }
      }
    });

    await app.whenSourceCacheReady();
    await clickAction(root, { action: "sync-bdns" });

    assert.equal(store.getState().sourceSyncRuns[0].status, "healthy");
    assert.equal(store.getState().sourceSyncRuns[0].opportunitiesInserted, 2);
    assert.equal(store.getState().opportunities.filter((item) => item.sourceConnector === "bdns").length, 2);
    assert.equal(sourceCache.getStatus().status, "error");
    assert.equal(sourceCache.getStatus().lastError?.code, "SOURCE_CACHE_SAVE_FAILED");
    assert.match(root.innerHTML, /BDNS \/ SNPSAP sync completed: 2 inserted, 0 updated, 0 unchanged\./);
    assert.match(root.innerHTML, /Source cache persistence is unavailable, so these BDNS records may be lost after reload\./);
    assert.doesNotMatch(root.innerHTML, /Official BDNS \/ SNPSAP sync failed\./);
    assert.doesNotMatch(root.innerHTML, /Sync failed/i);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("BDNS partial detail failures preserve cached records and do not disturb PLACSP cache or connector state", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const catalog = await loadCatalog();
    const existingA = normalizeBdnsOpportunity(catalog.normalSmeGrant, {
      fetchedAt: "2026-08-13T08:00:00.000Z",
      now: new Date("2026-08-13T08:00:00.000Z")
    });
    const existingB = normalizeBdnsOpportunity(catalog.fixedWindow, {
      fetchedAt: "2026-08-13T08:00:00.000Z",
      now: new Date("2026-08-13T08:00:00.000Z")
    });
    const existingC = normalizeBdnsOpportunity(catalog.futureDeadlineAbiertoFalse, {
      fetchedAt: "2026-08-13T08:00:00.000Z",
      now: new Date("2026-08-13T08:00:00.000Z")
    });
    const updatedC = normalizeBdnsOpportunity(
      {
        ...catalog.futureDeadlineAbiertoFalse,
        descripcion: "Convocatoria con abierto=false pero cierre futuro (actualizada)",
        presupuestoTotal: "1750000"
      },
      {
        fetchedAt: "2026-08-13T11:00:00.000Z",
        now: new Date("2026-08-13T11:00:00.000Z")
      }
    );
    const recoveredB = normalizeBdnsOpportunity(
      {
        ...catalog.fixedWindow,
        descripcion: "Subvenciones para equipos de climatizacion eficiente (recuperada)"
      },
      {
        fetchedAt: "2026-08-13T12:00:00.000Z",
        now: new Date("2026-08-13T12:00:00.000Z")
      }
    );
    const placspOpportunity = makePlacspOpportunity(1, {
      id: "placsp:test-isolated",
      title: "PLACSP opportunity kept during BDNS failures"
    });
    const state = createDemoState();
    state.opportunities = [];
    state.savedOpportunityIds = [existingB.id, placspOpportunity.id];

    const store = createStore({
      storageAdapter: createMockStorageAdapter({
        initialRaw: JSON.stringify(state)
      })
    });
    const sourceCache = createSourceOpportunityCache({
      adapter: createInMemorySourceCacheAdapter()
    });
    await sourceCache.upsertMany("bdns", [existingA, existingB, existingC]);
    await sourceCache.upsertMany("placsp", [placspOpportunity]);
    await sourceCache.setConnectorState("placsp", {
      lastSuccessfulSyncAt: "2026-08-12T10:00:00.000Z",
      lastFeedUpdated: "2026-08-12T09:00:00.000Z",
      entryUpdatedWatermark: "2026-08-12T08:30:00.000Z",
      lastRunMode: "incremental",
      autoRefreshEnabled: false
    });
    await sourceCache.setConnectorState("bdns", {
      lastSuccessfulSyncAt: "2026-08-12T10:00:00.000Z",
      lastManualSyncAt: "2026-08-12T10:00:00.000Z",
      lastRunMode: "manual"
    });

    const payloads = [
      {
        connector: "bdns",
        mode: "manual",
        startedAt: "2026-08-13T11:00:00.000Z",
        completedAt: "2026-08-13T11:00:00.000Z",
        fetchedAt: "2026-08-13T11:00:00.000Z",
        pagesFetched: 1,
        pageSize: 20,
        discoveryCount: 3,
        uniqueCodes: 3,
        detailsRequested: 3,
        detailsFetched: 2,
        detailFailures: [
          {
            code: existingB.sourceOpportunityId,
            message: "502 Bad Gateway for BDNS detail 700002"
          }
        ],
        truncated: false,
        truncationReason: null,
        opportunities: [existingA, updatedC],
        stats: {
          uniqueEntries: 3
        }
      },
      {
        connector: "bdns",
        mode: "manual",
        startedAt: "2026-08-13T12:00:00.000Z",
        completedAt: "2026-08-13T12:00:00.000Z",
        fetchedAt: "2026-08-13T12:00:00.000Z",
        pagesFetched: 1,
        pageSize: 20,
        discoveryCount: 3,
        uniqueCodes: 3,
        detailsRequested: 3,
        detailsFetched: 3,
        detailFailures: [],
        truncated: false,
        truncationReason: null,
        opportunities: [existingA, recoveredB, updatedC],
        stats: {
          uniqueEntries: 3
        }
      }
    ];

    const root = createRoot();
    const app = startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache,
        refreshScheduler: {
          start() {},
          getNextAutomaticRefreshAt() {
            return "2026-08-14T00:00:00.000Z";
          }
        },
        async runBdnsSync() {
          return payloads.shift();
        }
      }
    });

    await app.whenSourceCacheReady();

    const placspStateBefore = await sourceCache.getConnectorState("placsp");
    assert.equal(placspStateBefore.ok, true);
    assert.equal(placspStateBefore.state.lastFeedUpdated, "2026-08-12T09:00:00.000Z");
    assert.equal(placspStateBefore.state.entryUpdatedWatermark, "2026-08-12T08:30:00.000Z");
    assert.equal(placspStateBefore.state.autoRefreshEnabled, false);
    assert.equal((await sourceCache.count("placsp")).count, 1);
    assert.equal((await sourceCache.count("bdns")).count, 3);

    await clickAction(root, { action: "sync-bdns" });

    const firstPassA = store.getState().opportunities.find((item) => item.id === existingA.id);
    const firstPassB = store.getState().opportunities.find((item) => item.id === existingB.id);
    const firstPassC = store.getState().opportunities.find((item) => item.id === existingC.id);
    assert.ok(store.getState().opportunities.some((item) => item.id === placspOpportunity.id));
    assert.equal(firstPassA?.sourceNoticeVersionId, existingA.sourceNoticeVersionId);
    assert.equal(firstPassA?.title, existingA.title);
    assert.equal(firstPassB?.sourceNoticeVersionId, existingB.sourceNoticeVersionId);
    assert.equal(firstPassB?.title, existingB.title);
    assert.equal(firstPassC?.sourceNoticeVersionId, updatedC.sourceNoticeVersionId);
    assert.match(store.getState().sourceSyncRuns[0].note, /isolated detail failures/i);
    assert.equal(store.getState().sourceSyncRuns[0].detailFailures, 1);
    assert.match(store.getState().sourceSyncRuns[0].errors[0] ?? "", /700002/);

    const firstCacheB = (await sourceCache.loadByConnector("bdns")).opportunities.find((item) => item.id === existingB.id);
    assert.equal(firstCacheB?.sourceNoticeVersionId, existingB.sourceNoticeVersionId);
    assert.equal((await sourceCache.count("placsp")).count, 1);
    assert.equal((await sourceCache.count("bdns")).count, 3);

    const placspStateAfterFailure = await sourceCache.getConnectorState("placsp");
    assert.deepEqual(placspStateAfterFailure.state, placspStateBefore.state);

    await clickAction(root, { action: "sync-bdns" });

    const recoveredStoreB = store.getState().opportunities.find((item) => item.id === existingB.id);
    const recoveredCacheB = (await sourceCache.loadByConnector("bdns")).opportunities.find((item) => item.id === existingB.id);
    assert.equal(recoveredStoreB?.sourceNoticeVersionId, recoveredB.sourceNoticeVersionId);
    assert.match(recoveredStoreB?.title ?? "", /recuperada/i);
    assert.equal(recoveredCacheB?.sourceNoticeVersionId, recoveredB.sourceNoticeVersionId);
    assert.equal((await sourceCache.count("placsp")).count, 1);
    assert.equal((await sourceCache.count("bdns")).count, 3);

    const placspStateAfterRecovery = await sourceCache.getConnectorState("placsp");
    const bdnsStateAfterRecovery = await sourceCache.getConnectorState("bdns");
    assert.deepEqual(placspStateAfterRecovery.state, placspStateBefore.state);
    assert.equal(bdnsStateAfterRecovery.state.lastManualSyncAt, "2026-08-13T12:00:00.000Z");
    assert.equal(bdnsStateAfterRecovery.state.lastRunMode, "manual");
  } finally {
    globalThis.window = previousWindow;
  }
});
