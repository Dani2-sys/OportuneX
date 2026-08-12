import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildOpenAiVerificationRequest,
  buildVerificationPrompt,
  classifyOpenAi429,
  validateVerificationResult
} from "../scripts/openai-verification.mjs";
import {
  createRuntimeConfig,
  loadLocalEnv,
  parseEnvFile,
  serializeBrowserRuntimeConfig
} from "../scripts/runtime-config.mjs";

test("parseEnvFile supports a simple .env.local workflow", () => {
  const parsed = parseEnvFile(`
OPENAI_API_KEY=sk-test-server-key-1234567890
OPORTUNEX_VERIFICATION_MODEL=gpt-5.6-terra
OPORTUNEX_AI_REASONING_EFFORT=medium
  `);

  assert.equal(parsed.OPENAI_API_KEY, "sk-test-server-key-1234567890");
  assert.equal(parsed.OPORTUNEX_VERIFICATION_MODEL, "gpt-5.6-terra");
  assert.equal(parsed.OPORTUNEX_AI_REASONING_EFFORT, "medium");
});

test("loadLocalEnv reads .env.local for server-side configuration", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oportunex-env-"));
  await writeFile(path.join(tempDir, ".env.local"), "OPENAI_API_KEY=sk-test-server-key-1234567890\nOPORTUNEX_AI_PROVIDER=openai\n");
  const env = {};

  await loadLocalEnv(tempDir, { env, filenames: [".env.local"] });

  assert.equal(env.OPENAI_API_KEY, "sk-test-server-key-1234567890");
  assert.equal(env.OPORTUNEX_AI_PROVIDER, "openai");
});

test(".env.local is ignored by Git", async () => {
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");

  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.local$/m);
  assert.match(gitignore, /^\.env\.\*\.local$/m);
});

test("browser runtime config never contains the API key", () => {
  const runtimeConfig = createRuntimeConfig({
    OPENAI_API_KEY: "sk-test-server-key-1234567890",
    OPORTUNEX_AI_PROVIDER: "openai"
  });
  const browserConfig = serializeBrowserRuntimeConfig(runtimeConfig);

  assert.equal(runtimeConfig.ai.status, "configured");
  assert.ok(!browserConfig.includes("sk-test-server-key-1234567890"));
  assert.ok(browserConfig.includes('"verificationModel": "gpt-5.6-terra"'));
});

test("AI verifier request uses configured server-side model and strict structured output", () => {
  const runtimeConfig = createRuntimeConfig({
    OPENAI_API_KEY: "sk-test-server-key-1234567890",
    OPORTUNEX_AI_PROVIDER: "openai",
    OPORTUNEX_VERIFICATION_MODEL: "gpt-5.6-terra",
    OPORTUNEX_AI_REASONING_EFFORT: "medium"
  });
  const requestBody = buildOpenAiVerificationRequest(
    {
      company: { legalName: "Prospect Installations SL" },
      opportunity: { title: "Electrical maintenance contract" },
      analysis: { recommendationClass: "VERIFY_BEFORE_DECIDING" }
    },
    runtimeConfig
  );

  assert.equal(requestBody.model, "gpt-5.6-terra");
  assert.equal(requestBody.reasoning.effort, "medium");
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.format.strict, true);
  assert.ok("corrected_action" in requestBody.text.format.schema.properties);
  assert.ok("corrected_fit_band" in requestBody.text.format.schema.properties);
  assert.deepEqual(
    requestBody.text.format.schema.properties.corrected_fit_band.anyOf[0].enum,
    ["EXCELLENT_FIT", "STRONG_FIT", "POSSIBLE_FIT", "LOW_PRIORITY", "DO_NOT_PURSUE"]
  );
  assert.doesNotMatch(
    JSON.stringify(requestBody.text.format.schema.properties.corrected_fit_band.anyOf[0].enum),
    /VERIFY_BEFORE_DECIDING/
  );
});

test("verification prompt is framed as an independent second-pass layer", () => {
  const prompt = buildVerificationPrompt({
    company: { legalName: "Prospect Installations SL" },
    opportunity: { title: "Electrical maintenance contract" },
    analysis: { recommendationClass: "VERIFY_BEFORE_DECIDING" }
  });

  assert.match(prompt, /independent second-pass verification layer/i);
  assert.doesNotMatch(prompt, /deterministic second-pass verification layer/i);
  assert.match(prompt, /amountMinor uses currency minor units/i);
  assert.match(prompt, /publication date or publication timestamp is not a submission deadline/i);
  assert.match(prompt, /missing recorded evidence|absence of recorded evidence/i);
  assert.match(prompt, /VERIFY_BEFORE_DECIDING is an action, not a fit band/i);
});

test("AI verifier rejects action vocabulary in corrected_fit_band", () => {
  const error = validateVerificationResult({
    review_status: "needs_review",
    warnings: [],
    disagreements: [],
    corrected_action: "VERIFY_BEFORE_DECIDING",
    corrected_fit_band: "VERIFY_BEFORE_DECIDING",
    confidence: "medium",
    notes: "Cross-enum validation should reject action vocabulary in fit-band fields."
  });

  assert.equal(error, "corrected_fit_band must use canonical fit-band values, not action values.");
});

test("429 classification distinguishes quota exhaustion from rate limiting", () => {
  assert.equal(classifyOpenAi429("Error: insufficient_quota, billing credits exhausted"), "insufficient_quota");
  assert.equal(classifyOpenAi429("Rate limit reached for requests"), "rate_limited");
});
