import test from "node:test";
import assert from "node:assert/strict";

import { verificationEvaluationFixtures } from "../src/data/verification-evaluation-fixtures.js";
import {
  buildMockVerificationResult,
  buildVerificationCustomerSummary,
  buildVerificationPacket,
  buildVerificationResultEvidenceRefCatalog,
  deriveVerificationStatusV4,
  getVerificationPacketEvidenceRefEntry,
  validateVerificationEvidenceRefs,
  validateVerificationResultSemantics,
  validateVerificationResultV4
} from "../src/domain/verification-protocol.js";
import { runVerificationEvaluationSuite } from "../src/domain/verification-evaluation.js";

function baseContext() {
  return verificationEvaluationFixtures[0].createContext();
}

function basePacket() {
  const context = baseContext();
  return {
    context,
    packet: buildVerificationPacket(context.company, context.opportunity, context.analysis)
  };
}

function aliasFor(packet, canonicalRef) {
  const match = packet.evidence_ref_catalog?.find((item) => item.canonical_ref === canonicalRef) ?? null;
  assert.ok(match, `Expected alias for ${canonicalRef}`);
  return match.ref;
}

function aliasesFor(packet, canonicalRefs) {
  return canonicalRefs.map((ref) => aliasFor(packet, ref));
}

function resultBase(overrides = {}) {
  return {
    protocol_version: "v4",
    findings: [],
    strongest_counterfactual: {
      exists: false,
      description: null,
      evidence_refs: [],
      would_change_fit_or_action: false
    },
    suggested_corrections: {
      action: null,
      fit_band: null,
      selected_lot_id: null
    },
    advisory_summary: "Verifier summary.",
    next_actions: [],
    confidence: "high",
    ...overrides
  };
}

function createAliasValidationPacket() {
  const packet = {
    allowed_evidence_refs: ["E001", "E002", "E003"],
    explicit_published_lot_ids: ["lot-1"]
  };
  const evidenceRefCatalog = [
    {
      ref: "E001",
      kind: "opportunity_source",
      display_label: "Opportunity source · E001",
      canonical_ref: "opportunity-source:opp-source-notice"
    },
    {
      ref: "E002",
      kind: "opportunity_evidence",
      display_label: "Opportunity evidence · E002",
      canonical_ref: "opportunity-evidence:ev-deadline"
    },
    {
      ref: "E003",
      kind: "analysis",
      display_label: "Analysis evidence · E003",
      canonical_ref: "analysis:deadline"
    }
  ];

  Object.defineProperties(packet, {
    evidence_ref_catalog: {
      value: evidenceRefCatalog,
      enumerable: false
    },
    evidence_ref_map: {
      value: Object.fromEntries(evidenceRefCatalog.map((item) => [item.ref, item])),
      enumerable: false
    }
  });

  return packet;
}

function finding(overrides = {}) {
  return {
    category: "money",
    disposition: "confirmed",
    severity: "informational",
    claim: "Money semantics are correct.",
    company_impact: "This matters because the company-facing amount stays correctly scoped.",
    evidence_refs: [],
    recommended_follow_up: null,
    ...overrides
  };
}

test("verification packet exposes source deadline facts separately from OportuneX timezone interpretation", () => {
  const { packet } = basePacket();
  const analysisDeadline = packet.evidence_ref_catalog.find((item) => item.canonical_ref === "analysis:deadline");

  assert.deepEqual(packet.opportunity.deadline, {
    source_text: "25/09/2026 at 14:00",
    source_date: "2026-09-25",
    source_time: "14:00",
    source_timezone: null,
    interpreted_timezone: "Europe/Madrid",
    interpretation_source: "oportunex_default_timezone_for_local_deadline",
    utc_equivalent: null
  });
  assert.ok(analysisDeadline);
  assert.equal(analysisDeadline.data.source_text, "25/09/2026 at 14:00");
  assert.equal(analysisDeadline.data.source_timezone, null);
  assert.equal(analysisDeadline.data.interpreted_timezone, "Europe/Madrid");
  assert.equal(analysisDeadline.data.interpretation_source, "oportunex_default_timezone_for_local_deadline");
});

