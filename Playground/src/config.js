import { APP_PHASE } from "./phase.js";

export const APP_TITLE = "OportuneX";

export const NAV_ITEMS = [
  { id: "overview", label: "Overview" },
  { id: "opportunities", label: "Opportunities" },
  { id: "saved", label: "Saved" },
  { id: "company", label: "Company Profile" },
  { id: "lab", label: "Intelligence Lab", admin: true },
  { id: "sources", label: "Data Sources", admin: true },
  { id: "debug", label: "Analysis Debugger", admin: true },
  { id: "evaluation", label: "Evaluation", admin: true },
  { id: "health", label: "System Health", admin: true }
];

export const DEFAULT_RUNTIME = {
  appName: APP_TITLE,
  appPhase: APP_PHASE,
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
    placsp: "ready",
    bdns: "ready",
    ted: "planned"
  },
  verification: {
    priorityThreshold: 84,
    valueThresholdEur: 120000,
    imminentDeadlineDays: 5
  },
  scoring: {
    match: {
      capabilityFit: 0.28,
      financialScaleFit: 0.14,
      geographicFit: 0.12,
      strategicFit: 0.14,
      qualificationReadiness: 0.18,
      deadlineFeasibility: 0.07,
      applicationEffort: 0.07
    },
    priority: {
      matchScore: 0.46,
      qualificationReadiness: 0.16,
      deadlineFeasibility: 0.16,
      evidenceQuality: 0.12,
      applicationEffort: 0.1
    }
  }
};

export const SEARCH_DEPTH_PLANS = {
  preview: {
    defaultAnalysis: 20,
    maxAnalysis: 20,
    customerSurface: 5
  },
  radar: {
    defaultAnalysis: 75,
    maxAnalysis: 150,
    customerSurface: 25
  },
  pro: {
    defaultAnalysis: 150,
    maxAnalysis: 400,
    customerSurface: 40
  },
  portfolio: {
    defaultAnalysis: 200,
    maxAnalysis: 600,
    customerSurface: 50
  }
};

export const DEFAULT_SEARCH_PLAN_ID = "radar";

export function getSearchDepthPolicy({
  planId = DEFAULT_SEARCH_PLAN_ID,
  localDevelopment = true
} = {}) {
  const plan = SEARCH_DEPTH_PLANS[planId] ?? SEARCH_DEPTH_PLANS[DEFAULT_SEARCH_PLAN_ID];
  return {
    id: planId,
    candidateConsideration: 150,
    defaultAnalysis: plan.defaultAnalysis,
    customerSurface: plan.customerSurface,
    expansionBatch: 75,
    explorationReserveRatio: 0.2,
    planMaxAnalysis: plan.maxAnalysis,
    // Billing can later enforce planMaxAnalysis. Local development keeps a wider deterministic ceiling.
    maxAnalysis: localDevelopment ? Math.max(plan.defaultAnalysis, 300) : plan.maxAnalysis,
    plans: SEARCH_DEPTH_PLANS
  };
}

export const FIT_BAND_COPY = {
  EXCELLENT_FIT: "Excellent Fit",
  STRONG_FIT: "Strong Fit",
  POSSIBLE_FIT: "Possible Fit",
  LOW_PRIORITY: "Low Priority"
};

export const RECOMMENDATION_COPY = FIT_BAND_COPY;

export const ACTION_COPY = {
  INVESTIGATE_NOW: "Investigate Now",
  VERIFY_BEFORE_DECIDING: "Verify Before Deciding",
  DO_NOT_PURSUE: "Do Not Pursue"
};

export const ELIGIBILITY_COPY = {
  ELIGIBILITY_NOT_ASSESSED: "Eligibility Not Assessed",
  CONFIRMED_ELIGIBLE: "Confirmed Eligible",
  ELIGIBILITY_UNCLEAR: "Eligibility Unclear",
  INELIGIBLE: "Ineligible"
};

export const CONFIDENCE_COPY = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low"
};

export const OPPORTUNITY_TYPES = {
  contract: "Public contract",
  grant: "Grant / subsidy"
};

export const NOTICE_TYPES = {
  active_contract_notice: "Active contract notice",
  award_notice: "Award notice",
  grant_call: "Grant call",
  amendment: "Amendment",
  cancellation: "Cancellation",
  prior_information: "Prior information"
};

export const STATUS_LABELS = {
  open: "Open",
  upcoming: "Upcoming",
  closing_soon: "Closing soon",
  closed: "Closed",
  cancelled: "Cancelled",
  suspended: "Suspended",
  awarded: "Awarded",
  unknown: "Unknown / verification required"
};

export const FEEDBACK_LABELS = {
  interested: "Interested",
  not_relevant: "Not relevant",
  saved: "Saved"
};

export function getRuntimeConfig() {
  const runtime = typeof window !== "undefined" ? window.OPORTUNEX_RUNTIME : {};
  return {
    ...DEFAULT_RUNTIME,
    ...runtime,
    ai: {
      ...DEFAULT_RUNTIME.ai,
      ...(runtime?.ai ?? {})
    },
    connectors: {
      ...DEFAULT_RUNTIME.connectors,
      ...(runtime?.connectors ?? {})
    },
    verification: {
      ...DEFAULT_RUNTIME.verification,
      ...(runtime?.verification ?? {})
    },
    scoring: {
      match: {
        ...DEFAULT_RUNTIME.scoring.match,
        ...(runtime?.scoring?.match ?? {})
      },
      priority: {
        ...DEFAULT_RUNTIME.scoring.priority,
        ...(runtime?.scoring?.priority ?? {})
      }
    }
  };
}
