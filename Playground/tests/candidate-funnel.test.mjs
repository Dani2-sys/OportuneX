import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_RUNTIME, getSearchDepthPolicy } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { evaluationFixtures } from "../src/data/evaluation-fixtures.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import { parseSpanishDate } from "../src/domain/deadline.js";
import { createMoney } from "../src/domain/money.js";
import { createAnalysisCache } from "../src/services/analysis-cache.js";
import { buildCandidateFunnel } from "../src/services/candidate-funnel.js";

const NOW = new Date("2026-08-13T10:00:00.000Z");

function baseCompany() {
  return structuredClone(createDemoState().companyProfiles[0]);
}

function makeOpportunity(index, overrides = {}) {
  const type = overrides.type ?? "contract";
  const connector = Object.prototype.hasOwnProperty.call(overrides, "sourceConnector")
    ? overrides.sourceConnector
    : type === "grant"
      ? "bdns"
      : "placsp";
  const connectorLabel = connector ?? "manual";
  const title = overrides.title ?? `Opportunity ${index}`;
  const description = overrides.description ?? title;
  const location = overrides.location ?? {
    municipality: "Tarragona",
    province: "Tarragona",
    autonomousCommunity: "Catalonia",
    display: "Tarragona"
  };
  const cpvCodes = overrides.cpvCodes ?? (type === "grant" ? [] : ["45233252"]);
  const keywords = overrides.keywords ?? [];
  const amount =
    overrides.amount === undefined
      ? type === "grant"
        ? createMoney({
            major: 30000,
            currency: "EUR",
            amountType: "maximum_grant",
            vatStatus: "unknown",
            source: "official_snpsap_api"
          })
        : createMoney({
            major: 600000,
            currency: "EUR",
            amountType: "estimated_value",
            vatStatus: "excluding",
            source: "official_open_data_atom"
          })
      : overrides.amount;

  return {
    id: overrides.id ?? `${connectorLabel}:candidate-${index}`,
    sourceConnector: connector,
    sourceOpportunityId: overrides.sourceOpportunityId ?? `${connectorLabel}:source:${index}`,
    sourceNoticeVersionId: overrides.sourceNoticeVersionId ?? `${connectorLabel}:version:${index}`,
    canonicalId: overrides.canonicalId ?? `${connectorLabel}:canonical:${index}`,
    type,
    noticeType: overrides.noticeType ?? (type === "grant" ? "grant_call" : "active_contract_notice"),
    status: overrides.status ?? "open",
    title,
    description,
    publicationDate: overrides.publicationDate ?? "2026-08-10",
    modificationDate: overrides.modificationDate ?? "2026-08-12",
    deadline: overrides.deadline ?? parseSpanishDate("29/08/2026 14:00"),
    location,
    cpvCodes,
    keywords,
    procedureType: overrides.procedureType ?? (type === "grant" ? "" : "Open procedure"),
    estimatedValue: type === "grant" ? null : overrides.estimatedValue ?? amount,
    awardValue: overrides.awardValue ?? null,
    baseBudget: overrides.baseBudget ?? null,
    relevantValue: type === "grant" ? null : overrides.relevantValue ?? amount,
    wholeProcedureValue: overrides.wholeProcedureValue ?? null,
    annualValue: overrides.annualValue ?? null,
    multiYearValue: overrides.multiYearValue ?? null,
    maximumAidPerBeneficiary: type === "grant" ? overrides.maximumAidPerBeneficiary ?? amount : null,
    programmeBudget: overrides.programmeBudget ?? null,
    eligibleProjectCost: overrides.eligibleProjectCost ?? null,
    aidIntensity: overrides.aidIntensity ?? "",
    duration: overrides.duration ?? "",
    guarantees: overrides.guarantees ?? "",
    submissionMechanism: overrides.submissionMechanism ?? "",
    applicationUrl: overrides.applicationUrl ?? `https://example.com/${connectorLabel}/${index}/apply`,
    noticeUrl: overrides.noticeUrl ?? `https://example.com/${connectorLabel}/${index}`,
    referenceNumber: overrides.referenceNumber ?? `${connectorLabel.toUpperCase()}-${index}`,
    requiredDocuments: overrides.requiredDocuments ?? [],
    documents: overrides.documents ?? [],
    contacts: overrides.contacts ?? [],
    sources: overrides.sources ?? [
      {
        id: `${connectorLabel}-source-${index}`,
        organisation:
          connector === "bdns"
            ? "Sistema Nacional de Publicidad de Subvenciones y Ayudas Publicas"
            : connector == null
              ? "Manual import"
              : "Plataforma de Contratacion del Sector Publico",
        title:
          connector === "bdns"
            ? "Official BDNS API"
            : connector == null
              ? "Manual opportunity import"
              : "Official PLACSP ATOM feed",
        url:
          connector === "bdns"
            ? `https://www.infosubvenciones.es/bdnstrans/api/convocatorias?numConv=${index}&vpd=GE`
            : connector == null
              ? ""
              : `https://contrataciondelsectorpublico.gob.es/sindicacion/${index}.atom`,
        official: connector == null ? false : true,
        metadata: {
          sourceType:
            connector === "bdns"
              ? "official_snpsap_api"
              : connector == null
                ? "manual_import"
                : "official_open_data_atom"
        }
      }
    ],
    evidence: overrides.evidence ?? [],
    requirements: overrides.requirements ?? [],
    lots: overrides.lots ?? [],
    sourceConflicts: overrides.sourceConflicts ?? [],
    availabilityWarnings: overrides.availabilityWarnings ?? [],
    cancellationStatus: overrides.cancellationStatus ?? null,
    lastChecked: overrides.lastChecked ?? "2026-08-13T09:00:00.000Z"
  };
}