test("confirmations only derive accepted", () => {
  const { context, packet } = basePacket();
  const result = resultBase({
    findings: [
      finding({
        evidence_refs: aliasesFor(packet, ["analysis:money", "opportunity-evidence:ev-money-lot-1"])
      })
    ]
  });

  assert.equal(validateVerificationResultV4(result, { packet, analysis: context.analysis }), null);
  assert.equal(deriveVerificationStatusV4(result, context.analysis), "accepted");
});

test("informational unresolved only derives accepted", () => {
  const { context, packet } = basePacket();
  const result = resultBase({
    findings: [
      finding({
        category: "deadline",
        disposition: "unresolved",
        severity: "informational",
        claim: "Exact submission time is not evidenced.",
        company_impact: "The company should still verify the exact time before final submission.",
        evidence_refs: aliasesFor(packet, ["analysis:deadline", "opportunity-evidence:ev-deadline"])
      })
    ],
    confidence: "medium"
  });

  assert.equal(validateVerificationResultV4(result, { packet, analysis: context.analysis }), null);
  assert.equal(deriveVerificationStatusV4(result, context.analysis), "accepted");
});

test("material unresolved derives needs_review", () => {
  const { context, packet } = basePacket();
  const result = resultBase({
    findings: [
      finding({
        category: "eligibility",
        disposition: "unresolved",
        severity: "material",
        claim: "The required classification is not yet verified.",
        company_impact: "This could change whether the company can pursue the opportunity.",
        evidence_refs: aliasesFor(packet, [
          "analysis:eligibility",
          "opportunity-requirement:req-classification",
          "company-fact:classification:p1"
        ]),
        recommended_follow_up: "Confirm the published classification requirement."
      })
    ],
    confidence: "medium"
  });

  assert.equal(validateVerificationResultV4(result, { packet, analysis: context.analysis }), null);
  assert.equal(deriveVerificationStatusV4(result, context.analysis), "needs_review");
});

test("material disagreement derives needs_review", () => {
  const { context, packet } = basePacket();
  const result = resultBase({
    findings: [
      finding({
        category: "capability",
        disposition: "disagreed",
        severity: "material",
        claim: "Specialist scope looks weaker than the deterministic summary implies.",
        company_impact: "This could lower confidence in the current pursuit decision.",
        evidence_refs: aliasesFor(packet, [
          "analysis:capability",
          "company-source:company-source-web",
          "opportunity-requirement:req-classification"
        ]),
        recommended_follow_up: "Re-check the specialist scope evidence."
      })
    ],
    confidence: "medium"
  });

  assert.equal(validateVerificationResultV4(result, { packet, analysis: context.analysis }), null);
  assert.equal(deriveVerificationStatusV4(result, context.analysis), "needs_review");
});

test("critical contradiction derives rejected", () => {
  const { context, packet } = basePacket();
  const result = resultBase({
    findings: [
      finding({
        category: "actionability",
        disposition: "critical_contradiction",
        severity: "critical",
        claim: "The notice is not actionable.",
        company_impact: "This would make the current assessment unsafe to rely on.",
        evidence_refs: aliasesFor(packet, ["analysis:actionability", "opportunity-source:opp-source-notice"]),
        recommended_follow_up: "Confirm whether a newer active notice exists."
      })
    ]
  });

  assert.equal(validateVerificationResultV4(result, { packet, analysis: context.analysis }), null);
  assert.equal(deriveVerificationStatusV4(result, context.analysis), "rejected");
});

