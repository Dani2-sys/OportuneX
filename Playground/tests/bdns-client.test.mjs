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

function createLatestPage(...codes) {
  return JSON.stringify({
    items: codes.map((code) => ({ codigoBDNS: code }))
  });
}

function createVirtualClock(start = "2026-08-13T10:00:00.000Z") {
  let currentMs = Date.parse(start);
  const sleepCalls = [];

  return {
    nowMsImpl() {
      return currentMs;
    },
    async sleepImpl(milliseconds) {
      sleepCalls.push(milliseconds);
      currentMs += milliseconds;
    },
    getSleepCalls() {
      return [...sleepCalls];
    }
  };
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

test("BDNS client retries a 429 detail response once and succeeds without dropping the record", async () => {
  const catalog = await loadCatalog();
  const clock = createVirtualClock();
  let detailCalls = 0;

  const result = await syncBdnsCalls({
    pages: 1,
    pageSize: 20,
    fetchImpl: async (url) => {
      if (url.includes("/ultimas")) return mockResponse(createLatestPage("700001"));
      if (!url.includes("numConv=700001")) throw new Error(`Unexpected URL: ${url}`);
      detailCalls += 1;
      if (detailCalls === 1) {
        return mockResponse("Too Many Requests", { status: 429 });
      }
      return mockResponse(JSON.stringify(catalog.normalSmeGrant));
    },
    sleepImpl: clock.sleepImpl,
    nowMsImpl: clock.nowMsImpl,
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(detailCalls, 2);
  assert.equal(result.detailsFetched, 1);
  assert.equal(result.detailFailures.length, 0);
  assert.equal(result.requests[0].attempts, 2);
  assert.deepEqual(clock.getSleepCalls(), [1500]);
});

test("BDNS client respects Retry-After on a 429 detail response when it is reasonable", async () => {
  const catalog = await loadCatalog();
  const clock = createVirtualClock();
  let detailCalls = 0;

  const result = await syncBdnsCalls({
    pages: 1,
    pageSize: 20,
    fetchImpl: async (url) => {
      if (url.includes("/ultimas")) return mockResponse(createLatestPage("700001"));
      if (!url.includes("numConv=700001")) throw new Error(`Unexpected URL: ${url}`);
      detailCalls += 1;
      if (detailCalls === 1) {
        return mockResponse("Too Many Requests", {
          status: 429,
          headers: {
            "retry-after": "4"
          }
        });
      }
      return mockResponse(JSON.stringify(catalog.normalSmeGrant));
    },
    sleepImpl: clock.sleepImpl,
    nowMsImpl: clock.nowMsImpl,
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(detailCalls, 2);
  assert.equal(result.detailsFetched, 1);
  assert.deepEqual(clock.getSleepCalls(), [4000]);
});

test("BDNS client bounds repeated 429 retries, isolates the failed detail, and keeps other records flowing", async () => {
  const catalog = await loadCatalog();
  const clock = createVirtualClock();
  const detailCalls = new Map();

  const result = await syncBdnsCalls({
    pages: 1,
    pageSize: 20,
    fetchImpl: async (url) => {
      if (url.includes("/ultimas")) return mockResponse(createLatestPage("700001", "700002"));
      const requestedCode = new URL(url).searchParams.get("numConv");
      detailCalls.set(requestedCode, (detailCalls.get(requestedCode) ?? 0) + 1);
      if (requestedCode === "700001") {
        return mockResponse("Too Many Requests", { status: 429 });
      }
      if (requestedCode === "700002") {
        return mockResponse(JSON.stringify(catalog.fixedWindow));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    sleepImpl: clock.sleepImpl,
    nowMsImpl: clock.nowMsImpl,
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(detailCalls.get("700001"), 3);
  assert.equal(detailCalls.get("700002"), 1);
  assert.equal(result.detailsFetched, 1);
  assert.equal(result.detailFailures.length, 1);
  assert.equal(result.detailFailures[0].attempts, 3);
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].sourceOpportunityId, "700002");
});

test("BDNS client does not retry non-transient 400 detail errors", async () => {
  const catalog = await loadCatalog();
  const detailCalls = new Map();

  const result = await syncBdnsCalls({
    pages: 1,
    pageSize: 20,
    fetchImpl: async (url) => {
      if (url.includes("/ultimas")) return mockResponse(createLatestPage("700001", "700002"));
      const requestedCode = new URL(url).searchParams.get("numConv");
      detailCalls.set(requestedCode, (detailCalls.get(requestedCode) ?? 0) + 1);
      if (requestedCode === "700001") {
        return mockResponse("Bad Request", { status: 400 });
      }
      if (requestedCode === "700002") {
        return mockResponse(JSON.stringify(catalog.fixedWindow));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(detailCalls.get("700001"), 1);
  assert.equal(detailCalls.get("700002"), 1);
  assert.equal(result.detailsFetched, 1);
  assert.equal(result.detailFailures.length, 1);
  assert.equal(result.detailFailures[0].attempts, 1);
});

test("BDNS client retries transient 503 detail failures with bounded exponential backoff", async () => {
  const catalog = await loadCatalog();
  const clock = createVirtualClock();
  let detailCalls = 0;

  const result = await syncBdnsCalls({
    pages: 1,
    pageSize: 20,
    fetchImpl: async (url) => {
      if (url.includes("/ultimas")) return mockResponse(createLatestPage("700001"));
      if (!url.includes("numConv=700001")) throw new Error(`Unexpected URL: ${url}`);
      detailCalls += 1;
      if (detailCalls < 3) {
        return mockResponse("Service Unavailable", { status: 503 });
      }
      return mockResponse(JSON.stringify(catalog.normalSmeGrant));
    },
    sleepImpl: clock.sleepImpl,
    nowMsImpl: clock.nowMsImpl,
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(detailCalls, 3);
  assert.equal(result.detailsFetched, 1);
  assert.equal(result.detailFailures.length, 0);
  assert.deepEqual(clock.getSleepCalls(), [1500, 3000]);
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

test("BDNS client serializes detail enrichment to concurrency 1 and paces manual starts", async () => {
  const catalog = await loadCatalog();
  const clock = createVirtualClock();
  let active = 0;
  let maxActive = 0;
  const detailStartTimes = [];

  const detailBodies = new Map([
    ["700001", JSON.stringify(catalog.normalSmeGrant)],
    ["700002", JSON.stringify(catalog.fixedWindow)],
    ["700003", JSON.stringify(catalog.expiredWindow)],
    ["700004", JSON.stringify(catalog.indefiniteOpen)]
  ]);

  const result = await syncBdnsCalls({
    pages: 1,
    pageSize: 20,
    mode: "manual",
    fetchImpl: async (url) => {
      if (url.includes("/ultimas")) return mockResponse(createLatestPage("700001", "700002", "700003", "700004"));
      active += 1;
      maxActive = Math.max(maxActive, active);
      detailStartTimes.push(clock.nowMsImpl());
      const requestedCode = new URL(url).searchParams.get("numConv");
      await Promise.resolve();
      active -= 1;
      return mockResponse(detailBodies.get(requestedCode));
    },
    sleepImpl: clock.sleepImpl,
    nowMsImpl: clock.nowMsImpl,
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(result.detailsFetched, 4);
  assert.equal(maxActive, 1);
  assert.equal(result.detailConcurrency, 1);
  assert.equal(result.detailStartSpacingMs, 400);
  assert.deepEqual(
    detailStartTimes.slice(1).map((time, index) => time - detailStartTimes[index]),
    [400, 400, 400]
  );
  assert.deepEqual(clock.getSleepCalls(), [400, 400, 400]);
});

test("BDNS client uses gentler automatic pacing without increasing concurrency", async () => {
  const catalog = await loadCatalog();
  const clock = createVirtualClock();
  const detailStartTimes = [];

  const detailBodies = new Map([
    ["700001", JSON.stringify(catalog.normalSmeGrant)],
    ["700002", JSON.stringify(catalog.fixedWindow)]
  ]);

  const result = await syncBdnsCalls({
    mode: "automatic",
    fetchImpl: async (url) => {
      if (url.includes("/ultimas")) return mockResponse(createLatestPage("700001", "700002"));
      detailStartTimes.push(clock.nowMsImpl());
      const requestedCode = new URL(url).searchParams.get("numConv");
      return mockResponse(detailBodies.get(requestedCode));
    },
    sleepImpl: clock.sleepImpl,
    nowMsImpl: clock.nowMsImpl,
    now: new Date("2026-08-13T10:00:00.000Z")
  });

  assert.equal(result.detailsFetched, 2);
  assert.equal(result.detailConcurrency, 1);
  assert.equal(result.detailStartSpacingMs, 600);
  assert.deepEqual(
    detailStartTimes.slice(1).map((time, index) => time - detailStartTimes[index]),
    [600]
  );
  assert.deepEqual(clock.getSleepCalls(), [600]);
});

test("BDNS client rejects arbitrary non-official hosts", async () => {

  await assert.rejects(
    () => syncBdnsCalls({ apiBase: "https://evil.example.test/api" }),
    (error) => {
      assert.equal(error.code, "bdns_host_rejected");
      return true;
    }
  );
});
