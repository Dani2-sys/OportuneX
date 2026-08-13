import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { PlacspSyncError, syncPlacspFeed } from "../scripts/connectors/placsp-client.mjs";

async function fixture(name) {
  return readFile(new URL(`./fixtures/placsp/${name}`, import.meta.url), "utf8");
}

function mockResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = name.toLowerCase();
        return headers[key] ?? headers[name] ?? null;
      }
    },
    async arrayBuffer() {
      return Buffer.from(body, "utf8");
    }
  };
}

function makeEntryXml({
  atomId,
  title,
  updated,
  folderId = "REF-TEST-001",
  statusCode = "PUB"
}) {
  return `
    <entry>
      <id>${atomId}</id>
      <title>${title}</title>
      <summary>${title}</summary>
      <updated>${updated}</updated>
      <link href="https://contrataciondelestado.es/wps/poc?uri=${folderId}" />
      <cac-place-ext:ContractFolderStatus>
        <cbc-place-ext:ContractFolderStatusCode>${statusCode}</cbc-place-ext:ContractFolderStatusCode>
        <cbc:ContractFolderID>${folderId}</cbc:ContractFolderID>
        <cac:ProcurementProject>
          <cbc:Name>${title}</cbc:Name>
        </cac:ProcurementProject>
      </cac-place-ext:ContractFolderStatus>
    </entry>
  `;
}

function makeDeletedEntryXml({ ref, when, commentType = "ANULADA" }) {
  return `<at:deleted-entry ref="${ref}" when="${when}"><at:comment type="${commentType}" /></at:deleted-entry>`;
}

