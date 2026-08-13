import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { BdnsSyncError, syncBdnsCalls } from "../scripts/connectors/bdns-client.mjs";

async function fixture(name) {
  return readFile(new URL(`./fixtures/bdns/${name}`, import.meta.url), "utf8");
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

async function loadCatalog() {
  return JSON.parse(await fixture("details-catalog.json"));
}

test("BDNS client discovers latest calls, respects pages/pageSize, and fetches each unique code once", async () => {
  const catalog = await loadCatalog();
  const page1 = await fixture("latest-page-1.json");
  const page2 = await fixture("latest-page-2.json");
  const urls = [];
  const detailBodies = new Map([
    ["700001", JSON.stringify(catalog.normalSmeGrant)],
    ["700002", JSON.stringify(catalog.fixedWindow)],
    ["700003", JSON.stringify(catalog.expiredWindow)],
    ["700006", JSON.stringify(catalog.descriptiveTextFin)]
  ]);

  const result = await syncBdnsCalls({
    pages: 2,
    pageSize: 20,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes("/ultimas") && url.includes("page=1")) return mockResponse(page1);
      if (url.includes("/ultimas") && url.includes("page=2")) return mockResponse(page2);

      const requestedCode = new URL(url).searchParams.get("numConv");
      return mockResponse(detailBodies.get(requestedCode));
    },
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(result.pagesFetched, 2);
  assert.equal(result.pageSize, 20);
  assert.equal(result.discoveryCount, 5);
  assert.equal(result.uniqueCodes, 4);
  assert.equal(result.detailsRequested, 4);
  assert.equal(result.detailsFetched, 4);
  assert.equal(result.detailFailures.length, 0);
  assert.equal(result.opportunities.length, 4);
  assert.equal(urls.filter((url) => url.includes("numConv=700002")).length, 1);
  assert.ok(urls.some((url) => url.includes("/bdnstrans/api/convocatorias/ultimas")));
  assert.ok(urls.some((url) => url.includes("/bdnstrans/api/convocatorias?numConv=700001")));
});

test("BDNS client isolates detail failures while keeping successful grant details", async () => {
  const catalog = await loadCatalog();
  const page1 = await fixture("latest-page-1.json");
  const urls = [];

  const result = await syncBdnsCalls({
    pages: 1,
    pageSize: 20,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes("/ultimas")) return mockResponse(page1);
      if (url.includes("numConv=700001")) return mockResponse(JSON.stringify(catalog.normalSmeGrant));
      if (url.includes("numConv=700002")) return mockResponse("Bad gateway", { status: 502 });
      throw new Error(`Unexpected URL: ${url}`);
    },
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(result.uniqueCodes, 2);
  assert.equal(result.detailsFetched, 1);
  assert.equal(result.detailFailures.length, 1);
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].sourceOpportunityId, "700001");
});

test("BDNS client surfaces systemic detail enrichment failure as a structured sync error", async () => {
  const page1 = await fixture("latest-page-1.json");

  await assert.rejects(
    () =>
      syncBdnsCalls({
        pages: 1,
        pageSize: 20,
        fetchImpl: async (url) => {
          if (url.includes("/ultimas")) return mockResponse(page1);
          return mockResponse("Bad gateway", { status: 502 });
        }
      }),
    (error) => {
      assert.ok(error instanceof BdnsSyncError);
      assert.equal(error.code, "bdns_detail_enrichment_failed");
      return true;
    }
  );
});

test("BDNS client reports timeout, malformed JSON, and oversized responses safely", async () => {
  await assert.rejects(
    () =>
      syncBdnsCalls({
        timeoutMs: 10,
        fetchImpl: async (_url, { signal }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("Aborted");
              error.name = "AbortError";
              reject(error);
            });
          })
      }),
    (error) => {
      assert.equal(error.code, "bdns_timeout");
      return true;
    }
  );

  await assert.rejects(
    () =>
      syncBdnsCalls({
        fetchImpl: async () => mockResponse("{not-json")
      }),
    (error) => {
      assert.equal(error.code, "bdns_parse_failed");
      return true;
    }
  );

  await assert.rejects(
    () =>
      syncBdnsCalls({
        fetchImpl: async () =>
          mockResponse("[]", {
            headers: {
              "content-length": "7000000"
            }
          })
      }),
    (error) => {
      assert.equal(error.code, "bdns_response_too_large");
      return true;
    }
  );
});

test("BDNS client enforces bounded concurrency and rejects arbitrary non-official hosts", async () => {
  const page1 = JSON.stringify({
    items: [
      { codigoBDNS: "700001" },
      { codigoBDNS: "700002" },
      { codigoBDNS: "700003" },
      { codigoBDNS: "700004" }
    ]
  });
  const catalog = await loadCatalog();
  let active = 0;
  let maxActive = 0;

  const detailBodies = new Map([
    ["700001", JSON.stringify(catalog.normalSmeGrant)],
    ["700002", JSON.stringify(catalog.fixedWindow)],
    ["700003", JSON.stringify(catalog.expiredWindow)],
    ["700004", JSON.stringify(catalog.indefiniteOpen)]
  ]);

  const result = await syncBdnsCalls({
    pages: 1,
    pageSize: 20,
    detailConcurrency: 2,
    fetchImpl: async (url) => {
      if (url.includes("/ultimas")) return mockResponse(page1);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const requestedCode = new URL(url).searchParams.get("numConv");
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return mockResponse(detailBodies.get(requestedCode));
    },
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(result.detailsFetched, 4);
  assert.equal(maxActive, 2);

  await assert.rejects(
    () => syncBdnsCalls({ apiBase: "https://evil.example.test/api" }),
    (error) => {
      assert.equal(error.code, "bdns_host_rejected");
      return true;
    }
  );
});
