import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parsePlacspAtom } from "../scripts/connectors/placsp-parser.mjs";
import {
  deterministicPlacspOpportunityId,
  normalizePlacspDataset
} from "../src/connectors/placsp-normalizer.js";
import { deriveStatus } from "../src/domain/deadline.js";
import { buildFinancialPicture } from "../src/domain/financial-picture.js";

async function fixture(name) {
  return readFile(new URL(`./fixtures/placsp/${name}`, import.meta.url), "utf8");
}

async function parseFixture(name, sourceUrl = "https://contrataciondelsectorpublico.gob.es/sindicacion/test.atom") {
  return parsePlacspAtom(await fixture(name), { sourceUrl });
}

test("PLACSP parser preserves namespaced Atom metadata and entry identity", async () => {
  const parsed = await parseFixture("open-tender.atom.xml");

  assert.equal(
    parsed.entries[0].atomId,
    "https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/entry-open-001"
  );
  assert.equal(
    parsed.entries[0].linkUrl,
    "https://contrataciondelestado.es/wps/poc?uri=entry-open-001"
  );
  assert.equal(
    parsed.feed.nextUrl,
    "https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3-next.atom"
  );
  assert.equal(parsed.entryErrors.length, 0);
});

test("PLACSP normalization uses TenderSubmissionDeadlinePeriod and keeps official amounts separate", async () => {
  const parsed = await parseFixture("open-tender.atom.xml");
  const normalized = normalizePlacspDataset({
    feed: parsed.feed,
    entries: parsed.entries,
    deletedEntries: parsed.deletedEntries,
    fetchedAt: "2026-08-12T10:00:00.000Z"
  });
  const opportunity = normalized.opportunities[0];

  assert.equal(opportunity.referenceNumber, "REF-OPEN-001");
  assert.equal(opportunity.status, "open");
  assert.equal(opportunity.noticeType, "active_contract_notice");
  assert.equal(opportunity.contractingAuthority, "Ajuntament de Tarragona");
  assert.deepEqual(opportunity.cpvCodes, ["50711000", "45315300"]);
  assert.equal(opportunity.deadline.date, "2026-08-29");
  assert.equal(opportunity.deadline.time, "14:00");
  assert.equal(opportunity.deadline.timezone, "Europe/Madrid");
  assert.equal(opportunity.deadline.sourceTimezone, null);
  assert.doesNotMatch(opportunity.deadline.sourceText, /20\/08\/2026/);
  assert.equal(opportunity.estimatedValue.amountMinor, 21000000);
  assert.equal(opportunity.baseBudget.amountMinor, 19800000);
  assert.equal(opportunity.sources[0].metadata.statusCode, "PUB");
  assert.ok(opportunity.requirements.length >= 2);
  assert.equal(opportunity.requirements[0].kind, "custom");
  assert.equal(
    deriveStatus(opportunity, new Date("2026-08-30T10:00:00+02:00")),
    "closed"
  );
});

test("duplicate Atom ids collapse to the newest version and keep stable semantic versioning", async () => {
  const parsed = await parseFixture("duplicate-entries.atom.xml");
  const first = normalizePlacspDataset({
    feed: parsed.feed,
    entries: parsed.entries,
    deletedEntries: [],
    fetchedAt: "2026-08-12T10:00:00.000Z"
  });
  const second = normalizePlacspDataset({
    feed: parsed.feed,
    entries: parsed.entries,
    deletedEntries: [],
    fetchedAt: "2026-08-13T10:00:00.000Z"
  });

  assert.equal(first.stats.uniqueEntries, 1);
  assert.equal(first.opportunities[0].deadline.date, "2026-08-30");
  assert.equal(first.opportunities[0].deadline.time, "09:30");
  assert.equal(first.opportunities[0].estimatedValue.amountMinor, 120000000);
  assert.equal(
    first.opportunities[0].sourceNoticeVersionId,
    second.opportunities[0].sourceNoticeVersionId
  );

  const changedEntries = structuredClone(parsed.entries);
  changedEntries[1].contractFolderStatus["cac:TenderingProcess"]["cac:TenderSubmissionDeadlinePeriod"]["cbc:EndDate"] = "2026-08-31";
  const changed = normalizePlacspDataset({
    feed: parsed.feed,
    entries: changedEntries,
    deletedEntries: [],
    fetchedAt: "2026-08-13T10:00:00.000Z"
  });

  assert.notEqual(
    changed.opportunities[0].sourceNoticeVersionId,
    first.opportunities[0].sourceNoticeVersionId
  );
});

