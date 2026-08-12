import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_RUNTIME } from "../src/config.js";
import { demoCompany } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import { evaluateRequirement } from "../src/domain/eligibility.js";
import { importCompanyProfileFromJson } from "../src/services/company-importer.js";
import { importOpportunityFromJson, importOpportunityFromText, validateOpportunityImport } from "../src/services/importer.js";

const ANALYSIS_NOW = new Date("2026-08-11T10:00:00+02:00");

test("rejects empty or near-empty manual imports", () => {
  const validation = validateOpportunityImport({
    sourceText: "   ",
    title: "Mini",
    type: "contract",
    location: "",
    valueText: "",
    deadlineText: "",
    noticeUrl: ""
  });

  assert.equal(validation.ok, false);
  assert.match(validation.message, /Add useful source text/i);
});

test("accepts meaningful structured manual imports", () => {
  const validation = validateOpportunityImport({
    sourceText: "",
    title: "Barcelona HVAC maintenance contract",
    type: "contract",
    location: "Barcelona",
    valueText: "84.500",
    deadlineText: "",
    noticeUrl: ""
  });

  assert.equal(validation.ok, true);
});

test("imports meaningful pasted text without the old junk fallback title", () => {
  const text = `Title: Tarragona electrical maintenance opportunity
Deadline: 26/08/2026 14:00
Value: €84.500
Location: Tarragona`;
  const imported = importOpportunityFromText(text);

  assert.equal(imported.title, "Tarragona electrical maintenance opportunity");
  assert.notEqual(imported.title, "Imported opportunity");
});

test("imports strict structured opportunity JSON", () => {
  const imported = importOpportunityFromJson(
    JSON.stringify({
      type: "contract",
      title: "Structured electrical maintenance opportunity",
      publicationDate: "2026-08-11",
      deadline: "29/08/2026 14:00",
      location: {
        municipality: "Tarragona",
        province: "Tarragona",
        autonomousCommunity: "Catalonia"
      },
      relevantValue: {
        major: 84500,
        currency: "EUR",
        vatStatus: "excluding",
        amountType: "relevant_lot_value"
      },
      sources: [
        {
          id: "src-1",
          organisation: "Ajuntament example",
          title: "Official notice",
          url: "https://example.com/opportunity",
          official: true,
          publishedAt: "2026-08-11"
        }
      ],
      evidence: [
        {
          id: "ev-1",
          fieldKey: "deadline",
          excerpt: "Submission deadline 29/08/2026 14:00",
          sourceId: "src-1",
          sourceType: "official_notice",
          confidence: 0.91
        }
      ]
    })
  );

  assert.equal(imported.noticeType, "active_contract_notice");
  assert.equal(imported.deadline.date, "2026-08-29");
  assert.equal(imported.location.province, "Tarragona");
  assert.equal(imported.relevantValue.amountMinor, 8450000);
  assert.equal(imported.sources[0].organisation, "Ajuntament example");
});

test("structured contract import preserves lot-specific value and source conflicts", () => {
  const imported = importOpportunityFromJson(
    JSON.stringify({
      type: "contract",
      title: "Structured electrical maintenance contract",
      description: "Lot-specific electrical maintenance services.",
      publicationDate: "2026-08-11",
      deadline: "29/08/2026 14:00",
      location: {
        municipality: "Tarragona",
        province: "Tarragona",
        autonomousCommunity: "Catalonia"
      },
      wholeProcedureValue: {
        major: 210000,
        currency: "EUR",
        vatStatus: "excluding",
        amountType: "whole_procedure_value"
      },
      lots: [
        {
          id: "lot-1",
          title: "Lot 1",
          description: "Electrical maintenance lot",
          cpvCodes: ["50711000", "45315300"],
          keywords: ["electrical maintenance", "municipal facilities"],
          value: {
            major: 84500,
            currency: "EUR",
            vatStatus: "excluding",
            amountType: "relevant_lot_value"
          },
          requirements: [],
          documents: ["Lot 1 terms"],
          contacts: [
            {
              role: "authority",
              name: "Lot contact",
              email: "lot@example.com",
              phone: "+34 977 000 001"
            }
          ]
        }
      ],
      sourceConflicts: [
        {
          field: "professional_classification",
          left: "Summary references a specialist classification.",
          right: "Detailed clauses do not confirm the exact code."
        }
      ]
    })
  );

  const portfolio = analyzePortfolio(demoCompany, [imported], DEFAULT_RUNTIME, ANALYSIS_NOW);

  assert.equal(imported.sourceConflicts.length, 1);
  assert.equal(imported.lots[0].documents[0], "Lot 1 terms");
  assert.equal(imported.lots[0].contacts[0].role, "authority");
  assert.equal(portfolio.recommended[0]?.displayValueLabel, "€84,500 excl. VAT");
});