function makeDistractor(index, overrides = {}) {
  return makeOpportunity(index, {
    sourceConnector: overrides.sourceConnector ?? "placsp",
    title: overrides.title ?? `Road resurfacing package ${index}`,
    description:
      overrides.description ??
      "Civil engineering works for asphalt resurfacing, kerbs, drainage and traffic markings.",
    cpvCodes: overrides.cpvCodes ?? ["45233252"],
    keywords: overrides.keywords ?? ["roadworks", "asphalt"],
    location:
      overrides.location ?? {
        municipality: "Seville",
        province: "Seville",
        autonomousCommunity: "Andalusia",
        display: "Seville"
      },
    amount:
      overrides.amount ??
      createMoney({
        major: 900000,
        currency: "EUR",
        amountType: "estimated_value",
        vatStatus: "excluding",
        source: "official_open_data_atom"
      }),
    ...overrides
  });
}

function makeFixtureOpportunity(fixture, index) {
  const opportunity = structuredClone(fixture.opportunity);
  const connector = opportunity.type === "grant" ? "bdns" : "placsp";
  opportunity.id = `${fixture.id}:${opportunity.id}`;
  opportunity.canonicalId = opportunity.canonicalId ?? `${connector}:fixture:${fixture.id}`;
  opportunity.sourceConnector = connector;
  opportunity.sourceOpportunityId = `${connector}:fixture-source:${fixture.id}`;
  opportunity.sourceNoticeVersionId = `${connector}:fixture-version:${fixture.id}`;
  opportunity.sources = (
    Array.isArray(opportunity.sources) && opportunity.sources.length
      ? opportunity.sources
      : [
          {
            id: `${connector}-fixture-source-${index + 1}`,
            organisation:
              connector === "bdns"
                ? "Sistema Nacional de Publicidad de Subvenciones y Ayudas Publicas"
                : "Plataforma de Contratacion del Sector Publico",
            title: connector === "bdns" ? "Official BDNS API" : "Official PLACSP ATOM feed",
            url: `https://example.com/${connector}/${fixture.id}`,
            official: true
          }
        ]
  ).map((source, sourceIndex) => ({
    ...source,
    id: `${fixture.id}-${source.id ?? `source-${sourceIndex + 1}`}`,
    official: source.official !== false
  }));
  return opportunity;
}