test("different corrected action, fit, lot, and counterfactual each derive needs_review", () => {
  const { context, packet } = basePacket();
  const actionResult = resultBase({
    suggested_corrections: { action: "VERIFY_BEFORE_DECIDING", fit_band: null, selected_lot_id: null }
  });
  const fitResult = resultBase({
    suggested_corrections: { action: null, fit_band: "POSSIBLE_FIT", selected_lot_id: null }
  });
  const lotResult = resultBase({
    suggested_corrections: { action: null, fit_band: null, selected_lot_id: "lot-3" }
  });
  const counterfactualResult = resultBase({
    strongest_counterfactual: {
      exists: true,
      description: "A credible alternative source reading could change the decision.",
      evidence_refs: aliasesFor(packet, ["opportunity-source:opp-source-notice"]),
      would_change_fit_or_action: true
    },
    confidence: "medium"
  });

  assert.equal(validateVerificationResultV4(actionResult, { packet, analysis: context.analysis }), null);
  assert.equal(validateVerificationResultV4(fitResult, { packet, analysis: context.analysis }), null);
  assert.equal(validateVerificationResultV4(lotResult, { packet, analysis: context.analysis }), null);
  assert.equal(validateVerificationResultV4(counterfactualResult, { packet, analysis: context.analysis }), null);
  assert.equal(deriveVerificationStatusV4(actionResult, context.analysis), "needs_review");
  assert.equal(deriveVerificationStatusV4(fitResult, context.analysis), "needs_review");
  assert.equal(deriveVerificationStatusV4(lotResult, context.analysis), "needs_review");
  assert.equal(deriveVerificationStatusV4(counterfactualResult, context.analysis), "needs_review");
});

test("critical contradiction always dominates", () => {
  const { context, packet } = basePacket();
  const result = resultBase({
    findings: [
      finding({
        category: "eligibility",
        disposition: "unresolved",
        severity: "material",
        claim: "One qualification point remains unresolved.",
        company_impact: "This needs follow-up.",
        evidence_refs: aliasesFor(packet, [
          "analysis:eligibility",
          "opportunity-requirement:req-classification",
          "company-fact:classification:p1"
        ]),
        recommended_follow_up: "Check the requirement."
      }),
      finding({
        category: "deadline",
        disposition: "critical_contradiction",
        severity: "critical",
        claim: "The current deadline statement is unsafe.",
        company_impact: "This makes the assessment unsafe to rely on.",
        evidence_refs: aliasesFor(packet, ["analysis:deadline", "opportunity-evidence:ev-deadline"]),
        recommended_follow_up: "Use the official deadline instead."
      })
    ]
  });

  assert.equal(validateVerificationResultV4(result, { packet, analysis: context.analysis }), null);
  assert.equal(deriveVerificationStatusV4(result, context.analysis), "rejected");
});

test("semantic validation rejects invalid disposition and severity combinations", () => {
  assert.equal(
    validateVerificationResultSemantics(
      resultBase({
        findings: [finding({ severity: "critical" })]
      })
    ),
    "confirmed findings cannot use critical severity."
  );
  assert.equal(
    validateVerificationResultSemantics(
      resultBase({
        findings: [finding({ disposition: "disagreed", severity: "informational" })]
      })
    ),
    "disagreed findings cannot use informational severity."
  );
  assert.equal(
    validateVerificationResultSemantics(
      resultBase({
        findings: [finding({ disposition: "critical_contradiction", severity: "material" })]
      })
    ),
    "critical_contradiction findings must use critical severity."
  );
  assert.equal(
    validateVerificationResultSemantics(
      resultBase({
        findings: [finding({ disposition: "unresolved", severity: "critical" })]
      })
    ),
    "unresolved findings cannot use critical severity."
  );
});

test("semantic validation rejects missing evidence, invalid enums, and V3-shaped payloads", () => {
  assert.equal(
    validateVerificationResultSemantics(
      resultBase({
        findings: [
          finding({
            disposition: "unresolved",
            severity: "material",
            evidence_refs: []
          })
        ]
      })
    ),
    "material findings must include evidence_refs."
  );
  assert.equal(
    validateVerificationResultSemantics(
      resultBase({
        findings: [finding({ category: "unknown-category" })]
      })
    ),
    "findings[0].category must be a known category."
  );
  assert.equal(
    validateVerificationResultSemantics(
      resultBase({
        findings: [finding({ disposition: "unknown-disposition" })]
      })
    ),
    "findings[0].disposition must be a known disposition."
  );
  assert.equal(
    validateVerificationResultSemantics(
      resultBase({
        findings: [finding({ severity: "unknown-severity" })]
      })
    ),
    "findings[0].severity must be informational, material, or critical."
  );
  assert.equal(
    validateVerificationResultSemantics({
      review_status: "accepted",
      warnings: [],
      disagreements: [],
      corrected_action: null,
      corrected_fit_band: null,
      confidence: "high",
      notes: "Legacy payload."
    }),
    "V3-shaped object pretending to be V4."
  );
});