test("structured grant import keeps max beneficiary amount separate from programme budget", () => {
  const imported = importOpportunityFromJson(
    JSON.stringify({
      type: "grant",
      title: "Structured solar self-consumption grant",
      description: "Grant for solar installations in Catalonia.",
      publicationDate: "2026-08-11",
      deadline: "30/08/2026 13:00",
      location: {
        municipality: "Tarragona",
        province: "Tarragona",
        autonomousCommunity: "Catalonia"
      },
      cpvCodes: ["09331200"],
      keywords: ["solar", "photovoltaic"],
      maximumAidPerBeneficiary: {
        major: 40000,
        currency: "EUR",
        vatStatus: "unknown",
        amountType: "maximum_grant"
      },
      programmeBudget: {
        major: 400000,
        currency: "EUR",
        vatStatus: "unknown",
        amountType: "programme_budget"
      },
      eligibleProjectCost: {
        major: 120000,
        currency: "EUR",
        vatStatus: "unknown",
        amountType: "eligible_project_cost"
      }
    })
  );

  const portfolio = analyzePortfolio(demoCompany, [imported], DEFAULT_RUNTIME, ANALYSIS_NOW);

  assert.match(portfolio.recommended[0]?.companyAmountLabel ?? "", /€40,000/);
  assert.doesNotMatch(portfolio.recommended[0]?.companyAmountLabel ?? "", /€400,000/);
});

test("structured award notice import preserves award value semantics and does not invent a deadline", () => {
  const imported = importOpportunityFromJson(
    JSON.stringify({
      type: "contract",
      noticeType: "award_notice",
      status: "awarded",
      title: "Structured award notice",
      publicationDate: "2026-08-11",
      location: {
        municipality: "Tarragona",
        province: "Tarragona",
        autonomousCommunity: "Catalonia"
      },
      awardValue: {
        amountMinor: 180000000,
        currency: "EUR",
        vatStatus: "excluding",
        amountType: "award_value"
      }
    })
  );

  const result = analyzePortfolio(demoCompany, [imported], DEFAULT_RUNTIME, ANALYSIS_NOW);

  assert.equal(imported.deadline, null);
  assert.equal(imported.awardValue.amountMinor, 180000000);
  assert.equal(result.recommended.length, 0);
  assert.equal(result.rejected[0]?.bestMatch.financialPicture?.primaryLine?.label, "Awarded contract value");
});

test("structured certification requirement stays unknown when company evidence is missing", () => {
  const company = importCompanyProfileFromJson(
    JSON.stringify({
      profileMode: "prospect",
      legalName: "Sparse Prospect SL"
    })
  );
  const imported = importOpportunityFromJson(
    JSON.stringify({
      type: "contract",
      title: "ISO 9001 maintenance requirement",
      publicationDate: "2026-08-11",
      deadline: "29/08/2026 14:00",
      location: {
        municipality: "Tarragona",
        province: "Tarragona",
        autonomousCommunity: "Catalonia"
      },
      sources: [
        {
          id: "src-1",
          organisation: "Ajuntament example",
          title: "Official notice",
          url: "https://example.com/opportunity",
          official: true,
          publishedAt: "2026-08-11"
        }
      ],
      evidence: [
        {
          id: "ev-req",
          fieldKey: "requirements",
          excerpt: "Valid ISO 9001 certification is required.",
          sourceId: "src-1",
          sourceType: "official_notice",
          confidence: 0.94
        }
      ],
      requirements: [
        {
          id: "req-iso-9001",
          kind: "certification",
          label: "ISO 9001",
          requiredValue: "ISO 9001",
          mandatory: true,
          gating: "hard",
          evidenceIds: ["ev-req"]
        }
      ]
    })
  );

  const row = evaluateRequirement(company, imported, imported.requirements[0], null, ANALYSIS_NOW);
  assert.equal(row.status, "needs_verification");
});

