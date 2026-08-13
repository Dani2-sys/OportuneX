import test from "node:test";
import assert from "node:assert/strict";

import { createMoneyFromMinor, createMoneyFromText, formatMoney, moneyTextToMinor, moneyToMajor } from "../src/domain/money.js";

test("amountMinor is interpreted using currency minor units", () => {
  const cases = [
    { amountMinor: 504000, expectedMajor: 5040, expectedDisplay: "€5,040" },
    { amountMinor: 12482791, expectedMajor: 124827.91, expectedDisplay: "€124,827.91" },
    { amountMinor: 180000000, expectedMajor: 1800000, expectedDisplay: "€1,800,000" },
    { amountMinor: 321202987, expectedMajor: 3212029.87, expectedDisplay: "€3,212,029.87" }
  ];

  cases.forEach(({ amountMinor, expectedMajor, expectedDisplay }) => {
    const money = {
      amountMinor,
      currency: "EUR",
      vatStatus: "unknown",
      amountType: "generic"
    };

    assert.equal(moneyToMajor(money), expectedMajor);
    assert.equal(formatMoney(money), expectedDisplay);
  });
});

test("exact money parsing keeps decimal comma and decimal point cents without floating-point drift", () => {
  assert.equal(moneyTextToMinor("5989390,79"), 598939079);
  assert.equal(moneyTextToMinor("5989390.79"), 598939079);
  assert.equal(moneyTextToMinor("10.000.000"), 1000000000);

  const commaMoney = createMoneyFromText("5989390,79", {
    amountType: "estimated_value",
    vatStatus: "excluding"
  });
  const dotMoney = createMoneyFromText("5989390.79", {
    amountType: "estimated_value",
    vatStatus: "excluding"
  });

  assert.equal(commaMoney.amountMinor, 598939079);
  assert.equal(dotMoney.amountMinor, 598939079);
});

test("createMoneyFromMinor preserves exact minor-unit values", () => {
  const money = createMoneyFromMinor({
    amountMinor: 8450000,
    amountType: "base_budget",
    vatStatus: "excluding"
  });

  assert.equal(money.amountMinor, 8450000);
  assert.equal(formatMoney(money), "€84,500 excl. VAT");
});
