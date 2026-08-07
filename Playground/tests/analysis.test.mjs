import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { OPORTUNEX_RUNTIME: {} };

import { getRuntimeConfig } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";

test("prefers relevant lot value over full procedure value", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const portfolio = analyzePortfolio(
    state.companyProfiles[0],
    state.opportunities,
    runtime,
    new Date("2026-08-07T10:00:00+02:00")
  );
  const lotMatch = portfolio.recommended.find((item) => item.opportunityId === "opp-multi-lot-framework");
  assert.equal(lotMatch.displayValueLabel, "€96,000 excl. VAT");
});

test("does not present programme budget as company amount", () => {
  const runtime = getRuntimeConfig();
  const state = createDemoState();
  const portfolio = analyzePortfolio(
    state.companyProfiles[0],
    state.opportunities,
    runtime,
    new Date("2026-08-07T10:00:00+02:00")
  );
  const grant = portfolio.recommended.find((item) => item.opportunityId === "opp-efficiency-grant");
  assert.ok(grant.companyAmountLabel.includes("€40,000"));
  assert.ok(!grant.companyAmountLabel.includes("10,000,000"));
});
