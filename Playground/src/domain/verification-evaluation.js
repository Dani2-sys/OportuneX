import {
  buildVerificationPacket,
  deriveVerificationStatusV4,
  validateVerificationResultV4
} from "./verification-protocol.js";

function sanitizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value, fallback = null) {
  if (value == null) return fallback;
  const text = typeof value === "string" ? value : String(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function findRef(packet, ref) {
  return sanitizeArray(packet?.evidence_catalog).find((item) => item?.ref === ref) ?? null;
}

function createFixtureRefs(packet) {
  const aliasByCanonicalRef = new Map(
    sanitizeArray(packet?.evidence_ref_catalog)
      .filter((item) => item?.ref && item?.canonical_ref)
      .map((item) => [item.canonical_ref, item.ref])
  );
  const getRef = (ref) => {
    const alias = aliasByCanonicalRef.get(ref) ?? ref;
    if (!findRef(packet, alias)) {
      throw new Error(`Missing verification fixture ref: ${ref}`);
    }
    return alias;
  };

  return {
    companySource(id) {
      return getRef(`company-source:${id}`);
    },
    companyFact(id) {
      return getRef(`company-fact:${id}`);
    },
    opportunitySource(id) {
      return getRef(`opportunity-source:${id}`);
    },
    opportunityEvidence(id) {
      return getRef(`opportunity-evidence:${id}`);
    },
    opportunityLot(id) {
      return getRef(`opportunity-lot:${id}`);
    },
    opportunityRequirement(id) {
      return getRef(`opportunity-requirement:${id}`);
    },
    analysis(id) {
      return getRef(`analysis:${id}`);
    },
    finding(category, disposition, severity, claim, evidenceRefs = [], recommendedFollowUp = null, companyImpact = null) {
      return {
        category,
        disposition,
        severity,
        claim,
        company_impact:
          companyImpact ??
          `For the active company, this matters because ${claim.charAt(0).toLowerCase()}${claim.slice(1)}`,
        evidence_refs: sanitizeArray(evidenceRefs).map((ref) => aliasByCanonicalRef.get(ref) ?? ref).filter(Boolean),
        recommended_follow_up: normalizeText(recommendedFollowUp, null)
      };
    }
  };
}

function hasFinding(result, expected) {
  return sanitizeArray(result?.findings).some(
    (finding) =>
      finding?.category === expected.category &&
      finding?.disposition === expected.disposition
  );
}

function hasForbiddenFinding(result, forbidden) {
  return sanitizeArray(result?.findings).some(
    (finding) =>
      finding?.category === forbidden.category &&
      finding?.disposition === forbidden.disposition
  );
}

function packetMatchesExpectation(packet, expected = {}) {
  const actualLotIds = sanitizeArray(packet?.explicit_published_lot_ids);
  const selectedLotId = packet?.selected_assessment?.selected_lot_id ?? null;

  if (expected.explicitLotIds) {
    const left = [...actualLotIds].sort();
    const right = [...expected.explicitLotIds].sort();
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      return {
        pass: false,
        detail: `expected explicit lot ids ${right.join(", ")} but received ${left.join(", ")}`
      };
    }
  }
  if ("selectedLotId" in expected && selectedLotId !== expected.selectedLotId) {
    return {
      pass: false,
      detail: `expected selected lot ${expected.selectedLotId} but received ${selectedLotId}`
    };
  }
  if (expected.excludesSyntheticLots) {
    const includesSynthetic = actualLotIds.some((item) => /root|synthetic/i.test(item));
    if (includesSynthetic) {
      return {
        pass: false,
        detail: "synthetic/root lot leaked into explicit_published_lot_ids"
      };
    }
  }
  return { pass: true, detail: "" };
}

function correctionMatches(result, expected = {}) {
  const corrections = result?.suggested_corrections ?? {};
  return Object.entries(expected).every(([key, value]) => corrections?.[key] === value);
}

function percentage(numerator, denominator) {
  return denominator === 0 ? 100 : Math.round((numerator / denominator) * 100);
}

export function runVerificationEvaluationSuite(fixtures) {
  const results = fixtures.map((fixture) => {
    const context = fixture.createContext();
    const packet = buildVerificationPacket(context.company, context.opportunity, context.analysis);
    const refs = createFixtureRefs(packet);
    const result = fixture.buildResult({ context, packet, refs });
    const validationError = validateVerificationResultV4(result, {
      packet,
      analysis: context.analysis
    });
    const derivedStatus = validationError ? null : deriveVerificationStatusV4(result, context.analysis);
    const packetExpectation = packetMatchesExpectation(packet, fixture.expected?.packet);
    const requiredFindings = sanitizeArray(fixture.expected?.requiredFindings);
    const forbiddenFindings = sanitizeArray(fixture.expected?.forbiddenFindings);
    const requiredMatched = requiredFindings.filter((item) => hasFinding(result, item));
    const forbiddenMatched = forbiddenFindings.filter((item) => hasForbiddenFinding(result, item));
    const correctionPass =
      fixture.expected?.expectedCorrection
        ? correctionMatches(result, fixture.expected.expectedCorrection)
        : true;
    const pass =
      !validationError &&
      derivedStatus === fixture.expected?.status &&
      requiredMatched.length === requiredFindings.length &&
      forbiddenMatched.length === 0 &&
      packetExpectation.pass &&
      correctionPass;

    return {
      id: fixture.id,
      title: fixture.title,
      tags: fixture.tags ?? [],
      expectedStatus: fixture.expected?.status ?? null,
      derivedStatus,
      validationError,
      pass,
      requiredFindingsTotal: requiredFindings.length,
      requiredFindingsMatched: requiredMatched.length,
      forbiddenFindingsMatched: forbiddenMatched.length,
      correctionPass,
      packetPass: packetExpectation.pass,
      packetDetail: packetExpectation.detail,
      result
    };
  });

  const totalRequiredFindings = results.reduce((sum, item) => sum + item.requiredFindingsTotal, 0);
  const matchedRequiredFindings = results.reduce((sum, item) => sum + item.requiredFindingsMatched, 0);
  const challengeGuardFixtures = results.filter((item) => item.tags.includes("false_challenge_guard"));
  const criticalFixtures = results.filter((item) => item.expectedStatus === "rejected");
  const lotFixtures = results.filter((item) => item.tags.includes("lot"));
  const moneyFixtures = results.filter((item) => item.tags.includes("money"));
  const deadlineFixtures = results.filter((item) => item.tags.includes("deadline"));
  const invalidRefCount = results.filter((item) => /unknown evidence ref/i.test(item.validationError ?? "")).length;

  return {
    results,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.pass).length,
      statusAccuracy: percentage(results.filter((item) => item.derivedStatus === item.expectedStatus).length, results.length),
      criticalErrorDetectionRecall: percentage(
        criticalFixtures.filter((item) => item.derivedStatus === "rejected").length,
        criticalFixtures.length
      ),
      falseChallengeRate: percentage(
        challengeGuardFixtures.filter((item) => item.expectedStatus !== "rejected" && item.derivedStatus === "rejected").length,
        challengeGuardFixtures.length
      ),
      requiredFindingRecall: percentage(matchedRequiredFindings, totalRequiredFindings),
      findingClassificationAccuracy: percentage(
        results.filter((item) => item.requiredFindingsMatched === item.requiredFindingsTotal && item.forbiddenFindingsMatched === 0).length,
        results.length
      ),
      evidenceGroundingRate: percentage(results.filter((item) => !item.validationError).length, results.length),
      invalidEvidenceReferenceRate: percentage(invalidRefCount, results.length),
      lotAuditAccuracy: percentage(lotFixtures.filter((item) => item.pass).length, lotFixtures.length),
      moneySemanticAccuracy: percentage(moneyFixtures.filter((item) => item.pass).length, moneyFixtures.length),
      deadlineAccuracy: percentage(deadlineFixtures.filter((item) => item.pass).length, deadlineFixtures.length)
    }
  };
}