test("candidate funnel preserves recall, forced inclusion, and safe hard exclusions on a large mixed corpus", () => {
  const company = baseCompany();
  const fixtureOpportunities = evaluationFixtures.map((fixture, index) => makeFixtureOpportunity(fixture, index));
  const relevantFixtureIds = evaluationFixtures
    .filter((fixture) => fixture.expected.relevant)
    .map((fixture) => `${fixture.id}:${fixture.opportunity.id}`);

  const weakTitleStrongCpv = makeOpportunity("weak-title-cpv", {
    id: "adversarial-a",
    title: "Service contract 2026-114",
    description: "Routine municipal service support.",
    cpvCodes: ["50711000"]
  });
  const genericTitleStrongDescription = makeOpportunity("generic-title-description", {
    id: "adversarial-b",
    title: "Open procedure 14/2026",
    description: "Preventive HVAC maintenance, climate systems retrofit support, and electrical backup integration.",
    cpvCodes: ["79993000"],
    keywords: ["hvac", "climate systems"]
  });
  const unusualBdnsGrant = makeOpportunity("bdns-strong", {
    id: "adversarial-c",
    type: "grant",
    sourceConnector: "bdns",
    title: "Linea 3 / expediente 44-2026",
    description: "Grant for SME solar PV self-consumption and electrical efficiency upgrades in Catalonia.",
    keywords: ["solar", "electrical", "efficiency"],
    maximumAidPerBeneficiary: createMoney({
      major: 40000,
      currency: "EUR",
      amountType: "maximum_grant",
      vatStatus: "unknown",
      source: "official_snpsap_api"
    }),
    programmeBudget: createMoney({
      major: 3000000,
      currency: "EUR",
      amountType: "programme_budget",
      vatStatus: "unknown",
      source: "official_snpsap_api"
    })
  });
  const sparseGeoRelevant = makeOpportunity("sparse-geo", {
    id: "adversarial-d",
    title: "Facilities service package",
    description: "Public contract.",
    cpvCodes: ["79993000"],
    keywords: [],
    location: {
      municipality: "Tarragona",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Tarragona"
    }
  });
  const unknownEligibilityStrong = makeOpportunity("unknown-eligibility", {
    id: "adversarial-e",
    title: "Electrical maintenance framework",
    description: "Electrical maintenance across public buildings and emergency circuits.",
    cpvCodes: ["50711000", "45315300"],
    requirements: [
      {
        id: "req-unknown-hard-gate",
        kind: "custom",
        label: "Installer classification must be confirmed",
        mandatory: true,
        gating: "hard",
        defaultStatus: "needs_verification",
        evidenceIds: []
      }
    ]
  });
  const highValueRelevant = makeOpportunity("high-value", {
    id: "adversarial-f",
    title: "High-value electrical infrastructure maintenance",
    description: "Electrical maintenance and industrial electrical support across municipal assets.",
    cpvCodes: ["50711000", "45315"],
    amount: createMoney({
      major: 600000,
      currency: "EUR",
      amountType: "estimated_value",
      vatStatus: "excluding",
      source: "official_open_data_atom"
    }),
    estimatedValue: createMoney({
      major: 600000,
      currency: "EUR",
      amountType: "estimated_value",
      vatStatus: "excluding",
      source: "official_open_data_atom"
    }),
    relevantValue: createMoney({
      major: 600000,
      currency: "EUR",
      amountType: "relevant_lot_value",
      vatStatus: "excluding",
      source: "official_open_data_atom"
    })
  });
  const missingAmountRelevant = makeOpportunity("missing-amount", {
    id: "adversarial-g",
    title: "Municipal solar maintenance opportunity",
    description: "Solar PV maintenance, inverter checks and electrical safety updates.",
    cpvCodes: ["0933", "50711000"],
    estimatedValue: null,
    relevantValue: null
  });
  const noApplicationUrlRelevant = makeOpportunity("missing-route", {
    id: "adversarial-h",
    title: "HVAC and electrical systems maintenance",
    description: "HVAC maintenance with electrical controls and backup systems.",
    cpvCodes: ["50730000", "50711000"],
    applicationUrl: ""
  });
  const savedLowScore = makeDistractor("saved-low-score", {
    id: "adversarial-i",
    sourceConnector: "placsp",
    title: "Waste collection route support",
    description: "Operational support unrelated to electrical, HVAC or solar capability.",
    cpvCodes: ["90511000"],
    keywords: ["waste", "collection"]
  });
  const manualLowScore = makeDistractor("manual-low-score", {
    id: "adversarial-j",
    sourceConnector: null,
    title: "Archive note on unrelated supplies",
    description: "Manual import with little relevance to the company's profile.",
    cpvCodes: ["30192000"],
    keywords: ["stationery"]
  });
  const expiredPerfectMatch = makeOpportunity("expired-perfect", {
    id: "adversarial-k",
    title: "Electrical maintenance contract — expired",
    description: "Electrical maintenance and low-voltage support for public facilities.",
    cpvCodes: ["50711000", "45315300"],
    deadline: parseSpanishDate("01/08/2026 10:00")
  });
  const cancelledPerfectMatch = makeOpportunity("cancelled-perfect", {
    id: "adversarial-l",
    title: "Cancelled solar PV programme",
    description: "Solar PV and electrical efficiency works.",
    cpvCodes: ["0933", "50711000"],
    status: "cancelled",
    cancellationStatus: true
  });

  const distractors = Array.from({ length: 260 }, (_, index) => makeDistractor(index + 1));
  const opportunities = [
    ...fixtureOpportunities,
    weakTitleStrongCpv,
    genericTitleStrongDescription,
    unusualBdnsGrant,
    sparseGeoRelevant,
    unknownEligibilityStrong,
    highValueRelevant,
    missingAmountRelevant,
    noApplicationUrlRelevant,
    savedLowScore,
    manualLowScore,
    expiredPerfectMatch,
    cancelledPerfectMatch,
    ...distractors
  ];

  const policy = getSearchDepthPolicy({ localDevelopment: true });
  const funnel = buildCandidateFunnel({
    company,
    opportunities,
    now: NOW,
    policy,
    savedOpportunityIds: [savedLowScore.id]
  });
  const selectedIds = new Set(funnel.selectedOpportunityIds);
  const safeExcludedIds = new Set(funnel.safeExcluded.map((item) => item.opportunityId));

  const fullPortfolio = analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, NOW);
  const fullRecommendedFixtureIds = new Set(
    fullPortfolio.recommended
      .map((item) => item.opportunityId)
      .filter((id) => relevantFixtureIds.includes(id))
  );

  assert.equal(funnel.sourceUniverseCount, opportunities.length);
  assert.equal(funnel.policy.defaultAnalysis, 75);
  assert.equal(funnel.policy.customerSurface, 25);
  assert.equal(funnel.policy.expansionBatch, 75);
  assert.equal(funnel.policy.maxAnalysis, 300);
  assert.equal(funnel.candidatePoolCount, 150);
  assert.equal(funnel.selectedForAnalysisCount, 75);
  assert.equal(new Set(funnel.selectedOpportunityIds).size, funnel.selectedOpportunityIds.length);
  assert.equal(fullRecommendedFixtureIds.size, relevantFixtureIds.length);

  relevantFixtureIds.forEach((id) => {
    assert.equal(selectedIds.has(id), true, `Relevant evaluation fixture should survive candidate screening: ${id}`);
  });

  [
    weakTitleStrongCpv.id,
    genericTitleStrongDescription.id,
    unusualBdnsGrant.id,
    sparseGeoRelevant.id,
    unknownEligibilityStrong.id,
    highValueRelevant.id,
    missingAmountRelevant.id,
    noApplicationUrlRelevant.id,
    savedLowScore.id,
    manualLowScore.id
  ].forEach((id) => {
    assert.equal(selectedIds.has(id), true, `Expected candidate to survive screening: ${id}`);
  });

  assert.equal(safeExcludedIds.has(expiredPerfectMatch.id), true);
  assert.equal(safeExcludedIds.has(cancelledPerfectMatch.id), true);
  assert.equal(selectedIds.has(expiredPerfectMatch.id), false);
  assert.equal(selectedIds.has(cancelledPerfectMatch.id), false);

  assert.match(
    funnel.byOpportunityId[savedLowScore.id].forcedReasons.join(","),
    /saved/
  );
  assert.match(
    funnel.byOpportunityId[manualLowScore.id].forcedReasons.join(","),
    /manual_or_demo/
  );
});

