import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_AI_MODELS = {
  analysisModel: "gpt-5.6-terra",
  verificationModel: "gpt-5.6-terra",
  extractionModel: "gpt-5.6-luna",
  reasoningEffort: "medium"
};

function unquoteEnvValue(value) {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    const unquoted = value.slice(1, -1);
    return value[0] === '"' ? unquoted.replace(/\\n/g, "\n").replace(/\\"/g, '"') : unquoted;
  }
  return value;
}

export function parseEnvFile(text) {
  return Object.fromEntries(
    text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) return null;
        const rawKey = line.slice(0, separatorIndex).trim().replace(/^export\s+/, "");
        const rawValue = line.slice(separatorIndex + 1).trim();
        return rawKey ? [rawKey, unquoteEnvValue(rawValue)] : null;
      })
      .filter(Boolean)
  );
}

export async function loadLocalEnv(rootDir, { env = process.env, filenames = [".env", ".env.local"] } = {}) {
  const merged = {};
  const loadedFiles = [];

  for (const filename of filenames) {
    try {
      const text = await readFile(path.join(rootDir, filename), "utf8");
      Object.assign(merged, parseEnvFile(text));
      loadedFiles.push(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  Object.entries(merged).forEach(([key, value]) => {
    if (env[key] === undefined) env[key] = value;
  });

  return { loadedFiles, values: merged };
}

export function hasMeaningfulOpenAiKey(value = "") {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 20) return false;
  return !/(your[_\-\s]?api[_\-\s]?key|placeholder|replace[_\-\s]?me|changeme|example|sk-\.\.\.)/i.test(trimmed);
}

export function resolveAiProvider(env = process.env) {
  const openAiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  return env.OPORTUNEX_AI_PROVIDER || (hasMeaningfulOpenAiKey(openAiApiKey) ? "openai" : "mock");
}

export function initialAiState(env = process.env) {
  const provider = resolveAiProvider(env);
  const openAiApiKey = env.OPENAI_API_KEY?.trim() ?? "";

  if (provider === "mock") {
    return {
      provider: "mock",
      status: "mock",
      lastChecked: null,
      lastError: null
    };
  }

  if (provider !== "openai") {
    return {
      provider,
      status: "unavailable",
      lastChecked: null,
      lastError: `Unsupported AI provider: ${provider}.`
    };
  }

  if (!hasMeaningfulOpenAiKey(openAiApiKey)) {
    return {
      provider: "openai",
      status: "unavailable",
      lastChecked: null,
      lastError: "No usable OPENAI_API_KEY is configured."
    };
  }

  return {
    provider: "openai",
    status: "configured",
    lastChecked: null,
    lastError: null
  };
}

export function createRuntimeConfig(env = process.env) {
  return {
    appName: "OportuneX",
    appPhase: "phase-0.2",
    ai: {
      ...initialAiState(env),
      analysisModel: env.OPORTUNEX_ANALYSIS_MODEL || DEFAULT_AI_MODELS.analysisModel,
      verificationModel: env.OPORTUNEX_VERIFICATION_MODEL || DEFAULT_AI_MODELS.verificationModel,
      extractionModel: env.OPORTUNEX_EXTRACTION_MODEL || DEFAULT_AI_MODELS.extractionModel,
      reasoningEffort: env.OPORTUNEX_AI_REASONING_EFFORT || DEFAULT_AI_MODELS.reasoningEffort
    },
    connectors: {
      placsp: "planned",
      bdns: "planned",
      ted: "planned"
    },
    verification: {
      priorityThreshold: Number(env.OPORTUNEX_PRIORITY_THRESHOLD || 84),
      valueThresholdEur: Number(env.OPORTUNEX_VALUE_THRESHOLD_EUR || 120000),
      imminentDeadlineDays: Number(env.OPORTUNEX_IMMINENT_DEADLINE_DAYS || 5)
    }
  };
}

export function sanitizeRuntimeConfig(runtimeConfig) {
  return {
    appName: runtimeConfig.appName,
    appPhase: runtimeConfig.appPhase,
    ai: {
      provider: runtimeConfig.ai.provider,
      status: runtimeConfig.ai.status,
      lastChecked: runtimeConfig.ai.lastChecked,
      lastError: runtimeConfig.ai.lastError,
      analysisModel: runtimeConfig.ai.analysisModel,
      verificationModel: runtimeConfig.ai.verificationModel,
      extractionModel: runtimeConfig.ai.extractionModel,
      reasoningEffort: runtimeConfig.ai.reasoningEffort
    },
    connectors: { ...runtimeConfig.connectors },
    verification: { ...runtimeConfig.verification }
  };
}

export function serializeBrowserRuntimeConfig(runtimeConfig) {
  return `window.OPORTUNEX_RUNTIME = ${JSON.stringify(sanitizeRuntimeConfig(runtimeConfig), null, 2)};`;
}