test("multi-lot PLACSP records preserve lot-level base budget semantics without generic relevant-lot wording", async () => {
  const parsed = await parseFixture("multi-lot-tender.atom.xml");
  const normalized = normalizePlacspDataset({
    feed: parsed.feed,
    entries: parsed.entries,
    deletedEntries: [],
    fetchedAt: "2026-08-11T08:00:00.000Z"
  });
  const opportunity = normalized.opportunities[0];
  const firstLot = opportunity.lots[0];
  const financialPicture = buildFinancialPicture(opportunity, firstLot);

  assert.equal(opportunity.lots.length, 2);
  assert.equal(firstLot.value.amountType, "base_budget");
  assert.equal(opportunity.deadline.date, "2026-08-26");
  assert.equal(opportunity.deadline.time, null);
  assert.equal(opportunity.deadline.timezone, "Europe/Madrid");
  assert.equal(opportunity.deadline.sourceTimezone, null);
  assert.equal(financialPicture.primaryLine.label, "Lot 1 low-voltage maintenance base / tender budget");
  assert.doesNotMatch(financialPicture.primaryLine.label, /Relevant lot/i);
});

test("awarded notices and tombstones map to conservative non-actionable states", async () => {
  const parsed = await parseFixture("awarded-and-tombstones.atom.xml");
  const normalized = normalizePlacspDataset({
    feed: parsed.feed,
    entries: parsed.entries,
    deletedEntries: parsed.deletedEntries,
    fetchedAt: "2026-08-12T18:30:00.000Z"
  });

  assert.equal(normalized.opportunities[0].status, "awarded");
  assert.equal(normalized.opportunities[0].noticeType, "award_notice");
  assert.equal(normalized.tombstones.length, 2);
  assert.deepEqual(
    normalized.tombstones.map((item) => [item.id, item.status]),
    [
      [deterministicPlacspOpportunityId("https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/entry-cancelled-001"), "cancelled"],
      [deterministicPlacspOpportunityId("https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/entry-closed-001"), "closed"]
    ]
  );
});

test("description-only deadlines stay unresolved and decimal comma amounts keep exact cents", async () => {
  const parsed = await parseFixture("descriptive-deadline.atom.xml");
  const normalized = normalizePlacspDataset({
    feed: parsed.feed,
    entries: parsed.entries,
    deletedEntries: [],
    fetchedAt: "2026-08-12T08:00:00.000Z"
  });
  const opportunity = normalized.opportunities[0];

  assert.equal(opportunity.deadline.date, null);
  assert.equal(opportunity.deadline.time, null);
  assert.match(opportunity.deadline.sourceText, /administrative clauses/i);
  assert.equal(opportunity.estimatedValue.amountMinor, 598939079);
  assert.equal(opportunity.baseBudget.amountMinor, 598939079);
  assert.equal(opportunity.requirements[0].kind, "custom");
});

test("malformed PLACSP entries fail safely without killing the whole feed", async () => {
  const parsed = await parseFixture("malformed-entry.atom.xml");
  const normalized = normalizePlacspDataset({
    feed: parsed.feed,
    entries: parsed.entries,
    deletedEntries: parsed.deletedEntries,
    fetchedAt: "2026-08-12T09:00:00.000Z"
  });

  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entryErrors.length, 1);
  assert.equal(parsed.entryErrors[0].code, "PLACSP_ENTRY_MISSING_CONTRACT_FOLDER_STATUS");
  assert.equal(normalized.opportunities.length, 1);
});
