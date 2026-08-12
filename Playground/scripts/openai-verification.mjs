const CANONICAL_ACTIONS = [
  "INVESTIGATE_NOW",
  "VERIFY_BEFORE_DECIDING",
  "DO_NOT_PURSUE"
];

const CANONICAL_FIT_BANDS = [
  "EXCELLENT_FIT",
  "STRONG_FIT",
  "POSSIBLE_FIT",
  "LOW_PRIORITY"
];

export const verificationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["review_status", "warnings", "disagreements", "corrected_action", "corrected_fit_band", "confidence", "notes"],
  properties: {
    review_status: {
      type: "string",
      enum: ["accepted", "needs_review", "rejected"]
    },
    warnings: {
      type: "array",
      items: {
        type: "string"
      }
    },
    disagreements: {
      type: "array",
      items: {
        type: "string"
      }
    },
    corrected_action: {
      anyOf: [
        {
          type: "string",
          enum: CANONICAL_ACTIONS
        },
        {
          type: "null"
        }
      ]
    },
    corrected_fit_band: {
      anyOf: [
        {
          type: "string",
          enum: CANONICAL_FIT_BANDS
        },
        {
          type: "null"
        }
      ]
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"]
    },
    notes: {
      type: "string"
    }
  }
};

const actionSet = new Set(verificationSchema.properties.corrected_action.anyOf[0].enum);
const fitBandSet = new Set(verificationSchema.properties.corrected_fit_band.anyOf[0].enum);
const reviewStatusSet = new Set(verificationSchema.properties.review_status.enum);
const confidenceSet = new Set(verificationSchema.properties.confidence.enum);

export function classifyOpenAi429(message = "") {
  return /quota|insufficient|billing|credit|credits|exhausted|plan/i.test(message)
    ? "insufficient_quota"
    : "rate_limited";
}

export function buildVerificationPrompt(payload) {
  return `
You are the independent second-pass verification layer for OportuneX.
Check the opportunity, company facts and first analysis for:
- unsupported claims
- missed hard blockers
- grant-vs-contract monetary confusion
- wrong lot selection
- deadline mistakes
- wrong contact categorisation
- overconfident recommendations

Return only the schema-constrained verification object.

Verification invariants:
- amountMinor uses currency minor units. For EUR, 100 minor units = €1.
- Do not treat missing recorded evidence as confirmed absence.
- A hard requirement without company evidence is unresolved, not automatically failed.
- Historical company evidence is not a confirmed current fact unless the requirement explicitly uses that historical period.
- Source/data confidence is different from eligibility confidence and company-fact confidence.
- Preserve the financial field semantics exactly as provided, including estimatedValue, awardValue, relevantValue, and maximumAidPerBeneficiary.
- Do not invent lot semantics when the opportunity has no explicit relevant lot context.
- Publication date or publication timestamp is not a submission deadline unless a real deadline is explicitly provided.
- Awarded, expired, cancelled, or suspended notices are hard-stop/non-actionable states, and active-pursuit diagnostics should be secondary.
- corrected_action must use the canonical action vocabulary: ${CANONICAL_ACTIONS.join(", ")}.
- corrected_fit_band must use the canonical fit-band vocabulary: ${CANONICAL_FIT_BANDS.join(", ")}.
- VERIFY_BEFORE_DECIDING is an action, not a fit band, and must never appear in corrected_fit_band.

Opportunity:
${JSON.stringify(payload.opportunity, null, 2)}

Company:
${JSON.stringify(payload.company, null, 2)}

First analysis:
${JSON.stringify(payload.analysis, null, 2)}
  `.trim();
}

export function buildOpenAiVerificationRequest(payload, runtimeConfig) {
  return {
    model: runtimeConfig.ai.verificationModel,
    reasoning: {
      effort: runtimeConfig.ai.reasoningEffort ?? "medium"
    },
    input: buildVerificationPrompt(payload),
    text: {
      format: {
        type: "json_schema",
        name: "oportunex_verification",
        strict: true,
        schema: verificationSchema
      }
    }
  };
}

export function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  for (const outputItem of data?.output ?? []) {
    for (const contentItem of outputItem?.content ?? []) {
      if (typeof contentItem?.text === "string" && contentItem.text.trim()) {
        return contentItem.text.trim();
      }
      if (contentItem?.json && typeof contentItem.json === "object") {
        return JSON.stringify(contentItem.json);
      }
      if (contentItem?.parsed && typeof contentItem.parsed === "object") {
        return JSON.stringify(contentItem.parsed);
      }
    }
  }

  return "";
}

export function validateVerificationResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "Structured output must be a JSON object.";
  }
  if (!reviewStatusSet.has(result.review_status)) {
    return "review_status must be accepted, needs_review, or rejected.";
  }
  if (!Array.isArray(result.warnings) || result.warnings.some((item) => typeof item !== "string")) {
    return "warnings must be an array of strings.";
  }
  if (!Array.isArray(result.disagreements) || result.disagreements.some((item) => typeof item !== "string")) {
    return "disagreements must be an array of strings.";
  }
  if (
    result.corrected_action !== null &&
    !actionSet.has(result.corrected_action)
  ) {
    return "corrected_action must be null or a known canonical action.";
  }
  if (
    result.corrected_fit_band !== null &&
    actionSet.has(result.corrected_fit_band)
  ) {
    return "corrected_fit_band must use canonical fit-band values, not action values.";
  }
  if (
    result.corrected_fit_band !== null &&
    !fitBandSet.has(result.corrected_fit_band)
  ) {
    return "corrected_fit_band must be null or a known fit band.";
  }
  if (!confidenceSet.has(result.confidence)) {
    return "confidence must be high, medium, or low.";
  }
  if (typeof result.notes !== "string") {
    return "notes must be a string.";
  }
  return null;
}
