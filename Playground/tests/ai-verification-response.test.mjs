import test from "node:test";
import assert from "node:assert/strict";

import { getEvaluationNow } from "../src/clock.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import {
  buildAiVerificationSuccessResponse,
  normalizeAiVerificationResponse
} from "../src/domain/ai-verification-response.js";
import {
  buildMockVerificationResult,
  buildVerificationPacket,
  deriveVerificationStatusV4
} from "../src/domain/verification-protocol.js";
import { AiVerificationError, runAiVerification } from "../src/services/ai-client.js";

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

function mockJsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

test("server V4 success contract is top-level, deterministic, and contains no model review_status", () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const packet = buildVerificationPacket(company, opportunity, analysis);
  const result = buildMockVerificationResult(packet);
  const derivedReviewStatus = deriveVerificationStatusV4(result, analysis);

  const response = buildAiVerificationSuccessResponse({
    provider: "mock",
    model: "gpt-5.6-terra",
    derived_review_status: derivedReviewStatus,
    aiRuntime: {
      provider: "mock",
      status: "mock",
      lastChecked: "2026-08-19T09:45:00.000Z",
      lastError: null
    },
    result
  });

  assert.equal(response.protocol_version, "v4");
  assert.equal(response.derived_review_status, derivedReviewStatus);
  assert.ok(Array.isArray(response.findings));
  assert.ok("strongest_counterfactual" in response);
  assert.ok("suggested_corrections" in response);
  assert.ok("advisory_summary" in response);
  assert.ok("next_actions" in response);
  assert.ok("confidence" in response);
  assert.ok("aiRuntime" in response);
  assert.ok(!("result" in response));
  assert.ok(!("review_status" in response));
});

test("frontend normalization accepts both the server success shape and a wrapped transport envelope", () => {
  const { company, opportunity, analysis } = createFixtureContext();
  const packet = buildVerificationPacket(company, opportunity, analysis);
  const result = buildMockVerificationResult(packet);
  const derivedReviewStatus = deriveVerificationStatusV4(result, analysis);
  const response = buildAiVerificationSuccessResponse({
    provider: "openai",
    model: "gpt-5.6-terra",
    derived_review_status: derivedReviewStatus,
    aiRuntime: {
      provider: "openai",
      status: "connected",
      lastChecked: "2026-08-19T09:45:00.000Z",
      lastError: null
    },
    result
  });

  const wrapped = normalizeAiVerificationResponse({
    provider: "openai",
    model: "gpt-5.6-terra",
    derived_review_status: derivedReviewStatus,
    aiRuntime: response.aiRuntime,
    result
  });

  assert.deepEqual(wrapped, response);
  assert.deepEqual(normalizeAiVerificationResponse(response), response);
});

test("runAiVerification returns the canonical frontend shape for a valid V4 success envelope", async () => {
  const previousFetch = globalThis.fetch;
  const { company, opportunity, analysis } = createFixtureContext();
  const packet = buildVerificationPacket(company, opportunity, analysis);
  const result = buildMockVerificationResult(packet);
  const derivedReviewStatus = deriveVerificationStatusV4(result, analysis);
  const response = buildAiVerificationSuccessResponse({
    provider: "mock",
    model: "gpt-5.6-terra",
    derived_review_status: derivedReviewStatus,
    aiRuntime: {
      provider: "mock",
      status: "mock",
      lastChecked: "2026-08-19T09:45:00.000Z",
      lastError: null
    },
    result
  });

  try {
    globalThis.fetch = async () => mockJsonResponse(response);

    const normalized = await runAiVerification({
      company,
      opportunity,
      analysis
    });

    assert.equal(normalized.protocol_version, "v4");
    assert.equal(normalized.derived_review_status, derivedReviewStatus);
    assert.ok(Array.isArray(normalized.findings));
    assert.ok(!("result" in normalized));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("runAiVerification rejects invalid 200 success envelopes instead of silently accepting them", async () => {
  const previousFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      mockJsonResponse({
        provider: "openai",
        model: "gpt-5.6-terra",
        protocol_version: "v4",
        findings: [],
        aiRuntime: {
          provider: "openai",
          status: "connected",
          lastChecked: "2026-08-19T09:45:00.000Z",
          lastError: null
        }
      });

    await assert.rejects(
      () => runAiVerification({}),
      (error) =>
        error instanceof AiVerificationError &&
        error.code === "invalid_verification_response" &&
        /invalid result and was not saved/i.test(error.message)
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("runAiVerification turns a 504 timeout response into an AiVerificationError", async () => {
  const previousFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      mockJsonResponse(
        {
          error: {
            code: "timeout",
            message: "AI verification took too long to complete. Please try again.",
            adminMessage: "OpenAI Responses request exceeded 60000 ms."
          },
          aiRuntime: {
            provider: "openai",
            status: "error",
            lastChecked: "2026-08-19T09:45:00.000Z",
            lastError: "OpenAI Responses request exceeded 60000 ms."
          }
        },
        { status: 504 }
      );

    await assert.rejects(
      () => runAiVerification({}),
      (error) =>
        error instanceof AiVerificationError &&
        error.code === "timeout" &&
        error.status === 504 &&
        /too long to complete/i.test(error.message)
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("runAiVerification wraps rejected fetch calls in an AiVerificationError", async () => {
  const previousFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      throw new TypeError("");
    };

    await assert.rejects(
      () => runAiVerification({}),
      (error) =>
        error instanceof AiVerificationError &&
        error.code === "network_failure" &&
        error.status === 0 &&
        /could not be completed/i.test(error.message)
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
