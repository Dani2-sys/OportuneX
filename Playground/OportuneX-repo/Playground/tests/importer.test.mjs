import test from "node:test";
import assert from "node:assert/strict";

import { importOpportunityFromText, validateOpportunityImport } from "../src/services/importer.js";

test("rejects empty or near-empty manual imports", () => {
  const validation = validateOpportunityImport({
    sourceText: "   ",
    title: "Mini",
    type: "contract",
    location: "",
    valueText: "",
    deadlineText: "",
    noticeUrl: ""
  });

  assert.equal(validation.ok, false);
  assert.match(validation.message, /Add useful source text/i);
});

test("accepts meaningful structured manual imports", () => {
  const validation = validateOpportunityImport({
    sourceText: "",
    title: "Barcelona HVAC maintenance contract",
    type: "contract",
    location: "Barcelona",
    valueText: "84.500",
    deadlineText: "",
    noticeUrl: ""
  });

  assert.equal(validation.ok, true);
});

test("imports meaningful pasted text without the old junk fallback title", () => {
  const text = `Title: Tarragona electrical maintenance opportunity
Deadline: 26/08/2026 14:00
Value: €84.500
Location: Tarragona`;
  const imported = importOpportunityFromText(text);

  assert.equal(imported.title, "Tarragona electrical maintenance opportunity");
  assert.notEqual(imported.title, "Imported opportunity");
});