test("grounding validation accepts valid refs and rejects analysis-only or hallucinated material challenges", () => {
  const { context, packet } = basePacket();
  const validResult = resultBase({
    findings: [
      finding({
        category: "lot",
        disposition: "disagreed",
        severity: "material",
        claim: "A different lot may be better overall.",
        company_impact: "This could change the selected lot for the company.",
        evidence_refs: aliasesFor(packet, [
          "analysis:selected-lot",
          "opportunity-lot:lot-1",
          "opportunity-lot:lot-3",
          "company-fact:geography"
        ]),
        recommended_follow_up: "Review the explicit lot comparison."
      })
    ],
    confidence: "medium"
  });
  const analysisOnlyResult = resultBase({
    findings: [
      finding({
        category: "deadline",
        disposition: "disagreed",
        severity: "material",
        claim: "The current deadline may be wrong.",
        company_impact: "This could change the pursuit timing.",
        evidence_refs: aliasesFor(packet, ["analysis:deadline"]),
        recommended_follow_up: "Check the official deadline."
      })
    ],
    confidence: "medium"
  });
  const hallucinatedResult = resultBase({
    findings: [
      finding({
        category: "money",
        disposition: "disagreed",
        severity: "material",
        claim: "The published amount may be wrong.",
        company_impact: "This could change the commercial relevance.",
        evidence_refs: [aliasFor(packet, "analysis:money"), "opportunity-evidence:missing-evidence-id"],
        recommended_follow_up: "Check the official amount."
      })
    ],
    confidence: "medium"
  });

  assert.equal(validateVerificationResultV4(validResult, { packet, analysis: context.analysis }), null);
  assert.equal(
    validateVerificationEvidenceRefs(analysisOnlyResult, packet),
    "findings[0].evidence_refs must include at least one non-analysis evidence ref."
  );
  assert.equal(
    validateVerificationEvidenceRefs(hallucinatedResult, packet),
    "findings[0].evidence_refs contains an unknown evidence ref: opportunity-evidence:missing-evidence-id."
  );
});

test("exact alias evidence refs pass while unknown, lowercase, canonical, and typo refs fail", () => {
  const packet = createAliasValidationPacket();
  const validResult = resultBase({
    findings: [
      finding({
        disposition: "disagreed",
        severity: "material",
        evidence_refs: ["E002"]
      })
    ]
  });
  const unknownAliasResult = resultBase({
    findings: [
      finding({
        disposition: "disagreed",
        severity: "material",
        evidence_refs: ["E004"]
      })
    ]
  });
  const lowercaseAliasResult = resultBase({
    findings: [
      finding({
        disposition: "disagreed",
        severity: "material",
        evidence_refs: ["e002"]
      })
    ]
  });
  const canonicalLeakResult = resultBase({
    findings: [
      finding({
        disposition: "disagreed",
        severity: "material",
        evidence_refs: ["opportunity-evidence:some-id"]
      })
    ]
  });
  const typoAliasResult = resultBase({
    findings: [
      finding({
        disposition: "disagreed",
        severity: "material",
        evidence_refs: ["E00I"]
      })
    ]
  });

  assert.equal(validateVerificationEvidenceRefs(validResult, packet), null);
  assert.equal(
    validateVerificationEvidenceRefs(unknownAliasResult, packet),
    "findings[0].evidence_refs contains an unknown evidence ref: E004."
  );
  assert.equal(
    validateVerificationEvidenceRefs(lowercaseAliasResult, packet),
    "findings[0].evidence_refs contains an unknown evidence ref: e002."
  );
  assert.equal(
    validateVerificationEvidenceRefs(canonicalLeakResult, packet),
    "findings[0].evidence_refs contains an unknown evidence ref: opportunity-evidence:some-id."
  );
  assert.equal(
    validateVerificationEvidenceRefs(typoAliasResult, packet),
    "findings[0].evidence_refs contains an unknown evidence ref: E00I."
  );
});

