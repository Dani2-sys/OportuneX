import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompanyConflicts,
  getCompanyClassifications,
  getCompanyFact,
  getCompanyFactHistory,
  getFactValue,
  setCompanyConfirmedFact
} from "../src/domain/company-profile.js";
import { evaluateRequirement } from "../src/domain/eligibility.js";
import { importCompanyProfileFromJson } from "../src/services/company-importer.js";

test("company-confirmed fact overrides public value while preserving history", () => {
  const company = importCompanyProfileFromJson(
    JSON.stringify({
      profileMode: "prospect",
      legalName: "Prospect Installations SL",
      facts: {
        employeeCountCurrent: {
          value: 9,
          status: "public_reported",
          confidence: "medium",
          referenceYear: 2024,
          sourceIds: ["src-public"]
        }
      }
    })
  );

  setCompanyConfirmedFact(company, "employeeCountCurrent", 12, {
    asOfDate: "2026-08-08",
    notes: "Confirmed directly by the company."
  });

  assert.equal(getFactValue(getCompanyFact(company, "employeeCountCurrent")), 12);
  assert.equal(getCompanyFact(company, "employeeCountCurrent").status, "company_confirmed");
  assert.equal(getCompanyFactHistory(company, "employeeCountCurrent").length, 1);
  assert.equal(getCompanyFactHistory(company, "employeeCountCurrent")[0].value, 9);
  assert.equal(getCompanyFactHistory(company, "employeeCountCurrent")[0].referenceYear, 2024);
});

test("public historical turnover is not treated as exact current turnover", () => {
  const company = importCompanyProfileFromJson(
    JSON.stringify({
      profileMode: "prospect",
      legalName: "Prospect Installations SL",
      facts: {
        turnoverRange: {
          min: 300000,
          max: 600000,
          currency: "EUR",
          referenceYear: 2024,
          status: "public_reported",
          confidence: "medium",
          sourceIds: ["src-public"]
        }
      }
    })
  );

  const requirement = evaluateRequirement(
    company,
    { location: {} },
    {
      id: "req-turnover",
      kind: "turnover",
      label: "Turnover above 400k EUR",
      minimumAmount: 400000,
      mandatory: true
    },
    new Date("2026-08-08T10:00:00Z")
  );

  assert.equal(requirement.status, "needs_verification");
});

test("public website capability does not imply certification", () => {
  const company = importCompanyProfileFromJson(
    JSON.stringify({
      profileMode: "prospect",
      legalName: "Prospect Installations SL",
      capabilities: [
        {
          label: "Electrical installation",
          strength: "high",
          status: "public_verified",
          sourceIds: ["website-source"]
        }
      ]
    })
  );

  const requirement = evaluateRequirement(
    company,
    { location: {} },
    {
      id: "req-iso",
      kind: "certification",
      label: "ISO 9001",
      requiredValue: "ISO 9001",
      mandatory: true
    },
    new Date("2026-08-08T10:00:00Z")
  );

  assert.equal(requirement.status, "needs_verification");
});

test("CNAE does not imply IAE", () => {
  const company = importCompanyProfileFromJson(
    JSON.stringify({
      profileMode: "prospect",
      legalName: "Prospect Installations SL",
      classifications: {
        cnae: [
          {
            code: "4321",
            label: "Electrical installation",
            status: "public_reported"
          }
        ]
      }
    })
  );

  assert.equal(getCompanyClassifications(company, "cnae").length, 1);
  assert.equal(getCompanyClassifications(company, "iae").length, 0);
});

test("conflicting CNAE sources remain conflicted", () => {
  const company = importCompanyProfileFromJson(
    JSON.stringify({
      profileMode: "prospect",
      legalName: "Prospect Installations SL",
      classifications: {
        cnae: [
          {
            code: "4321",
            label: "Electrical installation",
            status: "conflicted",
            sourceIds: ["src-a"]
          },
          {
            code: "4322",
            label: "Plumbing and HVAC",
            status: "conflicted",
            sourceIds: ["src-b"]
          }
        ]
      }
    })
  );

  const conflicts = buildCompanyConflicts(company);
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((item) => item.field === "CNAE"));
});

test("prospect importer rejects blind benchmark keys", () => {
  assert.throws(
    () =>
      importCompanyProfileFromJson(
        JSON.stringify({
          legalName: "Prospect Installations SL",
          expectedRanking: ["opp-1"]
        })
      ),
    /blind/i
  );
});
