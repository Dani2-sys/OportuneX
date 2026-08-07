import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const runtimeConfig = {
  appName: "OportuneX",
  appPhase: "phase-0",
  ai: {
    provider: process.env.OPORTUNEX_AI_PROVIDER || "mock",
    enabled: Boolean(process.env.OPENAI_API_KEY),
    analysisModel: process.env.OPORTUNEX_ANALYSIS_MODEL || "gpt-5",
    verificationModel: process.env.OPORTUNEX_VERIFICATION_MODEL || "gpt-5",
    extractionModel: process.env.OPORTUNEX_EXTRACTION_MODEL || "gpt-5"
  },
  connectors: {
    placsp: "planned",
    bdns: "planned",
    ted: "planned"
  },
  verification: {
    priorityThreshold: Number(process.env.OPORTUNEX_PRIORITY_THRESHOLD || 84),
    valueThresholdEur: Number(process.env.OPORTUNEX_VALUE_THRESHOLD_EUR || 120000),
    imminentDeadlineDays: Number(process.env.OPORTUNEX_IMMINENT_DEADLINE_DAYS || 5)
  }
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function mockVerification(payload) {
  const analysis = payload.analysis ?? {};
  const warnings = [];
  if (analysis.unknowns?.length) warnings.push("Critical company confirmation is still missing.");
  if (analysis.blockers?.length) warnings.push("At least one blocker remains visible in the deterministic pass.");
  return {
    provider: "mock",
    model: runtimeConfig.ai.verificationModel,
    review_status: warnings.length ? "needs_review" : "accepted",
    warnings,
    disagreements: [],
    corrected_recommendation: analysis.recommendationClass,
    confidence: analysis.confidenceShield?.label?.toLowerCase?.() ?? "medium",
    notes: "Mock verification used because no OPENAI_API_KEY was provided."
  };
}

async function callOpenAiVerification(payload) {
  const prompt = `
You are the second-pass verification layer for OportuneX.
Review the opportunity, company facts and first analysis for unsupported claims, missed blockers, monetary confusion, wrong lot selection, deadline mistakes, incorrect contact categorisation and overconfident recommendations.
Return strict JSON with keys:
review_status, warnings, disagreements, corrected_recommendation, confidence, notes.

Opportunity:
${JSON.stringify(payload.opportunity, null, 2)}

Company:
${JSON.stringify(payload.company, null, 2)}

First analysis:
${JSON.stringify(payload.analysis, null, 2)}
`.trim();

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: runtimeConfig.ai.verificationModel,
      input: prompt
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI verification failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const output = data.output_text ?? "";
  try {
    return {
      provider: "openai",
      model: runtimeConfig.ai.verificationModel,
      ...JSON.parse(output)
    };
  } catch {
    return {
      provider: "openai",
      model: runtimeConfig.ai.verificationModel,
      review_status: "needs_review",
      warnings: ["Model output did not parse as JSON."],
      disagreements: [],
      corrected_recommendation: payload.analysis?.recommendationClass ?? null,
      confidence: "low",
      notes: output
    };
  }
}

async function handleApi(request, response) {
  if (request.url === "/api/health") {
    return sendJson(response, 200, {
      ok: true,
      runtimeConfig
    });
  }

  if (request.url === "/api/ai/analyze" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || "{}");
    try {
      const result = process.env.OPENAI_API_KEY
        ? await callOpenAiVerification(payload)
        : mockVerification(payload);
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, 500, {
        error: error.message
      });
    }
  }

  return sendJson(response, 404, { error: "Not found" });
}

async function serveStatic(request, response) {
  let pathname = request.url === "/" ? "/index.html" : request.url;
  if (pathname === "/runtime-config.js") {
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    response.end(`window.OPORTUNEX_RUNTIME = ${JSON.stringify(runtimeConfig, null, 2)};`);
    return;
  }

  const resolved = path.resolve(root, `.${pathname}`);
  if (!resolved.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(resolved);
    const filePath = fileStat.isDirectory() ? path.join(resolved, "index.html") : resolved;
    const content = await readFile(filePath);
    const extension = path.extname(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extension] || "application/octet-stream" });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  if ((request.url ?? "").startsWith("/api/")) {
    return handleApi(request, response);
  }
  return serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`OportuneX dev server running at http://${host}:${port}`);
});
