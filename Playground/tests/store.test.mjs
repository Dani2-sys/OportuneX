import test from "node:test";
import assert from "node:assert/strict";

import { importCompanyProfileFromJson } from "../src/services/company-importer.js";
import { createLocalStorageAdapter, createStore } from "../src/state/store.js";

const MINIMAL_PROSPECT_JSON = JSON.stringify({
  id: "company-test-import",
  profileMode: "prospect",
  legalName: "TEST IMPORT SL"
});

function importIntoDraft(draft, importedProfile) {
  const existingIndex = draft.companyProfiles.findIndex((item) => item.id === importedProfile.id);
  if (existingIndex >= 0) draft.companyProfiles.splice(existingIndex, 1, importedProfile);
  else draft.companyProfiles.unshift(importedProfile);
  draft.activeCompanyId = importedProfile.id;
}

function createMockStorageAdapter({ initialRaw = null, saveError = null } = {}) {
  let raw = initialRaw;
  return {
    load() {
      return {
        ok: true,
        value: raw
      };
    },
    save(snapshot) {
      if (saveError) throw saveError;
      raw = JSON.stringify(snapshot);
      return { ok: true };
    },
    readRaw() {
      return raw;
    }
  };
}

function createMockLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, value);
    }
  };
}

test("minimal valid prospect profile import becomes active immediately", () => {
  const storageAdapter = createMockStorageAdapter();
  const store = createStore({ storageAdapter });
  const importedProfile = importCompanyProfileFromJson(MINIMAL_PROSPECT_JSON);

  assert.doesNotThrow(() => {
    store.update((draft) => {
      importIntoDraft(draft, importedProfile);
    });
  });

  assert.equal(store.getState().activeCompanyId, importedProfile.id);
  assert.equal(store.getState().companyProfiles[0].legalName, "TEST IMPORT SL");
  assert.equal(store.getPersistenceStatus().status, "available");
});

test("storage failure does not block imported company activation in memory", () => {
  const storageAdapter = createMockStorageAdapter({
    saveError: new Error("Quota exceeded")
  });
  const store = createStore({ storageAdapter });
  const importedProfile = importCompanyProfileFromJson(MINIMAL_PROSPECT_JSON);

  assert.doesNotThrow(() => {
    store.update((draft) => {
      importIntoDraft(draft, importedProfile);
    });
  });

  assert.equal(store.getState().activeCompanyId, importedProfile.id);
  assert.equal(
    store.getState().companyProfiles.find((item) => item.id === importedProfile.id)?.legalName,
    "TEST IMPORT SL"
  );
  assert.equal(store.getPersistenceStatus().status, "unavailable");
  assert.equal(store.getPersistenceStatus().mode, "memory_only");
  assert.match(store.getPersistenceStatus().detail, /may be lost after reload/i);
  assert.equal(store.getPersistenceStatus().lastError.code, "PERSISTENCE_SAVE_FAILED");
  assert.match(store.getPersistenceStatus().lastError.message, /quota exceeded/i);
});

test("normal localStorage persistence still works", () => {
  const storage = createMockLocalStorage();
  const importedProfile = importCompanyProfileFromJson(MINIMAL_PROSPECT_JSON);

  const firstStore = createStore({
    storageAdapter: createLocalStorageAdapter({
      storage,
      key: "oportunex.test.store"
    })
  });

  firstStore.update((draft) => {
    importIntoDraft(draft, importedProfile);
  });

  const reloadedStore = createStore({
    storageAdapter: createLocalStorageAdapter({
      storage,
      key: "oportunex.test.store"
    })
  });

  assert.equal(reloadedStore.getState().activeCompanyId, importedProfile.id);
  assert.equal(
    reloadedStore.getState().companyProfiles.find((item) => item.id === importedProfile.id)?.legalName,
    "TEST IMPORT SL"
  );
  assert.equal(reloadedStore.getPersistenceStatus().status, "available");
});

test("store normalizes sparse prospect profiles loaded from persistence", () => {
  const storageAdapter = createMockStorageAdapter({
    initialRaw: JSON.stringify({
      companyProfiles: [
        {
          id: "prospect-1",
          profileMode: "prospect",
          legalName: "Sparse Prospect SL"
        }
      ],
      activeCompanyId: "prospect-1",
      opportunities: []
    })
  });

  const store = createStore({ storageAdapter });
  const company = store.getState().companyProfiles[0];

  assert.equal(company.profileMode, "prospect");
  assert.deepEqual(company.preferences.desiredWorkTypes, []);
  assert.deepEqual(company.preferences.unwantedWorkTypes, []);
  assert.deepEqual(company.classifications.cnae, []);
  assert.equal(company.geography.display, "");
  assert.deepEqual(store.getState().opportunities, []);
});