test("material findings still require at least one non-analysis alias", () => {
  const packet = createAliasValidationPacket();
  const result = resultBase({
    findings: [
      finding({
        disposition: "disagreed",
        severity: "material",
        evidence_refs: ["E003"]
      })
    ]
  });

  assert.equal(
    validateVerificationEvidenceRefs(result, packet),
    "findings[0].evidence_refs must include at least one non-analysis evidence ref."
  );
});

test("counterfactual grounding uses the same exact alias set", () => {
  const packet = createAliasValidationPacket();
  const validResult = resultBase({
    strongest_counterfactual: {
      exists: true,
      description: "A supported alternative deadline reading exists.",
      evidence_refs: ["E001", "E002"],
      would_change_fit_or_action: true
    }
  });
  const invalidAliasResult = resultBase({
    strongest_counterfactual: {
      exists: true,
      description: "A supported alternative deadline reading exists.",
      evidence_refs: ["E004"],
      would_change_fit_or_action: true
    }
  });
  const canonicalLeakResult = resultBase({
    strongest_counterfactual: {
      exists: true,
      description: "A supported alternative deadline reading exists.",
      evidence_refs: ["opportunity-source:opp-source-notice"],
      would_change_fit_or_action: true
    }
  });

  assert.equal(validateVerificationEvidenceRefs(validResult, packet), null);
  assert.equal(
    validateVerificationEvidenceRefs(invalidAliasResult, packet),
    "strongest_counterfactual.evidence_refs contains an unknown evidence ref: E004."
  );
  assert.equal(
    validateVerificationEvidenceRefs(canonicalLeakResult, packet),
    "strongest_counterfactual.evidence_refs contains an unknown evidence ref: opportunity-source:opp-source-notice."
  );
});

test("lot packet includes every explicit lot, excludes synthetic lots, and preserves deterministic scores", () => {
  const { context, packet } = basePacket();
  assert.deepEqual(packet.explicit_published_lot_ids.sort(), ["lot-1", "lot-3"]);
  assert.equal(packet.selected_assessment.selected_lot_id, "lot-1");
  assert.ok(packet.allowed_evidence_refs.every((item) => /^E\d{3}$/.test(item)));
  assert.ok(packet.evidence_catalog.every((item) => /^E\d{3}$/.test(item.ref)));
  assert.ok(!packet.explicit_published_lot_ids.some((item) => /root|synthetic/i.test(item)));

  const lot1 = packet.lot_comparison.find((item) => item.lot_id === "lot-1");
  const lot3 = packet.lot_comparison.find((item) => item.lot_id === "lot-3");

  assert.ok(lot1);
  assert.ok(lot3);
  assert.equal(lot1.selected_best_match, true);
  assert.equal(lot1.capability_fit, context.analysis.lotMatches[0].dimensions.capabilityFit);
  assert.equal(lot1.geographic_fit, context.analysis.lotMatches[0].dimensions.geographicFit);
  assert.equal(lot1.financial_scale_fit, context.analysis.lotMatches[0].dimensions.financialScaleFit);
  assert.equal(lot1.qualification_readiness, context.analysis.lotMatches[0].dimensions.qualificationReadiness);
  assert.equal(lot1.priority_score, context.analysis.lotMatches[0].priorityScore);
  assert.equal(lot3.priority_score, context.analysis.lotMatches[1].priorityScore);
});

