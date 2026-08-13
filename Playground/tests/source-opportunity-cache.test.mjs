import test from "node:test";
import assert from "node:assert/strict";

import {
  createConnectorState,
  createInMemorySourceCacheAdapter,
  createIndexedDbSourceCacheAdapter,
  createSourceOpportunityCache
} from "../src/services/source-opportunity-cache.js";

function makePlacspOpportunity(index, overrides = {}) {
  return {
    id: overrides.id ?? `placsp:bulk-${index}`,
    sourceConnector: "placsp",
    sourceOpportunityId: overrides.sourceOpportunityId ?? `https://contrataciondelestado.es/sindicacion/bulk-${index}`,
    sourceNoticeVersionId: overrides.sourceNoticeVersionId ?? `placsp-version:${index}`,
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: overrides.title ?? `Bulk PLACSP opportunity ${index}`,
    description: "Synthetic source opportunity for source-cache tests.",
    location: {
      display: "Tarragona"
    },
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
        id: `src-bulk-${index}`,
        organisation: "Plataforma de Contratacion del Sector Publico",
        title: "Official PLACSP ATOM feed",
        url: "https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom",
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

function createNameList(set) {
  return {
    contains(name) {
      return set.has(name);
    }
  };
}

class FakeObjectStore {
  constructor(transaction, meta) {
    this.transaction = transaction;
    this.meta = meta;
  }

  get indexNames() {
    return createNameList(this.meta.indexes);
  }

  createIndex(name) {
    this.meta.indexes.add(name);
  }

  getAll() {
    const request = {};
    queueMicrotask(() => {
      request.result = [...this.meta.records.values()].map((item) => structuredClone(item));
      request.onsuccess?.();
      this.transaction.scheduleComplete();
    });
    return request;
  }

  get(key) {
    const request = {};
    queueMicrotask(() => {
      request.result = structuredClone(this.meta.records.get(key));
      request.onsuccess?.();
      this.transaction.scheduleComplete();
    });
    return request;
  }

  put(value) {
    this.meta.records.set(value[this.meta.keyPath], structuredClone(value));
    this.transaction.scheduleComplete();
    return {};
  }

  delete(key) {
    this.meta.records.delete(key);
    this.transaction.scheduleComplete();
    return {};
  }
}

class FakeTransaction {
  constructor(dbRecord, storeNames) {
    this.dbRecord = dbRecord;
    this.storeNames = storeNames;
    this.completeScheduled = false;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }

  objectStore(name) {
    const meta = this.dbRecord.stores.get(name);
    if (!meta) throw new Error(`Unknown object store: ${name}`);
    return new FakeObjectStore(this, meta);
  }

  scheduleComplete() {
    if (this.completeScheduled) return;
    this.completeScheduled = true;
    setTimeout(() => {
      this.oncomplete?.();
    }, 0);
  }
}

class FakeDb {
  constructor(record) {
    this.record = record;
  }

  get objectStoreNames() {
    return createNameList(new Set(this.record.stores.keys()));
  }

  createObjectStore(name, { keyPath }) {
    const meta = {
      keyPath,
      records: new Map(),
      indexes: new Set()
    };
    this.record.stores.set(name, meta);
    return new FakeObjectStore(new FakeTransaction(this.record, [name]), meta);
  }

  transaction(storeName) {
    const names = Array.isArray(storeName) ? storeName : [storeName];
    return new FakeTransaction(this.record, names);
  }
}

class FakeIndexedDB {
  constructor() {
    this.databases = new Map();
  }

  open(name, version) {
    const request = {
      result: null,
      error: null,
      transaction: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null
    };

    setTimeout(() => {
      let record = this.databases.get(name);
      const oldVersion = record?.version ?? 0;
      if (!record) {
        record = {
          version: version ?? 1,
          stores: new Map()
        };
        this.databases.set(name, record);
      }

      const targetVersion = version ?? record.version;
      const needsUpgrade = targetVersion > oldVersion;
      record.version = targetVersion;
      request.result = new FakeDb(record);

      if (needsUpgrade) {
        request.transaction = new FakeTransaction(record, [...record.stores.keys()]);
        request.onupgradeneeded?.({
          oldVersion,
          newVersion: targetVersion,
          target: request
        });
      }

      request.onsuccess?.({
        target: request
      });
    }, 0);

    return request;
  }
}

async function seedVersion1Opportunity(indexedDB, record) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("oportunex-source-cache", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore("opportunities", { keyPath: "id" });
      store.createIndex("connector", "connector", { unique: false });
      store.createIndex("sourceOpportunityId", "sourceOpportunityId", { unique: false });
      store.put(record);
    };
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

test("source cache accepts 1,000 PLACSP records without duplicates and updates changed versions in place", async () => {
  const cache = createSourceOpportunityCache({
    adapter: createInMemorySourceCacheAdapter()
  });
  const opportunities = Array.from({ length: 1000 }, (_, index) => makePlacspOpportunity(index + 1));

  const firstUpsert = await cache.upsertMany("placsp", opportunities);
  const firstCount = await cache.count("placsp");
  const firstLoad = await cache.loadByConnector("placsp");

  assert.deepEqual(firstUpsert, { ok: true });
  assert.equal(firstCount.ok, true);
  assert.equal(firstCount.count, 1000);
  assert.equal(firstLoad.ok, true);
  assert.equal(firstLoad.count, 1000);
  assert.equal(firstLoad.opportunities[0].sourceConnector, "placsp");

  await cache.upsertMany("placsp", opportunities);
  const secondCount = await cache.count("placsp");
  assert.equal(secondCount.count, 1000);

  const changedId = opportunities[499].id;
  const changedVersion = "placsp-version:changed";
  const changedOpportunities = opportunities.map((item) =>
    item.id === changedId
      ? {
          ...item,
          sourceNoticeVersionId: changedVersion,
          title: "Updated cached title"
        }
      : item
  );

  await cache.upsertMany("placsp", changedOpportunities);
  const finalLoad = await cache.loadByConnector("placsp");
  const changedRecord = finalLoad.opportunities.find((item) => item.id === changedId);

  assert.equal(finalLoad.count, 1000);
  assert.equal(changedRecord?.sourceNoticeVersionId, changedVersion);
  assert.equal(changedRecord?.title, "Updated cached title");
});

test("connector state persists in the in-memory adapter and patching preserves auto-refresh preferences", async () => {
  const cache = createSourceOpportunityCache({
    adapter: createInMemorySourceCacheAdapter()
  });

  const initial = await cache.getConnectorState("placsp");
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.state, createConnectorState("placsp"));

  const saved = await cache.setConnectorState("placsp", {
    lastSuccessfulSyncAt: "2026-08-13T08:00:00.000Z",
    lastManualSyncAt: "2026-08-13T08:00:00.000Z",
    lastFeedUpdated: "2026-08-13T06:00:00.000Z",
    entryUpdatedWatermark: "2026-08-13T05:00:00.000Z",
    lastRunMode: "incremental",
    lastPagesFetched: 1,
    autoRefreshEnabled: false
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.autoRefreshEnabled, false);

  const patched = await cache.patchConnectorState("placsp", {
    lastAutomaticSyncAt: "2026-08-13T12:00:00.000Z",
    lastRunMode: "automatic"
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.state.lastAutomaticSyncAt, "2026-08-13T12:00:00.000Z");
  assert.equal(patched.state.lastRunMode, "automatic");
  assert.equal(patched.state.autoRefreshEnabled, false);
});

test("v1 to v2 IndexedDB migration preserves cached opportunities and adds connector state storage", async () => {
  const indexedDB = new FakeIndexedDB();
  const seededOpportunity = makePlacspOpportunity(1);
  await seedVersion1Opportunity(indexedDB, {
    id: seededOpportunity.id,
    connector: "placsp",
    sourceOpportunityId: seededOpportunity.sourceOpportunityId,
    sourceNoticeVersionId: seededOpportunity.sourceNoticeVersionId,
    cachedAt: "2026-08-13T07:00:00.000Z",
    opportunity: seededOpportunity
  });

  const cache = createSourceOpportunityCache({
    adapter: createIndexedDbSourceCacheAdapter({ indexedDB })
  });

  const loaded = await cache.loadByConnector("placsp");
  assert.equal(loaded.ok, true);
  assert.equal(loaded.count, 1);
  assert.equal(loaded.opportunities[0].id, seededOpportunity.id);

  const connectorState = await cache.getConnectorState("placsp");
  assert.equal(connectorState.ok, true);
  assert.equal(connectorState.state.connector, "placsp");
  assert.equal(connectorState.state.autoRefreshEnabled, true);

  await cache.setConnectorState("placsp", {
    lastSuccessfulSyncAt: "2026-08-13T08:00:00.000Z",
    lastRunMode: "manual"
  });
  const reloadedState = await cache.getConnectorState("placsp");
  assert.equal(reloadedState.state.lastSuccessfulSyncAt, "2026-08-13T08:00:00.000Z");
  assert.equal(reloadedState.state.lastRunMode, "manual");
});