test("candidate funnel keeps strong PLACSP and BDNS matches inside a 2,100-record mixed corpus without artificial quotas", () => {
  const company = baseCompany();
  const placspStrong = makeOpportunity("placsp-strong", {
    id: "strong-placsp",
    sourceConnector: "placsp",
    title: "Electrical maintenance for public facilities",
    description: "Electrical maintenance, emergency circuits and low-voltage work.",
    cpvCodes: ["50711000", "45315300"],
    keywords: ["electrical maintenance", "hvac", "emergency circuits"],
    amount: createMoney({
      major: 84500,
      currency: "EUR",
      amountType: "estimated_value",
      vatStatus: "excluding",
      source: "official_open_data_atom"
    }),
    estimatedValue: createMoney({
      major: 84500,
      currency: "EUR",
      amountType: "estimated_value",
      vatStatus: "excluding",
      source: "official_open_data_atom"
    }),
    relevantValue: createMoney({
      major: 84500,
      currency: "EUR",
      amountType: "relevant_lot_value",
      vatStatus: "excluding",
      source: "official_open_data_atom"
    })
  });
  const bdnsStrong = makeOpportunity("bdns-strong-cross", {
    id: "strong-bdns",
    type: "grant",
    sourceConnector: "bdns",
    title: "Programme line 2026 / lot 4",
    description: "SME grant for solar PV, electrical efficiency and HVAC optimisation in Catalonia.",
    keywords: ["solar", "hvac", "efficiency"]
  });
  const placspDistractors = Array.from({ length: 1999 }, (_, index) => makeOpportunity(`placsp-${index + 1}`, {
    sourceConnector: "placsp",
    title: `Electrical maintenance tranche ${index + 1}`,
    description: "Electrical maintenance, HVAC controls and low-voltage support for public facilities.",
    cpvCodes: ["50711000", "45315300"],
    keywords: ["electrical maintenance", "hvac"],
    location: {
      municipality: "Barcelona",
      province: "Barcelona",
      autonomousCommunity: "Catalonia",
      display: "Barcelona"
    },
    amount: createMoney({
      major: 95000,
      currency: "EUR",
      amountType: "estimated_value",
      vatStatus: "excluding",
      source: "official_open_data_atom"
    }),
    estimatedValue: createMoney({
      major: 95000,
      currency: "EUR",
      amountType: "estimated_value",
      vatStatus: "excluding",
      source: "official_open_data_atom"
    }),
    relevantValue: createMoney({
      major: 95000,
      currency: "EUR",
      amountType: "relevant_lot_value",
      vatStatus: "excluding",
      source: "official_open_data_atom"
    })
  }));
  const bdnsDistractors = Array.from({ length: 99 }, (_, index) => makeDistractor(`bdns-${index + 1}`, {
    sourceConnector: "bdns",
    type: "grant",
    noticeType: "grant_call",
    cpvCodes: [],
    maximumAidPerBeneficiary: createMoney({
      major: 12000,
      currency: "EUR",
      amountType: "maximum_grant",
      vatStatus: "unknown",
      source: "official_snpsap_api"
    }),
    estimatedValue: null,
    relevantValue: null
  }));

  const funnel = buildCandidateFunnel({
    company,
    opportunities: [placspStrong, bdnsStrong, ...placspDistractors, ...bdnsDistractors],
    now: NOW,
    policy: getSearchDepthPolicy({ localDevelopment: true })
  });

  assert.equal(funnel.sourceUniverseCount, 2100);
  assert.equal(new Set(funnel.selectedOpportunityIds).has(placspStrong.id), true);
  assert.equal(new Set(funnel.selectedOpportunityIds).has(bdnsStrong.id), true);
  assert.ok(
    (funnel.connectorBreakdown.placsp?.selectedForAnalysis ?? 0) >
      (funnel.connectorBreakdown.bdns?.selectedForAnalysis ?? 0),
    "Conservative diversity should not create a simplistic 50/50 connector quota."
  );
});

