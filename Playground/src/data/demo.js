import { createMoney } from "../domain/money.js";
import { parseSpanishDate } from "../domain/deadline.js";

function source(id, organisation, title, url, publishedAt, lastChecked, official = true) {
  return { id, organisation, title, url, publishedAt, lastChecked, official };
}

function evidence(id, fieldKey, excerpt, sourceId, confidence = 0.92) {
  return { id, fieldKey, excerpt, sourceId, sourceType: "official_notice", confidence };
}

function certificationRequirement(id, label, requiredValue, evidenceIds, question) {
  return {
    id,
    kind: "certification",
    label,
    requiredValue,
    mandatory: true,
    gating: "hard",
    evidenceIds,
    question
  };
}

export const demoCompany = {
  id: "company-demo",
  legalName: "Instalaciones Demo Tarragona SL",
  tradingName: "Instalaciones Demo Tarragona",
  cif: "B00000001",
  preferredLanguage: "es",
  website: "https://instalaciones-demo.example",
  geography: {
    municipality: "Tarragona",
    province: "Tarragona",
    autonomousCommunity: "Catalonia",
    preferredWorkingRadiusKm: 100,
    acceptedRegions: ["Catalonia"],
    excludedRegions: [],
    willingToTravel: true
  },
  size: {
    employeeBand: "10-25",
    turnoverBand: "1m-2m",
    companyAgeYears: 11,
    smeStatus: "confirmed",
    legalEntityType: "SL"
  },
  capabilities: [
    { id: "electrical-installation", label: "Electrical installation", level: "high", aliases: [], cpvPrefixes: ["4531", "45311"] },
    { id: "industrial-electrical", label: "Industrial electrical work", level: "medium", aliases: [], cpvPrefixes: ["45315", "5111"] },
    { id: "hvac", label: "HVAC and climate systems", level: "high", aliases: [], cpvPrefixes: ["4251", "45331", "5073"] },
    { id: "solar-pv", label: "Solar PV", level: "high", aliases: [], cpvPrefixes: ["0933", "45261"] },
    { id: "maintenance", label: "Building and industrial maintenance", level: "high", aliases: [], cpvPrefixes: ["5000", "5071"] }
  ],
  certifications: [
    { name: "ISO 9001", status: "unknown" },
    { name: "ISO 14001", status: "missing" }
  ],
  preferences: {
    minimumAttractiveProjectValue: 10000,
    idealProjectValue: 85000,
    maximumRealisticProjectValue: 250000,
    desiredWorkTypes: ["electrical", "maintenance", "hvac", "solar"],
    unwantedWorkTypes: ["civil engineering"]
  },
  experience: {
    yearsInTrade: 12,
    maximumProjectValue: 220000,
    publicProcurementProjects: 1,
    representativeProjects: [
      "Municipal lighting upgrade in Reus (€140,000)",
      "Industrial HVAC retrofit in Tarragona (€180,000)"
    ]
  },
  insurance: [{ name: "Civil liability", coverAmount: 600000 }],
  grants: {
    canCoFinance: true,
    minimumWorthwhileSubsidy: 20000,
    deMinimisUsage: "unknown"
  }
};

const demoLastChecked = "2026-08-07T08:12:00+02:00";

