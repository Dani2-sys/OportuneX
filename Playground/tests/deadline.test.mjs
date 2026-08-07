import test from "node:test";
import assert from "node:assert/strict";

import { deriveStatus, formatDeadline, parseSpanishDate } from "../src/domain/deadline.js";

test("parses Spanish deadlines without inventing a time", () => {
  const parsed = parseSpanishDate("12/09/2026");
  assert.equal(parsed.date, "2026-09-12");
  assert.equal(parsed.time, null);
  assert.equal(formatDeadline(parsed), "12/09/2026");
});

test("keeps explicit deadline time", () => {
  const parsed = parseSpanishDate("12/09/2026 14:00");
  assert.equal(parsed.time, "14:00");
  assert.equal(formatDeadline(parsed), "12/09/2026 at 14:00");
});

test("expired opportunities become closed", () => {
  const status = deriveStatus(
    {
      deadline: parseSpanishDate("01/08/2026 10:00")
    },
    new Date("2026-08-07T10:00:00+02:00")
  );
  assert.equal(status, "closed");
});
