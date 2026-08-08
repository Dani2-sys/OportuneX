import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { OPORTUNEX_RUNTIME: {} };

import { parseSpanishDate } from "../src/domain/deadline.js";
import { analyzeOpportunity } from "../src/domain/analysis.js";
import { createCompanyFact, createCompanyRange } from "../src/domain/company-profile.js";
import { createMoney, assessScaleFit } from "../src/domain/money.js";
import { getRuntimeConfig } from "../src/config.js";
import { demoCompany } from "../src/data/demo.js";
import { clone } from "../src/utils.js";

function makeProspectCompany() {
  const company = clone(demoCompany);
  company.profileMode = "prospect";
  company.companySources = [
    {
      id: "website-source",
      organisation: company.legalName,
      title: "Company website",
      url: "https://prospect.example",
      sourceType: "company_website",
      publishedAt: null,
      retrievedAt: "2026-08-08T09:00:00Z"
    }
  ];
  company.capabilities = company.capabilities.map((capability) => ({
    ...capability,
    status: "public_verified",
    sourceIds: ["website-source"]
  }));
  company.certifications = [];
  company.facts.minimumAttractiveProjectValue = createCompanyFact(null, { status: "unknown" });
  company.facts.idealProjectValue = createCompanyFact(null, { status: "unknown" });
  company.facts.maximumRealisticProjectValue = createCompanyFact(null, { status: "unknown" });
  company.facts.maximumProjectValue = createCompanyFact(220000, {
    status: "public_verified",
    confidence: "medium",
    sourceIds: ["website-source"],
    asOfDate: "2026-08-01"
  });
  company.facts.publicProcurementProjects = createCompanyFact(1, {
    status: "public_verified",
    confidence: "medium",
    sourceIds: ["website-source"],
    asOfDate: "2026-08-01"
  });
  company.facts.turnoverRange = createCompanyRange({
    min: 1000000,
    max: 2000000,
    currency: "EUR",
    referenceYear: 2024,
    status: "public_reported",
    confidence: "medium",
    sourceIds: ["website-source"]
  });
  company.facts.canCoFinance = createCompanyFact(null, { status: "unknown" });
  company.facts.deMinimisUsage = createCompanyFact(null, { status: "unknown" });
  return company;
}

function makeEvidence() {
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
    id: `ev-${index + 1}`,
    fieldKey,
    excerpt: `${fieldKey} evidence`,
    sourceId: "source-1",
    confidence: 0.94
  }));
}

function makeOpportunity({ id, valueMajor, requirements = [] }) {
  const value = createMoney({
    major: valueMajor,
    amountType: "relevant_lot_value",
    vatStatus: "excluding"
  });

  return {
    id,
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title: "Electrical maintenance contract",
    description: "Preventive and corrective electrical maintenance across municipal facilities.",
    location: {
      municipality: "Tarragona",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      display: "Tarragona"
    },
    cpvCodes: ["50711000", "45315300"],
    keywords: ["electrical maintenance", "municipal buildings"],
    deadline: parseSpanishDate("01/09/2026 14:00"),
    relevantValue: value,
    estimatedValue: value,
    duration: "12 months",
    guarantees: "None",
    lots: [
      {
        id: `${id}-lot-1`,
        title: "Lot 1",
        description: "Electrical maintenance",
        cpvCodes: ["50711000", "45315300"],
        keywords: ["electrical maintenance"],
        value,
        requirements
      }
    ],
    contacts: [{ role: "authority", name: "Ajuntament de Tarragona", email: "contractacio@example.com" }],
    sources: [
      {
        id: "source-1",
        organisation: "Ajuntament de Tarragona",
        title: "Official tender notice",
        url: "https://official.example/opportunity",
        publishedAt: "2026-08-01",
        lastChecked: "2026-08-08T10:00:00Z",
        official: true
      }
    ],
    evidence: makeEvidence(),
    lastChecked: "2026-08-08T10:00:00Z",
    applicationUrl: "https://official.example/apply",
    noticeUrl: "https://official.example/opportunity",
    referenceNumber: `${id}-ref`,
    requiredDocuments: [],
    documents: []
  };
}

test("unknown project maximum does not become zero", () => {
  const company = makeProspectCompany();
  const assessment = assessScaleFit(
    company,
    createMoney({ major: 90000, amountType: "relevant_lot_value", vatStatus: "excluding" })
  );

  assert.equal(assessment.basis, "public_scale_signal");
  assert.ok(assessment.score > 0);
});

test("large opportunity can have high technical fit but low scale fit", () => {
  const runtime = getRuntimeConfig();
  const company = makeProspectCompany();
  const opportunity = makeOpportunity({ id: "opp-large-scale", valueMajor: 4000000 });
  const result = analyzeOpportunity(company, opportunity, runtime, new Date("2026-08-08T10:00:00Z"));

  assert.ok(result.bestMatch.dimensions.capabilityFit >= 90);
  assert.ok(result.bestMatch.dimensions.financialScaleFit <= 20);
});

test("low scale fit alone does not create fake legal ineligibility", () => {
  const runtime = getRuntimeConfig();
  const company = makeProspectCompany();
  const opportunity = makeOpportunity({ id: "opp-low-scale", valueMajor: 4000000 });
  const result = analyzeOpportunity(company, opportunity, runtime, new Date("2026-08-08T10:00:00Z"));

  assert.notEqual(result.bestMatch.eligibilityStatus, "INELIGIBLE");
  assert.notEqual(result.bestMatch.eligibilityStatus, "LIKELY_INELIGIBLE");
});

test("unknown mandatory requirement remains unknown and reduces confidence", () => {
  const runtime = getRuntimeConfig();
  const company = makeProspectCompany();
  const opportunity = makeOpportunity({
    id: "opp-unknown-iso",
    valueMajor: 90000,
    requirements: [
      {
        id: "req-iso9001",
        kind: "certification",
        label: "ISO 9001",
        requiredValue: "ISO 9001",
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-5"],
        question: "Do you currently hold ISO 9001?"
      }
    ]
  });
  const result = analyzeOpportunity(company, opportunity, runtime, new Date("2026-08-08T10:00:00Z"));

  assert.equal(result.bestMatch.eligibilityStatus, "ELIGIBILITY_UNCLEAR");
  assert.equal(result.bestMatch.requirementRows[0].status, "needs_verification");
  assert.notEqual(result.bestMatch.confidenceShield.label, "HIGH");
});

test("irrelevant unknown fields do not unnecessarily penalise unrelated opportunities", () => {
  const runtime = getRuntimeConfig();
  const company = makeProspectCompany();
  const opportunity = makeOpportunity({ id: "opp-clean", valueMajor: 90000 });
  const result = analyzeOpportunity(company, opportunity, runtime, new Date("2026-08-08T10:00:00Z"));

  assert.equal(result.bestMatch.unknowns.length, 0);
  assert.equal(result.bestMatch.confidenceShield.label, "HIGH");
});
