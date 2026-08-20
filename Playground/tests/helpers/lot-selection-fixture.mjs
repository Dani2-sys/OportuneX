import { createDemoState } from "../../src/data/demo.js";
import { createCompanyFact, createCompanyRange, createCompanySource } from "../../src/domain/company-profile.js";
import { createMoney } from "../../src/domain/money.js";

export const LOT_SELECTION_FIXTURE_NOW = new Date("2026-08-20T09:00:00+02:00");

function source(id, organisation, title, url, publishedAt, lastChecked) {
  return { id, organisation, title, url, publishedAt, lastChecked, official: true };
}

function evidence(id, fieldKey, excerpt, sourceId, confidence = 0.92) {
  return { id, fieldKey, excerpt, sourceId, sourceType: "official_notice", confidence };
}

export function createFourLotSelectionFixture() {
  const state = createDemoState();
  const company = structuredClone(state.companyProfiles[0]);
  const opportunity = {
    id: "opp-four-lot-selection-fixture",
    canonicalId: "placsp-four-lot-selection-fixture",
    sourceOpportunityId: "PLACSP-FOUR-LOT-001",
    sourceNoticeVersionId: "PLACSP-FOUR-LOT-001-v1",
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: "HVAC and building-maintenance services across mutual sites",
    description: "Four explicit lots for HVAC, electrical, monitoring and plumbing support.",
    issuingOrganisation: "Mutual facilities authority",
    contractingAuthority: "Mutual facilities authority",
    publicationDate: "2026-08-10",
    deadline: {
      date: "2026-09-18",
      time: "14:00",
      timezone: "Europe/Madrid",
      sourceText: "18/09/2026 14:00"
    },
    location: {
      municipality: "Castellon de la Plana",
      province: "Castellon",
      autonomousCommunity: "Valencian Community",
      country: "Spain",
      display: "Eastern Spain sites"
    },
    cpvCodes: ["50730000", "50700000", "45310000"],
    estimatedValue: createMoney({ major: 620000, amountType: "estimated_value", vatStatus: "excluding" }),
    wholeProcedureValue: createMoney({ major: 620000, amountType: "estimated_value", vatStatus: "excluding" }),
    relevantValue: createMoney({ major: 139136, amountType: "relevant_lot_value", vatStatus: "excluding" }),
    duration: "24 months",
    guarantees: "5% definitive guarantee on the awarded lot",
    applicationUrl: "https://official.example.test/four-lot/apply",
    noticeUrl: "https://official.example.test/four-lot/notice",
    referenceNumber: "FOUR-LOT-2026-01",
    requiredDocuments: ["Technical offer", "Economic offer"],
    contacts: [{ role: "authority", name: "Mutual procurement office", email: "procurement@example.test" }],
    sources: [
      source(
        "source-four-lot",
        "Mutual facilities authority",
        "Official multi-lot notice",
        "https://official.example.test/four-lot/notice",
        "2026-08-10",
        "2026-08-20T08:45:00+02:00"
      )
    ],
    evidence: [
      evidence("ev-four-lot-deadline", "deadline", "Submission deadline: 18/09/2026 14:00.", "source-four-lot"),
      evidence("ev-four-lot-procedure", "wholeProcedureValue", "Estimated procedure value: EUR 620,000 excluding VAT.", "source-four-lot"),
      evidence("ev-four-lot-lot-1", "relevantValue", "Lote I estimated value: EUR 139,136 excluding VAT.", "source-four-lot"),
      evidence("ev-four-lot-lot-3", "relevantValue", "Lote III estimated value: EUR 121,000 excluding VAT.", "source-four-lot"),
      evidence("ev-four-lot-route", "submission_route", "Electronic procurement submission portal.", "source-four-lot")
    ],
    requirements: [],
    lots: [
      {
        id: "lot-i-hvac",
        title: "Lote I",
        description:
          "Preventive and corrective HVAC and climate-system maintenance for hospital and office installations, including building-maintenance coverage.",
        cpvCodes: ["50730000", "50700000"],
        keywords: ["hvac", "climate", "maintenance"],
        value: createMoney({ major: 139136, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        location: {
          municipality: "Castellon de la Plana",
          province: "Castellon",
          autonomousCommunity: "Valencian Community",
          country: "Spain",
          display: "Castellon and Valencia"
        },
        requirements: []
      },
      {
        id: "lot-ii-electrical",
        title: "Lote II",
        description:
          "Low-voltage electrical support and switchboard interventions for eastern region sites.",
        cpvCodes: ["45310000", "45315300"],
        keywords: ["electrical", "switchboard"],
        value: createMoney({ major: 155000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        location: {
          municipality: "Madrid",
          province: "Madrid",
          autonomousCommunity: "Madrid",
          country: "Spain",
          display: "Madrid"
        },
        requirements: []
      },
      {
        id: "lot-iii-catalonia",
        title: "Lote III",
        description:
          "Catalonia monitoring-system supervision with limited HVAC support for satellite facilities.",
        cpvCodes: ["50730000", "50324200"],
        keywords: ["monitoring", "hvac support"],
        value: createMoney({ major: 121000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        location: {
          municipality: "Reus",
          province: "Tarragona",
          autonomousCommunity: "Catalonia",
          country: "Spain",
          display: "Catalonia"
        },
        requirements: []
      },
      {
        id: "lot-iv-plumbing",
        title: "Lote IV",
        description:
          "Plumbing and hydraulic interventions outside the company's core specialist focus.",
        cpvCodes: ["45330000"],
        keywords: ["plumbing", "hydraulic"],
        value: createMoney({ major: 162000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        location: {
          municipality: "Alicante",
          province: "Alicante",
          autonomousCommunity: "Valencian Community",
          country: "Spain",
          display: "Alicante"
        },
        requirements: []
      }
    ]
  };

  return { company, opportunity, now: new Date(LOT_SELECTION_FIXTURE_NOW) };
}

export function createLiveLotDifferentiationFixture() {
  const company = {
    id: "company-live-lot-differentiation",
    profileMode: "prospect",
    legalName: "COMERCIAL MIFER SOCIEDAD LIMITADA",
    tradingName: "Instalaciones Mifer",
    preferredLanguage: "es",
    companySources: [
      createCompanySource({
        id: "company-source-live-lot",
        organisation: "Public registry",
        title: "Public company profile",
        url: "https://public.example.test/mifer",
        sourceType: "public_registry",
        publishedAt: "2026-08-18",
        retrievedAt: "2026-08-20T08:30:00+02:00"
      })
    ],
    geography: {
      municipality: "Reus",
      province: "Tarragona",
      autonomousCommunity: "Catalonia"
    },
    capabilities: [
      {
        id: "hvac",
        label: "HVAC and climate systems",
        level: "high",
        strength: "high",
        status: "public_verified",
        aliases: [],
        cpvPrefixes: ["5073"],
        sourceIds: ["company-source-live-lot"]
      }
    ],
    preferences: {},
    experience: {
      maximumProjectValue: 180000
    },
    facts: {
      employeeRange: createCompanyRange({
        min: 5,
        max: 9,
        referenceYear: 2025,
        status: "public_reported",
        confidence: "medium",
        sourceIds: ["company-source-live-lot"],
        asOfDate: "2025-12-31"
      }),
      turnoverRange: createCompanyRange({
        min: 500000,
        max: 1000000,
        referenceYear: 2025,
        status: "public_reported",
        confidence: "medium",
        sourceIds: ["company-source-live-lot"],
        asOfDate: "2025-12-31"
      }),
      maximumProjectValue: createCompanyFact(180000, {
        status: "public_verified",
        confidence: "medium",
        sourceIds: ["company-source-live-lot"],
        asOfDate: "2026-08-18"
      })
    },
    classifications: {},
    certifications: [],
    insurance: [],
    grants: {}
  };

  const procedureTitle =
    "Servicio de mantenimiento de las instalaciones de climatizacion, ventilacion y tratamiento de aire de los centros asistenciales y administrativos";
  const sharedDescription =
    "Procedimiento con lotes explicitos para el mantenimiento preventivo y correctivo de climatizacion, ventilacion y tratamiento de aire.";
  const sharedCpvCodes = ["50730000", "50700000"];
  const sharedKeywords = ["mantenimiento", "climatizacion", "ventilacion"];
  const requirement = {
    id: "req-required-installer-classification",
    kind: "custom",
    label: "Required installer classification",
    mandatory: true,
    gating: "hard",
    question: "Can the company evidence the required installer classification?"
  };

  const lot = (id, display, autonomousCommunity, major) => ({
    id,
    title: procedureTitle,
    description: sharedDescription,
    cpvCodes: sharedCpvCodes,
    keywords: sharedKeywords,
    value: createMoney({ major, amountType: "relevant_lot_value", vatStatus: "excluding" }),
    location: {
      display,
      autonomousCommunity,
      country: "Spain"
    },
    requirements: []
  });

  const opportunity = {
    id: "opp-live-lot-differentiation",
    canonicalId: "placsp-live-lot-differentiation",
    sourceOpportunityId: "PLACSP-LIVE-LOT-DIFFERENTIATION-001",
    sourceNoticeVersionId: "PLACSP-LIVE-LOT-DIFFERENTIATION-001-v1",
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: procedureTitle,
    description: sharedDescription,
    issuingOrganisation: "Union de Mutuas",
    contractingAuthority: "Union de Mutuas",
    publicationDate: "2026-08-18",
    deadline: {
      date: "2026-09-30",
      time: "12:00",
      timezone: "Europe/Madrid",
      sourceText: "30/09/2026 12:00"
    },
    location: {
      display: "Spain",
      country: "Spain"
    },
    cpvCodes: sharedCpvCodes,
    estimatedValue: createMoney({ major: 620000, amountType: "estimated_value", vatStatus: "excluding" }),
    wholeProcedureValue: createMoney({ major: 620000, amountType: "estimated_value", vatStatus: "excluding" }),
    applicationUrl: "https://official.example.test/live-lot/apply",
    noticeUrl: "https://official.example.test/live-lot/notice",
    referenceNumber: "LIVE-LOT-2026-01",
    requiredDocuments: ["Technical offer"],
    contacts: [{ role: "authority", name: "Procurement office" }],
    sources: [
      source(
        "source-live-lot",
        "Union de Mutuas",
        "Official notice",
        "https://official.example.test/live-lot/notice",
        "2026-08-18",
        "2026-08-20T08:45:00+02:00"
      )
    ],
    evidence: [
      evidence("ev-live-lot-title", "title", procedureTitle, "source-live-lot"),
      evidence("ev-live-lot-route", "submission_route", "Electronic procurement submission portal.", "source-live-lot")
    ],
    requirements: [requirement],
    lots: [
      lot("Lote I", "Castellon/Castello", "Comunitat Valenciana", 139136),
      lot("Lote II", "Comunitat Valenciana", "Comunitat Valenciana", 145000),
      lot("Lote III", "Cataluna", "Cataluna", 121000),
      lot("Lote IV", "Espana / multiple regions", "Espana / multiple regions", 155000)
    ]
  };

  return { company, opportunity, now: new Date(LOT_SELECTION_FIXTURE_NOW) };
}
