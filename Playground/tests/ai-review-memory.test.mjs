import test from "node:test";
import assert from "node:assert/strict";

import { startApp } from "../src/app.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { createStore } from "../src/state/store.js";
import { formatDate } from "../src/utils.js";

function createRuntime() {
  return structuredClone(DEFAULT_RUNTIME);
}

function createMockStorageAdapter() {
  let raw = null;
  return {
    load() {
      return {
        ok: true,
        value: raw
      };
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
    renderCount: 0,
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
      root.renderCount += 1;
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

function changeActiveCompany(root, value) {
  return root.dispatch("change", {
    target: {
      dataset: {
        control: "active-company"
      },
      value
    }
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createAiVerificationResponse(overrides = {}) {
  return {
    provider: "openai",
    model: "gpt-5.6-terra",
    review_status: "accepted",
    warnings: ["Verify remaining commercial assumptions."],
    disagreements: [],
    corrected_action: null,
    corrected_fit_band: null,
    confidence: "medium",
    notes: "Stored second-pass review.",
    aiRuntime: {
      provider: "openai",
      status: "connected",
      lastChecked: "2026-08-12T09:45:00.000Z",
      lastError: null
    },
    ...overrides
  };
}

function createTwoCompanyState() {
  const state = createDemoState();
  const secondCompany = structuredClone(state.companyProfiles[0]);
  secondCompany.id = "company-alt";
  secondCompany.legalName = "Alt Energy Systems SL";
  secondCompany.tradingName = "Alt Energy Systems";
  state.companyProfiles.push(secondCompany);
  return state;
}

function getAiRunByPair(store, companyId, opportunityId) {
  return store.getState().aiRuns.find(
    (item) => item.companyId === companyId && item.opportunityId === opportunityId
  ) ?? null;
}

test("saved AI verification persists through reload, keeps company scope, and does not auto-run again", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const storageAdapter = createMockStorageAdapter();
    const store = createStore({ storageAdapter });
    const root = createRoot();
    let verificationCalls = 0;

    startApp(root, {
      runtime: createRuntime(),
      store,
      services: {
        async runAiVerification() {
          verificationCalls += 1;
          return createAiVerificationResponse();
        }
      }
    });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });
    await clickAction(root, { action: "ai-verify", id: "opp-efficiency-grant" });

    const savedRun = getAiRunByPair(store, "company-demo", "opp-efficiency-grant");
    assert.equal(verificationCalls, 1);
    assert.ok(savedRun);
    assert.equal(savedRun.companyId, "company-demo");

    const reviewedAtLabel = formatDate(savedRun.completedAt, { includeTime: true });

    const reloadedStore = createStore({ storageAdapter });
    const reloadRoot = createRoot();
    let reloadCalls = 0;

    startApp(reloadRoot, {
      runtime: createRuntime(),
      store: reloadedStore,
      services: {
        async runAiVerification() {
          reloadCalls += 1;
          return createAiVerificationResponse();
        }
      }
    });

    clickAction(reloadRoot, { action: "route", route: "opportunities" });
    clickAction(reloadRoot, { action: "select", id: "opp-efficiency-grant" });

    assert.equal(reloadCalls, 0);
    assert.match(reloadRoot.innerHTML, /AI reviewed/);
    assert.match(reloadRoot.innerHTML, /Re-run AI verification/);
    assert.match(reloadRoot.innerHTML, new RegExp(escapeRegExp(reviewedAtLabel)));
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Saved route reuses the existing AI verification flow, stays scoped by company, and does not auto-run on open", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const state = createTwoCompanyState();
    state.savedOpportunityIds = ["opp-efficiency-grant"];
    const storageAdapter = createMockStorageAdapter();
    const store = createStore({ storageAdapter });
    store.replace(state);
    const root = createRoot();
    let verificationCalls = 0;

    startApp(root, {
      runtime: createRuntime(),
      store,
      services: {
        async runAiVerification({ company }) {
          verificationCalls += 1;
          return createAiVerificationResponse({
            notes: `Saved review for ${company.legalName}.`
          });
        }
      }
    });

    clickAction(root, { action: "route", route: "saved" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.equal(verificationCalls, 0);
    assert.match(root.innerHTML, /class="nav-item active" data-action="route" data-route="saved"/);
    assert.match(root.innerHTML, /Run AI verification/);
    assert.match(root.innerHTML, /Catalonia energy-efficiency grant for SME building services/);

    await clickAction(root, { action: "ai-verify", id: "opp-efficiency-grant" });

    const savedRun = getAiRunByPair(store, "company-demo", "opp-efficiency-grant");
    assert.equal(verificationCalls, 1);
    assert.ok(savedRun);
    assert.match(root.innerHTML, /Saved review for Instalaciones Demo Tarragona SL\./);
    assert.match(root.innerHTML, /class="nav-item active" data-action="route" data-route="saved"/);

    const reloadedStore = createStore({ storageAdapter });
    const reloadRoot = createRoot();
    let reloadCalls = 0;
    startApp(reloadRoot, {
      runtime: createRuntime(),
      store: reloadedStore,
      services: {
        async runAiVerification() {
          reloadCalls += 1;
          return createAiVerificationResponse();
        }
      }
    });

    clickAction(reloadRoot, { action: "route", route: "saved" });
    clickAction(reloadRoot, { action: "select", id: "opp-efficiency-grant" });

    assert.equal(reloadCalls, 0);
    assert.match(reloadRoot.innerHTML, /AI reviewed/);
    assert.match(reloadRoot.innerHTML, /Saved review for Instalaciones Demo Tarragona SL\./);

    changeActiveCompany(reloadRoot, "company-alt");
    clickAction(reloadRoot, { action: "route", route: "saved" });
    clickAction(reloadRoot, { action: "select", id: "opp-efficiency-grant" });

    assert.match(reloadRoot.innerHTML, /No AI review yet/);
    assert.doesNotMatch(reloadRoot.innerHTML, /Saved review for Instalaciones Demo Tarragona SL\./);

    changeActiveCompany(reloadRoot, "company-demo");
    clickAction(reloadRoot, { action: "route", route: "saved" });
    clickAction(reloadRoot, { action: "select", id: "opp-efficiency-grant" });

    assert.match(reloadRoot.innerHTML, /AI reviewed/);
    assert.match(reloadRoot.innerHTML, /Saved review for Instalaciones Demo Tarragona SL\./);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("AI verification memory stays isolated by company and by opportunity", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const state = createTwoCompanyState();
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    store.replace(state);
    const root = createRoot();

    startApp(root, {
      runtime: createRuntime(),
      store,
      services: {
        async runAiVerification({ company }) {
          return createAiVerificationResponse({
            notes: `Review for ${company.legalName}.`
          });
        }
      }
    });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });
    await clickAction(root, { action: "ai-verify", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /Review for Instalaciones Demo Tarragona SL\./);
    assert.ok(getAiRunByPair(store, "company-demo", "opp-efficiency-grant"));

    clickAction(root, { action: "scope", scope: "all_analysed" });
    clickAction(root, { action: "select", id: "opp-multi-lot-framework" });
    assert.match(root.innerHTML, /No AI review yet/);
    assert.match(root.innerHTML, /Run AI verification/);
    assert.doesNotMatch(root.innerHTML, /Review for Instalaciones Demo Tarragona SL\./);

    changeActiveCompany(root, "company-alt");
    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /No AI review yet/);
    assert.match(root.innerHTML, /Run AI verification/);
    assert.doesNotMatch(root.innerHTML, /Review for Instalaciones Demo Tarragona SL\./);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("failed AI rerun preserves the previous successful saved review", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    let callCount = 0;

    startApp(root, {
      runtime: createRuntime(),
      store,
      services: {
        async runAiVerification() {
          callCount += 1;
          if (callCount === 1) {
            return createAiVerificationResponse({
              notes: "First saved review."
            });
          }
          throw new Error("AI verification unavailable.");
        }
      }
    });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });
    await clickAction(root, { action: "ai-verify", id: "opp-efficiency-grant" });

    const savedBeforeFailure = getAiRunByPair(store, "company-demo", "opp-efficiency-grant");
    await clickAction(root, { action: "ai-verify", id: "opp-efficiency-grant" });
    const savedAfterFailure = getAiRunByPair(store, "company-demo", "opp-efficiency-grant");

    assert.equal(savedAfterFailure.completedAt, savedBeforeFailure.completedAt);
    assert.equal(savedAfterFailure.result.notes, "First saved review.");
    assert.match(root.innerHTML, /AI verification unavailable\./);
    assert.match(root.innerHTML, /First saved review\./);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("AI verify button disables during an active request and blocks duplicate calls for the same pair", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    const deferred = createDeferred();
    let calls = 0;

    startApp(root, {
      runtime: createRuntime(),
      store,
      services: {
        runAiVerification() {
          calls += 1;
          return deferred.promise;
        }
      }
    });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    const pendingVerification = clickAction(root, { action: "ai-verify", id: "opp-efficiency-grant" });

    assert.equal(calls, 1);
    assert.match(root.innerHTML, /Verifying\.\.\./);
    assert.match(root.innerHTML, /data-action="ai-verify"[^>]*data-id="opp-efficiency-grant"[^>]*disabled/);

    await clickAction(root, { action: "ai-verify", id: "opp-efficiency-grant" });
    assert.equal(calls, 1);

    deferred.resolve(createAiVerificationResponse());
    await pendingVerification;

    assert.doesNotMatch(root.innerHTML, /Verifying\.\.\./);
    assert.match(root.innerHTML, /AI reviewed/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("customer detail hides raw AI JSON while the debugger still exposes it", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();

    startApp(root, {
      runtime: createRuntime(),
      store,
      services: {
        async runAiVerification() {
          return createAiVerificationResponse();
        }
      }
    });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });
    await clickAction(root, { action: "ai-verify", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /AI review/);
    assert.doesNotMatch(root.innerHTML, /"review_status"/);
    assert.doesNotMatch(root.innerHTML, /"provider"/);

    clickAction(root, { action: "route", route: "debug" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /&quot;review_status&quot;: &quot;accepted&quot;/);
    assert.match(root.innerHTML, /&quot;provider&quot;: &quot;openai&quot;/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("legacy unscoped AI reviews remain debug-only for customer-facing detail", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    store.update((draft) => {
      draft.aiRuns = [
        {
          id: "legacy-ai-review",
          opportunityId: "opp-efficiency-grant",
          completedAt: "2026-08-12T07:30:00.000Z",
          result: {
            provider: "openai",
            review_status: "accepted",
            notes: "Legacy unscoped review."
          }
        }
      ];
    });

    const root = createRoot();
    startApp(root, {
      runtime: createRuntime(),
      store
    });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /No AI review yet/);
    assert.match(root.innerHTML, /Run AI verification/);
    assert.match(root.innerHTML, /legacy unscoped AI review exists/i);
    assert.doesNotMatch(root.innerHTML, /Legacy unscoped review\./);

    clickAction(root, { action: "route", route: "debug" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /Legacy unscoped review\./);
  } finally {
    globalThis.window = previousWindow;
  }
});
