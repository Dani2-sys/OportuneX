import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzeOpportunity, analyzePortfolio } from "../src/domain/analysis.js";
import { parseSpanishDate } from "../src/domain/deadline.js";
import { createMoney } from "../src/domain/money.js";
import { runEvaluationSuite } from "../src/domain/evaluation.js";
import { evaluationFixtures } from "../src/data/evaluation-fixtures.js";
import { getEvaluationNow } from "../src/clock.js";
import { buildAnalysisCacheTimeKey, createAnalysisCache } from "../src/services/analysis-cache.js";

function makeOpportunity(index, overrides = {}) {
  return {
    id: overrides.id ?? `analysis-cache-opportunity-${index}`,
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: overrides.title ?? `Analysis cache opportunity ${index}`,
    description: "Synthetic contract for deterministic analysis-cache tests.",
    publicationDate: "2026-08-10",
    deadline: parseSpanishDate("29/08/2026 14:00"),
    location: {
      municipality: "Tarragona",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Tarragona"
    },
    cpvCodes: ["50711000"],
    keywords: ["electrical maintenance"],
    relevantValue: createMoney({
      major: 84500 + index,
      currency: "EUR",
      amountType: "relevant_lot_value",
      vatStatus: "excluding"
    }),
    lots: [],
    contacts: [],
    sources: [
      {
        id: `analysis-source-${index}`,
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
    requiredDocuments: [],
    documents: [],
    requirements: [],
    sourceNoticeVersionId: overrides.sourceNoticeVersionId ?? `placsp-version:${index}`,
    ...overrides
  };
}

function baseCompany() {
  const state = createDemoState();
  return structuredClone(state.companyProfiles[0]);
}

const FIXED_NOW = new Date("2026-08-13T12:00:00.000Z");
const VOLATILE_ANALYSIS_KEYS = new Set(["analysisNow", "cacheCheckedAt", "cacheUpdatedAt"]);

function stripVolatileAnalysisFields(value) {
  if (Array.isArray(value)) return value.map((entry) => stripVolatileAnalysisFields(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_ANALYSIS_KEYS.has(key))
      .map(([key, entry]) => [key, stripVolatileAnalysisFields(entry)])
  );
}

test("analysis cache time key stays stable within the same absolute hour and rolls on Madrid day boundaries", () => {
  assert.equal(
    buildAnalysisCacheTimeKey(new Date("2026-08-13T12:00:00.000Z")),
    buildAnalysisCacheTimeKey(new Date("2026-08-13T12:59:59.000Z"))
  );
  assert.notEqual(
    buildAnalysisCacheTimeKey(new Date("2026-08-13T12:59:59.000Z")),
    buildAnalysisCacheTimeKey(new Date("2026-08-13T13:00:00.000Z"))
  );
  assert.match(buildAnalysisCacheTimeKey(new Date("2026-08-13T21:59:59.000Z")), /madrid-date:2026-08-13@Europe\/Madrid\|absolute-hour:/);
  assert.match(buildAnalysisCacheTimeKey(new Date("2026-08-13T22:00:00.000Z")), /madrid-date:2026-08-14@Europe\/Madrid\|absolute-hour:/);
  assert.notEqual(
    buildAnalysisCacheTimeKey(new Date("2026-08-13T21:59:59.000Z")),
    buildAnalysisCacheTimeKey(new Date("2026-08-13T22:00:00.000Z"))
  );
});

test("analysis cache reuses same-minute and different-minute same-hour portfolio analyses and invalidates changed opportunities exactly once", () => {
  const company = baseCompany();
  const opportunities = [makeOpportunity(1), makeOpportunity(2), makeOpportunity(3)];
  let analyzeCalls = 0;
  const cache = createAnalysisCache({
    analyzeOpportunityImpl(companyArg, opportunityArg, runtimeArg, nowArg) {
      analyzeCalls += 1;
      return analyzeOpportunity(companyArg, opportunityArg, runtimeArg, nowArg);
    }
  });

  const firstPortfolio = cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, FIXED_NOW);
  const firstMetrics = cache.getMetrics();
  assert.equal(firstPortfolio.analysed.length, 3);
  assert.equal(firstMetrics.lastRunMisses, 3);
  assert.equal(firstMetrics.lastRunHits, 0);
  assert.equal(analyzeCalls, 3);

  const secondPortfolio = cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, FIXED_NOW);
  const secondMetrics = cache.getMetrics();
  assert.equal(secondPortfolio.analysed.length, 3);
  assert.equal(secondMetrics.lastRunHits, 3);
  assert.equal(secondMetrics.lastRunMisses, 0);
  assert.equal(analyzeCalls, 3);

  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T12:45:00.000Z"));
  const sameHourMetrics = cache.getMetrics();
  assert.equal(sameHourMetrics.lastRunHits, 3);
  assert.equal(sameHourMetrics.lastRunMisses, 0);
  assert.equal(analyzeCalls, 3);

  const changedOpportunities = opportunities.map((item) =>
    item.id === opportunities[1].id
      ? {
          ...item,
          sourceNoticeVersionId: "placsp-version:changed"
        }
      : item
  );
  cache.analyzePortfolio(company, changedOpportunities, DEFAULT_RUNTIME, FIXED_NOW);
  const changedMetrics = cache.getMetrics();
  assert.equal(changedMetrics.lastRunHits, 2);
  assert.equal(changedMetrics.lastRunMisses, 1);
  assert.deepEqual(changedMetrics.lastRecomputedOpportunityIds, [opportunities[1].id]);
  assert.equal(analyzeCalls, 4);
});

