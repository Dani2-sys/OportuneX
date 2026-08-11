import test from "node:test";
import assert from "node:assert/strict";

import { EVALUATION_NOW_ISO, getApplicationNow, getEvaluationNow } from "../src/clock.js";

test("application clock follows the live Date constructor while evaluation clock stays fixed", () => {
  const RealDate = Date;
  const fakeNow = "2031-02-03T04:05:06.000Z";

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length) {
        super(...args);
        return;
      }
      super(fakeNow);
    }

    static now() {
      return new RealDate(fakeNow).valueOf();
    }
  }

  globalThis.Date = FakeDate;

  try {
    assert.equal(getApplicationNow().toISOString(), fakeNow);
    assert.equal(getEvaluationNow().toISOString(), new RealDate(EVALUATION_NOW_ISO).toISOString());
  } finally {
    globalThis.Date = RealDate;
  }
});
