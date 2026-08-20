import { RECOMMENDATION_COPY } from "../config.js";
import { compareDesc } from "../utils.js";
import { getCompanyCapabilities } from "./company-profile.js";
import { daysRemaining, deriveStatus, isActiveDerivedStatus, isNonActionableDerivedStatus } from "./deadline.js";
import { extractClaims } from "./evidence.js";
import { evaluateEligibility } from "./eligibility.js";
import { buildFinancialPicture } from "./financial-picture.js";
import { formatMoney, moneyToMajor } from "./money.js";
import {
  countExplicitPublishedLots,
  getAnalysisScopeLabel,
  getAnalysisScopeType,
  getSelectedExplicitLotId,
  getSelectedExplicitLotLabel,
  isSelectedExplicitLot,
  resolveLotOrOpportunityLocation
} from "./opportunity-scope.js";
import { assembleDimensions, computeScores, deriveRecommendation, normalizeLocationRecord } from "./scoring.js";
import { scoreCapabilityFit } from "./semantic.js";
import { executiveVerdict, generateReportMarkdown } from "./report.js";

function primaryOpportunityMoney(opportunity) {
  return opportunity.type === "grant"
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

function defaultLot(opportunity) {
  return {
    id: `${opportunity.id}-root`,
    title: opportunity.title,
    description: opportunity.description,
    cpvCodes: opportunity.cpvCodes ?? [],
    value: primaryOpportunityMoney(opportunity),
    synthetic: true,
    requirements: []
  };
}

function hasExplicitPublishedLot(lot) {
  return Boolean(lot && !lot.synthetic);
}

function collapseDiagnosticText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function conciseLotDiagnosticLabel(sourceLot, lotMatch, opportunityTitle) {
  const procedureTitle = collapseDiagnosticText(opportunityTitle);
  const candidates = [
    lotMatch?.lotLabel,
    sourceLot?.id,
    sourceLot?.title,
    lotMatch?.lotId
  ]
    .map(collapseDiagnosticText)
    .filter(Boolean)
    .filter((value, index, items) => items.indexOf(value) === index);
  const withoutProcedureTitle = candidates.filter((value) => value !== procedureTitle);
  const preferred = (withoutProcedureTitle.length ? withoutProcedureTitle : candidates).find((value) => value.length <= 48);
  return preferred ?? withoutProcedureTitle[0] ?? candidates[0] ?? "Unknown lot";
}

function summarizeRequirementForTrace(requirement = {}) {
  return {
    id: requirement.id ?? null,
    label: requirement.label ?? requirement.title ?? null,
    kind: requirement.kind ?? null,
    mandatory: Boolean(requirement.mandatory),
    gating: requirement.gating ?? null
  };
}

export function deriveLotSelectionReason(analysis = {}) {
  const selectionSource = getSelectedExplicitLotId(analysis) ? analysis : (analysis?.bestMatch ?? analysis);
  const selectedLotId = getSelectedExplicitLotId(selectionSource);
  if (!selectedLotId) return "Whole opportunity";
  const rankedLotMatches = (analysis?.lotMatches ?? []).filter((lotMatch) => lotMatch?.hasPublishedLot && lotMatch?.lotId);
  if (!rankedLotMatches.length) return "Selected lot not found in analysed lot matches";
  const topPriority = rankedLotMatches[0]?.priorityScore ?? Number.NEGATIVE_INFINITY;
  const topPriorityLots = rankedLotMatches.filter((lotMatch) => (lotMatch?.priorityScore ?? Number.NEGATIVE_INFINITY) === topPriority);
  return topPriorityLots.length > 1 ? "Stable tie-break: source order" : "Highest priority score";
}

export function traceLotDifferentiation(company = {}, opportunity = {}, analysis = {}) {
  const selectionSource = getSelectedExplicitLotId(analysis) ? analysis : (analysis?.bestMatch ?? analysis);
  const explicitLots = (opportunity?.lots ?? []).filter((lot) => lot && !lot.synthetic);
  const lotMatchesById = new Map(
    (analysis?.lotMatches ?? [])
      .filter((lotMatch) => lotMatch?.hasPublishedLot && lotMatch?.lotId)
      .map((lotMatch) => [lotMatch.lotId, lotMatch])
  );
  const companyLocationRaw = {
    municipality: company?.geography?.municipality ?? "",
    province: company?.geography?.province ?? "",
    autonomousCommunity: company?.geography?.autonomousCommunity ?? "",
    country: company?.geography?.country ?? ""
  };
  const companyCapabilities = getCompanyCapabilities(company).map((capability) => ({
    id: capability.id ?? null,
    label: capability.label ?? null,
    level: capability.level ?? null,
    status: capability.status ?? null,
    cpvPrefixes: [...(capability.cpvPrefixes ?? [])]
  }));

  return {
    procedureTitle: opportunity?.title ?? null,
    selectedLotId: getSelectedExplicitLotId(selectionSource),
    selectionReason: deriveLotSelectionReason(analysis),
    companyLocationRaw,
    companyLocationNormalized: normalizeLocationRecord(companyLocationRaw),
    companyCapabilities,
    lots: explicitLots.flatMap((sourceLot) => {
      const lotMatch = lotMatchesById.get(sourceLot.id);
      if (!lotMatch) return [];
      const rawLotLocation = sourceLot.location ?? {};
      const resolvedLocation = resolveLotOrOpportunityLocation(sourceLot, opportunity);
      return [{
        lotId: sourceLot.id ?? lotMatch.lotId ?? null,
        conciseLabel: conciseLotDiagnosticLabel(sourceLot, lotMatch, opportunity?.title),
        fullTitle: collapseDiagnosticText(sourceLot.title) || null,
        rawLotLocation,
        rawLotLocationNormalized: normalizeLocationRecord(rawLotLocation),
        resolvedLocation,
        resolvedLocationNormalized: normalizeLocationRecord(resolvedLocation),
        capabilityScopeInput: {
          title: sourceLot.title ?? null,
          description: sourceLot.description ?? null,
          keywords: [...(sourceLot.keywords ?? [])],
          cpvCodes: [...(sourceLot.cpvCodes ?? [])]
        },
        lotFinancialValue: sourceLot.value ?? null,
        lotFinancialValueLabel: formatMoney(sourceLot.value),
        qualificationRequirementsSupplied: {
          opportunityRequirements: (opportunity.requirements ?? []).map(summarizeRequirementForTrace),
          lotRequirements: (sourceLot.requirements ?? []).map(summarizeRequirementForTrace)
        },
        eligibilitySubject: {
          title: sourceLot.title ?? null,
          description: sourceLot.description ?? null,
          keywords: [...(sourceLot.keywords ?? [])],
          cpvCodes: [...(sourceLot.cpvCodes ?? [])],
          location: resolvedLocation
        },
        outputs: {
          capabilityFit: lotMatch.dimensions?.capabilityFit ?? null,
          geographicFit: lotMatch.dimensions?.geographicFit ?? null,
          financialScaleFit: lotMatch.dimensions?.financialScaleFit ?? null,
          qualificationReadiness: lotMatch.dimensions?.qualificationReadiness ?? null,
          eligibilityStatus: lotMatch.eligibilityStatus ?? null,
          matchScore: lotMatch.matchScore ?? null,
          priorityScore: lotMatch.priorityScore ?? null
        }
      }];
    })
  };
}

function buildAdaptiveQuestions(eligibility) {
  return eligibility.requirementRows
    .filter((row) => row.status === "needs_verification" && row.mandatory)
    .sort((left, right) => (right.questionPriority ?? 0) - (left.questionPriority ?? 0) || left.label.localeCompare(right.label))
    .map((row) => ({
      id: row.id,
      question:
        row.question ??
        `Can your company confirm the requirement: ${row.label}?`,
      why: row.why,
      options: ["Yes", "No", "Unsure", "Add later"]
    }));
}

function buildDeadlineSignal(opportunity, now) {
  if (opportunity.derivedStatus === "awarded") return "This notice is already awarded and is not open for submission.";
  if (opportunity.derivedStatus === "cancelled") return "This notice is cancelled and no submission window applies.";
  if (opportunity.derivedStatus === "suspended") return "This notice is suspended and should not be treated as actively pursuable.";
  const remaining = daysRemaining(opportunity.deadline, now);
  if (remaining == null) return "The published deadline is not clear enough to assess timing.";
  if (remaining < 0) return "The published deadline has already passed.";
  if (remaining === 0) return "The published deadline is today in Europe/Madrid.";
  return `The published deadline is ${remaining} calendar day${remaining === 1 ? "" : "s"} away in Europe/Madrid.`;
}

function buildPreMortem(match) {
  const items = [];
  if (match.decision?.recommendedAction?.code === "DO_NOT_PURSUE") {
    items.push(`Primary stop reason: ${match.decision.mainReason}.`);
  }
  if (isNonActionableDerivedStatus(match.opportunityDerivedStatus)) {
    if (match.opportunityDerivedStatus === "awarded") {
      items.push("Archival review only. No live submission planning or route is relevant for an awarded notice.");
    }
    return items.slice(0, 2);
  }
  if (match.decision?.mainQuestion) {
    items.push(`Primary open question: ${match.decision.mainQuestion}.`);
  }
  if (match.dimensions.deadlineFeasibility < 50) {
    items.push("The preparation window may be too short for a careful submission.");
  }
  if (match.dimensions.applicationEffort < 45) {
    items.push("The published requirement load looks heavy relative to the likely return.");
  }
  return items.slice(0, 3);
}

function choosePrimaryContact(opportunity) {
  return (
    (opportunity.contacts ?? []).find((contact) => contact.role === "authority") ??
    (opportunity.contacts ?? []).find((contact) => contact.role === "submission") ??
    null
  );
}

function computeCompanyAmountLabel(opportunity) {
  if (opportunity.type === "grant") {
    return opportunity.maximumAidPerBeneficiary
      ? `Maximum public aid: up to ${formatMoney(opportunity.maximumAidPerBeneficiary)}`
      : "Maximum public aid not yet verified from reviewed sources";
  }
  return "Not a grant";
}

function fallbackDisplayValueLabel(opportunity) {
  const value = primaryOpportunityMoney(opportunity);
  return value ? formatMoney(value) : "Value not published";
}

function fallbackLocationLabel(opportunity) {
  return (
    opportunity.location?.display ??
    [opportunity.location?.municipality, opportunity.location?.province].filter(Boolean).join(", ") ??
    "Location not published"
  );
}

function availabilityRisks(opportunity) {
  return (opportunity.availabilityWarnings ?? []).map((warning, index) => ({
    id: warning.id ?? `availability-warning-${index + 1}`,
    title: warning.title ?? "Availability / competition warning",
    detail: warning.detail ?? "The source indicates heightened competition or reduced remaining availability.",
    severity: warning.severity ?? "medium",
    requiresVerification: false,
    category: "availability"
  }));
}

function procurementRisks(opportunity, eligibility, primaryContact) {
  const risks = [];
  const activeStatus = isActiveDerivedStatus(opportunity.derivedStatus);

  if (!activeStatus) {
    if ((opportunity.sources ?? []).every((source) => !source.official)) {
      risks.push({
        id: "secondary-sources-only",
        title: "Official dossier evidence is incomplete",
        detail: "The current workspace relies on listings or secondary summaries rather than a verified official dossier.",
        severity: "medium",
        requiresVerification: true,
        category: "source"
      });
    }
    return risks;
  }

  if (!primaryContact) {
    risks.push({
      id: "missing-contact",
      title: "Contact not found in reviewed/imported sources",
      detail: "No authority or submission contact is currently linked from the reviewed/imported sources.",
      severity: "medium",
      requiresVerification: true,
      category: "source"
    });
  }

  if (!opportunity.applicationUrl) {
    risks.push({
      id: "missing-submission-route",
      title: "Submission route not yet verified",
      detail: "The reviewed/imported sources do not yet establish the submission mechanism or application URL.",
      severity: "medium",
      requiresVerification: true,
      category: "source"
    });
  }

  if (!opportunity.noticeUrl) {
    risks.push({
      id: "missing-dossier",
      title: "Official notice / dossier not yet verified",
      detail: "The reviewed/imported sources do not yet include an authoritative tender dossier or call notice URL.",
      severity: "high",
      requiresVerification: true,
      category: "source"
    });
  }

  if (activeStatus && eligibility.requirementRows.filter((row) => row.mandatory).length === 0) {
    risks.push({
      id: "requirements-not-verified",
      title: "Eligibility requirements not yet assessed",
      detail: "No meaningful mandatory qualification requirements have been obtained from the reviewed/imported sources.",
      severity: "high",
      requiresVerification: true,
      category: "eligibility"
    });
  }

  if ((opportunity.sources ?? []).every((source) => !source.official)) {
    risks.push({
      id: "secondary-sources-only",
      title: "Official dossier evidence is incomplete",
      detail: "The current workspace relies on listings or secondary summaries rather than a verified official dossier.",
      severity: "medium",
      requiresVerification: true,
      category: "source"
    });
  }

  return risks;
}

function canonicalAction(matchBand, opportunity, match) {
  if (isNonActionableDerivedStatus(opportunity.derivedStatus)) return "DO_NOT_PURSUE";
  if (match.dimensions.capabilityFit < 18) return "DO_NOT_PURSUE";
  if (match.eligibilityStatus === "INELIGIBLE") return "DO_NOT_PURSUE";
  if (match.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED") return "VERIFY_BEFORE_DECIDING";
  if (match.eligibilityStatus === "ELIGIBILITY_UNCLEAR") return "VERIFY_BEFORE_DECIDING";
  if (match.risks.some((risk) => risk.requiresVerification)) return "VERIFY_BEFORE_DECIDING";
  if (matchBand === "LOW_PRIORITY") return "DO_NOT_PURSUE";
  return "INVESTIGATE_NOW";
}

function actionLabel(action, match) {
  if (action === "DO_NOT_PURSUE") return "Do not pursue";
  if (action === "VERIFY_BEFORE_DECIDING") {
    return match.adaptiveQuestions.length ? "Verify eligibility before deciding" : "Verify before deciding";
  }
  return "Investigate now";
}

function bucketForAction(action) {
  if (action === "INVESTIGATE_NOW") return "worth_attention";
  if (action === "VERIFY_BEFORE_DECIDING") return "needs_verification";
  return "not_suitable";
}

function potentialHardBlockerReason(match) {
  const blocker = match.potentialHardBlockers?.[0];
  if (!blocker) return null;
  return `Potential hard blocker: ${blocker.title} not yet verified.`;
}

function mainReason(action, matchBand, opportunity, match) {
  if (opportunity.derivedStatus === "closed") return "Deadline passed";
  if (opportunity.derivedStatus === "cancelled") return "Cancelled";
  if (opportunity.derivedStatus === "awarded") return "Already awarded / not an open opportunity.";
  if (opportunity.derivedStatus === "suspended") return "Suspended";
  if (match.dimensions.capabilityFit < 18) return "Unrelated capability";
  if (match.eligibilityStatus === "INELIGIBLE") return match.blockers[0]?.title ?? "Confirmed eligibility failure";
  if (action === "VERIFY_BEFORE_DECIDING" && match.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED") {
    return "Eligibility requirements not yet assessed";
  }
  if (action === "VERIFY_BEFORE_DECIDING") {
    return potentialHardBlockerReason(match) ?? match.unknowns[0]?.title ?? match.risks[0]?.title ?? "Evidence needs verification";
  }
  if (matchBand === "LOW_PRIORITY") {
    return match.blockers[0]?.title ?? "Low overall fit";
  }
  return match.positives[0]?.title ?? "Actionable opportunity";
}

function mainQuestion(action, match) {
  if (isNonActionableDerivedStatus(match.opportunityDerivedStatus)) {
    return "No further action is recommended because this notice is not open for submission.";
  }
  if (action === "DO_NOT_PURSUE") {
    return match.blockers[0]?.detail ?? "No further action is recommended under the current evidence set.";
  }
  return (
    match.potentialHardBlockers?.[0]?.detail ??
    match.unknowns[0]?.detail ??
    match.risks.find((risk) => risk.requiresVerification)?.detail ??
    "No blocking question is currently recorded."
  );
}

function buildDecision(matchBand, opportunity, match) {
  const action = canonicalAction(matchBand, opportunity, match);
  return {
    match: {
      band: matchBand,
      label: RECOMMENDATION_COPY[matchBand],
      score: match.matchScore,
      baseCapabilityFit: match.dimensions.baseCapabilityFit,
      specialistScopeConfidence: match.dimensions.specialistScopeConfidence,
      qualificationReadiness: match.dimensions.qualificationReadiness
    },
    eligibility: {
      status: match.eligibilityStatus
    },
    evidenceConfidence: {
      label: match.confidenceShield.label,
      dataConfidence: match.confidenceShield.dataConfidence,
      eligibilityConfidence: match.confidenceShield.eligibilityConfidence,
      companyFactConfidence: match.confidenceShield.companyFactConfidence,
      decisionConfidence: match.confidenceShield.decisionConfidence
    },
    priority: {
      score: match.priorityScore,
      actionable: action === "INVESTIGATE_NOW"
    },
    recommendedAction: {
      code: action,
      label: actionLabel(action, match),
      bucket: bucketForAction(action)
    },
    mainReason: mainReason(action, matchBand, opportunity, match),
    mainQuestion: mainQuestion(action, match),
    risks: match.risks
  };
}

function buildAnalysedItem(outcome) {
  const bestMatch = outcome.bestMatch;
  const opportunity = outcome.opportunity;
  const selectedLotId = getSelectedExplicitLotId(bestMatch);
  const selectedLotLabel = getSelectedExplicitLotLabel(bestMatch);

  return {
    opportunity,
    opportunityId: opportunity.id,
    id: bestMatch.id,
    bestMatch,
    lotId: bestMatch.lotId,
    selectedLotId,
    selectedLotLabel,
    uiCategory: bestMatch.decision.recommendedAction.bucket,
    hasPublishedLot: bestMatch.hasPublishedLot,
    scopeType: getAnalysisScopeType(bestMatch),
    scopeLabel: bestMatch.scopeLabel,
    fitBand: bestMatch.fitBand ?? bestMatch.recommendationClass,
    fitBandLabel: bestMatch.fitBandLabel ?? bestMatch.recommendationLabel,
    recommendationClass: bestMatch.recommendationClass,
    eligibilityStatus: bestMatch.eligibilityStatus,
    confidenceShield: bestMatch.confidenceShield,
    priorityScore: bestMatch.priorityScore,
    matchScore: bestMatch.matchScore,
    displayTitle: bestMatch.displayTitle,
    displayValueLabel: bestMatch.displayValueLabel,
    companyAmountLabel: bestMatch.companyAmountLabel,
    locationLabel: bestMatch.locationLabel,
    deadlineLabel: bestMatch.deadlineLabel,
    executiveVerdict: bestMatch.executiveVerdict,
    positives: bestMatch.positives,
    blockers: bestMatch.blockers,
    potentialHardBlockers: bestMatch.potentialHardBlockers,
    unknowns: bestMatch.unknowns,
    risks: bestMatch.risks,
    adaptiveQuestions: bestMatch.adaptiveQuestions,
    requirementRows: bestMatch.requirementRows,
    primaryContact: bestMatch.primaryContact,
    rankLabel: bestMatch.rankLabel,
    publishedLotCount: bestMatch.publishedLotCount,
    lotMatches: outcome.lotMatches,
    claims: bestMatch.claims,
    reportMarkdown: bestMatch.reportMarkdown,
    lotLabel: bestMatch.lotLabel,
    financialPicture: bestMatch.financialPicture,
    analysisNow: bestMatch.analysisNow,
    dimensions: bestMatch.dimensions,
    preMortem: bestMatch.preMortem,
    decision: bestMatch.decision
  };
}

function analyzeLot(company, opportunity, lot, runtime, now) {
  const semantic = scoreCapabilityFit(company, lot);
  const eligibility = evaluateEligibility(company, opportunity, lot, now);
  const dimensions = assembleDimensions(company, opportunity, lot, semantic, eligibility, now);
  const scores = computeScores({ runtime, ...dimensions });
  const matchBand = deriveRecommendation({
    priorityScore: scores.priorityScore,
    geographicFit: dimensions.geographicFit,
    capabilityFit: dimensions.capabilityFit
  });

  const displayValue = lot.value ?? primaryOpportunityMoney(opportunity);
  const financialPicture = buildFinancialPicture(opportunity, lot);
  const primaryContact = choosePrimaryContact(opportunity);
  const hasPublishedLot = hasExplicitPublishedLot(lot);
  const publishedLotCount = countExplicitPublishedLots(opportunity);
  const resolvedLocation = resolveLotOrOpportunityLocation(lot, opportunity);
  const match = {
    id: `${company.id}:${opportunity.id}:${lot.id}`,
    opportunityId: opportunity.id,
    companyId: company.id,
    lotId: lot.id,
    selectedLotId: hasPublishedLot ? lot.id : null,
    selectedLotLabel: hasPublishedLot ? lot.title : null,
    fitBand: matchBand,
    fitBandLabel: RECOMMENDATION_COPY[matchBand],
    recommendationClass: matchBand,
    recommendationLabel: RECOMMENDATION_COPY[matchBand],
    eligibilityStatus: eligibility.eligibilityStatus,
    dimensions,
    confidenceShield: dimensions.confidenceShield,
    matchScore: scores.matchScore,
    priorityScore: scores.priorityScore,
    displayTitle: lot.title !== opportunity.title ? `${opportunity.title} — ${lot.title}` : opportunity.title,
    hasPublishedLot,
    publishedLotCount,
    lotLabel: hasPublishedLot ? lot.title : null,
    scopeType: hasPublishedLot ? "explicit_published_lot" : "whole_opportunity",
    scopeLabel: hasPublishedLot ? lot.title : "Whole opportunity",
    displayValueLabel: financialPicture.primaryLine?.displayValue ?? formatMoney(displayValue),
    companyAmountLabel: computeCompanyAmountLabel(opportunity),
    financialPicture,
    analysisNow: now.toISOString(),
    locationLabel:
      resolvedLocation?.display ??
      opportunity.location?.display ??
      [opportunity.location?.municipality, opportunity.location?.province].filter(Boolean).join(", "),
    deadlineLabel: opportunity.deadline?.sourceText ?? "Not published",
    positives: [],
    blockers: [...eligibility.blockers],
    potentialHardBlockers: [...(eligibility.potentialHardBlockers ?? [])],
    unknowns: [...eligibility.unknowns],
    risks: [],
    adaptiveQuestions: buildAdaptiveQuestions(eligibility),
    requirementRows: eligibility.requirementRows,
    primaryContact,
    rankLabel: "#1",
    claims: [],
    opportunityDerivedStatus: opportunity.derivedStatus,
    verificationRequired:
      scores.priorityScore >= runtime.verification.priorityThreshold ||
      (displayValue && moneyToMajor(displayValue) >= runtime.verification.valueThresholdEur) ||
      dimensions.confidenceShield.label !== "HIGH" ||
      (eligibility.potentialHardBlockers?.length ?? 0) > 0 ||
      eligibility.unknowns.length > 0
  };

  if (semantic.matchedCapabilities.length && dimensions.baseCapabilityFit >= 70) {
    match.positives.push({
      title: "Strong capability fit",
      detail: `Matched capabilities: ${semantic.matchedCapabilities.map((item) => item.label).join(", ")}.`
    });
  }
  if (
    dimensions.geographyAssessment?.note &&
    dimensions.geographyAssessment.score >= 70 &&
    (
      dimensions.geographyAssessment.travelPreferenceLabel !== "Unknown" ||
      dimensions.geographyAssessment.proximityLabel === "Very strong"
    )
  ) {
    match.positives.push({
      title: "Geographic fit",
      detail: dimensions.geographyAssessment.note
    });
  } else if (
    dimensions.geographyAssessment?.note &&
    dimensions.geographyAssessment.travelPreferenceLabel === "Unknown" &&
    dimensions.geographyAssessment.proximityLabel !== "Very strong"
  ) {
    match.unknowns.push({
      title: "Geographic travel compatibility",
      detail: dimensions.geographyAssessment.note,
      severity: "low",
      priority: 12
    });
  }
  if (dimensions.financialScaleFit >= 70) {
    match.positives.push({
      title: "Scale fit",
      detail: dimensions.scaleAssessment?.note ?? `${match.displayValueLabel} sits inside the company's realistic project range.`
    });
  }
  if (dimensions.financialScaleFit < 35) {
    match.blockers.push({
      title: "Scale fit concern",
      detail:
        dimensions.scaleAssessment?.note ??
        "The opportunity appears larger than the currently evidenced company delivery capacity.",
      severity: "medium"
    });
  }
  if (dimensions.deadlineFeasibility >= 70 && isActiveDerivedStatus(opportunity.derivedStatus)) {
    match.positives.push({
      title: "Deadline window",
      detail: buildDeadlineSignal(opportunity, now)
    });
  }
  if (dimensions.evidenceQuality < 50) {
    match.risks.push({
      id: "low-evidence-confidence",
      title: "Evidence confidence remains low",
      detail: "Several critical facts still need stronger source confirmation.",
      severity: "medium",
      requiresVerification: true,
      category: "evidence"
    });
  }

  match.risks.push(...procurementRisks(opportunity, eligibility, primaryContact));
  match.risks.push(...availabilityRisks(opportunity));
  match.decision = buildDecision(matchBand, opportunity, match);
  match.preMortem = buildPreMortem(match);
  match.executiveVerdict = executiveVerdict(company, opportunity, match);
  match.claims = extractClaims(opportunity, lot, match);
  match.reportMarkdown = generateReportMarkdown(company, opportunity, match, now);
  return match;
}

export function analyzeOpportunity(company, opportunity, runtime, now = new Date()) {
  const derivedStatus = deriveStatus(opportunity, now);
  const enriched = {
    ...opportunity,
    derivedStatus
  };

  const lots = opportunity.lots?.length ? opportunity.lots : [defaultLot(opportunity)];
  const lotMatches = lots.map((lot) => analyzeLot(company, enriched, lot, runtime, now));
  lotMatches.sort((left, right) => compareDesc(left.priorityScore, right.priorityScore));
  const bestMatch = lotMatches[0];

  return {
    opportunity: enriched,
    bestMatch,
    lotMatches
  };
}

export function diagnoseLotSelection(opportunity = {}, analysis = {}) {
  const selectionSource = getSelectedExplicitLotId(analysis) ? analysis : (analysis?.bestMatch ?? analysis);
  const selectedLotId = getSelectedExplicitLotId(selectionSource);
  const selectedLotLabel = getSelectedExplicitLotLabel(selectionSource);
  const scopeType = getAnalysisScopeType(selectionSource);
  const explicitLots = (opportunity?.lots ?? []).filter((lot) => lot && !lot.synthetic);
  const explicitLotsById = new Map(explicitLots.map((lot) => [lot.id, lot]));
  const rankedLotMatches = [...(analysis?.lotMatches ?? [])]
    .filter((lotMatch) => lotMatch?.hasPublishedLot && lotMatch?.lotId)
    .sort(
      (left, right) =>
        compareDesc(left.priorityScore ?? Number.NEGATIVE_INFINITY, right.priorityScore ?? Number.NEGATIVE_INFINITY) ||
        compareDesc(left.matchScore ?? Number.NEGATIVE_INFINITY, right.matchScore ?? Number.NEGATIVE_INFINITY) ||
        String(left.lotId ?? "").localeCompare(String(right.lotId ?? ""))
    );
  const rankByLotId = new Map(rankedLotMatches.map((lotMatch, index) => [lotMatch.lotId, index + 1]));
  const lotMatchById = new Map(rankedLotMatches.map((lotMatch) => [lotMatch.lotId, lotMatch]));

  const lots = explicitLots.flatMap((sourceLot) => {
    const lotMatch = lotMatchById.get(sourceLot.id);
    if (!lotMatch) return [];
    const conciseLabel = conciseLotDiagnosticLabel(sourceLot, lotMatch, opportunity?.title);
    const resolvedLocation = resolveLotOrOpportunityLocation(sourceLot, opportunity);
    return {
      lotId: lotMatch.lotId,
      title: lotMatch.lotLabel ?? sourceLot?.title ?? null,
      conciseLabel,
      fullTitle: collapseDiagnosticText(sourceLot?.title) || null,
      location: lotMatch.locationLabel ?? sourceLot?.location?.display ?? null,
      coverageLabel:
        resolvedLocation?.display ??
        ([resolvedLocation?.municipality, resolvedLocation?.province, resolvedLocation?.autonomousCommunity]
          .filter(Boolean)
          .join(", ") || null),
      resolvedLocation,
      resolvedLocationNormalized: normalizeLocationRecord(resolvedLocation),
      synthetic: Boolean(sourceLot?.synthetic ?? !lotMatch.hasPublishedLot),
      capabilityFit: lotMatch.dimensions?.capabilityFit ?? null,
      geographicFit: lotMatch.dimensions?.geographicFit ?? null,
      financialScaleFit: lotMatch.dimensions?.financialScaleFit ?? null,
      qualificationReadiness: lotMatch.dimensions?.qualificationReadiness ?? null,
      eligibilityStatus: lotMatch.eligibilityStatus ?? null,
      evidenceDataConfidence: lotMatch.confidenceShield?.dataConfidence ?? null,
      matchScore: lotMatch.matchScore ?? null,
      priorityScore: lotMatch.priorityScore ?? null,
      fitBand: lotMatch.fitBand ?? lotMatch.recommendationClass ?? null,
      recommendedAction: lotMatch.decision?.recommendedAction?.code ?? null,
      selectedBestMatch: isSelectedExplicitLot(selectionSource, lotMatch),
      rank: rankByLotId.get(lotMatch.lotId) ?? null
    };
  });
  const selectedLotRow = lots.find((lot) => lot.selectedBestMatch);
  const selectedLotDisplay = selectedLotRow
    ? `${selectedLotRow.conciseLabel}${selectedLotRow.coverageLabel ? ` — ${selectedLotRow.coverageLabel}` : ""}`
    : selectedLotLabel;

  return {
    bestMatchId: analysis?.bestMatch?.id ?? analysis?.id ?? null,
    bestMatchLotId: analysis?.bestMatch?.lotId ?? analysis?.lotId ?? null,
    selectedLot: selectedLotDisplay,
    selectedLotId,
    procedureTitle: opportunity?.title ?? null,
    selectionReason: deriveLotSelectionReason(analysis),
    scope: getAnalysisScopeLabel(analysis),
    scopeType,
    lots
  };
}

function sortAnalysed(left, right) {
  return compareDesc(left.priorityScore, right.priorityScore) || left.displayTitle.localeCompare(right.displayTitle);
}

export function buildPortfolioFromOutcomes(
  company,
  analysedOutcomes,
  now = new Date(),
  analysedCount = analysedOutcomes.length
) {
  const analysedItems = analysedOutcomes.map((item) => buildAnalysedItem(item)).sort(sortAnalysed);
  const buckets = {
    worthAttention: analysedItems.filter((item) => item.decision.recommendedAction.bucket === "worth_attention"),
    needsVerification: analysedItems.filter((item) => item.decision.recommendedAction.bucket === "needs_verification"),
    notSuitable: analysedItems.filter((item) => item.decision.recommendedAction.bucket === "not_suitable"),
    allAnalysed: analysedItems
  };
  const recommended = [...buckets.worthAttention, ...buckets.needsVerification].sort(sortAnalysed);
  recommended.forEach((item, index) => {
    item.rankLabel = `#${index + 1}`;
    item.reportMarkdown = generateReportMarkdown(company, item.opportunity, item, now);
  });
  const rejected = buckets.notSuitable.map((item) => ({
    opportunity: item.opportunity,
    reason: item.decision.mainReason,
    bestMatch: item.bestMatch ?? item
  }));

  return {
    analysed: analysedItems,
    buckets,
    recommended,
    rejected,
    counts: {
      analysed: analysedCount,
      worthAttention: buckets.worthAttention.length,
      needsVerification: buckets.needsVerification.length,
      notSuitable: buckets.notSuitable.length
    }
  };
}

export function analyzePortfolio(company, opportunities, runtime, now = new Date()) {
  const analysedOutcomes = opportunities.map((opportunity) => analyzeOpportunity(company, opportunity, runtime, now));
  return buildPortfolioFromOutcomes(company, analysedOutcomes, now, opportunities.length);
}
