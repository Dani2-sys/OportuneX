import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { startApp } from "../src/app.js";
import { getEvaluationNow } from "../src/clock.js";
import { ACTION_COPY, DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import { parseSpanishDate } from "../src/domain/deadline.js";
import { createMoney } from "../src/domain/money.js";
import { importCompanyProfileFromJson } from "../src/services/company-importer.js";
import { createAnalysisCache } from "../src/services/analysis-cache.js";
import {
  createInMemorySourceCacheAdapter,
  createSourceOpportunityCache
} from "../src/services/source-opportunity-cache.js";
import { createStore } from "../src/state/store.js";
import { escapeHtml } from "../src/utils.js";
import { createFourLotSelectionFixture, createLiveLotDifferentiationFixture } from "./helpers/lot-selection-fixture.mjs";

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

function makeProgrammeBudgetUiGrant() {
  return {
    id: "bdns-ui-programme-budget",
    sourceConnector: "bdns",
    sourceOpportunityId: "700007",
    sourceNoticeVersionId: "bdns-version:ui-programme-budget",
    type: "grant",
    noticeType: "grant_call",
    status: "open",
    title: "Programme budget only grant",
    description: "Grant without a structured maximum aid per beneficiary.",
    publicationDate: "2026-08-10",
    deadline: parseSpanishDate("01/11/2026 23:59"),
    location: {
      municipality: "",
      province: "",
      autonomousCommunity: "Andalusia",
      display: "Andalusia"
    },
    cpvCodes: [],
    keywords: ["grant"],
    relevantValue: null,
    estimatedValue: null,
    awardValue: null,
    baseBudget: null,
    wholeProcedureValue: null,
    annualValue: null,
    multiYearValue: null,
    maximumAidPerBeneficiary: null,
    programmeBudget: createMoney({
      major: 10000000,
      currency: "EUR",
      amountType: "programme_budget",
      vatStatus: "unknown",
      source: "official_snpsap_api"
    }),
    eligibleProjectCost: null,
    aidIntensity: "",
    duration: "",
    guarantees: "",
    submissionMechanism: "Official electronic application site",
    applicationUrl: "https://sede.example.gob.es/grants/700007",
    noticeUrl: "https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/700007",
    referenceNumber: "700007",
    requiredDocuments: [],
    documents: [],
    contacts: [],
    sources: [
      {
        id: "bdns-ui-source-700007",
        organisation: "Sistema Nacional de Publicidad de Subvenciones y Ayudas Publicas",
        title: "Official BDNS API",
        url: "https://www.infosubvenciones.es/bdnstrans/api/convocatorias?numConv=700007&vpd=GE",
        official: true,
        publishedAt: "2026-08-10",
        lastChecked: "2026-08-13T09:00:00Z",
        metadata: {
          sourceType: "official_snpsap_api"
        }
      }
    ],
    evidence: [],
    requirements: [],
    sourceConflicts: [],
    availabilityWarnings: [],
    lots: [],
    cancellationStatus: null,
    lastChecked: "2026-08-13T09:00:00Z"
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

function makeLongTitleTechnicalOpportunity() {
  const rawRequirement =
    "Specific tenderer requirement: 1: http://contrataciondelestado.es/codice/PlaceTendererQualification/CapacidadDeObrar: Capacidad de obrar";

  return {
    ...makeNoLotUiOpportunity(),
    id: "opp-long-technical-title",
    title:
      "Servicio integral de mantenimiento, mejora, reforma, adecuacion normativa, eficiencia energetica, supervisión tecnica, documentacion de obra y soporte operativo para infraestructuras electricas municipales, edificios auxiliares y equipamientos especiales con alcance plurianual",
    issuingOrganisation:
      "Consorci Metropolita de Serveis Energetics i Infraestructures Publiques amb una denominacio administrativa excepcionalment llarga",
    requirements: [
      {
        id: "req-capacidad-obrar",
        kind: "custom",
        label: rawRequirement,
        mandatory: true,
        gating: "hard",
        question: `Please verify whether the company satisfies the published requirement: ${rawRequirement}.`,
        evidenceIds: ["ev-long-title-req"],
        defaultStatus: "needs_verification"
      }
    ],
    requiredDocuments: ["Administrative dossier"],
    evidence: [
      ...makeUiEvidence(),
      {
        id: "ev-long-title-req",
        fieldKey: "requirements",
        excerpt: rawRequirement,
        sourceId: "ui-source-1",
        sourceType: "official_notice",
        confidence: 0.96,
        sourcePath: "pcap.section.17.A.4"
      }
    ]
  };
}

function makeDeadlineOnlyLowFitOpportunity() {
  return {
    ...makeCachedPlacspOpportunity({
      id: "placsp:deadline-only-low-fit",
      sourceOpportunityId: "https://contrataciondelestado.es/sindicacion/deadline-only-low-fit",
      sourceNoticeVersionId: "placsp-version:deadline-only-low-fit",
      referenceNumber: "PLACSP-DEADLINE-LOW-FIT"
    }),
    title: "Provincial asphalt resurfacing framework",
    description: "Road resurfacing, line marking and asphalt reinforcement across provincial roads.",
    cpvCodes: ["45233252"],
    keywords: ["roadworks", "asphalt"],
    location: {
      municipality: "Bilbao",
      province: "Bizkaia",
      autonomousCommunity: "Basque Country",
      display: "Bilbao"
    },
    deadline: parseSpanishDate("21/08/2026 14:00"),
    estimatedValue: createMoney({ major: 2500000, amountType: "estimated_value", vatStatus: "excluding" }),
    relevantValue: createMoney({ major: 2500000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
    lots: [],
    requirements: []
  };
}

function createMockStorageAdapter(initialRaw = null) {
  let raw = initialRaw;
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

function changeActiveCompany(root, companyId) {
  root.dispatch("change", {
    target: {
      dataset: {
        control: "active-company"
      },
      value: companyId
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
      `data-id="${escapeRegExp(scenario.id)}"[\\s\\S]*?${escapeRegExp(actionLabel)}[\\s\\S]*?<strong>Why it surfaced<\\/strong>[\\s\\S]*?<p>${escapeRegExp(encodedCardReason)}<\\/p>[\\s\\S]*?<strong>Needs checking<\\/strong>[\\s\\S]*?<p>${escapeRegExp(encodedCardQuestion)}<\\/p>`
    )
  );

  clickAction(root, { action: "select", id: scenario.id });
  clickAction(root, { action: "tab", tab: "report" });

  assert.match(root.innerHTML, new RegExp(`<h3 class="detail-report-title">${escapeRegExp(analysed.displayTitle)}<\\/h3>`));
  assert.match(
    root.innerHTML,
    new RegExp(
      `<span class="decision-kicker">Recommended action<\\/span>[\\s\\S]*?${escapeRegExp(actionLabel)}`
    )
  );
  assert.match(
    root.innerHTML,
    new RegExp(
      `data-id="${escapeRegExp(scenario.id)}"[\\s\\S]*?${escapeRegExp(actionLabel)}[\\s\\S]*?<strong>Why it surfaced<\\/strong>[\\s\\S]*?<p>${escapeRegExp(encodedCardReason)}<\\/p>[\\s\\S]*?<strong>Needs checking<\\/strong>[\\s\\S]*?<p>${escapeRegExp(encodedCardQuestion)}<\\/p>`
    )
  );
  assert.match(root.innerHTML, new RegExp(`<p class="decision-reason">${escapeRegExp(encodedReason)}<\\/p>`));
  assert.match(root.innerHTML, new RegExp(`<span>Before proceeding<\\/span>\\s*<p>${escapeRegExp(encodedQuestion)}<\\/p>`));
}

test("customer navigation keeps only the core routes prominent and nests admin routes under Developer tools", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    const navMatch = root.innerHTML.match(/<nav class="nav-list" aria-label="Main">([\s\S]*?)<\/nav>/);
    assert.ok(navMatch, "Expected customer sidebar navigation");

    const customerNav = navMatch[1];
    assert.match(customerNav, /data-route="overview"[\s\S]*?<span>Overview<\/span>/);
    assert.match(customerNav, /data-route="opportunities"[\s\S]*?<span>Opportunities<\/span>/);
    assert.match(customerNav, /data-route="saved"[\s\S]*?<span>Saved<\/span>/);
    assert.match(customerNav, /data-route="company"[\s\S]*?<span>Company<\/span>/);
    assert.doesNotMatch(customerNav, /data-route="lab"/);
    assert.doesNotMatch(customerNav, /data-route="debug"/);
    assert.match(root.innerHTML, /<summary>Developer tools<\/summary>/);
    assert.match(root.innerHTML, /data-route="lab"/);
    assert.match(root.innerHTML, /data-route="debug"/);
    assert.doesNotMatch(root.innerHTML, /data-control="developer-tools" open/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Overview leads with customer decision copy and hides funnel diagnostics while keeping the find-more CTA", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    assert.match(root.innerHTML, /<p class="eyebrow">Overview<\/p>/);
    assert.match(root.innerHTML, /deserves your attention|deserve your attention|No opportunity needs immediate attention/);
    assert.match(root.innerHTML, /Top opportunities/);
    assert.match(root.innerHTML, /Find more opportunities/);
    assert.doesNotMatch(root.innerHTML, /Search wider/i);
    assert.doesNotMatch(root.innerHTML, /Stored universe/i);
    assert.doesNotMatch(root.innerHTML, /Candidate pool/i);
    assert.doesNotMatch(root.innerHTML, /Current depth/i);
  } finally {
    globalThis.window = previousWindow;
  }
});

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

test("detail panel uses bounded desktop scrolling and resets to normal flow at the single-column breakpoint", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.detail-panel\s*\{[\s\S]*?max-height:\s*calc\(100vh - 48px\);[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;[\s\S]*?scrollbar-gutter:\s*stable;[\s\S]*?\}/
  );
  assert.match(
    css,
    /@media \(max-width: 1200px\)\s*\{[\s\S]*?\.detail-panel\s*\{[\s\S]*?position:\s*static;[\s\S]*?top:\s*auto;[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;[\s\S]*?overscroll-behavior:\s*auto;[\s\S]*?scrollbar-gutter:\s*auto;[\s\S]*?\}/
  );
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

test("grant cards and detail views keep programme budget separate from company amount wording", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    const opportunity = makeProgrammeBudgetUiGrant();
    nextState.opportunities = [opportunity];
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
    clickAction(root, { action: "scope", scope: analysed.decision.recommendedAction.bucket });

    assert.match(root.innerHTML, /Programme budget: €10,000,000/);
    assert.doesNotMatch(root.innerHTML, /Maximum aid: €10,000,000/);
    assert.doesNotMatch(root.innerHTML, /Your potential amount: €10,000,000/);
    assert.doesNotMatch(root.innerHTML, /Company amount: €10,000,000/);

    clickAction(root, { action: "select", id: opportunity.id });
    clickAction(root, { action: "tab", tab: "report" });

    assert.match(root.innerHTML, /Programme budget[\s\S]*?€10,000,000/);
    assert.match(root.innerHTML, /<li>Programme budget: €10,000,000<\/li>/);
    assert.doesNotMatch(root.innerHTML, /Maximum aid per beneficiary: €10,000,000/);
    assert.doesNotMatch(root.innerHTML, /Your potential amount: €10,000,000/);
    assert.doesNotMatch(root.innerHTML, /Company amount: €10,000,000/);
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
        sort: "match"
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

test("verify-first customer cards keep positive relevance under Why it surfaced and blocker detail under Needs checking", () => {
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
        `data-id="opp-electrical-maintenance"[\\s\\S]*?<strong>Why it surfaced<\\/strong>[\\s\\S]*?<p>${escapeRegExp(escapeHtml(analysed.positives[0].detail))}<\\/p>[\\s\\S]*?<strong>Needs checking<\\/strong>[\\s\\S]*?<p>${escapeRegExp(escapeHtml(expectedCustomerNeedsChecking(analysed)))}<\\/p>`
      )
    );
    assert.doesNotMatch(
      root.innerHTML,
      new RegExp(
        `data-id="opp-electrical-maintenance"[\\s\\S]*?<strong>Why it surfaced<\\/strong>[\\s\\S]*?<p>${escapeRegExp(escapeHtml(analysed.decision.mainReason))}<\\/p>`
      )
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("low-fit cards do not use the deadline as the sole why-it-surfaced explanation", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    nextState.opportunities = [makeDeadlineOnlyLowFitOpportunity()];
    store.replace(nextState);

    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "not_suitable" });

    assert.match(root.innerHTML, /<strong>Why it surfaced<\/strong>/);
    assert.match(
      root.innerHTML,
      new RegExp(escapeRegExp(escapeHtml("Some scope signals overlap with the company's activity, but overall fit remains limited.")))
    );
    assert.doesNotMatch(root.innerHTML, /<strong>Why it surfaced<\/strong>[\s\S]*?The published deadline is/i);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("customer opportunity cards stay decision-first, show key facts, and keep no-AI states out of card copy", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "worth_attention" });
    const cardMatch = root.innerHTML.match(
      /<article\s+class="opportunity-card[^"]*"[\s\S]*?data-id="opp-efficiency-grant"[\s\S]*?<\/article>/
    );

    assert.ok(cardMatch, "Expected the highlighted customer opportunity card");
    assert.match(
      cardMatch[0],
      /Investigate Now[\s\S]*?Strong Fit · \d+% match[\s\S]*?<span>Value<\/span>[\s\S]*?<span>Deadline<\/span>[\s\S]*?<span>Location<\/span>[\s\S]*?<strong>Why it surfaced<\/strong>[\s\S]*?<strong>Needs checking<\/strong>/
    );
    assert.doesNotMatch(
      cardMatch[0],
      /(No AI review yet|Run AI verification|legacy unscoped AI review)/i
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("long card titles and organisation names keep full text in markup while exposing clamp classes", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    const longOpportunity = makeLongTitleTechnicalOpportunity();
    nextState.opportunities = [longOpportunity];
    store.replace(nextState);

    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "needs_verification" });

    assert.match(root.innerHTML, new RegExp(escapeRegExp(longOpportunity.title)));
    assert.match(root.innerHTML, new RegExp(escapeRegExp(longOpportunity.issuingOrganisation)));
    assert.match(
      root.innerHTML,
      /data-id="opp-long-technical-title"[\s\S]*?<h3 class="opportunity-card-title">[\s\S]*?<\/h3>[\s\S]*?<p class="opportunity-subline opportunity-card-subline">/
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("technical requirement boilerplate is cleaned from the customer report while raw requirement audit detail remains in Evidence", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    nextState.opportunities = [makeLongTitleTechnicalOpportunity()];
    store.replace(nextState);

    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "needs_verification" });
    clickAction(root, { action: "select", id: "opp-long-technical-title" });

    const decisionHero = root.innerHTML.match(/<div class="decision-hero">([\s\S]*?)<div class="detail-key-facts">/);
    assert.ok(decisionHero, "Expected decision hero markup");
    assert.match(decisionHero[1], /Capacidad de obrar/);
    assert.doesNotMatch(decisionHero[1], /contrataciondelestado\.es\/codice/i);
    assert.doesNotMatch(decisionHero[1], /Specific tenderer requirement:\s*1:/i);

    assert.match(root.innerHTML, /Needs verification — mandatory/);
    assert.match(root.innerHTML, /Capacidad de obrar has not yet been verified\./);
    assert.doesNotMatch(root.innerHTML, /ev-long-title-req/);
    assert.doesNotMatch(root.innerHTML, /pcap\.section\.17\.A\.4/);

    assert.match(root.innerHTML, /Full official title/);
    assert.match(root.innerHTML, /Specific tenderer requirement: 1: http:\/\/contrataciondelestado\.es\/codice\/PlaceTendererQualification\/CapacidadDeObrar: Capacidad de obrar/);
    assert.equal((decisionHero[1].match(/class="detail-alert"/g) ?? []).length, 0);

    clickAction(root, { action: "tab", tab: "evidence" });

    assert.match(root.innerHTML, /Requirement audit/);
    assert.match(root.innerHTML, /Specific tenderer requirement: 1: http:\/\/contrataciondelestado\.es\/codice\/PlaceTendererQualification\/CapacidadDeObrar: Capacidad de obrar/);
    assert.match(root.innerHTML, /ev-long-title-req/);
    assert.match(root.innerHTML, /pcap\.section\.17\.A\.4/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("customer report disclosures stay short on first load while keeping the main decision and deadline open", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /<details class="detail-disclosure"\s+open>\s*<summary>Why this matches<\/summary>/);
    assert.match(root.innerHTML, /<details class="detail-disclosure"\s+open>\s*<summary>Deadline &amp; submission<\/summary>/);
    assert.match(root.innerHTML, /<details class="detail-disclosure"\s*>\s*<summary>Eligibility &amp; blockers<\/summary>/);
    assert.match(root.innerHTML, /<details class="detail-disclosure"\s*>\s*<summary>Financial picture<\/summary>/);
    assert.match(root.innerHTML, /<details class="detail-disclosure"\s*>\s*<summary>Requirements<\/summary>/);
    assert.match(root.innerHTML, /<details class="detail-disclosure"\s*>\s*<summary>Evidence &amp; confidence<\/summary>/);
    assert.match(root.innerHTML, /<details class="detail-disclosure"\s*>\s*<summary>Opportunity details<\/summary>/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("analysis debugger exposes the current multi-lot comparison while customer detail keeps it debug-only", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const { company, opportunity } = createFourLotSelectionFixture();
    const nextState = createDemoState();
    nextState.companyProfiles = [company];
    nextState.activeCompanyId = company.id;
    nextState.opportunities = [opportunity];
    store.replace(nextState);
    const analysis = analyzePortfolio(company, [opportunity], DEFAULT_RUNTIME, new Date()).analysed[0];
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: opportunity.id });

    assert.match(root.innerHTML, /Assessment shown for .*published lots in this contract/);
    assert.doesNotMatch(root.innerHTML, /Lot comparison/);
    assert.doesNotMatch(root.innerHTML, /Selection state consistent/);

    clickAction(root, { action: "route", route: "debug" });

    assert.match(root.innerHTML, /Lot comparison/);
    assert.match(root.innerHTML, /Selection state consistent/);
    assert.match(root.innerHTML, /Procedure:<\/strong>\s*HVAC and building-maintenance services across mutual sites/);
    assert.match(root.innerHTML, /Selected explicit lot:<\/strong>\s*Lote I — Castellon and Valencia/);
    assert.match(root.innerHTML, /Selection reason:<\/strong>\s*(Highest priority score|Stable tie-break: source order)/);
    assert.match(root.innerHTML, /Selection scope:<\/strong>\s*Explicit published lot/);
    assert.match(root.innerHTML, /analysis\.bestMatch lot id:<\/strong>\s*lot-i-hvac/);
    assert.match(root.innerHTML, /analysis\.lotId:<\/strong>\s*lot-i-hvac/);
    assert.match(root.innerHTML, /canonical selected explicit lot id:<\/strong>\s*lot-i-hvac/);
    assert.match(root.innerHTML, /customer-presented lot id:<\/strong>\s*lot-i-hvac/);
    assert.match(root.innerHTML, /verification-packet selected lot id:<\/strong>\s*lot-i-hvac/);
    assert.match(root.innerHTML, /<th>Coverage<\/th>/);
    assert.match(root.innerHTML, /Lote I/);
    assert.match(root.innerHTML, /Lote II/);
    assert.match(root.innerHTML, /Lote III/);
    assert.match(root.innerHTML, /Lote IV/);
    assert.match(root.innerHTML, /Selected/);
    assert.equal((root.innerHTML.match(/<td>Selected<\/td>/g) ?? []).length, 1);
    assert.match(
      root.innerHTML,
      new RegExp(`<tr data-lot-id="${escapeRegExp(analysis.selectedLotId)}"[\\s\\S]*?<td>Selected<\\/td>`)
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("analysis debugger compacts long shared lot titles while preserving full official lot titles in developer details", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const { company, opportunity } = createLiveLotDifferentiationFixture();
    const nextState = createDemoState();
    nextState.companyProfiles = [company];
    nextState.activeCompanyId = company.id;
    nextState.opportunities = [opportunity];
    store.replace(nextState);

    const analysis = analyzePortfolio(company, [opportunity], DEFAULT_RUNTIME, new Date()).analysed[0];
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: opportunity.id });

    assert.doesNotMatch(root.innerHTML, /Lot comparison/);

    clickAction(root, { action: "route", route: "debug" });

    assert.match(root.innerHTML, /Lot comparison/);
    assert.equal((root.innerHTML.match(/Procedure:<\/strong>/g) ?? []).length, 1);
    assert.match(root.innerHTML, /Selection reason:<\/strong>\s*Highest priority score/);
    assert.match(root.innerHTML, /<th>Coverage<\/th>/);
    assert.match(root.innerHTML, /<td>\s*<strong>Lote I<\/strong>/);
    assert.match(root.innerHTML, /<td>\s*<strong>Lote II<\/strong>/);
    assert.match(root.innerHTML, /<td>\s*<strong>Lote III<\/strong>/);
    assert.match(root.innerHTML, /<td>\s*<strong>Lote IV<\/strong>/);
    assert.doesNotMatch(root.innerHTML, /<td>\s*<strong>Servicio de mantenimiento de las instalaciones de climatizacion/);
    assert.match(root.innerHTML, /Full official lot title/);
    assert.match(root.innerHTML, /title="ELIGIBILITY_UNCLEAR">Unclear<\/td>/);
    assert.equal((root.innerHTML.match(/<td>Selected<\/td>/g) ?? []).length, 1);
    assert.match(
      root.innerHTML,
      new RegExp(`<tr data-lot-id="${escapeRegExp(analysis.selectedLotId)}"[\\s\\S]*?<td>Selected<\\/td>`)
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test("analysis debugger shows a concise whole-opportunity lot state when no explicit published lots exist", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    nextState.opportunities = [makeNoLotUiOpportunity()];
    store.replace(nextState);

    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-ui-no-published-lots" });
    clickAction(root, { action: "route", route: "debug" });

    assert.match(root.innerHTML, /Lot comparison/);
    assert.match(root.innerHTML, /Selection state consistent/);
    assert.match(root.innerHTML, /Selected explicit lot:<\/strong>\s*None/);
    assert.match(root.innerHTML, /Selection scope:<\/strong>\s*Whole opportunity/);
    assert.match(root.innerHTML, /No explicit published lots for this opportunity\./);
    assert.equal((root.innerHTML.match(/<td>Selected<\/td>/g) ?? []).length, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("copy reference uses the official reference number and shows compact success feedback", async () => {
  const previousWindow = globalThis.window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = {};
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      clipboard: {
        copied: [],
        async writeText(value) {
          this.copied.push(value);
        }
      }
    }
  });

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    nextState.opportunities = [makeNoLotUiOpportunity()];
    store.replace(nextState);

    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "worth_attention" });
    clickAction(root, { action: "select", id: "opp-ui-no-published-lots" });
    clickAction(root, { action: "tab", tab: "report" });
    await clickAction(root, { action: "copy-reference", id: "opp-ui-no-published-lots" });

    assert.deepEqual(globalThis.navigator.clipboard.copied, ["opp-ui-no-published-lots-ref"]);
    assert.match(root.innerHTML, /Tender reference copied\./);
  } finally {
    globalThis.window = previousWindow;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
  }
});

test("PLACSP customer report replaces the broken direct notice link with Find on PLACSP and copies the official reference before opening search", async () => {
  const previousWindow = globalThis.window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const openCalls = [];
  globalThis.window = {
    open(...args) {
      openCalls.push(args);
    }
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      clipboard: {
        copied: [],
        async writeText(value) {
          this.copied.push(value);
        }
      }
    }
  });

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    nextState.opportunities = [
      makeCachedPlacspOpportunity({
        id: "placsp:search-hotfix",
        referenceNumber: "2094/2026",
        noticeUrl: "https://contrataciondelestado.es/wps/poc?uri=deeplink-token",
        sources: [
          {
            id: "placsp-hotfix-source-1",
            organisation: "Plataforma de Contratacion del Sector Publico",
            title: "Official PLACSP ATOM feed",
            url: "https://contrataciondelsectorpublico.gob.es/sindicacion/feed.atom",
            official: true,
            metadata: {
              sourceType: "official_open_data_atom",
              entryLinkUrl: "http://contrataciondelestado.es/wps/poc?uri=deeplink-token"
            }
          }
        ]
      })
    ];
    store.replace(nextState);

    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "needs_verification" });
    clickAction(root, { action: "select", id: "placsp:search-hotfix" });

    assert.match(root.innerHTML, /Find on PLACSP/);
    assert.match(root.innerHTML, /Copy reference/);
    assert.doesNotMatch(root.innerHTML, /Open official notice/);
    assert.match(root.innerHTML, /Paste the reference into the Expediente field\./);
    assert.doesNotMatch(root.innerHTML, /TLS|certificate|Safari|broken government link|deeplink/i);

    await clickAction(root, { action: "find-on-placsp", id: "placsp:search-hotfix" });

    assert.deepEqual(globalThis.navigator.clipboard.copied, ["2094/2026"]);
    assert.deepEqual(openCalls, [[
      "https://contrataciondelestado.es/wps/portal/plataforma/buscador/",
      "_blank",
      "noopener,noreferrer"
    ]]);
    assert.match(root.innerHTML, /Reference 2094\/2026 copied\. Paste it into the Expediente field on PLACSP\./);
  } finally {
    globalThis.window = previousWindow;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
  }
});

test("PLACSP search remains available without a reliable reference and no fake reference is generated", async () => {
  const previousWindow = globalThis.window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const openCalls = [];
  globalThis.window = {
    open(...args) {
      openCalls.push(args);
    }
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      clipboard: {
        copied: [],
        async writeText(value) {
          this.copied.push(value);
        }
      }
    }
  });

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    nextState.opportunities = [
      makeCachedPlacspOpportunity({
        id: "placsp:no-reference-hotfix",
        referenceNumber: "",
        noticeUrl: "https://contrataciondelestado.es/wps/poc?uri=deeplink-token"
      })
    ];
    store.replace(nextState);

    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "needs_verification" });
    clickAction(root, { action: "select", id: "placsp:no-reference-hotfix" });

    assert.match(root.innerHTML, /Find on PLACSP/);
    assert.doesNotMatch(root.innerHTML, /Copy reference/);
    assert.match(root.innerHTML, /Open PLACSP search and use the buyer\/title details shown in OportuneX\./);
    assert.match(root.innerHTML, /Reference:[\s\S]*?Not stated/);

    await clickAction(root, { action: "find-on-placsp", id: "placsp:no-reference-hotfix" });

    assert.deepEqual(globalThis.navigator.clipboard.copied, []);
    assert.deepEqual(openCalls, [[
      "https://contrataciondelestado.es/wps/portal/plataforma/buscador/",
      "_blank",
      "noopener,noreferrer"
    ]]);
    assert.match(root.innerHTML, /Open PLACSP search and use the buyer\/title details shown in OportuneX\./);
    assert.doesNotMatch(root.innerHTML, /source hash|evidence ID/i);
  } finally {
    globalThis.window = previousWindow;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
  }
});

