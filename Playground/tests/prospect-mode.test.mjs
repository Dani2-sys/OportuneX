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

function makeBroadOnlyProspectCompany() {
  const company = makeProspectCompany();
  company.capabilities = [
    {
      id: "maintenance-broad",
      label: "Building and industrial maintenance",
      level: "low",
      strength: "low",
      status: "public_verified",
      aliases: ["maintenance"],
      cpvPrefixes: ["5000"],
      sourceIds: ["website-source"]
    }
  ];
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
  assert.equal(result.bestMatch.decision.recommendedAction.code, "VERIFY_BEFORE_DECIDING");
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
  assert.equal(result.bestMatch.decision.recommendedAction.code, "VERIFY_BEFORE_DECIDING");
  assert.equal(result.bestMatch.decision.match.band, result.bestMatch.recommendationClass);
  assert.equal(result.bestMatch.requirementRows[0].status, "needs_verification");
  assert.equal(result.bestMatch.potentialHardBlockers.length, 1);
  assert.equal(result.bestMatch.unknowns.length, 0);
  assert.match(result.bestMatch.decision.mainReason, /Potential hard blocker/i);
  assert.ok(result.bestMatch.dimensions.baseCapabilityFit >= 90);
  assert.ok(result.bestMatch.dimensions.specialistScopeConfidence <= 44);
  assert.ok(result.bestMatch.dimensions.qualificationReadiness < result.bestMatch.dimensions.baseCapabilityFit);
  assert.equal(result.bestMatch.confidenceShield.sourceFieldsEvidenced, 8);
  assert.equal(result.bestMatch.confidenceShield.totalSourceFields, 8);
  assert.equal(result.bestMatch.confidenceShield.dataConfidence, "HIGH");
  assert.notEqual(result.bestMatch.confidenceShield.eligibilityConfidence, "HIGH");
  assert.notEqual(result.bestMatch.confidenceShield.companyFactConfidence, "HIGH");
  assert.equal(result.bestMatch.confidenceShield.label, result.bestMatch.confidenceShield.decisionConfidence);
  assert.notEqual(result.bestMatch.confidenceShield.label, "HIGH");
  assert.match(result.bestMatch.reportMarkdown, /Potential hard blocker/i);
  assert.match(result.bestMatch.reportMarkdown, /No confirmed blocker recorded, but potential hard blockers remain\./i);
});

test("broad public capability does not establish specialist delivery scope or classification", () => {
  const runtime = getRuntimeConfig();
  const company = makeProspectCompany();
  const opportunity = makeOpportunity({
    id: "opp-specialist-scope-gap",
    valueMajor: 140000,
    requirements: [
      {
        id: "req-public-portfolio",
        kind: "public_experience",
        label: "Comparable public-sector delivery references",
        minimumCount: 1,
        minimumAmount: 90000,
        lookbackYears: 3,
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-5"]
      },
      {
        id: "req-specialist-classification",
        kind: "custom",
        label: "Specialist delivery classification",
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-5"]
      },
      {
        id: "req-monitoring-competence",
        kind: "custom",
        label: "Monitoring competence confirmation",
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-5"]
      }
    ]
  });
  const result = analyzeOpportunity(company, opportunity, runtime, new Date("2026-08-08T10:00:00Z"));

  assert.ok(result.bestMatch.dimensions.baseCapabilityFit >= 90);
  assert.ok(result.bestMatch.dimensions.specialistScopeConfidence <= 44);
  assert.equal(result.bestMatch.decision.recommendedAction.code, "VERIFY_BEFORE_DECIDING");
  assert.equal(result.bestMatch.potentialHardBlockers.length, 3);
  assert.match(result.bestMatch.decision.mainReason, /Potential hard blocker/i);
});

test("medium capability and zero qualification readiness cannot produce a strong executive verdict", () => {
  const runtime = getRuntimeConfig();
  const company = makeBroadOnlyProspectCompany();
  const opportunity = makeOpportunity({
    id: "opp-medium-capability-zero-readiness",
    valueMajor: 120000,
    requirements: [
      {
        id: "req-hard-classification",
        kind: "custom",
        label: "Required specialist classification",
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-5"]
      }
    ]
  });
  const result = analyzeOpportunity(company, opportunity, runtime, new Date("2026-08-08T10:00:00Z"));

  assert.ok(result.bestMatch.dimensions.baseCapabilityFit > 0 && result.bestMatch.dimensions.baseCapabilityFit < 60);
  assert.ok(result.bestMatch.dimensions.specialistScopeConfidence < 45);
  assert.ok(result.bestMatch.dimensions.financialScaleFit < 75);
  assert.equal(result.bestMatch.dimensions.qualificationReadiness, 0);
  assert.doesNotMatch(
    result.bestMatch.executiveVerdict,
    /strong capability fit|are currently strong|qualification evidence is currently strong|broadly compatible/i
  );
  assert.match(result.bestMatch.executiveVerdict, /partial technical overlap|limited technical overlap/i);
  assert.match(result.bestMatch.executiveVerdict, /Qualification readiness is currently unproven|Potential hard blocker/i);
  assert.match(result.bestMatch.reportMarkdown, /Potential hard blocker/i);
});

test("confirmed hard eligibility failure forces do-not-pursue", () => {
  const runtime = getRuntimeConfig();
  const company = makeProspectCompany();
  company.certifications = [
    {
      name: "ISO 14001",
      currentStatus: createCompanyFact("missing", {
        status: "company_confirmed",
        confidence: "high",
        sourceIds: ["website-source"],
        asOfDate: "2026-08-08"
      })
    }
  ];
  const opportunity = makeOpportunity({
    id: "opp-hard-fail",
    valueMajor: 90000,
    requirements: [
      {
        id: "req-iso14001",
        kind: "certification",
        label: "ISO 14001",
        requiredValue: "ISO 14001",
        mandatory: true,
        gating: "hard",
        evidenceIds: ["ev-5"]
      }
    ]
  });
  const result = analyzeOpportunity(company, opportunity, runtime, new Date("2026-08-08T10:00:00Z"));

  assert.equal(result.bestMatch.eligibilityStatus, "INELIGIBLE");
  assert.equal(result.bestMatch.decision.recommendedAction.code, "DO_NOT_PURSUE");
  assert.equal(result.bestMatch.decision.match.band, result.bestMatch.recommendationClass);
  assert.equal(result.bestMatch.confidenceShield.hardMandatoryFailed, 1);
  assert.equal(result.bestMatch.confidenceShield.label, "LOW");
});

test("irrelevant unknown fields do not unnecessarily penalise unrelated opportunities", () => {
  const runtime = getRuntimeConfig();
  const company = makeProspectCompany();
  const opportunity = makeOpportunity({ id: "opp-clean", valueMajor: 90000 });
  const result = analyzeOpportunity(company, opportunity, runtime, new Date("2026-08-08T10:00:00Z"));

  assert.equal(result.bestMatch.unknowns.length, 0);
  assert.equal(result.bestMatch.eligibilityStatus, "ELIGIBILITY_NOT_ASSESSED");
  assert.equal(result.bestMatch.decision.recommendedAction.code, "VERIFY_BEFORE_DECIDING");
  assert.equal(result.bestMatch.confidenceShield.label, "LOW");
});
