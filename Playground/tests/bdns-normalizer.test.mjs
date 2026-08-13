import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createDemoState } from "../src/data/demo.js";
import { buildFinancialPicture } from "../src/domain/financial-picture.js";
import { evaluateEligibility } from "../src/domain/eligibility.js";
import {
  buildBdnsSemanticVersion,
  deterministicBdnsOpportunityId,
  normalizeBdnsOpportunity
} from "../src/connectors/bdns-normalizer.js";

async function loadCatalog() {
  return JSON.parse(
    await readFile(new URL("./fixtures/bdns/details-catalog.json", import.meta.url), "utf8")
  );
}

test("BDNS code creates a stable canonical id and semantic version ignores fetchedAt-only changes", async () => {
  const catalog = await loadCatalog();
  const detail = catalog.normalSmeGrant;
  const first = normalizeBdnsOpportunity(detail, {
    fetchedAt: "2026-08-13T08:00:00.000Z",
    now: new Date("2026-08-13T08:00:00.000Z")
  });
  const second = normalizeBdnsOpportunity(detail, {
    fetchedAt: "2026-08-13T10:00:00.000Z",
    now: new Date("2026-08-13T10:00:00.000Z")
  });
  const corrected = normalizeBdnsOpportunity(catalog.correctedSemantics, {
    fetchedAt: "2026-08-13T10:00:00.000Z",
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(first.id, deterministicBdnsOpportunityId("700001"));
  assert.equal(first.id, second.id);
  assert.equal(first.sourceNoticeVersionId, second.sourceNoticeVersionId);
  assert.equal(first.sourceNoticeVersionId, buildBdnsSemanticVersion(detail));
  assert.notEqual(first.sourceNoticeVersionId, corrected.sourceNoticeVersionId);
});

test("BDNS semantic version stays stable across unordered array order changes but changes on real semantic edits", async () => {
  const catalog = await loadCatalog();
  const baseDetail = {
    ...catalog.normalSmeGrant,
    tiposBeneficiarios: [
      { codigo: "SME", descripcion: "PYME" },
      { codigo: "COOP", descripcion: "COOPERATIVAS" }
    ],
    sectores: [
      { codigo: "4321", descripcion: "Electrical installation" },
      { codigo: "4322", descripcion: "Plumbing, heat and air-conditioning installation" }
    ],
    regiones: [
      { codigo: "ES51", descripcion: "Catalonia" },
      { codigo: "ES52", descripcion: "Valencian Community" }
    ],
    fondos: ["FEDER", "NextGenerationEU"],
    objetivos: ["Digitalizacion", "Descarbonizacion"],
    sectoresProductos: ["Solar equipment", "Battery systems"],
    documentos: [
      {
        id: "doc-z",
        nombreFic: "bases-z.pdf",
        descripcion: "Bases reguladoras",
        datPublicacion: "2026-07-20"
      },
      {
        id: "doc-a",
        nombreFic: "faq-a.pdf",
        descripcion: "Preguntas frecuentes",
        datPublicacion: "2026-07-21"
      }
    ],
    anuncios: [
      {
        numAnuncio: "B-700001-2",
        titulo: "Correccion",
        url: "https://boe.example/anuncio/700001-correccion",
        datPublicacion: "2026-07-22"
      },
      {
        numAnuncio: "B-700001-1",
        titulo: "Extracto inicial",
        url: "https://boe.example/anuncio/700001-inicial",
        datPublicacion: "2026-07-20"
      }
    ]
  };
  const shuffledDetail = {
    ...baseDetail,
    tiposBeneficiarios: [...baseDetail.tiposBeneficiarios].reverse(),
    sectores: [...baseDetail.sectores].reverse(),
    regiones: [...baseDetail.regiones].reverse(),
    fondos: [...baseDetail.fondos].reverse(),
    objetivos: [...baseDetail.objetivos].reverse(),
    sectoresProductos: [...baseDetail.sectoresProductos].reverse(),
    documentos: [...baseDetail.documentos].reverse(),
    anuncios: [...baseDetail.anuncios].reverse()
  };

  const baselineVersion = buildBdnsSemanticVersion(baseDetail);
  assert.equal(buildBdnsSemanticVersion(shuffledDetail), baselineVersion);

  const changedCases = [
    {
      label: "beneficiary type",
      detail: {
        ...baseDetail,
        tiposBeneficiarios: [{ codigo: "LARGE", descripcion: "GRAN EMPRESA" }]
      }
    },
    {
      label: "region",
      detail: {
        ...baseDetail,
        regiones: [{ codigo: "ES61", descripcion: "Andalusia" }]
      }
    },
    {
      label: "deadline",
      detail: {
        ...baseDetail,
        fechaFinSolicitud: "2026-09-30"
      }
    },
    {
      label: "programme budget",
      detail: {
        ...baseDetail,
        presupuestoTotal: "2000000"
      }
    },
    {
      label: "application URL",
      detail: {
        ...baseDetail,
        sedeElectronica: "https://sede.example.gob.es/grants/700001-v2"
      }
    },
    {
      label: "document metadata",
      detail: {
        ...baseDetail,
        documentos: [
          {
            ...baseDetail.documentos[0],
            datPublicacion: "2026-07-25"
          },
          baseDetail.documentos[1]
        ]
      }
    }
  ];

  changedCases.forEach(({ label, detail }) => {
    assert.notEqual(buildBdnsSemanticVersion(detail), baselineVersion, `Expected ${label} change to alter sourceNoticeVersionId`);
  });
});

test("BDNS programme budget stays separate from any company-amount grant semantics", async () => {
  const catalog = await loadCatalog();
  const opportunity = normalizeBdnsOpportunity(catalog.programmeBudgetOnly, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });
  const financialPicture = buildFinancialPicture(opportunity);

  assert.equal(opportunity.programmeBudget.amountMinor, 1000000000);
  assert.equal(opportunity.maximumAidPerBeneficiary, null);
  assert.equal(opportunity.eligibleProjectCost, null);
  assert.equal(opportunity.relevantValue, null);
  assert.equal(financialPicture.kind, "grant");
  assert.equal(financialPicture.primaryLine.id, "programme_budget");
  assert.equal(financialPicture.primaryLine.label, "Programme budget");
});

test("BDNS deadline normalization preserves date-only semantics and does not equate abierto=false with closed", async () => {
  const catalog = await loadCatalog();
  const fixed = normalizeBdnsOpportunity(catalog.fixedWindow, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });
  const futureOpen = normalizeBdnsOpportunity(catalog.futureDeadlineAbiertoFalse, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });
  const indefinite = normalizeBdnsOpportunity(catalog.indefiniteOpen, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });
  const descriptive = normalizeBdnsOpportunity(catalog.descriptiveTextFin, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });
  const recentReceptionExpired = normalizeBdnsOpportunity(
    {
      ...catalog.fixedWindow,
      fechaRecepcion: "2026-08-12",
      fechaFinSolicitud: "2026-08-01",
      abierto: false
    },
    {
      fetchedAt: "2026-08-13T09:00:00.000Z",
      now: new Date("2026-08-13T09:00:00.000Z")
    }
  );

  assert.equal(fixed.deadline.date, "2026-10-01");
  assert.equal(fixed.deadline.time, null);
  assert.equal(fixed.deadline.utcEquivalent, null);
  assert.equal(futureOpen.status, "open");
  assert.equal(indefinite.status, "open");
  assert.equal(indefinite.deadline, null);
  assert.equal(recentReceptionExpired.status, "closed");
  assert.equal(descriptive.deadline, null);
  assert.match(
    descriptive.availabilityWarnings.find((item) => /closing text/i.test(item.title))?.detail ?? "",
    /agotamiento del credito/i
  );
});