test("analysis cache isolates PLACSP and BDNS source-version invalidation", () => {
  const company = baseCompany();
  const opportunities = [
    makeOpportunity(1, {
      id: "placsp-cache-opportunity",
      sourceConnector: "placsp",
      sourceOpportunityId: "https://contrataciondelestado.es/sindicacion/placsp-cache-opportunity",
      sourceNoticeVersionId: "placsp-version:stable"
    }),
    makeOpportunity(2, {
      id: "bdns-cache-opportunity",
      sourceConnector: "bdns",
      sourceOpportunityId: "700001",
      sourceNoticeVersionId: "bdns-version:stable",
      sources: [
        {
          id: "analysis-source-bdns-2",
          organisation: "Sistema Nacional de Publicidad de Subvenciones y Ayudas Publicas",
          title: "Official BDNS API",
          url: "https://www.infosubvenciones.es/bdnstrans/api/convocatorias?numConv=700001&vpd=GE",
          official: true,
          metadata: {
            sourceType: "official_snpsap_api"
          }
        }
      ]
    })
  ];
  const cache = createAnalysisCache();

  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, FIXED_NOW);

  const bdnsUpdatedOnly = [
    opportunities[0],
    {
      ...opportunities[1],
      sourceNoticeVersionId: "bdns-version:changed"
    }
  ];
  cache.analyzePortfolio(company, bdnsUpdatedOnly, DEFAULT_RUNTIME, FIXED_NOW);
  const metrics = cache.getMetrics();

  assert.equal(metrics.lastRunHits, 1);
  assert.equal(metrics.lastRunMisses, 1);
  assert.deepEqual(metrics.lastRecomputedOpportunityIds, ["bdns-cache-opportunity"]);
});

test("analysis cache invalidates on absolute-hour and Madrid-date transitions", () => {
  const company = baseCompany();
  const opportunities = [makeOpportunity(1), makeOpportunity(2)];
  const cache = createAnalysisCache();

  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T12:05:00.000Z"));
  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T13:00:00.000Z"));
  let metrics = cache.getMetrics();
  assert.equal(metrics.lastRunHits, 0);
  assert.equal(metrics.lastRunMisses, 2);

  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T21:55:00.000Z"));
  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T22:00:00.000Z"));
  metrics = cache.getMetrics();
  assert.equal(metrics.lastRunHits, 0);
  assert.equal(metrics.lastRunMisses, 2);
});

