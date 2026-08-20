import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzeOpportunity, analyzePortfolio, deriveLotSelectionReason, diagnoseLotSelection, traceLotDifferentiation } from "../src/domain/analysis.js";
import { buildCustomerReportExport } from "../src/domain/customer-presentation.js";
import { createMoney } from "../src/domain/money.js";
import { buildVerificationLotComparison, buildVerificationPacket } from "../src/domain/verification-protocol.js";
import { createFourLotSelectionFixture, createLiveLotDifferentiationFixture, LOT_SELECTION_FIXTURE_NOW } from "./helpers/lot-selection-fixture.mjs";

function makeContractOpportunity({ id, title, estimatedMajor, lots = [] }) {
  return {
    id,
    type: "contract",
    noticeType: "active_contract_notice",
    status: "open",
    title,
    description: title,
    issuingOrganisation: "Fixture authority",
    contractingAuthority: "Fixture authority",
    publicationDate: "2026-08-10",
    deadline: {
      date: "2026-09-30",
      time: "12:00",
      timezone: "Europe/Madrid",
      sourceText: "30/09/2026 12:00"
    },
    location: {
      municipality: "Tarragona",
      province: "Tarragona",
      autonomousCommunity: "Catalonia",
      country: "Spain",
      display: "Tarragona"
    },
    cpvCodes: ["50711000", "50700000"],
    estimatedValue: createMoney({ major: estimatedMajor, amountType: "estimated_value", vatStatus: "excluding" }),
    wholeProcedureValue: createMoney({ major: estimatedMajor, amountType: "estimated_value", vatStatus: "excluding" }),
    applicationUrl: "https://official.example.test/fixture/apply",
    noticeUrl: "https://official.example.test/fixture/notice",
    referenceNumber: `${id}-2026`,
    requiredDocuments: ["Technical offer"],
    contacts: [{ role: "authority", name: "Fixture contact" }],
    sources: [
      {
        id: `${id}-source`,
        organisation: "Fixture authority",
        title: "Official notice",
        url: "https://official.example.test/fixture/notice",
        publishedAt: "2026-08-10",
        lastChecked: "2026-08-20T08:00:00+02:00",
        official: true
      }
    ],
    evidence: [],
    requirements: [],
    lots
  };
}

test("portfolio analysis preserves the selected explicit lot id and marks exactly one packet lot selected", () => {
  const { company, opportunity, now } = createFourLotSelectionFixture();
  const portfolio = analyzePortfolio(company, [opportunity], DEFAULT_RUNTIME, now);
  const analysis = portfolio.analysed[0];
  const packet = buildVerificationPacket(company, opportunity, analysis);
  const comparison = buildVerificationLotComparison(opportunity, analysis);

  assert.equal(analysis.bestMatch.lotId, "lot-i-hvac");
  assert.equal(analysis.lotId, "lot-i-hvac");
  assert.equal(analysis.selectedLotId, "lot-i-hvac");
  assert.equal(analysis.selectedLotLabel, "Lote I");
  assert.equal(packet.selected_assessment.selected_lot_id, "lot-i-hvac");
  assert.equal(packet.selected_assessment.selected_lot_label, "Lote I");
  assert.equal(comparison.filter((item) => item.selected_best_match).length, 1);
  assert.equal(comparison.find((item) => item.selected_best_match)?.lot_id, "lot-i-hvac");
  assert.equal(analysis.displayValueLabel, "€139,136 excl. VAT");
  assert.equal(packet.selected_assessment.value_label, "€139,136 excl. VAT");
});

test("four-lot diagnostic remains coherent and does not let geography alone override the selected lot", () => {
  const { company, opportunity, now } = createFourLotSelectionFixture();
  const portfolio = analyzePortfolio(company, [opportunity], DEFAULT_RUNTIME, now);
  const analysis = portfolio.analysed[0];
  const diagnostic = diagnoseLotSelection(opportunity, analysis);
  const lotI = diagnostic.lots.find((item) => item.lotId === "lot-i-hvac");
  const lotIII = diagnostic.lots.find((item) => item.lotId === "lot-iii-catalonia");

  assert.equal(diagnostic.scopeType, "explicit_published_lot");
  assert.equal(diagnostic.selectedLotId, "lot-i-hvac");
  assert.equal(diagnostic.selectedLot, "Lote I — Castellon and Valencia");
  assert.equal(diagnostic.lots.length, 4);
  assert.equal(diagnostic.lots[0].lotId, "lot-i-hvac");
  assert.equal(diagnostic.lots.filter((item) => item.selectedBestMatch).length, 1);
  assert.equal(diagnostic.lots.find((item) => item.selectedBestMatch)?.lotId, "lot-i-hvac");
  assert.ok(lotI);
  assert.ok(lotIII);
  assert.ok((lotIII.geographicFit ?? 0) >= (lotI.geographicFit ?? 0));
  assert.ok((lotI.priorityScore ?? 0) > (lotIII.priorityScore ?? 0));
});

