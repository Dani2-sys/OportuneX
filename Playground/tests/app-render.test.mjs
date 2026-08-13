import test from "node:test";
import assert from "node:assert/strict";

import { startApp } from "../src/app.js";
import { getEvaluationNow } from "../src/clock.js";
import { ACTION_COPY, DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import { parseSpanishDate } from "../src/domain/deadline.js";
import { createMoney } from "../src/domain/money.js";
import { importCompanyProfileFromJson } from "../src/services/company-importer.js";
import {
  createInMemorySourceCacheAdapter,
  createSourceOpportunityCache
} from "../src/services/source-opportunity-cache.js";
import { createStore } from "../src/state/store.js";
import { escapeHtml } from "../src/utils.js";

const MINIMAL_PROSPECT_JSON = JSON.stringify({
  id: "company-test-import",
  profileMode: "prospect",
  legalName: "TEST IMPORT SL"
});

const STRUCTURED_OPPORTUNITY_JSON = JSON.stringify({
  id: "structured-opportunity-test",
  type: "contract",
  title: "Structured electrical maintenance opportunity",
  publicationDate: "2026-08-11",
  deadline: "29/08/2026 14:00",
  location: {
    municipality: "Tarragona",
    province: "Tarragona",
    autonomousCommunity: "Catalonia"
  },
  cpvCodes: ["50711000", "45315300"],
  keywords: ["electrical", "maintenance"],
  relevantValue: {
    major: 84500,
    currency: "EUR",
    vatStatus: "excluding",
    amountType: "relevant_lot_value"
  },
  sources: [
    {
      id: "src-structured-opportunity-test",
      organisation: "Ajuntament example",
      title: "Official notice",
      url: "https://example.com/opportunity",
      official: true,
      publishedAt: "2026-08-11"
    }
  ],
  evidence: [
    {
      id: "ev-structured-opportunity-test",
      fieldKey: "deadline",
      excerpt: "Submission deadline 29/08/2026 14:00",
      sourceId: "src-structured-opportunity-test",
      sourceType: "official_notice",
      confidence: 0.91
    }
  ]
});

const CUSTOMER_WHY_BLOCKLIST = /potential hard blocker|eligibility requirements not yet assessed|confirmed eligibility failure|deadline passed|already awarded|cancelled|suspended|unrelated capability|no further action is recommended/i;

function makeUiEvidence() {
  return [
    "status",
    "deadline",
    "lot_value",
    "location",
    "requirements",
    "submission_route",
    "official_notice",
    "contacts"
  ].map((fieldKey, index) => ({
    id: `ui-ev-${index + 1}`,
    fieldKey,
    excerpt: `${fieldKey} evidence`,
    sourceId: "ui-source-1",
    confidence: 0.93
  }));
}

function makeNoLotUiOpportunity() {
  return {
    id: "opp-ui-no-published-lots",
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: "Standalone electrical maintenance contract",
    description: "Preventive and corrective electrical maintenance across municipal facilities.",
    location: {
      municipality: "Tarragona",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Tarragona"
    },
    cpvCodes: ["50711000", "45315300"],
    keywords: ["electrical maintenance"],
    deadline: parseSpanishDate("26/08/2026 14:00"),
    estimatedValue: createMoney({ major: 100000, amountType: "estimated_value", vatStatus: "excluding" }),
    relevantValue: null,
    duration: "12 months",
    guarantees: "None",
    lots: [],
    contacts: [{ role: "authority", name: "Ajuntament de Tarragona", email: "contractacio@example.com" }],
    sources: [
      {
        id: "ui-source-1",
        organisation: "Ajuntament de Tarragona",
        title: "Official tender notice",
        url: "https://official.example/opportunity",
        publishedAt: "2026-08-01",
        lastChecked: "2026-08-08T10:00:00Z",
        official: true
      }
    ],
    evidence: makeUiEvidence(),
    lastChecked: "2026-08-08T10:00:00Z",
    applicationUrl: "https://official.example/apply",
    noticeUrl: "https://official.example/opportunity",
    referenceNumber: "opp-ui-no-published-lots-ref",
    requiredDocuments: [],
    documents: []
  };
}

function makeCachedPlacspOpportunity(overrides = {}) {
  return {
    ...makeNoLotUiOpportunity(),
    id: overrides.id ?? "placsp:cached-ui-opportunity",
    sourceConnector: "placsp",
    sourceOpportunityId:
      overrides.sourceOpportunityId ??
      "https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/cached-ui-opportunity",
    sourceNoticeVersionId: overrides.sourceNoticeVersionId ?? "placsp-version:cached-ui-opportunity",
    title: overrides.title ?? "Cached PLACSP opportunity",
    referenceNumber: overrides.referenceNumber ?? "PLACSP-CACHED-001",
    sources: [
      {
        id: "placsp-ui-source-1",
        organisation: "Plataforma de Contratacion del Sector Publico",
        title: "Official PLACSP ATOM feed",
        url: "https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom",
        official: true,
        publishedAt: "2026-08-01",
        lastChecked: "2026-08-08T10:00:00Z",
        metadata: {
          sourceType: "official_open_data_atom"
        }
      }
    ],
    ...overrides
  };
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

function createFakeForm(root, datasetForm, values) {
  const nodes = {
    ".form-status-chip": {
      className: "form-status-chip",
      textContent: "Empty"
    },
    ".form-inline-feedback": {
      className: "form-inline-feedback",
      textContent: ""
    }
  };
  return {
    dataset: {
      form: datasetForm
    },
    values: { ...values },
    nodes,
    resetCalls: 0,
    reset() {
      this.values = {};
      this.resetCalls += 1;
    },
    querySelector(selector) {
      return this.nodes[selector] ?? null;
    },
    requestSubmit() {
      root.dispatch("submit", {
        preventDefault() {},
        target: this
      });
    }
  };
}

function createFormTarget(form) {
  return {
    dataset: {},
    closest(selector) {
      if (selector === "form[data-form='company-import'], form[data-form='opportunity-json-import']") {
        return form;
      }
      return null;
    }
  };
}

function createMockFormData() {
  return class MockFormData {
    constructor(form) {
      this.form = form;
    }

    get(name) {
      return this.form.values[name] ?? null;
    }
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function expectedCustomerWhy(analysed) {
  const positiveDetail = analysed?.positives?.find((entry) => entry?.detail)?.detail;
  if (positiveDetail) return positiveDetail;

  const candidate = analysed?.decision?.mainReason ?? analysed?.executiveVerdict ?? "";
  if (candidate && !CUSTOMER_WHY_BLOCKLIST.test(candidate)) return candidate;

  return "Relevant opportunity signals remain limited under the current evidence set.";
}

function expectedCustomerNeedsChecking(analysed) {
  return (
    (analysed?.potentialHardBlockers?.[0] ?? analysed?.unknowns?.[0] ?? analysed?.blockers?.[0])?.detail ??
    analysed?.decision?.mainQuestion ??
    analysed?.decision?.mainReason ??
    "No additional blocking question is currently recorded."
  );
}

function changeFilter(root, filter, value, checked = false) {
  root.dispatch("change", {
    target: {
      dataset: {
        filter
      },
      value,
      checked
    }
  });
}

function assertDecisionConsistency(root, store, scenario) {
  const portfolio = analyzePortfolio(
    store.getState().companyProfiles[0],
    store.getState().opportunities,
    DEFAULT_RUNTIME,
    getEvaluationNow()
  );
  const bucketKeyByScope = {
    worth_attention: "worthAttention",
    needs_verification: "needsVerification",
    not_suitable: "notSuitable"
  };
  const analysed = portfolio.analysed.find((item) => item.opportunityId === scenario.id);
  const actionLabel = ACTION_COPY[scenario.code] ?? analysed?.decision?.recommendedAction?.label ?? scenario.code;
  const encodedVerdict = escapeHtml(analysed?.executiveVerdict ?? "");
  const encodedReason = escapeHtml(analysed?.decision?.mainReason ?? "");
  const encodedQuestion = escapeHtml(analysed?.decision?.mainQuestion ?? "");
  const encodedCardReason = escapeHtml(expectedCustomerWhy(analysed));
  const encodedCardQuestion = escapeHtml(expectedCustomerNeedsChecking(analysed));

  assert.ok(analysed, `Expected analysed opportunity ${scenario.id}`);
  assert.equal(analysed.decision.recommendedAction.code, scenario.code);
  assert.equal(analysed.decision.recommendedAction.bucket, scenario.scope);
  assert.ok(
    portfolio.buckets[bucketKeyByScope[scenario.scope]].some((item) => item.opportunityId === scenario.id),
    `Expected ${scenario.id} in bucket ${scenario.scope}`
  );

  clickAction(root, { action: "route", route: "opportunities" });
  changeFilter(root, "type", "all");
  changeFilter(root, "recommendation", "all");
  changeFilter(root, "savedOnly", "all", false);
  changeFilter(root, "sort", scenario.sort);
  clickAction(root, { action: "scope", scope: scenario.scope });

  assert.match(root.innerHTML, new RegExp(`option value="${escapeRegExp(scenario.sort)}" selected`));
  assert.match(
    root.innerHTML,
    new RegExp(
      `data-id="${escapeRegExp(scenario.id)}"[\\s\\S]*?${escapeRegExp(actionLabel)}[\\s\\S]*?<strong>Why it matters<\\/strong>[\\s\\S]*?<p>${escapeRegExp(encodedCardReason)}<\\/p>[\\s\\S]*?<strong>Needs checking<\\/strong>[\\s\\S]*?<p>${escapeRegExp(encodedCardQuestion)}<\\/p>`
    )
  );

  clickAction(root, { action: "select", id: scenario.id });
  clickAction(root, { action: "tab", tab: "report" });

  assert.match(root.innerHTML, new RegExp(`<h3>${escapeRegExp(analysed.displayTitle)}<\\/h3>`));
  assert.match(
    root.innerHTML,
    new RegExp(`<span>Recommended action<\\/span>\\s*<strong>${escapeRegExp(actionLabel)}<\\/strong>`)
  );
  assert.match(
    root.innerHTML,
    new RegExp(
      `data-id="${escapeRegExp(scenario.id)}"[\\s\\S]*?${escapeRegExp(actionLabel)}[\\s\\S]*?<strong>Why it matters<\\/strong>[\\s\\S]*?<p>${escapeRegExp(encodedCardReason)}<\\/p>[\\s\\S]*?<strong>Needs checking<\\/strong>[\\s\\S]*?<p>${escapeRegExp(encodedCardQuestion)}<\\/p>`
    )
  );
  assert.match(root.innerHTML, new RegExp(`<span>Main reason<\\/span>\\s*<p>${escapeRegExp(encodedReason)}<\\/p>`));
  assert.match(root.innerHTML, new RegExp(`<span>Main blocker\\/question<\\/span>\\s*<p>${escapeRegExp(encodedQuestion)}<\\/p>`));
  assert.match(root.innerHTML, new RegExp(`<\\/div>\\s*<p>${escapeRegExp(encodedVerdict)}<\\/p>`));
  if (scenario.potentialHardBlocker) {
    assert.match(root.innerHTML, new RegExp(`Potential hard blocker:[\\s\\S]*?${escapeRegExp(scenario.potentialHardBlocker)}`));
  }
}

test("company page renders a sparse imported prospect profile without throwing", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const importedProfile = importCompanyProfileFromJson(MINIMAL_PROSPECT_JSON);
    const nextState = createDemoState();
    nextState.companyProfiles = [importedProfile];
    nextState.activeCompanyId = importedProfile.id;
    store.replace(nextState);

    const root = createRoot();

    assert.doesNotThrow(() => {
      startApp(root, { runtime: DEFAULT_RUNTIME, store });
    });

    assert.doesNotThrow(() => {
      root.dispatch("click", {
        preventDefault() {},
        target: {
          closest(selector) {
            if (selector === "[data-route]") {
              return {
                dataset: {
                  route: "company"
                }
              };
            }
            return null;
          }
        }
      });
    });

    assert.match(root.innerHTML, /TEST IMPORT SL/);
    assert.match(root.innerHTML, /Prospect profile/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("company import submit survives textarea change and activates the imported profile immediately", () => {
  const previousWindow = globalThis.window;
  const previousFormData = globalThis.FormData;
  globalThis.window = {};
  globalThis.FormData = createMockFormData();

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    const form = createFakeForm(root, "company-import", {
      companyJson: MINIMAL_PROSPECT_JSON
    });
    const textareaTarget = createFormTarget(form);
    const renderCountBeforeChange = root.renderCount;

    root.dispatch("change", {
      target: textareaTarget
    });

    assert.equal(root.renderCount, renderCountBeforeChange);

    form.requestSubmit();

    assert.equal(store.getState().activeCompanyId, "company-test-import");
    assert.equal(store.getState().companyProfiles[0].legalName, "TEST IMPORT SL");
    assert.match(root.innerHTML, /TEST IMPORT SL/);
    assert.match(root.innerHTML, /Prospect profile imported for TEST IMPORT SL\./);
  } finally {
    globalThis.window = previousWindow;
    globalThis.FormData = previousFormData;
  }
});

test("keyboard submit imports the prospect profile through requestSubmit", () => {
  const previousWindow = globalThis.window;
  const previousFormData = globalThis.FormData;
  globalThis.window = {};
  globalThis.FormData = createMockFormData();

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    const form = createFakeForm(root, "company-import", {
      companyJson: MINIMAL_PROSPECT_JSON
    });
    const textareaTarget = createFormTarget(form);
    let prevented = false;

    root.dispatch("keydown", {
      key: "Enter",
      ctrlKey: true,
      metaKey: false,
      preventDefault() {
        prevented = true;
      },
      target: textareaTarget
    });

    assert.equal(prevented, true);
    assert.equal(store.getState().activeCompanyId, "company-test-import");
    assert.match(root.innerHTML, /TEST IMPORT SL/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.FormData = previousFormData;
  }
});

test("company import still succeeds in memory and shows the persistence warning when saving fails", () => {
  const previousWindow = globalThis.window;
  const previousFormData = globalThis.FormData;
  globalThis.window = {};
  globalThis.FormData = createMockFormData();

  try {
    const store = createStore({
      storageAdapter: {
        load() {
          return { ok: true, value: null };
        },
        save() {
          throw new Error("Quota exceeded");
        }
      }
    });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    const form = createFakeForm(root, "company-import", {
      companyJson: MINIMAL_PROSPECT_JSON
    });

    form.requestSubmit();

    assert.equal(store.getState().activeCompanyId, "company-test-import");
    assert.equal(store.getPersistenceStatus().status, "unavailable");
    assert.match(root.innerHTML, /Browser persistence is unavailable/i);
  } finally {
    globalThis.window = previousWindow;
    globalThis.FormData = previousFormData;
  }
});

test("empty company import marks the status chip as Error and valid JSON input recovers it to JSON detected", () => {
  const previousWindow = globalThis.window;
  const previousFormData = globalThis.FormData;
  globalThis.window = {};
  globalThis.FormData = createMockFormData();

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    const form = createFakeForm(root, "company-import", {
      companyJson: ""
    });

    form.requestSubmit();

    assert.equal(form.querySelector(".form-status-chip").textContent, "Error");
    assert.match(form.querySelector(".form-status-chip").className, /is-error/);
    assert.equal(
      form.querySelector(".form-inline-feedback").textContent,
      "Paste structured company JSON here before importing."
    );

    const textareaTarget = {
      name: "companyJson",
      value: MINIMAL_PROSPECT_JSON,
      closest(selector) {
        if (selector === "form[data-form='company-import'], form[data-form='opportunity-json-import']") {
          return form;
        }
        return null;
      }
    };

    root.dispatch("input", {
      target: textareaTarget
    });

    assert.equal(form.querySelector(".form-status-chip").textContent, "JSON detected");
    assert.equal(form.querySelector(".form-inline-feedback").textContent, "");
  } finally {
    globalThis.window = previousWindow;
    globalThis.FormData = previousFormData;
  }
});

test("empty structured opportunity import marks the status chip as Error and valid JSON input recovers it", () => {
  const previousWindow = globalThis.window;
  const previousFormData = globalThis.FormData;
  globalThis.window = {};
  globalThis.FormData = createMockFormData();

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    const form = createFakeForm(root, "opportunity-json-import", {
      opportunityJson: ""
    });

    form.requestSubmit();

    assert.equal(form.querySelector(".form-status-chip").textContent, "Error");
    assert.match(form.querySelector(".form-status-chip").className, /is-error/);
    assert.equal(
      form.querySelector(".form-inline-feedback").textContent,
      "Paste structured opportunity JSON here before importing."
    );

    const textareaTarget = {
      name: "opportunityJson",
      value: "{\"type\":\"contract\",\"title\":\"Recovered structured opportunity\"}",
      closest(selector) {
        if (selector === "form[data-form='company-import'], form[data-form='opportunity-json-import']") {
          return form;
        }
        return null;
      }
    };

    root.dispatch("input", {
      target: textareaTarget
    });

    assert.equal(form.querySelector(".form-status-chip").textContent, "JSON detected");
    assert.equal(form.querySelector(".form-inline-feedback").textContent, "");
  } finally {
    globalThis.window = previousWindow;
    globalThis.FormData = previousFormData;
  }
});

test("structured opportunity import by submit shows the imported opportunity in the detail panel immediately", () => {
  const previousWindow = globalThis.window;
  const previousFormData = globalThis.FormData;
  globalThis.window = {};
  globalThis.FormData = createMockFormData();

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });
    clickAction(root, { action: "route", route: "lab" });

    const form = createFakeForm(root, "opportunity-json-import", {
      opportunityJson: STRUCTURED_OPPORTUNITY_JSON
    });

    form.requestSubmit();

    assert.equal(store.getState().opportunities[0].id, "structured-opportunity-test");
    assert.match(root.innerHTML, /Structured opportunity imported: Structured electrical maintenance opportunity\./);
    assert.match(root.innerHTML, /Opportunity editor/);
    assert.match(root.innerHTML, /Structured electrical maintenance opportunity/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.FormData = previousFormData;
  }
});

test("normal UI keeps whole-opportunity wording when a contract has no published lots", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    nextState.opportunities = [makeNoLotUiOpportunity()];
    store.replace(nextState);

    const portfolio = analyzePortfolio(
      nextState.companyProfiles[0],
      nextState.opportunities,
      DEFAULT_RUNTIME,
      getEvaluationNow()
    );
    const analysed = portfolio.analysed[0];
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    changeFilter(root, "type", "all");
    changeFilter(root, "recommendation", "all");
    changeFilter(root, "savedOnly", "all", false);
    clickAction(root, { action: "scope", scope: analysed.decision.recommendedAction.bucket });
    clickAction(root, { action: "select", id: analysed.opportunityId });
    clickAction(root, { action: "tab", tab: "report" });

    assert.match(root.innerHTML, /Estimated contract value: €100,000 excl\. VAT/);
    assert.doesNotMatch(root.innerHTML, /Relevant lot/i);
    assert.doesNotMatch(root.innerHTML, /lot value/i);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("card, detail, bucket and sorting state stay aligned across actionable, verify and do-not-pursue opportunities", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    const scenarios = [
      {
        id: "opp-efficiency-grant",
        code: "INVESTIGATE_NOW",
        scope: "worth_attention",
        sort: "deadline"
      },
      {
        id: "opp-multi-lot-framework",
        code: "VERIFY_BEFORE_DECIDING",
        scope: "needs_verification",
        sort: "match",
        potentialHardBlocker: "Civil liability insurance"
      },
      {
        id: "opp-expired-maintenance",
        code: "DO_NOT_PURSUE",
        scope: "not_suitable",
        sort: "confidence"
      }
    ];

    scenarios.forEach((scenario) => {
      assertDecisionConsistency(root, store, scenario);
    });
  } finally {
    globalThis.window = previousWindow;
  }
});

