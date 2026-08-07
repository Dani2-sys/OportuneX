window.OPORTUNEX_RUNTIME = {
  appName: "OportuneX",
  appPhase: "phase-0",
  ai: {
    provider: "mock",
    enabled: false,
    analysisModel: "gpt-5",
    verificationModel: "gpt-5",
    extractionModel: "gpt-5"
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