test("structured opportunity import supports turnover and company-age requirements directly", () => {
  const imported = importOpportunityFromJson(
    JSON.stringify({
      type: "contract",
      title: "Structured fit requirements",
      publicationDate: "2026-08-11",
      deadline: "29/08/2026 14:00",
      location: {
        municipality: "Tarragona",
        province: "Tarragona",
        autonomousCommunity: "Catalonia"
      },
      requirements: [
        {
          id: "req-turnover",
          kind: "turnover",
          label: "Turnover above 400k EUR",
          minimumAmount: 400000,
          mandatory: true
        },
        {
          id: "req-company-age",
          kind: "company_age",
          label: "Company older than 3 years",
          minimumYears: 3,
          mandatory: true
        }
      ]
    })
  );

  const rows = imported.requirements.map((requirement) =>
    evaluateRequirement(demoCompany, imported, requirement, null, ANALYSIS_NOW)
  );

  assert.equal(rows[0].status, "confirmed");
  assert.equal(rows[1].status, "confirmed");
});

test("structured opportunity import preserves employee-count requirements and availability warnings without forcing ineligibility", () => {
  const imported = importOpportunityFromJson(
    JSON.stringify({
      type: "contract",
      title: "Structured availability-aware contract",
      publicationDate: "2026-08-11",
      deadline: "29/08/2026 14:00",
      location: {
        municipality: "Tarragona",
        province: "Tarragona",
        autonomousCommunity: "Catalonia"
      },
      cpvCodes: ["50711000", "45315300"],
      keywords: ["electrical maintenance"],
      relevantValue: {
        major: 84500,
        currency: "EUR",
        vatStatus: "excluding",
        amountType: "relevant_lot_value"
      },
      availabilityWarnings: [
        {
          id: "availability-1",
          title: "High competition",
          detail: "The source warns that remaining budget may be allocated quickly.",
          severity: "medium"
        }
      ],
      requirements: [
        {
          id: "req-employee-count",
          kind: "employee_count",
          label: "Current employee count above 10",
          minimumCount: 10,
          mandatory: true,
          gating: "soft"
        }
      ],
      sources: [
        {
          id: "src-1",
          organisation: "Ajuntament example",
          title: "Official notice",
          url: "https://example.com/opportunity",
          official: true,
          publishedAt: "2026-08-11"
        }
      ]
    })
  );

  const portfolio = analyzePortfolio(demoCompany, [imported], DEFAULT_RUNTIME, ANALYSIS_NOW);
  const match = portfolio.recommended[0];

  assert.equal(imported.availabilityWarnings.length, 1);
  assert.equal(
    evaluateRequirement(demoCompany, imported, imported.requirements[0], null, ANALYSIS_NOW).status,
    "confirmed"
  );
  assert.equal(match.decision.recommendedAction.code, "VERIFY_BEFORE_DECIDING");
  assert.equal(match.eligibilityStatus, "CONFIRMED_ELIGIBLE");
  assert.ok(match.risks.some((risk) => risk.category === "availability"));
  assert.notEqual(match.eligibilityStatus, "INELIGIBLE");
});

test("expired structured opportunity remains rejected", () => {
  const imported = importOpportunityFromJson(
    JSON.stringify({
      type: "contract",
      title: "Expired structured maintenance opportunity",
      publicationDate: "2026-07-25",
      deadline: "01/08/2026 10:00",
      location: {
        municipality: "Tarragona",
        province: "Tarragona",
        autonomousCommunity: "Catalonia"
      },
      cpvCodes: ["50711000"],
      keywords: ["maintenance", "electrical"],
      relevantValue: {
        major: 84500,
        currency: "EUR",
        vatStatus: "excluding",
        amountType: "relevant_lot_value"
      }
    })
  );

  const portfolio = analyzePortfolio(demoCompany, [imported], DEFAULT_RUNTIME, ANALYSIS_NOW);

  assert.equal(portfolio.recommended.length, 0);
  assert.equal(portfolio.rejected[0]?.reason, "Deadline passed");
});

test("structured opportunity importer rejects unsupported fields", () => {
  assert.throws(
    () =>
      importOpportunityFromJson(
        JSON.stringify({
          title: "Structured electrical maintenance opportunity",
          unsupportedField: true
        })
      ),
    /unsupported/i
  );
});

test("structured opportunity importer rejects blind benchmark keys", () => {
  assert.throws(
    () =>
      importOpportunityFromJson(
        JSON.stringify({
          title: "Structured electrical maintenance opportunity",
          expectedRanking: ["opp-1"]
        })
      ),
    /blind/i
  );
});