export const demoOpportunities = [
  {
    id: "opp-electrical-maintenance",
    canonicalId: "placsp-2026-001",
    sourceOpportunityId: "PLACSP-2026-001",
    sourceNoticeVersionId: "PLACSP-2026-001-v2",
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: "Electrical maintenance contract — Tarragona municipal facilities",
    description:
      "Preventive and corrective maintenance of municipal electrical systems, low-voltage boards and emergency circuits across Tarragona facilities.",
    issuingOrganisation: "Ajuntament de Tarragona",
    contractingAuthority: "Ajuntament de Tarragona",
    publicationDate: "2026-08-01",
    modificationDate: "2026-08-04",
    startDate: "2026-08-02",
    deadline: parseSpanishDate("26/08/2026 14:00"),
    location: {
      municipality: "Tarragona",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Tarragona"
    },
    cpvCodes: ["50711000", "45315300"],
    keywords: ["electrical maintenance", "facility maintenance", "municipal buildings"],
    procedureType: "Open procedure",
    estimatedValue: createMoney({ major: 210000, amountType: "estimated_value", vatStatus: "excluding" }),
    baseBudget: createMoney({ major: 198000, amountType: "base_budget", vatStatus: "excluding" }),
    relevantValue: createMoney({ major: 84500, amountType: "relevant_lot_value", vatStatus: "excluding" }),
    duration: "12 months + 12 optional",
    guarantees: "Definitive guarantee 5%",
    submissionMechanism: "Electronic submission via the Ajuntament procurement portal",
    applicationUrl: "https://official.oportunex.local/tarragona-maintenance/apply",
    noticeUrl: "https://official.oportunex.local/tarragona-maintenance/notice",
    referenceNumber: "TGN-EM-2026-44",
    requiredDocuments: ["Administrative declaration", "Pricing schedule", "Technical staffing plan"],
    documents: ["Notice PDF", "Administrative clauses", "Technical clauses", "Pricing sheet"],
    lastChecked: demoLastChecked,
    contacts: [
      { role: "authority", name: "Procurement Office — Tarragona", email: "contractacio@tarragona.cat", phone: "+34 977 296 100" },
      { role: "submission", name: "Municipal procurement portal", email: "licitacio@tarragona.cat", phone: "+34 977 296 140" },
      { role: "technical_support", name: "Platform technical support", email: "support@platform.example", phone: "+34 900 000 111" }
    ],
    sources: [
      source(
        "source-tgn-maintenance",
        "Ajuntament de Tarragona",
        "Official tender notice",
        "https://official.oportunex.local/tarragona-maintenance/notice",
        "2026-08-01",
        demoLastChecked
      )
    ],
    evidence: [
      evidence("ev-tgn-status", "status", "Open procedure published for tendering", "source-tgn-maintenance"),
      evidence("ev-tgn-deadline", "deadline", "Closing date: 26/08/2026 14:00", "source-tgn-maintenance"),
      evidence("ev-tgn-location", "location", "Execution place: Tarragona municipal facilities", "source-tgn-maintenance"),
      evidence("ev-tgn-lot-value", "lot_value", "Lot 2 estimated value: 84,500 EUR excluding VAT", "source-tgn-maintenance"),
      evidence("ev-tgn-requirements", "requirements", "Lot 2 requires ISO 9001 and one similar maintenance contract over 60,000 EUR", "source-tgn-maintenance"),
      evidence("ev-tgn-route", "submission_route", "Electronic submission through the municipal procurement profile", "source-tgn-maintenance"),
      evidence("ev-tgn-notice", "official_notice", "Ajuntament de Tarragona official notice", "source-tgn-maintenance"),
      evidence("ev-tgn-contacts", "contacts", "Contact point: contractacio@tarragona.cat", "source-tgn-maintenance")
    ],
    requirements: [
      certificationRequirement(
        "req-tgn-iso9001",
        "Valid ISO 9001 certification",
        "ISO 9001",
        ["ev-tgn-requirements"],
        "This opportunity requires ISO 9001. Does your company currently hold a valid ISO 9001 certification?"
      ),
      {
        id: "req-tgn-public-experience",
        kind: "public_experience",
        label: "At least one comparable public maintenance contract",
        minimumCount: 1,
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-tgn-requirements"]
      }
    ],
    lots: [
      {
        id: "lot-tgn-2",
        title: "Lot 2 — Electrical systems",
        description: "Maintenance of electrical boards, emergency circuits and municipal electrical installations.",
        cpvCodes: ["50711000", "45315300"],
        keywords: ["electrical", "maintenance"],
        value: createMoney({ major: 84500, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        requirements: []
      }
    ]
  },
  {
    id: "opp-multi-lot-framework",
    canonicalId: "placsp-2026-088",
    sourceOpportunityId: "PLACSP-2026-088",
    sourceNoticeVersionId: "PLACSP-2026-088-v1",
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: "Framework agreement for building installations across Camp de Tarragona",
    description:
      "Multi-lot framework for electrical, plumbing and climate-system interventions in regional public buildings.",
    issuingOrganisation: "Consell Comarcal del Tarragones",
    contractingAuthority: "Consell Comarcal del Tarragones",
    publicationDate: "2026-08-03",
    deadline: parseSpanishDate("29/08/2026 12:00"),
    location: {
      municipality: "Tarragona",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Camp de Tarragona"
    },
    cpvCodes: ["45310000", "45330000", "45331000"],
    procedureType: "Framework agreement",
    estimatedValue: createMoney({ major: 2400000, amountType: "estimated_value", vatStatus: "excluding" }),
    relevantValue: createMoney({ major: 96000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
    duration: "24 months",
    guarantees: "5% definitive guarantee on awarded lot",
    submissionMechanism: "Regional electronic procurement profile",
    applicationUrl: "https://official.oportunex.local/framework/installations/apply",
    noticeUrl: "https://official.oportunex.local/framework/installations/notice",
    referenceNumber: "CC-TGN-2026-88",
    documents: ["Notice PDF", "Framework clauses", "Lot matrix"],
    requiredDocuments: ["Administrative declaration", "Insurance evidence"],
    lastChecked: "2026-08-07T07:45:00+02:00",
    contacts: [
      { role: "authority", name: "Regional procurement office", email: "compres@tarragones.cat", phone: "+34 977 244 500" }
    ],
    sources: [
      source(
        "source-framework",
        "Consell Comarcal del Tarragones",
        "Framework agreement notice",
        "https://official.oportunex.local/framework/installations/notice",
        "2026-08-03",
        "2026-08-07T07:45:00+02:00"
      )
    ],
    evidence: [
      evidence("ev-frame-status", "status", "Framework open for submission", "source-framework"),
      evidence("ev-frame-deadline", "deadline", "Submission deadline: 29/08/2026 12:00", "source-framework"),
      evidence("ev-frame-location", "location", "Execution region: Camp de Tarragona", "source-framework"),
      evidence("ev-frame-lot-value", "lot_value", "Lot 2 estimated value: 96,000 EUR excluding VAT", "source-framework"),
      evidence("ev-frame-requirements", "requirements", "Insurance cover of 300,000 EUR required for each awarded lot", "source-framework"),
      evidence("ev-frame-route", "submission_route", "Regional electronic procurement profile", "source-framework"),
      evidence("ev-frame-notice", "official_notice", "Official framework notice", "source-framework"),
      evidence("ev-frame-contacts", "contacts", "Regional procurement office", "source-framework")
    ],
    requirements: [
      {
        id: "req-frame-insurance",
        kind: "insurance",
        label: "Civil liability insurance",
        minimumAmount: 300000,
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-frame-requirements"]
      }
    ],
    lots: [
      {
        id: "lot-frame-electrical",
        title: "Lot 2 — Electrical systems",
        description: "Electrical works and low-voltage interventions.",
        cpvCodes: ["45310000", "45315300"],
        keywords: ["electrical", "low-voltage"],
        value: createMoney({ major: 96000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        requirements: []
      },
      {
        id: "lot-frame-plumbing",
        title: "Lot 3 — Plumbing",
        description: "Hydraulic and plumbing interventions.",
        cpvCodes: ["45330000"],
        keywords: ["plumbing"],
        value: createMoney({ major: 120000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        requirements: []
      }
    ]
  },
  {
    id: "opp-efficiency-grant",
    canonicalId: "bdns-2026-551",
    sourceOpportunityId: "BDNS-2026-551",
    sourceNoticeVersionId: "BDNS-2026-551-v3",
    type: "grant",
    noticeType: "grant_call",
    status: "open",
    title: "Catalonia energy-efficiency grant for SME building services",
    description:
      "Competitive subsidy for SMEs investing in energy-efficiency retrofits, digital controls and photovoltaic self-consumption assets.",
    issuingOrganisation: "Generalitat de Catalunya",
    contractingAuthority: "Institut Català d'Energia",
    publicationDate: "2026-07-30",
    modificationDate: "2026-08-05",
    deadline: parseSpanishDate("12/09/2026"),
    location: {
      municipality: "Catalonia",
      province: "Catalonia",
      autonomousCommunity: "Catalonia",
      display: "Catalonia"
    },
    cpvCodes: ["71314300", "09331200"],
    keywords: ["energy efficiency", "pv", "digitalisation"],
    maximumAidPerBeneficiary: createMoney({ major: 40000, amountType: "maximum_grant", vatStatus: "unknown" }),
    programmeBudget: createMoney({ major: 10000000, amountType: "programme_budget", vatStatus: "unknown" }),
    duration: "Projects must be completed within 18 months",
    submissionMechanism: "Catalan grants portal",
    applicationUrl: "https://official.oportunex.local/icaen-efficiency/apply",
    noticeUrl: "https://official.oportunex.local/icaen-efficiency/notice",
    referenceNumber: "ICAEN-EFF-2026-17",
    documents: ["Call resolution", "Eligible costs annex", "FAQ"],
    requiredDocuments: ["SME declaration", "Project budget", "Energy baseline"],
    lastChecked: "2026-08-07T06:30:00+02:00",
    contacts: [{ role: "authority", name: "ICAEN programme office", email: "subvencions@icaen.cat", phone: "+34 932 208 080" }],
    sources: [
      source(
        "source-efficiency-grant",
        "Institut Català d'Energia",
        "Official grant call",
        "https://official.oportunex.local/icaen-efficiency/notice",
        "2026-07-30",
        "2026-08-07T06:30:00+02:00"
      )
    ],
    evidence: [
      evidence("ev-grant-status", "status", "Grant call is open", "source-efficiency-grant"),
      evidence("ev-grant-deadline", "deadline", "Application period closes 12/09/2026", "source-efficiency-grant"),
      evidence("ev-grant-location", "location", "Projects located in Catalonia", "source-efficiency-grant"),
      evidence("ev-grant-lot-value", "lot_value", "Maximum grant per beneficiary: 40,000 EUR", "source-efficiency-grant"),
      evidence("ev-grant-requirements", "requirements", "Beneficiaries must be SMEs and co-finance 60% of eligible costs", "source-efficiency-grant"),
      evidence("ev-grant-route", "submission_route", "Catalan grants portal", "source-efficiency-grant"),
      evidence("ev-grant-notice", "official_notice", "ICAEN official call", "source-efficiency-grant"),
      evidence("ev-grant-contacts", "contacts", "subvencions@icaen.cat", "source-efficiency-grant")
    ],
    requirements: [
      {
        id: "req-grant-sme",
        kind: "beneficiary",
        label: "Confirmed SME status",
        requiredValue: "SME",
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-grant-requirements"]
      },
      {
        id: "req-grant-region",
        kind: "region",
        label: "Project located in Catalonia",
        allowedRegions: ["Catalonia"],
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-grant-location"]
      },
      {
        id: "req-grant-cofinance",
        kind: "co_finance",
        label: "Ability to co-finance non-subsidised project share",
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-grant-requirements"]
      }
    ],
    lots: []
  },
  {
    id: "opp-hospital-hvac-framework",
    canonicalId: "placsp-2026-502",
    sourceOpportunityId: "PLACSP-2026-502",
    sourceNoticeVersionId: "PLACSP-2026-502-v1",
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: "Hospital HVAC framework for regional health authority",
    description:
      "Large-scale maintenance and refurbishment framework for HVAC and climate-control systems across multiple hospital sites.",
    issuingOrganisation: "Servei Català de la Salut",
    contractingAuthority: "Servei Català de la Salut",
    publicationDate: "2026-08-05",
    deadline: parseSpanishDate("03/09/2026 13:00"),
    location: {
      municipality: "Barcelona",
      province: "Barcelona",
      autonomousCommunity: "Catalonia",
      display: "Barcelona province"
    },
    cpvCodes: ["50730000", "45331000"],
    keywords: ["hvac", "hospital", "climate systems"],
    estimatedValue: createMoney({ major: 1800000, amountType: "estimated_value", vatStatus: "excluding" }),
    relevantValue: createMoney({ major: 1800000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
    duration: "36 months",
    guarantees: "5% definitive guarantee",
    submissionMechanism: "Catalan health procurement portal",
    applicationUrl: "https://official.oportunex.local/hospital-hvac/apply",
    noticeUrl: "https://official.oportunex.local/hospital-hvac/notice",
    referenceNumber: "SCS-HVAC-2026-12",
    documents: ["Notice", "Hospital scope annex"],
    requiredDocuments: ["Three comparable projects", "ISO 14001 evidence"],
    lastChecked: "2026-08-07T08:00:00+02:00",
    contacts: [{ role: "authority", name: "Health authority procurement office", email: "licitacions@salut.cat", phone: "+34 933 242 424" }],
    sources: [
      source(
        "source-hospital",
        "Servei Català de la Salut",
        "Official framework notice",
        "https://official.oportunex.local/hospital-hvac/notice",
        "2026-08-05",
        "2026-08-07T08:00:00+02:00"
      )
    ],
    evidence: [
      evidence("ev-hospital-status", "status", "Active framework notice", "source-hospital"),
      evidence("ev-hospital-deadline", "deadline", "Submission deadline: 03/09/2026 13:00", "source-hospital"),
      evidence("ev-hospital-location", "location", "Hospital network in Barcelona province", "source-hospital"),
      evidence("ev-hospital-lot-value", "lot_value", "Estimated value: 1,800,000 EUR", "source-hospital"),
      evidence("ev-hospital-requirements", "requirements", "Three similar contracts above 800,000 EUR and ISO 14001 are mandatory", "source-hospital"),
      evidence("ev-hospital-route", "submission_route", "Catalan health procurement portal", "source-hospital"),
      evidence("ev-hospital-notice", "official_notice", "Official hospital framework notice", "source-hospital"),
      evidence("ev-hospital-contacts", "contacts", "licitacions@salut.cat", "source-hospital")
    ],
    requirements: [
      {
        id: "req-hospital-experience",
        kind: "experience_value",
        label: "Comparable HVAC contract over 800,000 EUR",
        minimumAmount: 800000,
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-hospital-requirements"]
      },
      certificationRequirement(
        "req-hospital-iso14001",
        "Valid ISO 14001 certification",
        "ISO 14001",
        ["ev-hospital-requirements"],
        "This framework requires ISO 14001. Does your company hold a current certificate?"
      )
    ],
    lots: []
  },
  {
    id: "opp-solar-school",
    canonicalId: "placsp-2026-303",
    sourceOpportunityId: "PLACSP-2026-303",
    sourceNoticeVersionId: "PLACSP-2026-303-v2",
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: "Solar PV installation for school rooftops",
    description:
      "Design and installation of rooftop photovoltaic systems and monitoring equipment across six public schools.",
    issuingOrganisation: "Diputació de Tarragona",
    contractingAuthority: "Diputació de Tarragona",
    publicationDate: "2026-08-02",
    modificationDate: "2026-08-06",
    deadline: parseSpanishDate("19/08/2026 10:00"),
    location: {
      municipality: "Tarragona",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Tarragona province"
    },
    cpvCodes: ["09331200", "45261215"],
    keywords: ["solar", "photovoltaic", "schools"],
    estimatedValue: createMoney({ major: 210000, amountType: "estimated_value", vatStatus: "excluding" }),
    relevantValue: createMoney({ major: 210000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
    duration: "8 months",
    guarantees: "Provisional guarantee not stated",
    submissionMechanism: "Provincial procurement portal",
    applicationUrl: "https://official.oportunex.local/solar-school/apply",
    noticeUrl: "https://official.oportunex.local/solar-school/notice",
    referenceNumber: "DIPTA-SOLAR-2026-09",
    documents: ["Notice", "Technical brief", "Clarification note"],
    requiredDocuments: ["Technical proposal", "Safety plan"],
    lastChecked: "2026-08-07T08:20:00+02:00",
    sourceConflicts: [
      {
        field: "professional_classification",
        left: "Notice summary suggests a specialised classification may be required.",
        right: "Detailed clauses do not clearly confirm the classification code."
      }
    ],
    contacts: [{ role: "authority", name: "Diputació procurement", email: "contractacio@dipta.cat", phone: "+34 977 296 600" }],
    sources: [
      source(
        "source-solar-school",
        "Diputació de Tarragona",
        "Official contract notice",
        "https://official.oportunex.local/solar-school/notice",
        "2026-08-02",
        "2026-08-07T08:20:00+02:00"
      )
    ],
    evidence: [
      evidence("ev-solar-status", "status", "Active contract notice", "source-solar-school"),
      evidence("ev-solar-deadline", "deadline", "Deadline: 19/08/2026 10:00", "source-solar-school"),
      evidence("ev-solar-location", "location", "Tarragona province school rooftops", "source-solar-school"),
      evidence("ev-solar-lot-value", "lot_value", "Estimated value: 210,000 EUR excluding VAT", "source-solar-school"),
      evidence("ev-solar-requirements", "requirements", "Clarification note references specialist installer classification but wording is ambiguous", "source-solar-school"),
      evidence("ev-solar-route", "submission_route", "Provincial procurement portal", "source-solar-school"),
      evidence("ev-solar-notice", "official_notice", "Official contract notice", "source-solar-school"),
      evidence("ev-solar-contacts", "contacts", "contractacio@dipta.cat", "source-solar-school")
    ],
    requirements: [
      {
        id: "req-solar-classification",
        kind: "custom",
        label: "Specialist installer classification",
        defaultStatus: "needs_verification",
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-solar-requirements"],
        question: "The notice may require a specialist installer classification. Can you confirm whether your company already holds it?"
      }
    ],
    lots: []
  },
  {
    id: "opp-expired-maintenance",
    canonicalId: "placsp-2026-122",
    sourceOpportunityId: "PLACSP-2026-122",
    sourceNoticeVersionId: "PLACSP-2026-122-v1",
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: "Expired building maintenance tender",
    description: "Historic maintenance tender kept for rejection-path testing.",
    issuingOrganisation: "Ajuntament de Reus",
    contractingAuthority: "Ajuntament de Reus",
    publicationDate: "2026-07-01",
    deadline: parseSpanishDate("29/07/2026 15:00"),
    location: {
      municipality: "Reus",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Reus"
    },
    cpvCodes: ["50711000"],
    keywords: ["maintenance", "electrical"],
    estimatedValue: createMoney({ major: 120000, amountType: "estimated_value", vatStatus: "excluding" }),
    relevantValue: createMoney({ major: 120000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
    documents: ["Notice"],
    lastChecked: "2026-08-07T08:05:00+02:00",
    contacts: [],
    sources: [
      source("source-expired", "Ajuntament de Reus", "Expired notice", "https://official.oportunex.local/expired", "2026-07-01", "2026-08-07T08:05:00+02:00")
    ],
    evidence: [
      evidence("ev-expired-status", "status", "Active notice archived after deadline", "source-expired"),
      evidence("ev-expired-deadline", "deadline", "Deadline: 29/07/2026 15:00", "source-expired"),
      evidence("ev-expired-location", "location", "Execution place: Reus", "source-expired"),
      evidence("ev-expired-lot-value", "lot_value", "Estimated value: 120,000 EUR", "source-expired"),
      evidence("ev-expired-route", "submission_route", "Archived municipal portal", "source-expired"),
      evidence("ev-expired-notice", "official_notice", "Official notice", "source-expired")
    ],
    requirements: [],
    lots: []
  },
  {
    id: "opp-award-notice",
    canonicalId: "placsp-2026-401",
    sourceOpportunityId: "PLACSP-2026-401",
    sourceNoticeVersionId: "PLACSP-2026-401-v1",
    type: "contract",
    noticeType: "award_notice",
    status: "awarded",
    title: "Award notice — municipal energy retrofit",
    description: "Award notice retained to ensure non-open notices never appear as new opportunities.",
    issuingOrganisation: "Ajuntament de Tortosa",
    contractingAuthority: "Ajuntament de Tortosa",
    publicationDate: "2026-08-06",
    deadline: parseSpanishDate("06/08/2026 11:00"),
    location: {
      municipality: "Tortosa",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Tortosa"
    },
    cpvCodes: ["09331200"],
    estimatedValue: createMoney({ major: 300000, amountType: "award_value", vatStatus: "excluding" }),
    relevantValue: createMoney({ major: 300000, amountType: "award_value", vatStatus: "excluding" }),
    lastChecked: "2026-08-07T08:10:00+02:00",
    contacts: [],
    sources: [source("source-award", "Ajuntament de Tortosa", "Award notice", "https://official.oportunex.local/award", "2026-08-06", "2026-08-07T08:10:00+02:00")],
    evidence: [
      evidence("ev-award-status", "status", "Award notice published after contract award", "source-award"),
      evidence("ev-award-deadline", "deadline", "Publication date 06/08/2026 11:00", "source-award"),
      evidence("ev-award-notice", "official_notice", "Award notice", "source-award")
    ],
    requirements: [],
    lots: []
  }
];

export function createDemoState() {
  return {
    organisations: [
      {
        id: "org-demo",
        name: "OportuneX Demo Workspace",
        admin: true
      }
    ],
    companyProfiles: [demoCompany],
    activeCompanyId: demoCompany.id,
    opportunities: demoOpportunities,
    savedOpportunityIds: ["opp-electrical-maintenance"],
    pursuitStatuses: {
      "opp-electrical-maintenance": "interested",
      "opp-efficiency-grant": "saved"
    },
    feedback: [
      {
        id: "feedback-1",
        opportunityId: "opp-electrical-maintenance",
        companyId: demoCompany.id,
        label: "would investigate",
        createdAt: "2026-08-07T08:18:00+02:00"
      }
    ],
    aiRuns: [],
    manualOverrides: [],
    auditEvents: [
      {
        id: "audit-seed",
        title: "Demo workspace seeded",
        detail: "Loaded fictional company profile and six synthetic opportunities.",
        at: "2026-08-07T08:12:00+02:00"
      }
    ],
    sourceSyncRuns: [
      {
        id: "sync-manual-phase0",
        source: "manual-intelligence-lab",
        status: "healthy",
        lastRun: "2026-08-07T08:12:00+02:00",
        note: "Manual opportunity fixtures loaded."
      },
      {
        id: "sync-placsp",
        source: "PLACSP",
        status: "planned",
        lastRun: null,
        note: "Connector scaffolded for Phase 1."
      },
      {
        id: "sync-bdns",
        source: "BDNS",
        status: "planned",
        lastRun: null,
        note: "Connector scaffolded for Phase 2."
      }
    ]
  };
}
