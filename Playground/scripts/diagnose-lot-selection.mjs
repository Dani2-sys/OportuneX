import { DEFAULT_RUNTIME } from "../src/config.js";
import { analyzePortfolio, diagnoseLotSelection } from "../src/domain/analysis.js";
import { getSelectedExplicitLotLabel } from "../src/domain/opportunity-scope.js";
import { buildVerificationPacket } from "../src/domain/verification-protocol.js";
import { createFourLotSelectionFixture } from "../tests/helpers/lot-selection-fixture.mjs";

function formatCell(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text.slice(0, width) : text.padEnd(width, " ");
}

function printMatrix(rows) {
  const headers = [
    ["Lot", 12],
    ["Capability", 10],
    ["Geography", 9],
    ["Scale", 7],
    ["Qual", 6],
    ["Eligibility", 19],
    ["Match", 5],
    ["Priority", 8],
    ["Fit", 12],
    ["Action", 22],
    ["Selected", 8],
    ["Rank", 4]
  ];
  console.log(headers.map(([label, width]) => formatCell(label, width)).join(" | "));
  console.log(headers.map(([, width]) => "-".repeat(width)).join("-+-"));
  rows.forEach((row) => {
    console.log(
      [
        formatCell(row.title ?? row.lotId, 12),
        formatCell(row.capabilityFit ?? "", 10),
        formatCell(row.geographicFit ?? "", 9),
        formatCell(row.financialScaleFit ?? "", 7),
        formatCell(row.qualificationReadiness ?? "", 6),
        formatCell(row.eligibilityStatus ?? "", 19),
        formatCell(row.matchScore ?? "", 5),
        formatCell(row.priorityScore ?? "", 8),
        formatCell(row.fitBand ?? "", 12),
        formatCell(row.recommendedAction ?? "", 22),
        formatCell(row.selectedBestMatch ? "yes" : "no", 8),
        formatCell(row.rank ?? "", 4)
      ].join(" | ")
    );
  });
}

const { company, opportunity, now } = createFourLotSelectionFixture();
const portfolio = analyzePortfolio(company, [opportunity], DEFAULT_RUNTIME, now);
const analysis = portfolio.analysed[0];
const diagnostic = diagnoseLotSelection(opportunity, analysis);
const packet = buildVerificationPacket(company, opportunity, analysis);

console.log("Top-level lot selection diagnostic");
console.log(JSON.stringify({
  analysisBestMatchId: diagnostic.bestMatchId,
  analysisBestMatchLotId: diagnostic.bestMatchLotId,
  analysisSelectedLot: diagnostic.selectedLot,
  analysisSelectedLotId: diagnostic.selectedLotId,
  analysisScope: diagnostic.scope,
  analysisScopeType: diagnostic.scopeType,
  customerPresentedLot: getSelectedExplicitLotLabel(analysis),
  verificationPacketSelectedLotId: packet.selected_assessment?.selected_lot_id ?? null,
  verificationPacketSelectedMarkers: (packet.lot_comparison ?? []).map((item) => ({
    lot_id: item.lot_id,
    selected_best_match: item.selected_best_match
  }))
}, null, 2));
console.log("");
printMatrix(diagnostic.lots);
