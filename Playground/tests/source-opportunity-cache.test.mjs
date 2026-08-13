import test from "node:test";
import assert from "node:assert/strict";

import {
  createInMemorySourceCacheAdapter,
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