test("BDNS beneficiary categories remain conservative and impact regions do not become a headquarters gate", async () => {
  const catalog = await loadCatalog();
  const multiBeneficiary = normalizeBdnsOpportunity(catalog.multipleBeneficiaryTypes, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });
  const multiRegion = normalizeBdnsOpportunity(catalog.multipleImpactRegions, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });
  const company = createDemoState().companyProfiles[0];
  const eligibility = evaluateEligibility(company, multiBeneficiary, null, new Date("2026-08-13T09:00:00.000Z"));

  assert.equal(multiBeneficiary.requirements.length, 1);
  assert.equal(multiBeneficiary.requirements[0].kind, "custom");
  assert.equal(multiBeneficiary.requirements[0].defaultStatus, "needs_verification");
  assert.equal(eligibility.eligibilityStatus, "ELIGIBILITY_UNCLEAR");
  assert.equal(eligibility.blockers.length, 0);
  assert.equal(multiRegion.requirements.some((item) => item.kind === "region"), false);
  assert.match(multiRegion.location.display, /Catalonia/);
  assert.match(multiRegion.location.display, /Valencian Community/);
});

test("BDNS documents stay separate from required submission documents and explicit ANULADA is cancelled", async () => {
  const catalog = await loadCatalog();
  const documents = normalizeBdnsOpportunity(catalog.documentsRich, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });
  const cancelled = normalizeBdnsOpportunity(catalog.explicitAnulada, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });
  const stateAid = normalizeBdnsOpportunity(catalog.stateAidEuFunds, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });

  assert.equal(documents.requiredDocuments.length, 0);
  assert.deepEqual(documents.documents, ["Bases reguladoras", "Preguntas frecuentes"]);
  assert.equal(documents.sources[0].metadata.documents.length, 2);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.noticeType, "cancellation");
  assert.equal(cancelled.cancellationStatus, "anulada");
  assert.deepEqual(stateAid.sources[0].metadata.euFunds, ["FEDER", "NextGenerationEU"]);
  assert.equal(stateAid.sources[0].metadata.stateAid.url, "https://competition.example/sa700011");
});

