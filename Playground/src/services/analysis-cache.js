import { APPLICATION_TIME_ZONE } from "../clock.js";
import { analyzeOpportunity, buildPortfolioFromOutcomes } from "../domain/analysis.js";
import { currentYmd } from "../domain/deadline.js";

const ANALYSIS_CACHE_ABSOLUTE_HOUR_MS = 3_600_000;
const VOLATILE_KEYS = new Set([
  "lastChecked",
  "fetchedAt",
  "syncedAt",
  "retrievedAt",
  "analysisNow",
  "cacheCheckedAt",
  "cacheUpdatedAt"
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactRecord(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value == null) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (isPlainObject(value)) return Object.keys(value).length > 0;
      return value !== "";
    })
  );
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce((record, key) => {
      if (VOLATILE_KEYS.has(key)) return record;
      const nextValue = sortValue(value[key]);
      if (nextValue !== undefined) record[key] = nextValue;
      return record;
    }, {});
}

function stableSerialize(value) {
  return JSON.stringify(sortValue(value));
}

function hashFingerprint(input) {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  const mask = 18446744073709551615n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function companyFingerprint(company = {}) {
  return `company:v1:${hashFingerprint(stableSerialize(company))}`;
}

function opportunityFingerprint(opportunity = {}) {
  if (opportunity?.sourceNoticeVersionId) {
    return `source:v1:${opportunity.id ?? "opportunity"}:${opportunity.sourceNoticeVersionId}`;
  }

  const payload = compactRecord({
    ...opportunity,
    id: opportunity?.id ?? null,
    sourceNoticeVersionId: null
  });
  return `manual:v1:${hashFingerprint(stableSerialize(payload))}`;
}

function runtimeFingerprint(runtime = {}) {
  return `runtime:v1:${hashFingerprint(stableSerialize({
    verification: runtime?.verification ?? {},
    scoring: runtime?.scoring ?? {}
  }))}`;
}

function normalizeInstant(now) {
  return now instanceof Date ? now : new Date(now);
}

function absoluteHourBucket(now) {
  const instant = normalizeInstant(now);
  return Math.floor(instant.getTime() / ANALYSIS_CACHE_ABSOLUTE_HOUR_MS);
}

export function buildAnalysisCacheTimeKey(now = new Date()) {
  const instant = normalizeInstant(now);
  return `madrid-date:${currentYmd(instant)}@${APPLICATION_TIME_ZONE}|absolute-hour:${absoluteHourBucket(instant)}`;
}

function originalAnalysisTimeOf(outcome, now) {
  return outcome?.analysisNow ?? normalizeInstant(now).toISOString();
}

function cacheEntryOf(outcome, now) {
  return {
    outcome,
    computedAt: originalAnalysisTimeOf(outcome, now)
  };
}

function cloneOutcomeForCurrentPass(entry, now) {
  if (!entry?.outcome || typeof entry.outcome !== "object") return entry?.outcome ?? null;
  return {
    ...entry.outcome,
    analysisNow: entry.computedAt,
    cacheCheckedAt: normalizeInstant(now).toISOString(),
    cacheUpdatedAt: entry.computedAt
  };
}

function timeKey(now) {
  const instant = now instanceof Date ? now : new Date(now);
  return buildAnalysisCacheTimeKey(instant);
}

export function createAnalysisCache({
  analyzeOpportunityImpl = analyzeOpportunity,
  timeKeyImpl = timeKey,
  nowImpl = () => new Date()
} = {}) {
  const records = new Map();
  const metrics = {
    totalHits: 0,
    totalMisses: 0,
    lastRunHits: 0,
    lastRunMisses: 0,
    lastRunAt: null,
    lastPortfolioAnalysisMs: 0,
    lastRunOpportunityCount: 0,
    lastRecomputedOpportunityIds: []
  };

  function recordHit() {
    metrics.totalHits += 1;
    metrics.lastRunHits += 1;
  }

  function recordMiss(opportunityId) {
    metrics.totalMisses += 1;
    metrics.lastRunMisses += 1;
    metrics.lastRecomputedOpportunityIds.push(opportunityId);
  }

  function buildKey(company, opportunity, runtime, now) {
    return [
      companyFingerprint(company),
      opportunityFingerprint(opportunity),
      runtimeFingerprint(runtime),
      `time:${timeKeyImpl(now)}`
    ].join("|");
  }

  function resetRunMetrics(now) {
    metrics.lastRunHits = 0;
    metrics.lastRunMisses = 0;
    metrics.lastRunAt = (now instanceof Date ? now : nowImpl()).toISOString();
    metrics.lastRunOpportunityCount = 0;
    metrics.lastRecomputedOpportunityIds = [];
  }

  function getOrAnalyze({ company, opportunity, runtime, now = nowImpl() }) {
    const key = buildKey(company, opportunity, runtime, now);
    const cachedEntry = records.get(key);
    if (cachedEntry) {
      recordHit();
      return {
        hit: true,
        key,
        // Cached outcomes keep their original analysis timestamp; pass timing
        // stays in metrics.lastRunAt so rerenders do not masquerade as recomputes.
        outcome: cloneOutcomeForCurrentPass(cachedEntry, now)
      };
    }

    const outcome = analyzeOpportunityImpl(company, opportunity, runtime, now);
    records.set(key, cacheEntryOf(outcome, now));
    recordMiss(opportunity?.id ?? "opportunity");
    return {
      hit: false,
      key,
      outcome: cloneOutcomeForCurrentPass(records.get(key), now)
    };
  }

  function analyzePortfolioWithCache(company, opportunities = [], runtime, now = nowImpl()) {
    const startedAt = Date.now();
    resetRunMetrics(now);
    const outcomes = opportunities.map((opportunity) => {
      const result = getOrAnalyze({ company, opportunity, runtime, now });
      metrics.lastRunOpportunityCount += 1;
      return result.outcome;
    });
    const portfolio = buildPortfolioFromOutcomes(company, outcomes, now, opportunities.length);
    metrics.lastPortfolioAnalysisMs = Date.now() - startedAt;
    return portfolio;
  }

  return {
    getOrAnalyze,
    analyzePortfolio: analyzePortfolioWithCache,
    clear() {
      records.clear();
      metrics.totalHits = 0;
      metrics.totalMisses = 0;
      metrics.lastRunHits = 0;
      metrics.lastRunMisses = 0;
      metrics.lastRunAt = null;
      metrics.lastPortfolioAnalysisMs = 0;
      metrics.lastRunOpportunityCount = 0;
      metrics.lastRecomputedOpportunityIds = [];
    },
    getMetrics() {
      const total = metrics.totalHits + metrics.totalMisses;
      return {
        cacheSize: records.size,
        totalHits: metrics.totalHits,
        totalMisses: metrics.totalMisses,
        hitRatio: total ? Math.round((metrics.totalHits / total) * 1000) / 10 : 0,
        lastRunHits: metrics.lastRunHits,
        lastRunMisses: metrics.lastRunMisses,
        lastRunAt: metrics.lastRunAt,
        lastPortfolioAnalysisMs: metrics.lastPortfolioAnalysisMs,
        lastRunOpportunityCount: metrics.lastRunOpportunityCount,
        lastRecomputedOpportunityIds: [...metrics.lastRecomputedOpportunityIds]
      };
    }
  };
}