test("analysis cache invalidates on company and runtime changes within the same hour", () => {
  const company = baseCompany();
  const opportunities = [makeOpportunity(1), makeOpportunity(2)];
  const cache = createAnalysisCache();

  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, FIXED_NOW);

  const companyChanged = structuredClone(company);
  companyChanged.capabilities = [...(companyChanged.capabilities ?? []), { label: "PV monitoring", status: "company_confirmed" }];
  cache.analyzePortfolio(companyChanged, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T12:20:00.000Z"));
  let metrics = cache.getMetrics();
  assert.equal(metrics.lastRunMisses, 2);

  const runtimeChanged = {
    ...DEFAULT_RUNTIME,
    scoring: {
      ...DEFAULT_RUNTIME.scoring,
      priority: {
        ...DEFAULT_RUNTIME.scoring.priority,
        evidenceQuality: 0.11
      }
    }
  };
  cache.analyzePortfolio(companyChanged, opportunities, runtimeChanged, new Date("2026-08-13T12:40:00.000Z"));
  metrics = cache.getMetrics();
  assert.equal(metrics.lastRunMisses, 2);
});

test("cached analyses remain semantically equivalent to uncached analyses while exposing cache timing diagnostics", () => {
  const company = baseCompany();
  const opportunities = [makeOpportunity(1), makeOpportunity(2)];
  const cache = createAnalysisCache();

  const firstPass = cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T12:00:00.000Z"));
  const cachedSameHour = cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T12:45:00.000Z"));
  const uncachedSameHour = analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T12:45:00.000Z"));
  const cachedResult = cache.getOrAnalyze({
    company,
    opportunity: opportunities[0],
    runtime: DEFAULT_RUNTIME,
    now: new Date("2026-08-13T12:45:00.000Z")
  });

  assert.deepEqual(stripVolatileAnalysisFields(cachedSameHour), stripVolatileAnalysisFields(uncachedSameHour));
  assert.equal(cachedSameHour.analysed[0].analysisNow, firstPass.analysed[0].analysisNow);
  assert.equal(cachedResult.hit, true);
  assert.equal(cachedResult.outcome.cacheUpdatedAt, firstPass.analysed[0].analysisNow);
  assert.equal(cachedResult.outcome.cacheCheckedAt, "2026-08-13T12:45:00.000Z");
  assert.equal(uncachedSameHour.analysed[0].analysisNow, "2026-08-13T12:45:00.000Z");
});

test("analysis cache invalidates on current company fact changes and scales to 1,000 unchanged opportunities across hour boundaries", () => {
  const company = baseCompany();
  const cache = createAnalysisCache();
  const opportunities = Array.from({ length: 1000 }, (_, index) => makeOpportunity(index + 1));

  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, FIXED_NOW);
  let metrics = cache.getMetrics();
  assert.equal(metrics.lastRunMisses, 1000);
  assert.equal(metrics.lastRunHits, 0);

  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T12:45:00.000Z"));
  metrics = cache.getMetrics();
  assert.equal(metrics.lastRunHits, 1000);
  assert.equal(metrics.lastRunMisses, 0);

  cache.analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, new Date("2026-08-13T13:00:00.000Z"));
  metrics = cache.getMetrics();
  assert.equal(metrics.lastRunHits, 0);
  assert.equal(metrics.lastRunMisses, 1000);

  const companyChanged = structuredClone(company);
  companyChanged.facts = {
    ...(companyChanged.facts ?? {}),
    employeeCountCurrent: {
      status: "company_confirmed",
      value: 48,
      notes: "Updated for cache invalidation test."
    }
  };
  cache.analyzePortfolio(companyChanged, opportunities, DEFAULT_RUNTIME, FIXED_NOW);
  metrics = cache.getMetrics();
  assert.equal(metrics.lastRunMisses, 1000);
});

test("existing evaluation fixtures remain identical under the phase 0.4B deterministic cache layer", () => {
  const summary = runEvaluationSuite(evaluationFixtures, DEFAULT_RUNTIME, getEvaluationNow()).summary;
  assert.equal(summary.total, 25);
  assert.equal(summary.passed, 25);
  assert.equal(summary.hardBlockerAccuracy, 100);
  assert.equal(summary.monetaryFieldAccuracy, 100);
  assert.equal(summary.deadlineAccuracy, 100);
});
