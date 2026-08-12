import test from "node:test";
import assert from "node:assert/strict";

import { formatMoney, moneyToMajor } from "../src/domain/money.js";

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
