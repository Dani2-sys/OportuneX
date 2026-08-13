import { getSearchDepthPolicy } from "../config.js";
import {
  getCompanyCapabilities,
  getCompanyClassifications,
  getCompanyFact,
  getEmployeeRange,
  getFactValue,
  getTurnoverRange
} from "../domain/company-profile.js";
import { daysRemaining, deriveStatus, isNonActionableDerivedStatus } from "../domain/deadline.js";
import { moneyToMajor } from "../domain/money.js";
import { clamp, normalizeText } from "../utils.js";

const SCREEN_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "para",
  "con",
  "por",
  "del",
  "los",
  "las",
  "una",
  "uno",
  "unos",
  "unas",
  "que",
  "como",
  "sobre",
  "entre",
  "this",
  "that",
  "your",
  "empresa",
  "servicio",
  "servicios",
  "contrato",
  "licitacion",
  "subvencion",
  "ayuda",
  "publico",
  "publica",
  "public",
  "obras",
  "obra",
  "suministro",
  "prestacion",
  "programa",
  "convocatoria",
  "expediente",
  "acuerdo",
  "marco",
  "municipal",
  "provincial"
]);

const ACTIVE_PURSUIT_STATUSES = new Set(["interested", "saved", "active", "pursuing"]);

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function toTokens(values = []) {
  const text = values.filter(Boolean).join(" ");
  if (!text) return [];
  return unique(
    normalizeText(text)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !SCREEN_STOPWORDS.has(token))
  );
}

function normalizeCodes(values = []) {
  return unique(
    values
      .map((value) => value?.toString?.().replace(/\D/g, "") ?? "")
      .filter(Boolean)
  );
}

function cpvPrefixMatch(codes = [], prefixes = []) {
  return codes.some((code) => prefixes.some((prefix) => code.startsWith(prefix) || prefix.startsWith(code)));
}

