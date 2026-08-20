import process from "node:process";

import { verificationEvaluationFixtures } from "../src/data/verification-evaluation-fixtures.js";
import { runVerificationEvaluationSuite } from "../src/domain/verification-evaluation.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { buildVerificationPacket } from "../src/domain/verification-protocol.js";
import {
  buildOpenAiVerificationRequest,
  extractResponseText,
  validateVerificationResult
} from "./openai-verification.mjs";

function parseArgs(argv = []) {
  const options = {
    live: false,
    caseId: null,
    limit: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--live") {
      options.live = true;
      continue;
    }
    if (token === "--case") {
      options.caseId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--limit") {
      const rawLimit = argv[index + 1] ?? "";
      const parsedLimit = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
        throw new Error(`Invalid --limit value: ${rawLimit || "(missing)"}`);
      }
      options.limit = parsedLimit;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function selectFixtures(options) {
  let fixtures = verificationEvaluationFixtures;
  if (options.caseId) {
    fixtures = fixtures.filter((fixture) => fixture.id === options.caseId);
    if (!fixtures.length) {
      throw new Error(`Unknown verification fixture: ${options.caseId}`);
    }
  }
  if (options.limit != null) {
    fixtures = fixtures.slice(0, options.limit);
  }
  return fixtures;
}

function assertLiveEnabled(options) {
  if (!options.live) {
    throw new Error(
      "Live verification evals are disabled by default. Re-run with --live and OPORTUNEX_RUN_LIVE_AI_EVALS=1 to allow OpenAI calls."
    );
  }
  if (process.env.OPORTUNEX_RUN_LIVE_AI_EVALS !== "1") {
    throw new Error(
      "Live verification evals require OPORTUNEX_RUN_LIVE_AI_EVALS=1. This script never calls OpenAI without that explicit opt-in."
    );
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey || /^replace[-_]?me$/i.test(apiKey)) {
    throw new Error("OPENAI_API_KEY is missing or unusable.");
  }
  return apiKey;
}

function buildFixtureContext(fixture) {
  const context = fixture.createContext();
  const packet = buildVerificationPacket(context.company, context.opportunity, context.analysis);
  return { context, packet };
}

async function callLiveVerification(apiKey, context, packet) {
  const requestBody = buildOpenAiVerificationRequest(
    {
      company: context.company,
      opportunity: context.opportunity,
      analysis: context.analysis,
      packet
    },
    DEFAULT_RUNTIME
  );
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OpenAI verification eval returned non-JSON: ${text.slice(0, 400)}`);
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      extractResponseText(data) ||
      response.statusText ||
      "Unknown OpenAI error.";
    throw new Error(`OpenAI verification eval failed (${response.status}): ${message}`);
  }

  const parsed = data?.output?.[0]?.content?.find((item) => item?.type === "output_text")?.parsed
    ?? data?.output?.flatMap((item) => item?.content ?? []).find((item) => item?.parsed)?.parsed
    ?? (extractResponseText(data) ? JSON.parse(extractResponseText(data)) : null);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("OpenAI verification eval returned no structured result.");
  }

  validateVerificationResult(parsed, {
    packet,
    analysis: context.analysis
  });

  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = selectFixtures(options);

  if (!options.live) {
    const evaluation = runVerificationEvaluationSuite(fixtures);
    console.log(
      JSON.stringify(
        {
          mode: "offline",
          fixtures: fixtures.length,
          summary: evaluation.summary
        },
        null,
        2
      )
    );
    return;
  }

  const apiKey = assertLiveEnabled(options);
  const results = [];

  for (const fixture of fixtures) {
    const { context, packet } = buildFixtureContext(fixture);
    const result = await callLiveVerification(apiKey, context, packet);
    results.push({
      id: fixture.id,
      protocol_version: result.protocol_version,
      confidence: result.confidence,
      findings: Array.isArray(result.findings) ? result.findings.length : 0,
      suggested_corrections: result.suggested_corrections ?? null
    });
  }

  console.log(
    JSON.stringify(
      {
        mode: "live",
        fixtures: fixtures.length,
        results
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
