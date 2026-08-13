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
