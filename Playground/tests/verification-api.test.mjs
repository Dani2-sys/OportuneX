import test from "node:test";
import assert from "node:assert/strict";

import { getEvaluationNow } from "../src/clock.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import { buildVerificationPacket } from "../src/domain/verification-protocol.js";
import { createRuntimeConfig } from "../scripts/runtime-config.mjs";
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  handleVerificationAnalyze,
  resolveVerificationTimeoutMs
} from "../scripts/verification-api.mjs";

function createFixtureContext() {
  const state = createDemoState();
  const company = structuredClone(state.companyProfiles[0]);
  const opportunities = structuredClone(state.opportunities);
  const opportunity = opportunities.find((item) => item.id === "opp-efficiency-grant");
  const portfolio = analyzePortfolio(company, opportunities, structuredClone(DEFAULT_RUNTIME), getEvaluationNow());
  const analysis = portfolio.analysed.find((item) => item.opportunityId === opportunity.id);

  assert.ok(opportunity);
  assert.ok(analysis);

  return { company, opportunity, analysis };
}

function aliasForPacket(packet, canonicalRef) {
  const match = packet.evidence_ref_catalog?.find((item) => item.canonical_ref === canonicalRef) ?? null;
  assert.ok(match, `Expected alias for ${canonicalRef}`);
  return match.ref;
}

function mockOpenAiStructuredResult(result, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return {
        status: "completed",
        output_text: JSON.stringify(result)
      };
    }
  };
}

test("default verification timeout is 60000 ms", () => {
  assert.equal(DEFAULT_VERIFICATION_TIMEOUT_MS, 60000);
  assert.equal(resolveVerificationTimeoutMs(undefined), 60000);
  assert.equal(resolveVerificationTimeoutMs(""), 60000);
});

test("explicit timeout env override works and clamps to a safe positive range", () => {
  assert.equal(resolveVerificationTimeoutMs("65000"), 65000);
  assert.equal(resolveVerificationTimeoutMs(120001), 120000);
  assert.equal(resolveVerificationTimeoutMs(4999), 5000);
});

test("invalid timeout values fall back to 60000 ms", () => {
  assert.equal(resolveVerificationTimeoutMs("not-a-number"), 60000);
  assert.equal(resolveVerificationTimeoutMs(-1), 60000);
  assert.equal(resolveVerificationTimeoutMs(0), 60000);
});

test("upstream AbortError becomes an HTTP 504 timeout response with valid JSON and safe logs", async () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const runtimeConfig = createRuntimeConfig({
    OPENAI_API_KEY: "sk-test-server-key-1234567890",
    OPORTUNEX_AI_PROVIDER: "openai"
  });
  const logs = [];
  const startedAt = Date.now();

  const result = await handleVerificationAnalyze({
    payload: { company, opportunity, analysis },
    runtimeConfig,
    openAiApiKey: "sk-test-server-key-1234567890",
    fetchImpl: async () => {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    },
    logger: {
      info(message) {
        logs.push(message);
      },
      error(message) {
        logs.push(message);
      }
    }
  });

  assert.equal(result.statusCode, 504);
  assert.equal(result.body.error.code, "timeout");
  assert.equal(result.body.error.message, "AI verification took too long to complete. Please try again.");
  assert.match(result.body.error.adminMessage, /exceeded 60000 ms/i);
  assert.equal(result.body.aiRuntime.status, "error");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result.body)));
  assert.ok(Date.now() - startedAt < 1000);
  assert.ok(logs.some((line) => /packet summary: lots=\d+ evidenceRefs=\d+ schemaEvidenceEnums=\d+ promptChars=\d+/i.test(line)));
  assert.ok(logs.some((line) => /timed out after 60000 ms/i.test(line)));
  assert.ok(logs.some((line) => /sending error response: 504 timeout/i.test(line)));
});

