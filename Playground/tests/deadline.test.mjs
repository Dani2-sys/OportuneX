import test from "node:test";
import assert from "node:assert/strict";

import {
  currentYmd,
  daysRemaining,
  deriveStatus,
  formatDeadline,
  parseSpanishDate,
  toUtcIso
} from "../src/domain/deadline.js";

test("parses Spanish deadlines without inventing a time", () => {
  const parsed = parseSpanishDate("12/09/2026");
  assert.equal(parsed.date, "2026-09-12");
  assert.equal(parsed.time, null);
  assert.equal(parsed.timezone, "Europe/Madrid");
  assert.equal(parsed.sourceTimezone, null);
  assert.equal(parsed.utcEquivalent, null);
  assert.equal(formatDeadline(parsed), "12/09/2026");
});

test("keeps explicit deadline time", () => {
  const parsed = parseSpanishDate("12/09/2026 14:00");
  assert.equal(parsed.time, "14:00");
  assert.equal(parsed.timezone, "Europe/Madrid");
  assert.equal(parsed.sourceTimezone, null);
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

test("converts winter Europe/Madrid deadline to UTC correctly", () => {
  assert.equal(toUtcIso("2026-01-12", "14:00"), "2026-01-12T13:00:00.000Z");
});

test("converts summer Europe/Madrid deadline to UTC correctly", () => {
  assert.equal(toUtcIso("2026-08-12", "14:00"), "2026-08-12T12:00:00.000Z");
});

test("calendar day logic follows Europe/Madrid around UTC midnight", () => {
  const now = new Date("2026-08-10T22:30:00Z");
  const deadline = parseSpanishDate("11/08/2026");

  assert.equal(currentYmd(now), "2026-08-11");
  assert.equal(daysRemaining(deadline, now), 0);
});