test("candidate funnel expands in stable 75-opportunity batches and analysis cache reuses prior deterministic work", () => {
  const company = baseCompany();
  const opportunities = Array.from({ length: 340 }, (_, index) =>
    index % 17 === 0
      ? makeOpportunity(index + 1, {
          title: `Electrical maintenance tranche ${index + 1}`,
          description: "Electrical maintenance, HVAC controls and low-voltage support.",
          cpvCodes: ["50711000", "50730000"]
        })
      : makeDistractor(index + 1)
  );
  const policy = getSearchDepthPolicy({ localDevelopment: true });
  const funnel75 = buildCandidateFunnel({ company, opportunities, now: NOW, policy, analysisDepth: 75 });
  const funnel150 = buildCandidateFunnel({ company, opportunities, now: NOW, policy, analysisDepth: 150 });
  const funnel225 = buildCandidateFunnel({ company, opportunities, now: NOW, policy, analysisDepth: 225 });
  const funnel300 = buildCandidateFunnel({ company, opportunities, now: NOW, policy, analysisDepth: 300 });
  const funnelBeyondMax = buildCandidateFunnel({ company, opportunities, now: NOW, policy, analysisDepth: 375 });
  const cache = createAnalysisCache();

  const selected75 = new Set(funnel75.selectedOpportunityIds);
  const selected150 = new Set(funnel150.selectedOpportunityIds);
  const selected225 = new Set(funnel225.selectedOpportunityIds);
  const selected300 = new Set(funnel300.selectedOpportunityIds);

  cache.analyzePortfolio(company, funnel75.selectedForAnalysis, DEFAULT_RUNTIME, NOW);
  let metrics = cache.getMetrics();
  assert.equal(metrics.lastRunOpportunityCount, 75);
  assert.equal(metrics.lastRunHits, 0);
  assert.equal(metrics.lastRunMisses, 75);

  assert.equal(funnel150.selectedForAnalysisCount, 150);
  assert.equal(funnel225.selectedForAnalysisCount, 225);
  assert.equal(funnel300.selectedForAnalysisCount, 300);
  assert.equal(funnelBeyondMax.selectedForAnalysisCount, 300);

  funnel75.selectedOpportunityIds.forEach((id) => {
    assert.equal(selected150.has(id), true, `First batch should remain in the wider 150 selection: ${id}`);
  });
  funnel150.selectedOpportunityIds.forEach((id) => {
    assert.equal(selected225.has(id), true, `150-depth batch should remain in the wider 225 selection: ${id}`);
  });
  funnel225.selectedOpportunityIds.forEach((id) => {
    assert.equal(selected300.has(id), true, `225-depth batch should remain in the wider 300 selection: ${id}`);
  });

  cache.analyzePortfolio(company, funnel150.selectedForAnalysis, DEFAULT_RUNTIME, NOW);
  metrics = cache.getMetrics();
  assert.equal(metrics.lastRunOpportunityCount, 150);
  assert.equal(metrics.lastRunHits, 75);
  assert.equal(metrics.lastRunMisses, 75);

  cache.analyzePortfolio(company, funnel225.selectedForAnalysis, DEFAULT_RUNTIME, NOW);
  metrics = cache.getMetrics();
  assert.equal(metrics.lastRunOpportunityCount, 225);
  assert.equal(metrics.lastRunHits, 150);
  assert.equal(metrics.lastRunMisses, 75);

  cache.analyzePortfolio(company, funnel300.selectedForAnalysis, DEFAULT_RUNTIME, NOW);
  metrics = cache.getMetrics();
  assert.equal(metrics.lastRunOpportunityCount, 300);
  assert.equal(metrics.lastRunHits, 225);
  assert.equal(metrics.lastRunMisses, 75);
});