test("missing source timezone does not stay a deadline disagreement when OportuneX already marks Europe/Madrid as an interpretation", async () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const runtimeConfig = createRuntimeConfig({
    OPENAI_API_KEY: "sk-test-server-key-1234567890",
    OPORTUNEX_AI_PROVIDER: "openai"
  });
  const packet = buildVerificationPacket(company, opportunity, analysis);
  const result = {
    protocol_version: "v4",
    findings: [
      {
        category: "deadline",
        disposition: "disagreed",
        severity: "material",
        claim: "The date and time are evidenced, but Europe/Madrid is not explicitly evidenced by the supplied source excerpt.",
        company_impact: "For the active company, the source timezone still needs verification before final submission timing is treated as source-stated.",
        evidence_refs: [
          aliasForPacket(packet, "analysis:deadline"),
          aliasForPacket(packet, "opportunity-evidence:ev-grant-deadline")
        ],
        recommended_follow_up: "Verify the official notice timezone."
      }
    ],
    strongest_counterfactual: {
      exists: true,
      description: "The strongest decision-changing alternative is that the official source specifies a different timezone.",
      evidence_refs: [aliasForPacket(packet, "opportunity-evidence:ev-grant-deadline")],
      would_change_fit_or_action: true
    },
    suggested_corrections: {
      action: null,
      fit_band: null,
      selected_lot_id: null
    },
    advisory_summary: "For the active company, the source-stated timezone still needs checking, but the packet already presents Europe/Madrid as an OportuneX interpretation.",
    next_actions: ["Verify the official notice timezone."],
    confidence: "medium"
  };

  const response = await handleVerificationAnalyze({
    payload: { company, opportunity, analysis },
    runtimeConfig,
    openAiApiKey: "sk-test-server-key-1234567890",
    fetchImpl: async () => mockOpenAiStructuredResult(result),
    logger: { info() {}, error() {} }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.derived_review_status, "accepted");
  assert.equal(response.body.findings[0].category, "deadline");
  assert.equal(response.body.findings[0].disposition, "unresolved");
  assert.equal(response.body.findings[0].severity, "informational");
  assert.equal(response.body.strongest_counterfactual.exists, false);
  assert.equal(response.body.strongest_counterfactual.would_change_fit_or_action, false);
});

test("source-timezone verification tasks may remain unresolved without becoming disagreements", async () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const runtimeConfig = createRuntimeConfig({
    OPENAI_API_KEY: "sk-test-server-key-1234567890",
    OPORTUNEX_AI_PROVIDER: "openai"
  });
  const packet = buildVerificationPacket(company, opportunity, analysis);
  const result = {
    protocol_version: "v4",
    findings: [
      {
        category: "deadline",
        disposition: "unresolved",
        severity: "material",
        claim: "The source does not explicitly state the timezone, so the closing time still needs source confirmation.",
        company_impact: "For the active company, this remains a follow-up task rather than a conflict with the packet.",
        evidence_refs: [
          aliasForPacket(packet, "analysis:deadline"),
          aliasForPacket(packet, "opportunity-evidence:ev-grant-deadline")
        ],
        recommended_follow_up: "Verify the official notice timezone."
      }
    ],
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
    advisory_summary: "The timezone remains a source-verification task, not a contradiction.",
    next_actions: ["Verify the official notice timezone."],
    confidence: "medium"
  };

  const response = await handleVerificationAnalyze({
    payload: { company, opportunity, analysis },
    runtimeConfig,
    openAiApiKey: "sk-test-server-key-1234567890",
    fetchImpl: async () => mockOpenAiStructuredResult(result),
    logger: { info() {}, error() {} }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.derived_review_status, "needs_review");
  assert.equal(response.body.findings[0].disposition, "unresolved");
  assert.equal(response.body.findings[0].severity, "material");
});

