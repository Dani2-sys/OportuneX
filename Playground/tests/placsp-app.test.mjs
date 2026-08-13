import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { startApp } from "../src/app.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { createSourceOpportunityCache } from "../src/services/source-opportunity-cache.js";
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
    startedAt: fetchedAt,
    completedAt: fetchedAt,
    fetchedAt,
    feedUpdated: parsed.feed.updated,
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
