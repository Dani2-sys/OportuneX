window.OPORTUNEX_RUNTIME = {
  appName: "OportuneX",
  appPhase: "phase-0.2",
  ai: {
    provider: "mock",
    status: "mock",
    lastChecked: null,
    lastError: null,
    analysisModel: "gpt-5.6-terra",
    verificationModel: "gpt-5.6-terra",
    extractionModel: "gpt-5.6-luna",
    reasoningEffort: "medium"
  },
  connectors: {
    placsp: "planned",
    bdns: "planned",
    ted: "planned"
  },
  verification: {
    priorityThreshold: 84,
    valueThresholdEur: 120000,
    imminentDeadlineDays: 5
  }
};