test("deadline timezone disagreement remains available when the packet claims the timezone was source-stated", async () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const runtimeConfig = createRuntimeConfig({
    OPENAI_API_KEY: "sk-test-server-key-1234567890",
    OPORTUNEX_AI_PROVIDER: "openai"
  });
  const packet = buildVerificationPacket(company, opportunity, analysis);
  const result = {
    protocol_version: "v4",
    findings: [
      {
        category: "deadline",
        disposition: "disagreed",
        severity: "material",
        claim: "The packet claims Europe/Madrid is source-stated, but the supplied source excerpt does not explicitly state any timezone.",
        company_impact: "For the active company, this would mean the packet overclaims what the source establishes.",
        evidence_refs: [
          aliasForPacket(packet, "analysis:deadline"),
          aliasForPacket(packet, "opportunity-evidence:ev-grant-deadline")
        ],
        recommended_follow_up: "Correct the packet to distinguish source facts from interpretation."
      }
    ],
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
    advisory_summary: "The packet overclaims the source timezone.",
    next_actions: ["Correct the packet deadline provenance."],
    confidence: "medium"
  };

  const response = await handleVerificationAnalyze({
    payload: {
      company,
      opportunity: {
        ...opportunity,
        deadline: {
          ...opportunity.deadline,
          sourceTimezone: "Europe/Madrid"
        }
      },
      analysis: {
        ...analysis,
        opportunity: {
          ...analysis.opportunity,
          deadline: {
            ...analysis.opportunity.deadline,
            sourceTimezone: "Europe/Madrid"
          }
        }
      }
    },
    runtimeConfig,
    openAiApiKey: "sk-test-server-key-1234567890",
    fetchImpl: async () => mockOpenAiStructuredResult(result),
    logger: { info() {}, error() {} }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.derived_review_status, "needs_review");
  assert.equal(response.body.findings[0].disposition, "disagreed");
  assert.equal(response.body.findings[0].severity, "material");
});

test("real conflicting deadline alternatives remain decision-changing when evidence supports them", async () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const runtimeConfig = createRuntimeConfig({
    OPENAI_API_KEY: "sk-test-server-key-1234567890",
    OPORTUNEX_AI_PROVIDER: "openai"
  });
  const packet = buildVerificationPacket(company, opportunity, analysis);
  const result = {
    protocol_version: "v4",
    findings: [
      {
        category: "deadline",
        disposition: "critical_contradiction",
        severity: "critical",
        claim: "The packet deadline conflicts with an alternative official source excerpt showing 24/08/2026 at 14:00.",
        company_impact: "For the active company, that would make the current submission timing unsafe to rely on.",
        evidence_refs: [
          aliasForPacket(packet, "analysis:deadline"),
          aliasForPacket(packet, "opportunity-evidence:ev-grant-deadline")
        ],
        recommended_follow_up: "Use the official conflicting deadline until the discrepancy is resolved."
      }
    ],
    strongest_counterfactual: {
      exists: true,
      description: "A supported alternative official reading is 24/08/2026 at 14:00, which would materially change the timing assessment.",
      evidence_refs: [aliasForPacket(packet, "opportunity-evidence:ev-grant-deadline")],
      would_change_fit_or_action: true
    },
    suggested_corrections: {
      action: null,
      fit_band: null,
      selected_lot_id: null
    },
    advisory_summary: "A concrete conflicting deadline would change the current assessment.",
    next_actions: ["Resolve the conflicting deadline before relying on this opportunity."],
    confidence: "high"
  };

  const response = await handleVerificationAnalyze({
    payload: { company, opportunity, analysis },
    runtimeConfig,
    openAiApiKey: "sk-test-server-key-1234567890",
    fetchImpl: async () => mockOpenAiStructuredResult(result),
    logger: { info() {}, error() {} }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.derived_review_status, "rejected");
  assert.equal(response.body.findings[0].disposition, "critical_contradiction");
  assert.equal(response.body.strongest_counterfactual.exists, true);
  assert.equal(response.body.strongest_counterfactual.would_change_fit_or_action, true);
});
