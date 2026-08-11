import test from "node:test";
import assert from "node:assert/strict";

import { evaluateEligibility, evaluateRequirement } from "../src/domain/eligibility.js";
import { importCompanyProfileFromJson } from "../src/services/company-importer.js";

function experienceSubject() {
  return {
    title: "Electrical maintenance contract",
    location: {},
    cpvCodes: ["50711000", "45315300"],
    keywords: ["electrical maintenance"]
  };
}

function experienceLot() {
  return {
    id: "lot-1",
    title: "Lot 1",
    cpvCodes: ["50711000", "45315300"],
    keywords: ["electrical maintenance"],
    requirements: []
  };
}

test("authoritative private project cannot confirm a public-only experience requirement", () => {
  const company = importCompanyProfileFromJson(
    JSON.stringify({
      legalName: "Prospect Installations SL",
      facts: {
        publicProcurementProjects: {
          value: 0,
          status: "company_confirmed",
          confidence: "high",
          sourceIds: ["src-company"]
        }
      },
      experience: {
        representativeProjects: [
          {
            name: "Private electrical maintenance contract",
            publicProject: false,
            scopeCapabilities: ["Electrical maintenance"],
            cpvPrefixes: ["5071", "45315"],
            projectValue: 140000,
            completionYear: 2025,
            status: "company_confirmed",
            sourceIds: ["src-private"]
          }
        ]
      }
    })
  );

  const requirement = evaluateRequirement(
    company,
    experienceSubject(),
    {
      id: "req-public-exp",
      kind: "public_experience",
      label: "At least one comparable public maintenance contract",
      minimumCount: 1,
      minimumAmount: 60000,
      lookbackYears: 3,
      mandatory: true,
      gating: "hard"
    },
    experienceLot(),
    new Date("2026-08-08T10:00:00Z")
  );

  assert.equal(requirement.status, "failed");
});

test("authoritative public project can confirm a public-only experience requirement", () => {
  const company = importCompanyProfileFromJson(
    JSON.stringify({
      legalName: "Prospect Installations SL",
      experience: {
        representativeProjects: [
          {
            name: "Municipal electrical maintenance contract",
            publicProject: true,
            scopeCapabilities: ["Electrical maintenance"],
            cpvPrefixes: ["5071", "45315"],
            projectValue: 140000,
            completionYear: 2025,
            status: "company_confirmed",
            sourceIds: ["src-public"]
          }
        ]
      }
    })
  );

  const requirement = evaluateRequirement(
    company,
    experienceSubject(),
    {
      id: "req-public-exp",
      kind: "public_experience",
      label: "At least one comparable public maintenance contract",
      minimumCount: 1,
      minimumAmount: 60000,
      lookbackYears: 3,
      mandatory: true,
      gating: "hard"
    },
    experienceLot(),
    new Date("2026-08-08T10:00:00Z")
  );

  assert.equal(requirement.status, "confirmed");
});

test("zero extracted requirements does not produce confirmed eligible", () => {
  const company = importCompanyProfileFromJson(
    JSON.stringify({
      legalName: "Prospect Installations SL"
    })
  );

  const eligibility = evaluateEligibility(
    company,
    {
      title: "Opportunity with no extracted requirements",
      requirements: [],
      location: {}
    },
    null,
    new Date("2026-08-08T10:00:00Z")
  );

  assert.equal(eligibility.eligibilityStatus, "LIKELY_ELIGIBLE");
  assert.notEqual(eligibility.eligibilityStatus, "CONFIRMED_ELIGIBLE");
});