test("live-style lot diagnostic keeps source-order labels concise while exposing the real selection reason", () => {
  const { company, opportunity, now } = createLiveLotDifferentiationFixture();
  const result = analyzeOpportunity(company, opportunity, DEFAULT_RUNTIME, now);
  const diagnostic = diagnoseLotSelection(opportunity, result);
  const trace = traceLotDifferentiation(company, opportunity, result);

  assert.equal(diagnostic.procedureTitle, opportunity.title);
  assert.equal(diagnostic.selectionReason, deriveLotSelectionReason(result));
  assert.deepEqual(diagnostic.lots.map((lot) => lot.conciseLabel), ["Lote I", "Lote II", "Lote III", "Lote IV"]);
  assert.equal(diagnostic.lots[0].fullTitle, opportunity.title);
  assert.equal(diagnostic.lots[0].coverageLabel, "Castellon/Castello");
  assert.equal(diagnostic.lots[1].coverageLabel, "Comunitat Valenciana");
  assert.equal(diagnostic.lots[2].coverageLabel, "Cataluna");
  assert.equal(diagnostic.lots[3].coverageLabel, "Espana / multiple regions");
  assert.equal(trace.selectionReason, diagnostic.selectionReason);
  assert.equal(trace.lots[0].lotFinancialValue.amountMinor, opportunity.lots[0].value.amountMinor);
});

test("whole-opportunity cases keep zero explicit lots selected", () => {
  const state = createDemoState();
  const company = structuredClone(state.companyProfiles[0]);
  const opportunity = makeContractOpportunity({
    id: "opp-whole-opportunity-selection",
    title: "Standalone electrical maintenance contract",
    estimatedMajor: 100000
  });
  const portfolio = analyzePortfolio(company, [opportunity], DEFAULT_RUNTIME, new Date(LOT_SELECTION_FIXTURE_NOW));
  const analysis = portfolio.analysed[0];
  const packet = buildVerificationPacket(company, opportunity, analysis);
  const diagnostic = diagnoseLotSelection(opportunity, analysis);
  const exported = buildCustomerReportExport({ company, opportunity, analysis });

  assert.equal(analysis.hasPublishedLot, false);
  assert.equal(packet.selected_assessment.selected_lot_id, null);
  assert.equal(packet.lot_comparison.length, 0);
  assert.equal(diagnostic.scopeType, "whole_opportunity");
  assert.equal(diagnostic.selectedLotId, null);
  assert.doesNotMatch(exported.html, /Assessment shown for/i);
});

test("customer/export and packet code do not fall back to a lot label when the selected lot id is absent", () => {
  const { company, opportunity, now } = createFourLotSelectionFixture();
  const portfolio = analyzePortfolio(company, [opportunity], DEFAULT_RUNTIME, now);
  const analysis = portfolio.analysed[0];
  const brokenAnalysis = {
    ...analysis,
    lotId: null,
    selectedLotId: null
  };
  const packet = buildVerificationPacket(company, opportunity, brokenAnalysis);
  const comparison = buildVerificationLotComparison(opportunity, brokenAnalysis);
  const exported = buildCustomerReportExport({ company, opportunity, analysis: brokenAnalysis });

  assert.equal(packet.selected_assessment.selected_lot_id, null);
  assert.equal(packet.selected_assessment.selected_lot_label, null);
  assert.equal(comparison.filter((item) => item.selected_best_match).length, 0);
  assert.doesNotMatch(exported.html, /Assessment shown for/i);
});

test("tied lots keep deterministic source-order selection", () => {
  const state = createDemoState();
  const company = structuredClone(state.companyProfiles[0]);
  const opportunity = makeContractOpportunity({
    id: "opp-tied-lots",
    title: "Two equivalent maintenance lots",
    estimatedMajor: 90000,
    lots: [
      {
        id: "lot-a",
        title: "Lot A",
        description: "HVAC and building maintenance services.",
        cpvCodes: ["50730000", "50700000"],
        keywords: ["hvac", "maintenance"],
        value: createMoney({ major: 90000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        location: {
          municipality: "Tarragona",
          province: "Tarragona",
          autonomousCommunity: "Catalonia",
          country: "Spain",
          display: "Tarragona"
        },
        requirements: []
      },
      {
        id: "lot-b",
        title: "Lot B",
        description: "HVAC and building maintenance services.",
        cpvCodes: ["50730000", "50700000"],
        keywords: ["hvac", "maintenance"],
        value: createMoney({ major: 90000, amountType: "relevant_lot_value", vatStatus: "excluding" }),
        location: {
          municipality: "Tarragona",
          province: "Tarragona",
          autonomousCommunity: "Catalonia",
          country: "Spain",
          display: "Tarragona"
        },
        requirements: []
      }
    ]
  });

  const result = analyzeOpportunity(company, opportunity, DEFAULT_RUNTIME, new Date(LOT_SELECTION_FIXTURE_NOW));
  const portfolio = analyzePortfolio(company, [opportunity], DEFAULT_RUNTIME, new Date(LOT_SELECTION_FIXTURE_NOW));

  assert.equal(result.bestMatch.lotId, "lot-a");
  assert.equal(portfolio.analysed[0].lotId, "lot-a");
});

test("diagnostic script prints a coherent lot matrix for the four-lot fixture", () => {
  const playgroundRoot = fileURLToPath(new URL("../", import.meta.url));
  const scriptPath = path.join(playgroundRoot, "scripts/diagnose-lot-selection.mjs");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: playgroundRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Top-level lot selection diagnostic/);
  assert.match(result.stdout, /Lot\s+\|\s+Capability\s+\|\s+Geography/);
  assert.match(result.stdout, /"analysisSelectedLotId": "lot-i-hvac"/);
  assert.match(result.stdout, /"selected_best_match": true/);
});