test("non-PLACSP customer report keeps authoritative official notice links unchanged", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const nextState = createDemoState();
    nextState.opportunities = [
      {
        ...makeNoLotUiOpportunity(),
        sourceConnector: "bdns",
        noticeUrl: "https://www.infosubvenciones.es/bdnstrans/GE/es/convocatoria/700007/document/notice"
      }
    ];
    store.replace(nextState);

    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "scope", scope: "worth_attention" });
    clickAction(root, { action: "select", id: "opp-ui-no-published-lots" });

    assert.match(root.innerHTML, /Open official notice/);
    assert.doesNotMatch(root.innerHTML, /Find on PLACSP/);
    assert.match(root.innerHTML, /https:\/\/www\.infosubvenciones\.es\/bdnstrans\/GE\/es\/convocatoria\/700007\/document\/notice/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("deadline report actions show a calendar button only when a reliable deadline exists", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /Add deadline to calendar/);
    assert.match(root.innerHTML, /Adds the published deadline with reminders 7 days and 1 day before\./);

    clickAction(root, { action: "scope", scope: "all_analysed" });
    clickAction(root, { action: "select", id: "opp-award-notice" });

    assert.doesNotMatch(root.innerHTML, /Add deadline to calendar/);
    assert.match(root.innerHTML, /Calendar event unavailable until a reliable deadline is published\./);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("customer topbar removes runtime AI-status pills while keeping the explicit AI verification path in the report", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    startApp(root, { runtime: DEFAULT_RUNTIME, store });

    assert.doesNotMatch(root.innerHTML, /AI configured|Mock verification|AI connected|AI unavailable/i);
    assert.match(root.innerHTML, /Confirmed company/);
    assert.match(root.innerHTML, /worth attention/);
    assert.match(root.innerHTML, /need verification/);
    assert.match(root.innerHTML, /saved/);

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /Run AI verification/);
    assert.doesNotMatch(root.innerHTML, /AI configured|Mock verification|AI connected|AI unavailable/i);
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

test("Saved route keeps the user on Saved, shows the full detail panel, and reselects safely after unsaving the selected item", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    let aiCalls = 0;

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        async runAiVerification() {
          aiCalls += 1;
          return {};
        }
      }
    });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "save", id: "opp-efficiency-grant" });
    clickAction(root, { action: "route", route: "saved" });

    assert.equal(aiCalls, 0);
    assert.match(root.innerHTML, /class="nav-item active" data-action="route" data-route="saved"/);
    assert.match(root.innerHTML, /Catalonia energy-efficiency grant for SME building services/);

    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /class="nav-item active" data-action="route" data-route="saved"/);
    assert.match(root.innerHTML, /AI verification/);
    assert.match(root.innerHTML, /Run AI verification/);

    clickAction(root, { action: "save", id: "opp-efficiency-grant" });

    assert.deepEqual(store.getState().savedOpportunityIds, ["opp-electrical-maintenance"]);
    assert.match(root.innerHTML, /class="nav-item active" data-action="route" data-route="saved"/);
    assert.match(root.innerHTML, /Electrical maintenance contract — Tarragona municipal facilities/);
    assert.match(root.innerHTML, /AI verification/);
    assert.doesNotMatch(root.innerHTML, /Catalonia energy-efficiency grant for SME building services/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Saved route keeps a low-rank saved opportunity fully analysed and accessible outside the normal surfaced shortlist", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    function makeFunnelPlacspOpportunity(index, overrides = {}) {
      const base = makeCachedPlacspOpportunity({
        id: `placsp:saved-funnel-${index}`,
        sourceOpportunityId: `https://contrataciondelestado.es/sindicacion/saved-funnel-${index}`,
        sourceNoticeVersionId: `placsp-version:saved-funnel-${index}`,
        title: `Relevant electrical opportunity ${index}`,
        referenceNumber: `PLACSP-SAVED-FUNNEL-${index}`
      });
      return {
        ...base,
        title: overrides.title ?? base.title,
        description:
          overrides.description ??
          "Electrical maintenance, low-voltage work, HVAC controls and emergency systems support.",
        cpvCodes: overrides.cpvCodes ?? ["50711000", "45315300"],
        keywords: overrides.keywords ?? ["electrical maintenance", "hvac"],
        location:
          overrides.location ?? {
            municipality: "Tarragona",
            province: "Tarragona",
            autonomousCommunity: "Catalonia",
            display: "Tarragona"
          },
        ...overrides
      };
    }

    const savedLowScore = makeFunnelPlacspOpportunity(999, {
      id: "placsp:saved-low-score-opportunity",
      title: "Saved low-score opportunity",
      description: "Generic road maintenance archive with weak fit to the active company.",
      cpvCodes: ["45233252"],
      keywords: ["roadworks", "asphalt"],
      location: {
        municipality: "Seville",
        province: "Seville",
        autonomousCommunity: "Andalusia",
        display: "Seville"
      }
    });
    const opportunities = [
      savedLowScore,
      ...Array.from({ length: 339 }, (_, index) =>
        index % 9 === 0
          ? makeFunnelPlacspOpportunity(index + 1)
          : makeFunnelPlacspOpportunity(index + 1, {
              title: `Irrelevant civil package ${index + 1}`,
              description: "Civil engineering, asphalt resurfacing and kerb works.",
              cpvCodes: ["45233252"],
              keywords: ["roadworks", "asphalt"],
              location: {
                municipality: "Seville",
                province: "Seville",
                autonomousCommunity: "Andalusia",
                display: "Seville"
              }
            })
      )
    ];

    const initialState = createDemoState();
    initialState.opportunities = opportunities;
    initialState.savedOpportunityIds = [savedLowScore.id];

    const store = createStore({
      storageAdapter: createMockStorageAdapter(JSON.stringify(initialState))
    });
    const root = createRoot();
    let aiCalls = 0;
    const app = startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        async runAiVerification() {
          aiCalls += 1;
          return {};
        }
      }
    });

    await app.whenSourceCacheReady();

    clickAction(root, { action: "route", route: "opportunities" });
    assert.doesNotMatch(root.innerHTML, /Saved low-score opportunity/);

    clickAction(root, { action: "route", route: "saved" });
    assert.equal(aiCalls, 0);
    assert.match(root.innerHTML, /Saved low-score opportunity/);

    clickAction(root, { action: "select", id: savedLowScore.id });

    assert.match(root.innerHTML, /class="nav-item active" data-action="route" data-route="saved"/);
    assert.match(root.innerHTML, /Saved low-score opportunity/);
    assert.match(root.innerHTML, /AI verification/);
    assert.match(root.innerHTML, /Run AI verification/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("search wider is company-scoped and reuses deterministic cache instead of triggering AI", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    function makeFunnelPlacspOpportunity(index, overrides = {}) {
      const base = makeCachedPlacspOpportunity({
        id: `placsp:funnel-${index}`,
        sourceOpportunityId: `https://contrataciondelestado.es/sindicacion/funnel-${index}`,
        sourceNoticeVersionId: `placsp-version:funnel-${index}`,
        title: `Relevant electrical opportunity ${index}`,
        referenceNumber: `PLACSP-FUNNEL-${index}`
      });
      return {
        ...base,
        title: overrides.title ?? base.title,
        description:
          overrides.description ??
          "Electrical maintenance, low-voltage work, HVAC controls and emergency systems support.",
        cpvCodes: overrides.cpvCodes ?? ["50711000", "45315300"],
        keywords: overrides.keywords ?? ["electrical maintenance", "hvac"],
        location:
          overrides.location ?? {
            municipality: "Tarragona",
            province: "Tarragona",
            autonomousCommunity: "Catalonia",
            display: "Tarragona"
          },
        ...overrides
      };
    }

    const opportunities = Array.from({ length: 340 }, (_, index) =>
      index % 9 === 0
        ? makeFunnelPlacspOpportunity(index + 1)
        : makeFunnelPlacspOpportunity(index + 1, {
            title: `Irrelevant civil package ${index + 1}`,
            description: "Civil engineering, asphalt resurfacing and kerb works.",
            cpvCodes: ["45233252"],
            keywords: ["roadworks", "asphalt"],
            location: {
              municipality: "Seville",
              province: "Seville",
              autonomousCommunity: "Andalusia",
              display: "Seville"
            }
          })
    );

    const initialState = createDemoState();
    const secondCompany = structuredClone(initialState.companyProfiles[0]);
    secondCompany.id = "company-second";
    secondCompany.legalName = "Second Demo Industrial SL";
    secondCompany.tradingName = "Second Demo Industrial";
    initialState.companyProfiles = [initialState.companyProfiles[0], secondCompany];
    initialState.activeCompanyId = initialState.companyProfiles[0].id;
    initialState.opportunities = opportunities;

    const store = createStore({
      storageAdapter: createMockStorageAdapter(JSON.stringify(initialState))
    });
    const analysisCache = createAnalysisCache();
    let aiCalls = 0;
    const root = createRoot();
    const app = startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        analysisCache,
        async runAiVerification() {
          aiCalls += 1;
          return {};
        }
      }
    });

    await app.whenSourceCacheReady();

    let metrics = analysisCache.getMetrics();
    assert.equal(metrics.lastRunOpportunityCount, 75);
    assert.match(root.innerHTML, /Find more opportunities/i);
    assert.match(root.innerHTML, /Analyse another 75 potential matches\./);
    assert.doesNotMatch(root.innerHTML, /Search wider/i);

    clickAction(root, { action: "search-wider" });
    metrics = analysisCache.getMetrics();
    assert.equal(metrics.lastRunOpportunityCount, 150);
    assert.equal(metrics.lastRunHits, 75);
    assert.equal(metrics.lastRunMisses, 75);

    changeActiveCompany(root, "company-second");
    metrics = analysisCache.getMetrics();
    assert.equal(metrics.lastRunOpportunityCount, 75);
    assert.equal(metrics.lastRunMisses, 75);

    changeActiveCompany(root, initialState.companyProfiles[0].id);
    metrics = analysisCache.getMetrics();
    assert.equal(metrics.lastRunOpportunityCount, 150);
    assert.equal(metrics.lastRunHits, 150);
    assert.equal(metrics.lastRunMisses, 0);
    assert.equal(aiCalls, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("hiding and reopening the report preserves selection and never triggers AI", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    let aiCalls = 0;

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        async runAiVerification() {
          aiCalls += 1;
          return {};
        }
      }
    });

    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.match(root.innerHTML, /Opportunity report/);
    assert.match(root.innerHTML, /Catalonia energy-efficiency grant for SME building services/);

    clickAction(root, { action: "collapse-report" });

    assert.equal(aiCalls, 0);
    assert.doesNotMatch(root.innerHTML, /Opportunity report/);
    assert.match(root.innerHTML, /data-action="open-report" aria-expanded="false"/);
    assert.match(root.innerHTML, /View opportunity/);

    clickAction(root, { action: "select", id: "opp-efficiency-grant" });

    assert.equal(aiCalls, 0);
    assert.match(root.innerHTML, /Opportunity report/);
    assert.match(root.innerHTML, /Catalonia energy-efficiency grant for SME building services/);
    assert.match(root.innerHTML, /data-action="collapse-report" aria-expanded="true"/);

    clickAction(root, { action: "collapse-report" });
    clickAction(root, { action: "open-report" });

    assert.equal(aiCalls, 0);
    assert.match(root.innerHTML, /Opportunity report/);
    assert.match(root.innerHTML, /Catalonia energy-efficiency grant for SME building services/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("opening customer routes never triggers AI verification calls", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};

  try {
    const store = createStore({ storageAdapter: createMockStorageAdapter() });
    const root = createRoot();
    let aiCalls = 0;

    startApp(root, {
      runtime: DEFAULT_RUNTIME,
      store,
      services: {
        async runAiVerification() {
          aiCalls += 1;
          return {};
        }
      }
    });

    clickAction(root, { action: "route", route: "overview" });
    clickAction(root, { action: "route", route: "opportunities" });
    clickAction(root, { action: "route", route: "saved" });
    clickAction(root, { action: "route", route: "company" });

    assert.equal(aiCalls, 0);
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