function overlapCount(left = [], right = []) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function hashString(input = "") {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function primaryOpportunityMoney(opportunity) {
  return opportunity?.type === "grant"
    ? opportunity.maximumAidPerBeneficiary ?? null
    : opportunity.relevantValue ??
        opportunity.estimatedValue ??
        opportunity.baseBudget ??
        opportunity.wholeProcedureValue ??
        opportunity.awardValue ??
        opportunity.annualValue ??
        opportunity.multiYearValue ??
        null;
}

function moneyMajor(money) {
  return money ? moneyToMajor(money) : null;
}

function normalizedConnector(opportunity) {
  return opportunity?.sourceConnector ?? "manual";
}

function opportunityFamilyKey(opportunity) {
  const authority = opportunity?.contractingAuthority ?? opportunity?.issuingOrganisation ?? "";
  const titleTokens = toTokens([opportunity?.title ?? ""]).slice(0, 4);
  const authorityTokens = toTokens([authority]).slice(0, 3);
  return [...authorityTokens, ...titleTokens].join("|") || normalizedConnector(opportunity);
}

function buildCompanyContext(company) {
  const capabilities = getCompanyCapabilities(company);
  const capabilitySignals = capabilities.map((capability) => ({
    label: capability.label,
    tokens: toTokens([capability.label, ...(capability.aliases ?? [])]),
    cpvPrefixes: normalizeCodes(capability.cpvPrefixes ?? []),
    baseWeight:
      capability.level === "high"
        ? 14
        : capability.level === "medium"
          ? 11
          : 8,
    statusWeight:
      capability.status === "company_confirmed"
        ? 4
        : capability.status === "public_verified"
          ? 3
          : capability.status === "public_reported"
            ? 2
            : 1
  }));
  const capabilityTokens = toTokens(
    capabilities.flatMap((capability) => [capability.label, ...(capability.aliases ?? [])])
  );
  const workTypeTokens = toTokens([
    ...(company?.preferences?.desiredWorkTypes ?? []),
    ...(company?.preferences?.unwantedWorkTypes ?? [])
  ]);
  const locationTokens = toTokens([
    company?.geography?.municipality,
    company?.geography?.province,
    company?.geography?.autonomousCommunity
  ]);
  const cpvPrefixes = normalizeCodes([
    ...capabilities.flatMap((capability) => capability.cpvPrefixes ?? []),
    ...getCompanyClassifications(company, "cpv").map((item) => item.code)
  ]);
  const minimumAttractive = getFactValue(getCompanyFact(company, "minimumAttractiveProjectValue"));
  const idealProjectValue = getFactValue(getCompanyFact(company, "idealProjectValue"));
  const maximumRealistic = getFactValue(getCompanyFact(company, "maximumRealisticProjectValue"));
  const maximumObserved = getFactValue(getCompanyFact(company, "maximumProjectValue"));
  const employeeRange = getEmployeeRange(company);
  const turnoverRange = getTurnoverRange(company);

  return {
    capabilityTokens,
    capabilitySignals,
    workTypeTokens,
    locationTokens,
    cpvPrefixes,
    minimumAttractive,
    idealProjectValue,
    maximumRealistic,
    maximumObserved,
    employeeRange,
    turnoverRange
  };
}

function capabilitySignal(companyContext, {
  titleTokens = [],
  descriptionTokens = [],
  keywordTokens = [],
  cpvCodes = []
} = {}) {
  const titleSet = new Set(titleTokens);
  const descriptionSet = new Set(descriptionTokens);
  const keywordSet = new Set(keywordTokens);
  const matchedCapabilityLabels = [];
  let score = 0;

  companyContext.capabilitySignals.forEach((capability) => {
    const textTitleHit = capability.tokens.some((token) => titleSet.has(token));
    const textDescriptionHit = capability.tokens.some((token) => descriptionSet.has(token));
    const textKeywordHit = capability.tokens.some((token) => keywordSet.has(token));
    const cpvHit = cpvPrefixMatch(cpvCodes, capability.cpvPrefixes);
    if (!textTitleHit && !textDescriptionHit && !textKeywordHit && !cpvHit) return;

    matchedCapabilityLabels.push(capability.label);
    score += capability.baseWeight + capability.statusWeight;
    if (cpvHit) score += 10;
    if (textTitleHit) score += 6;
    if (textDescriptionHit) score += 4;
    if (textKeywordHit) score += 4;
  });

  return {
    score: Math.min(42, score),
    matchedCapabilityLabels
  };
}

function safeExclusionReason(opportunity, derivedStatus) {
  if (derivedStatus === "closed") return "Deadline definitely in the past.";
  if (derivedStatus === "cancelled") return "Opportunity is explicitly cancelled.";
  if (derivedStatus === "awarded") return "Opportunity is explicitly awarded / non-pursuable.";
  if (derivedStatus === "suspended") return "Opportunity is explicitly suspended.";
  if (opportunity?.cancellationStatus) return "Source marks the opportunity as cancelled.";
  return null;
}

function forcedReasons(opportunity, { savedIds, selectedOpportunityId, pursuitStatuses }) {
  const reasons = [];
  const id = opportunity?.id;
  if (!id) return reasons;
  if (savedIds.has(id)) reasons.push("saved");
  if (selectedOpportunityId && selectedOpportunityId === id) reasons.push("selected");
  if (ACTIVE_PURSUIT_STATUSES.has(pursuitStatuses?.[id])) reasons.push("pursuit");
  if (!opportunity?.sourceConnector) reasons.push("manual_or_demo");
  return reasons;
}

function statusSignal(derivedStatus) {
  if (derivedStatus === "open") return 14;
  if (derivedStatus === "closing_soon") return 10;
  if (derivedStatus === "upcoming") return 8;
  return 4;
}

function deadlineSignal(opportunity, now) {
  const remaining = daysRemaining(opportunity?.deadline, now);
  if (remaining == null) return 4;
  if (remaining < 0) return -100;
  if (remaining === 0) return 2;
  if (remaining <= 3) return 4;
  if (remaining <= 21) return 9;
  return 7;
}

function recencySignal(opportunity, now) {
  const timestamp = opportunity?.modificationDate ?? opportunity?.publicationDate ?? opportunity?.lastChecked ?? null;
  const parsed = Date.parse(timestamp ?? "");
  if (!Number.isFinite(parsed)) return 0;
  const ageDays = (now.getTime() - parsed) / 86400000;
  if (ageDays <= 7) return 5;
  if (ageDays <= 30) return 3;
  if (ageDays <= 90) return 1;
  return 0;
}

function geographySignal(companyContext, opportunity) {
  const opportunityTokens = toTokens([
    opportunity?.location?.municipality,
    opportunity?.location?.province,
    opportunity?.location?.autonomousCommunity,
    opportunity?.location?.display
  ]);
  const overlap = overlapCount(companyContext.locationTokens, opportunityTokens);
  if (overlap >= 2) return 12;
  if (overlap === 1) return 7;

  const excludedRegions = opportunity?.location?.excludedRegions ?? [];
  const companyRegions = [
    opportunity?.location?.province,
    opportunity?.location?.autonomousCommunity
  ].filter(Boolean);
  if (companyRegions.some((region) => excludedRegions.includes(region))) return -6;
  return 0;
}

function scaleSignal(companyContext, opportunity) {
  const value = moneyMajor(primaryOpportunityMoney(opportunity));
  if (!Number.isFinite(value)) return 0;
  if (companyContext.maximumRealistic && value > companyContext.maximumRealistic * 3) return -14;
  if (companyContext.maximumRealistic && value > companyContext.maximumRealistic * 1.5) return -8;
  if (companyContext.minimumAttractive && value < companyContext.minimumAttractive * 0.5) return -4;
  if (companyContext.idealProjectValue && value <= companyContext.idealProjectValue * 1.3) return 8;
  if (companyContext.maximumRealistic && value <= companyContext.maximumRealistic) return 10;
  if (companyContext.maximumObserved && value <= companyContext.maximumObserved * 1.25) return 6;
  return 2;
}

function sparseOpportunityBonus(opportunity) {
  let bonus = 0;
  if (!opportunity?.applicationUrl) bonus += 2;
  if (!primaryOpportunityMoney(opportunity)) bonus += 2;
  if ((opportunity?.description ?? "").trim().length < 60) bonus += 3;
  if ((opportunity?.keywords ?? []).length > 0) bonus += 2;
  return bonus;
}

function buildCandidate(opportunity, company, companyContext, now, forcedReasonSet) {
  const derivedStatus = deriveStatus(opportunity, now);
  const exclusion = safeExclusionReason(opportunity, derivedStatus);
  const connector = normalizedConnector(opportunity);
  const titleTokens = toTokens([opportunity?.title]);
  const descriptionTokens = toTokens([opportunity?.description]);
  const keywordTokens = toTokens(opportunity?.keywords ?? []);
  const companyTokens = unique([...companyContext.capabilityTokens, ...companyContext.workTypeTokens]);
  const titleOverlap = overlapCount(companyTokens, titleTokens);
  const descriptionOverlap = overlapCount(companyTokens, descriptionTokens);
  const keywordOverlap = overlapCount(companyTokens, keywordTokens);
  const normalizedCpvCodes = normalizeCodes(opportunity?.cpvCodes ?? []);
  const capabilityMatch = capabilitySignal(companyContext, {
    titleTokens,
    descriptionTokens,
    keywordTokens,
    cpvCodes: normalizedCpvCodes
  });
  const cpvMatch = cpvPrefixMatch(normalizedCpvCodes, companyContext.cpvPrefixes);

  const signals = [];
  const penalties = [];
  let score = statusSignal(derivedStatus);
  signals.push(`status:${derivedStatus}`);

  if (capabilityMatch.score > 0) {
    score += capabilityMatch.score;
    signals.push(`capability:${capabilityMatch.score}`);
  }

  if (cpvMatch) {
    score += 16;
    signals.push("cpv:16");
  }

  if (titleOverlap > 0) {
    const value = Math.min(18, titleOverlap * 6);
    score += value;
    signals.push(`title:${value}`);
  }
  if (descriptionOverlap > 0) {
    const value = Math.min(14, descriptionOverlap * 4);
    score += value;
    signals.push(`description:${value}`);
  }
  if (keywordOverlap > 0) {
    const value = Math.min(10, keywordOverlap * 5);
    score += value;
    signals.push(`keywords:${value}`);
  }

  const geography = geographySignal(companyContext, opportunity);
  score += geography;
  if (geography > 0) signals.push(`geography:${geography}`);
  if (geography < 0) penalties.push(`geography:${geography}`);

  const scale = scaleSignal(companyContext, opportunity);
  score += scale;
  if (scale > 0) signals.push(`scale:${scale}`);
  if (scale < 0) penalties.push(`scale:${scale}`);

  const deadline = deadlineSignal(opportunity, now);
  score += deadline;
  if (deadline > 0) signals.push(`deadline:${deadline}`);

  const recency = recencySignal(opportunity, now);
  score += recency;
  if (recency > 0) signals.push(`recency:${recency}`);

  if (capabilityMatch.score < 12 && titleOverlap === 0 && descriptionOverlap === 0 && keywordOverlap === 0 && !cpvMatch) {
    score -= 10;
    penalties.push("text_scope:-10");
  }

  const explorationBonus =
    Math.round((capabilityMatch.score ?? 0) * 0.6) +
    (cpvMatch ? 10 : 0) +
    (descriptionOverlap > titleOverlap ? 6 : 0) +
    sparseOpportunityBonus(opportunity) +
    (connector === "bdns" ? 3 : 0);

  const rawScreenScore = score;
  const rawExplorationScore = Math.round(score * 0.7 + explorationBonus);

  return {
    opportunity,
    opportunityId: opportunity.id,
    connector,
    familyKey: opportunityFamilyKey(opportunity),
    derivedStatus,
    forcedReasons: forcedReasonSet,
    forced: forcedReasonSet.length > 0,
    safeExcludedReason: exclusion,
    rawScreenScore,
    rawExplorationScore,
    screenScore: clamp(rawScreenScore, 0, 100),
    explorationScore: clamp(rawExplorationScore, 0, 100),
    screenSignals: signals,
    screenPenalties: penalties,
    semanticScore: capabilityMatch.score,
    matchedCapabilityLabels: capabilityMatch.matchedCapabilityLabels,
    deterministicKey: `${opportunity.id}|${hashString(`${company.id}|${opportunity.id}`).toString(16)}`
  };
}

function selectWithDiversity(candidates, limit, existing = [], scoreField = "rawScreenScore") {
  if (limit <= 0 || !candidates.length) return [];
  const remaining = [...candidates];
  const connectorCounts = new Map();
  const familyCounts = new Map();

  [...existing].forEach((candidate) => {
    connectorCounts.set(candidate.connector, (connectorCounts.get(candidate.connector) ?? 0) + 1);
    familyCounts.set(candidate.familyKey, (familyCounts.get(candidate.familyKey) ?? 0) + 1);
  });

  const selected = [];
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    remaining.forEach((candidate, index) => {
      const baseScore =
        candidate[scoreField] ??
        candidate.rawScreenScore ??
        candidate.screenScore ??
        0;
      const connectorPenalty = (connectorCounts.get(candidate.connector) ?? 0) * 1.25;
      const familyPenalty = (familyCounts.get(candidate.familyKey) ?? 0) * 3;
      const adjusted = baseScore - connectorPenalty - familyPenalty;
      if (
          adjusted > bestScore ||
        (adjusted === bestScore &&
          baseScore >
            (
              remaining[bestIndex][scoreField] ??
              remaining[bestIndex].rawScreenScore ??
              remaining[bestIndex].screenScore ??
              0
            )) ||
        (adjusted === bestScore &&
          baseScore ===
            (
              remaining[bestIndex][scoreField] ??
              remaining[bestIndex].rawScreenScore ??
              remaining[bestIndex].screenScore ??
              0
            ) &&
          candidate.deterministicKey.localeCompare(remaining[bestIndex].deterministicKey) < 0)
      ) {
        bestIndex = index;
        bestScore = adjusted;
      }
    });

    const [winner] = remaining.splice(bestIndex, 1);
    selected.push(winner);
    connectorCounts.set(winner.connector, (connectorCounts.get(winner.connector) ?? 0) + 1);
    familyCounts.set(winner.familyKey, (familyCounts.get(winner.familyKey) ?? 0) + 1);
  }

  return selected;
}