test("lot grounding aliases trace back to their canonical records", () => {
  const { context, packet } = basePacket();
  const result = resultBase({
    findings: [
      finding({
        category: "lot",
        disposition: "disagreed",
        severity: "material",
        claim: "Another explicit lot deserves review.",
        company_impact: "This could change the selected lot for the company.",
        evidence_refs: aliasesFor(packet, [
          "analysis:selected-lot",
          "opportunity-lot:lot-1",
          "opportunity-lot:lot-3",
          "company-fact:geography"
        ]),
        recommended_follow_up: "Review the explicit lot comparison."
      })
    ]
  });

  const catalog = buildVerificationResultEvidenceRefCatalog(result, packet);

  assert.deepEqual(
    catalog.map((item) => item.ref),
    aliasesFor(packet, [
      "analysis:selected-lot",
      "company-fact:geography",
      "opportunity-lot:lot-1",
      "opportunity-lot:lot-3"
    ]).sort((left, right) => left.localeCompare(right))
  );
  assert.equal(getVerificationPacketEvidenceRefEntry(packet, aliasFor(packet, "analysis:selected-lot"))?.canonical_ref, "analysis:selected-lot");
  assert.equal(getVerificationPacketEvidenceRefEntry(packet, aliasFor(packet, "company-fact:geography"))?.canonical_ref, "company-fact:geography");
  assert.equal(getVerificationPacketEvidenceRefEntry(packet, aliasFor(packet, "opportunity-lot:lot-1"))?.canonical_ref, "opportunity-lot:lot-1");
  assert.equal(getVerificationPacketEvidenceRefEntry(packet, aliasFor(packet, "opportunity-lot:lot-3"))?.canonical_ref, "opportunity-lot:lot-3");
});

test("customer summaries use compact evidence labels while preserving canonical mapping metadata", () => {
  const { context, packet } = basePacket();
  const result = resultBase({
    findings: [
      finding({
        category: "lot",
        disposition: "disagreed",
        severity: "material",
        claim: "Another lot deserves review.",
        company_impact: "This could change the lot recommendation.",
        evidence_refs: aliasesFor(packet, [
          "analysis:selected-lot",
          "opportunity-lot:lot-1"
        ])
      })
    ],
    evidence_ref_catalog: buildVerificationResultEvidenceRefCatalog(
      resultBase({
        findings: [
          finding({
            category: "lot",
            disposition: "disagreed",
            severity: "material",
            claim: "Another lot deserves review.",
            company_impact: "This could change the lot recommendation.",
            evidence_refs: aliasesFor(packet, [
              "analysis:selected-lot",
              "opportunity-lot:lot-1"
            ])
          })
        ]
      }),
      packet
    )
  });

  const summary = buildVerificationCustomerSummary(result, context.analysis, context.company);

  assert.deepEqual(
    summary.grouped_findings.disagreed[0].evidence_ref_display,
    [
      `Analysis evidence · ${aliasFor(packet, "analysis:selected-lot")}`,
      `Lot evidence · ${aliasFor(packet, "opportunity-lot:lot-1")}`
    ]
  );
  assert.equal(summary.evidence_ref_catalog[0].canonical_ref, "analysis:selected-lot");
  assert.ok(summary.evidence_ref_catalog.some((item) => item.canonical_ref === "opportunity-lot:lot-1"));
});

test("mock verification result is valid v4 and derives status through the same function", () => {
  const { context, packet } = basePacket();
  const result = buildMockVerificationResult(packet);
  assert.equal(result.protocol_version, "v4");
  assert.ok(!("review_status" in result));
  assert.equal(validateVerificationResultV4(result, { packet, analysis: context.analysis }), null);
  assert.equal(deriveVerificationStatusV4(result, context.analysis), "accepted");
});

test("offline verification evaluation fixtures pass end to end", () => {
  const evaluation = runVerificationEvaluationSuite(verificationEvaluationFixtures);

  assert.equal(evaluation.summary.total, 16);
  assert.equal(evaluation.summary.passed, 16);
  assert.equal(evaluation.summary.statusAccuracy, 100);
  assert.equal(evaluation.summary.requiredFindingRecall, 100);
  assert.equal(evaluation.summary.evidenceGroundingRate, 100);
  assert.equal(evaluation.summary.invalidEvidenceReferenceRate, 0);
  assert.equal(evaluation.summary.lotAuditAccuracy, 100);
  assert.equal(evaluation.summary.moneySemanticAccuracy, 100);
  assert.equal(evaluation.summary.deadlineAccuracy, 100);
});