test("BDNS human notice URLs, object-array EU funds, and bare WWW official routes normalize safely", () => {
  const liveLikeDetail = {
    codigoBDNS: "924882",
    numeroConvocatoria: "924882",
    descripcion: "BECAS/AYUDAS POR ASISTENCIA A LA FORMACION DEL PROGRAMA EFESO DON BENITO.FNANCIADO POR EL FSE+ 2021-2027",
    fechaRecepcion: "2026-08-13",
    fechaInicioSolicitud: "2026-10-15",
    fechaFinSolicitud: "2026-11-14",
    abierto: false,
    sedeElectronica: "WWW.DONBENITO.ES",
    presupuestoTotal: 72630,
    tipoConvocatoria: "Concesión directa - canónica",
    tiposBeneficiarios: [{ descripcion: "PERSONAS FÍSICAS QUE NO DESARROLLAN ACTIVIDAD ECONÓMICA" }],
    sectores: [{ codigo: "85.5", descripcion: "Otra educación" }],
    regiones: [{ descripcion: "ES431 - Badajoz" }],
    descripcionFinalidad: "Educación",
    descripcionBasesReguladoras: "BASES REGULADORAS DE LAS BECAS/AYUDAS POR ASISTENCIA A LA FORMACION DEL PROGRAMA EFESO DON BENITO FINANCIADO POR EL FSE+2021-2027",
    urlBasesReguladoras: "WWW.DONBENITO.ES",
    fondos: [{ descripcion: "FSE+ - FONDO SOCIAL EUROPEO PLUS" }],
    reglamento: [{ descripcion: "Reglamento (UE) 2021/1057" }],
    objetivos: [{ descripcion: "Formación" }],
    organo: {
      nivel1: "LOCAL",
      nivel2: "DON BENITO",
      nivel3: "AYUNTAMIENTO DE DON BENITO"
    }
  };

  const opportunity = normalizeBdnsOpportunity(liveLikeDetail, {
    fetchedAt: "2026-08-13T09:00:00.000Z",
    now: new Date("2026-08-13T09:00:00.000Z")
  });

  assert.equal(opportunity.noticeUrl, "https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/924882");
  assert.equal(opportunity.applicationUrl, "https://WWW.DONBENITO.ES");
  assert.equal(opportunity.sources[0].metadata.regulatoryBasis.url, "https://WWW.DONBENITO.ES");
  assert.deepEqual(opportunity.sources[0].metadata.euFunds, ["FSE+ - FONDO SOCIAL EUROPEO PLUS"]);
  assert.deepEqual(opportunity.sources[0].metadata.regulation, ["Reglamento (UE) 2021/1057"]);
  assert.deepEqual(opportunity.sources[0].metadata.objectives, ["Formación"]);
});