function countByConnector(entries = [], accessor = (item) => item.connector) {
  return entries.reduce((record, item) => {
    const connector = accessor(item);
    record[connector] = (record[connector] ?? 0) + 1;
    return record;
  }, {});
}

function dedupeCandidates(candidates = []) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate?.opportunityId || seen.has(candidate.opportunityId)) return false;
    seen.add(candidate.opportunityId);
    return true;
  });
}

function candidatePoolLimit(policy, analysisDepth, sourceCount) {
  return Math.min(sourceCount, Math.max(policy.candidateConsideration, analysisDepth * 2));
}

export function buildCandidateFunnel({
  company,
  opportunities = [],
  now = new Date(),
  policy = getSearchDepthPolicy(),
  analysisDepth = policy.defaultAnalysis,
  savedOpportunityIds = [],
  pursuitStatuses = {},
  selectedOpportunityId = null
} = {}) {
  const startedAt = Date.now();
  const savedIds = new Set(savedOpportunityIds ?? []);
  const companyContext = buildCompanyContext(company);
  const screened = opportunities.map((opportunity) =>
    buildCandidate(
      opportunity,
      company,
      companyContext,
      now,
      forcedReasons(opportunity, { savedIds, selectedOpportunityId, pursuitStatuses })
    )
  );

  const forced = screened.filter((candidate) => candidate.forced);
  const safeExcluded = screened.filter((candidate) => candidate.safeExcludedReason && !candidate.forced);
  const eligible = screened.filter((candidate) => !candidate.safeExcludedReason || candidate.forced);
  const nonForcedEligible = eligible
    .filter((candidate) => !candidate.forced)
    .sort(
      (left, right) =>
        right.rawScreenScore - left.rawScreenScore ||
        right.rawExplorationScore - left.rawExplorationScore ||
        left.deterministicKey.localeCompare(right.deterministicKey)
    );

  const targetDepth = Math.max(policy.defaultAnalysis, Math.min(policy.maxAnalysis, Math.round(analysisDepth)));
  const poolLimit = candidatePoolLimit(policy, targetDepth, eligible.length);
  const nonForcedPoolLimit = Math.max(0, poolLimit - forced.length);
  const pooledNonForced = selectWithDiversity(nonForcedEligible, nonForcedPoolLimit, forced, "rawScreenScore");
  const candidatePool = dedupeCandidates([...forced, ...pooledNonForced]);

  const nonForcedTarget = Math.max(0, targetDepth - forced.length);
  const explorationTarget = nonForcedTarget > 0 ? Math.round(nonForcedTarget * policy.explorationReserveRatio) : 0;
  const topTarget = Math.max(0, nonForcedTarget - explorationTarget);
  const topScoreCandidates = selectWithDiversity(nonForcedEligible, topTarget, forced, "rawScreenScore");
  const topScoreIds = new Set(topScoreCandidates.map((candidate) => candidate.opportunityId));
  const explorationEligible = nonForcedEligible
    .filter((candidate) => !topScoreIds.has(candidate.opportunityId))
    .sort(
      (left, right) =>
        right.rawExplorationScore - left.rawExplorationScore ||
        right.rawScreenScore - left.rawScreenScore ||
        left.deterministicKey.localeCompare(right.deterministicKey)
    );
  const explorationCandidates = selectWithDiversity(
    explorationEligible,
    explorationTarget,
    [...forced, ...topScoreCandidates],
    "rawExplorationScore"
  );
  const selectedCandidates = dedupeCandidates([...forced, ...topScoreCandidates, ...explorationCandidates]);
  const selectedForAnalysis = selectedCandidates.map((candidate) => candidate.opportunity);

  const candidateByOpportunityId = Object.fromEntries(
    screened.map((candidate) => [candidate.opportunityId, candidate])
  );
  const connectorUniverse = countByConnector(screened);
  const connectorEligible = countByConnector(eligible);
  const connectorPool = countByConnector(candidatePool);
  const connectorSelected = countByConnector(selectedCandidates);

  return {
    policy,
    sourceUniverseCount: opportunities.length,
    safeExcludedCount: safeExcluded.length,
    eligibleForScreenCount: eligible.length,
    candidatePoolCount: candidatePool.length,
    analysisDepth: targetDepth,
    selectedForAnalysisCount: selectedCandidates.length,
    forcedCount: forced.length,
    topScoreCount: topScoreCandidates.length,
    explorationCount: explorationCandidates.length,
    selectedForAnalysis,
    selectedOpportunityIds: selectedCandidates.map((candidate) => candidate.opportunityId),
    candidatePoolOpportunityIds: candidatePool.map((candidate) => candidate.opportunityId),
    safeExcluded,
    screened,
    byOpportunityId: candidateByOpportunityId,
    connectorBreakdown: Object.keys({
      ...connectorUniverse,
      ...connectorEligible,
      ...connectorPool,
      ...connectorSelected
    })
      .sort((left, right) => left.localeCompare(right))
      .reduce((record, connector) => {
        record[connector] = {
          sourceUniverse: connectorUniverse[connector] ?? 0,
          eligibleForScreen: connectorEligible[connector] ?? 0,
          candidatePool: connectorPool[connector] ?? 0,
          selectedForAnalysis: connectorSelected[connector] ?? 0
        };
        return record;
      }, {}),
    canSearchWider: targetDepth < policy.maxAnalysis,
    screeningMs: Date.now() - startedAt
  };
}