function makeFeedXml({ feedUpdated, nextUrl = null, entries = [], deletedEntries = [] }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <feed
    xmlns="http://www.w3.org/2005/Atom"
    xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
    xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
    xmlns:cac-place-ext="urn:dgpe:names:draft:codice-place-ext:schema:xsd:CommonAggregateComponents-2"
    xmlns:cbc-place-ext="urn:dgpe:names:draft:codice-place-ext:schema:xsd:CommonBasicComponents-2"
    xmlns:at="http://purl.org/atompub/tombstones/1.0">
    <id>https://contrataciondelestado.es/sindicacion/test.atom</id>
    <updated>${feedUpdated}</updated>
    <link rel="self" href="https://contrataciondelestado.es/sindicacion/test.atom" />
    ${nextUrl ? `<link rel="next" href="${nextUrl}" />` : ""}
    ${entries.join("\n")}
    ${deletedEntries.join("\n")}
  </feed>`;
}

test("PLACSP client follows official next-page links and respects maxPages", async () => {
  const firstPage = await fixture("open-tender.atom.xml");
  const secondPage = await fixture("multi-lot-tender.atom.xml");
  const urls = [];

  const result = await syncPlacspFeed({
    maxPages: 2,
    fetchImpl: async (url) => {
      urls.push(url);
      if (urls.length === 1) return mockResponse(firstPage);
      return mockResponse(secondPage);
    }
  });

  assert.equal(result.pagesFetched, 2);
  assert.equal(result.entriesSeen, 2);
  assert.equal(result.uniqueEntries, 2);
  assert.equal(result.opportunities.length, 2);
  assert.equal(urls.length, 2);
});

test("PLACSP client stops after the first page when maxPages = 1 even if next exists", async () => {
  const firstPage = await fixture("open-tender.atom.xml");
  let requests = 0;

  const result = await syncPlacspFeed({
    maxPages: 1,
    fetchImpl: async () => {
      requests += 1;
      return mockResponse(firstPage);
    }
  });

  assert.equal(result.pagesFetched, 1);
  assert.equal(requests, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, "page_limit");
});

test("PLACSP client rejects external next-page hosts", async () => {
  const firstPage = (await fixture("open-tender.atom.xml")).replace(
    "https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3-next.atom",
    "https://evil.example.test/not-allowed.atom"
  );

  await assert.rejects(
    () =>
      syncPlacspFeed({
        maxPages: 2,
        fetchImpl: async () => mockResponse(firstPage)
      }),
    (error) => {
      assert.equal(error.code, "placsp_host_rejected");
      return true;
    }
  );
});

test("PLACSP client surfaces HTTP failures as structured sync errors", async () => {
  await assert.rejects(
    () =>
      syncPlacspFeed({
        fetchImpl: async () => mockResponse("Bad gateway", { status: 502 })
      }),
    (error) => {
      assert.ok(error instanceof PlacspSyncError);
      assert.equal(error.code, "placsp_http_error");
      return true;
    }
  );
});

test("PLACSP client reports malformed XML safely", async () => {
  await assert.rejects(
    () =>
      syncPlacspFeed({
        fetchImpl: async () => mockResponse("<root><broken /></root>")
      }),
    (error) => {
      assert.ok(error instanceof PlacspSyncError);
      assert.equal(error.code, "placsp_parse_failed");
      return true;
    }
  );
});

test("incremental sync short-circuits on unchanged feed updated and fetches only the head page", async () => {
  const urls = [];
  const page = makeFeedXml({
    feedUpdated: "2026-08-13T10:00:00.000Z",
    nextUrl: "https://contrataciondelestado.es/sindicacion/test-page-2.atom",
    entries: [
      makeEntryXml({
        atomId: "https://contrataciondelestado.es/sindicacion/entry-1",
        title: "Incremental head entry",
        updated: "2026-08-13T10:00:00.000Z"
      })
    ]
  });

  const result = await syncPlacspFeed({
    mode: "incremental",
    cursor: {
      lastFeedUpdated: "2026-08-13T10:00:00.000Z",
      entryUpdatedWatermark: "2026-08-13T10:00:00.000Z"
    },
    fetchImpl: async (url) => {
      urls.push(url);
      return mockResponse(page);
    }
  });

  assert.equal(urls.length, 1);
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.feedChanged, false);
  assert.equal(result.truncationReason, null);
  assert.equal(result.opportunities.length, 0);
  assert.equal(result.tombstones.length, 0);
});

test("incremental sync processes changed feeds, stops after the watermark overlap, and keeps equal-timestamp entries", async () => {
  const urls = [];
  const pages = [
    makeFeedXml({
      feedUpdated: "2026-08-13T12:00:00.000Z",
      nextUrl: "https://contrataciondelestado.es/sindicacion/test-page-2.atom",
      entries: [
        makeEntryXml({
          atomId: "https://contrataciondelestado.es/sindicacion/entry-newer",
          title: "Newest entry",
          updated: "2026-08-13T12:00:00.000Z",
          folderId: "REF-NEWER"
        })
      ]
    }),
    makeFeedXml({
      feedUpdated: "2026-08-13T11:00:00.000Z",
      nextUrl: "https://contrataciondelestado.es/sindicacion/test-page-3.atom",
      entries: [
        makeEntryXml({
          atomId: "https://contrataciondelestado.es/sindicacion/entry-boundary-a",
          title: "Boundary entry A",
          updated: "2026-08-12T09:00:00.000Z",
          folderId: "REF-BOUNDARY-A"
        })
      ]
    }),
    makeFeedXml({
      feedUpdated: "2026-08-13T10:30:00.000Z",
      nextUrl: "https://contrataciondelestado.es/sindicacion/test-page-4.atom",
      entries: [
        makeEntryXml({
          atomId: "https://contrataciondelestado.es/sindicacion/entry-boundary-b",
          title: "Boundary entry B",
          updated: "2026-08-12T09:00:00.000Z",
          folderId: "REF-BOUNDARY-B"
        })
      ]
    }),
    makeFeedXml({
      feedUpdated: "2026-08-13T10:00:00.000Z",
      entries: [
        makeEntryXml({
          atomId: "https://contrataciondelestado.es/sindicacion/entry-older",
          title: "Older entry",
          updated: "2026-08-10T09:00:00.000Z",
          folderId: "REF-OLDER"
        })
      ]
    })
  ];

  const result = await syncPlacspFeed({
    mode: "incremental",
    cursor: {
      lastFeedUpdated: "2026-08-11T08:00:00.000Z",
      entryUpdatedWatermark: "2026-08-12T09:00:00.000Z"
    },
    fetchImpl: async (url) => {
      urls.push(url);
      return mockResponse(pages[urls.length - 1]);
    }
  });

  assert.equal(urls.length, 3);
  assert.equal(result.pagesFetched, 3);
  assert.equal(result.cursorReached, true);
  assert.equal(result.truncated, false);
  assert.equal(result.opportunities.length, 3);
  assert.ok(result.opportunities.some((item) => item.referenceNumber === "REF-BOUNDARY-B"));
});

test("duplicate Atom ids still collapse to the newest version in incremental/manual sync", async () => {
  const firstPage = makeFeedXml({
    feedUpdated: "2026-08-13T12:00:00.000Z",
    nextUrl: "https://contrataciondelestado.es/sindicacion/test-page-2.atom",
    entries: [
      makeEntryXml({
        atomId: "https://contrataciondelestado.es/sindicacion/duplicate-entry",
        title: "Newest duplicate",
        updated: "2026-08-13T12:00:00.000Z",
        folderId: "REF-DUPLICATE-NEW"
      })
    ]
  });
  const secondPage = makeFeedXml({
    feedUpdated: "2026-08-13T11:00:00.000Z",
    entries: [
      makeEntryXml({
        atomId: "https://contrataciondelestado.es/sindicacion/duplicate-entry",
        title: "Older duplicate",
        updated: "2026-08-12T12:00:00.000Z",
        folderId: "REF-DUPLICATE-OLD"
      })
    ]
  });

  const result = await syncPlacspFeed({
    mode: "manual",
    maxPages: 2,
    fetchImpl: async (url) => mockResponse(url.includes("page-2") ? secondPage : firstPage)
  });

  assert.equal(result.uniqueEntries, 1);
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].referenceNumber, "REF-DUPLICATE-NEW");
});

test("incremental sync includes newer tombstones and reports truncation when safety limits stop traversal", async () => {
  const tombstonePage = makeFeedXml({
    feedUpdated: "2026-08-13T12:00:00.000Z",
    nextUrl: "https://contrataciondelestado.es/sindicacion/test-page-2.atom",
    entries: [],
    deletedEntries: [
      makeDeletedEntryXml({
        ref: "https://contrataciondelestado.es/sindicacion/entry-cancelled",
        when: "2026-08-13T11:30:00.000Z"
      })
    ]
  });

  const truncated = await syncPlacspFeed({
    mode: "incremental",
    maxPages: 2,
    maxTotalResponseBytes: tombstonePage.length + 10,
    cursor: {
      lastFeedUpdated: "2026-08-10T00:00:00.000Z",
      entryUpdatedWatermark: "2026-08-01T00:00:00.000Z"
    },
    fetchImpl: async () => mockResponse(tombstonePage)
  });

  assert.equal(truncated.tombstones.length, 1);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.cursorReached, false);
  assert.equal(truncated.truncationReason, "safety_limit");
});