test("verify-first customer cards keep positive relevance under Why it matters and blocker detail under Needs checking", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    const portfolio = analyzePortfolio(
      store.getState().companyProfiles[0],
      store.getState().opportunities,
      DEFAULT_RUNTIME,
      getEvaluationNow()
    );
    const analysed = portfolio.analysed.find((item) => item.opportunityId === "opp-electrical-maintenance");

    assert.ok(analysed);
    assert.equal(analysed.decision.recommendedAction.code, "VERIFY_BEFORE_DECIDING");

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "needs_verification" });

    assert.match(
      root.innerHTML,
      new RegExp(
        `data-id="opp-electrical-maintenance"[\\s\\S]*?<strong>Why it matters<\\/strong>[\\s\\S]*?<p>${escapeRegExp(escapeHtml(analysed.positives[0].detail))}<\\/p>[\\s\\S]*?<strong>Needs checking<\\/strong>[\\s\\S]*?<p>${escapeRegExp(escapeHtml(expectedCustomerNeedsChecking(analysed)))}<\\/p>`
      )
    );
    assert.doesNotMatch(
      root.innerHTML,
      new RegExp(
        `data-id="opp-electrical-maintenance"[\\s\\S]*?<strong>Why it matters<\\/strong>[\\s\\S]*?<p>${escapeRegExp(escapeHtml(analysed.decision.mainReason))}<\\/p>`
      )
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("customer opportunity markup escapes imported user-derived text", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    const dangerousOpportunity = makeNoLotUiOpportunity();
    dangerousOpportunity.id = "opp-escaped-customer-copy";
    dangerousOpportunity.title = "Escaped <script>alert(1)</script> opportunity";
    dangerousOpportunity.issuingOrganisation = "Authority <b>danger</b>";
    nextState.opportunities = [dangerousOpportunity];
    store.replace(nextState);

    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "all_analysed" });
    clickAction(root, { action: "select", id: dangerousOpportunity.id });

    assert.match(root.innerHTML, /Escaped &lt;script&gt;alert\(1\)&lt;\/script&gt; opportunity/);
    assert.match(root.innerHTML, /Authority &lt;b&gt;danger&lt;\/b&gt;/);
    assert.doesNotMatch(root.innerHTML, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(root.innerHTML, /<b>danger<\/b>/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("startup hydrates cached PLACSP opportunities and reconnects saved ids from localStorage", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const persistedState = createDemoState();
    const cachedOpportunity = makeCachedPlacspOpportunity({
      id: "placsp:cached-saved-opportunity",
      title: "Cached saved PLACSP opportunity"
    });
    persistedState.opportunities = [];
    persistedState.savedOpportunityIds = [cachedOpportunity.id];

    const store = createStore({
      storageAdapter: {
        load() {
          return { ok: true, value: JSON.stringify(persistedState) };
        },
        save(snapshot) {
          return { ok: true, value: snapshot };
        }
      }
    });
    const sourceCache = createSourceOpportunityCache({
      adapter: createInMemorySourceCacheAdapter()
    });
    await sourceCache.upsertMany("placsp", [cachedOpportunity]);

    const root = createRoot();
    const app = startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache
      }
    });

    await app.whenSourceCacheReady();
    clickAction(root, { action: "route", route: "saved" });

    assert.deepEqual(store.getState().savedOpportunityIds, [cachedOpportunity.id]);
    assert.ok(store.getState().opportunities.some((item) => item.id === cachedOpportunity.id));
    assert.match(root.innerHTML, /Cached saved PLACSP opportunity/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("source cache load failure leaves the workspace usable and shows a source-cache warning", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    const app = startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        sourceCache: createSourceOpportunityCache({
          adapter: {
            kind: "indexeddb",
            async loadByConnector() {
              return {
                ok: false,
                code: "SOURCE_CACHE_LOAD_FAILED",
                message: "IndexedDB read failed"
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
            }
          }
        })
      }
    });

    await app.whenSourceCacheReady();

    assert.match(root.innerHTML, /Instalaciones Demo Tarragona SL/);
    assert.match(root.innerHTML, /Stored source opportunities could not be loaded/i);
    assert.match(root.innerHTML, /IndexedDB read failed/i);
  } finally {
    globalThis.window = previousWindow;
  }
});
