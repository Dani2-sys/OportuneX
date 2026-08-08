export const verificationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["review_status", "warnings", "disagreements", "corrected_recommendation", "confidence", "notes"],
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
    corrected_recommendation: {
      anyOf: [
        {
          type: "string",
          enum: [
            "EXCELLENT_FIT",
            "STRONG_FIT",
            "POSSIBLE_FIT",
            "LOW_PRIORITY",
            "DO_NOT_PURSUE",
            "VERIFY_BEFORE_DECIDING"
          ]
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

const recommendationSet = new Set(
  verificationSchema.properties.corrected_recommendation.anyOf[0].enum
);
const reviewStatusSet = new Set(verificationSchema.properties.review_status.enum);
const confidenceSet = new Set(verificationSchema.properties.confidence.enum);

export function buildVerificationPrompt(payload) {
  return `
You are the deterministic second-pass verification layer for OportuneX.
Check the opportunity, company facts and first analysis for:
- unsupported claims
- missed hard blockers
- grant-vs-contract monetary confusion
- wrong lot selection
- deadline mistakes
- wrong contact categorisation
- overconfident recommendations

Return only the schema-constrained verification object.

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
    result.corrected_recommendation !== null &&
    !recommendationSet.has(result.corrected_recommendation)
  ) {
    return "corrected_recommendation must be null or a known recommendation class.";
  }
  if (!confidenceSet.has(result.confidence)) {
    return "confidence must be high, medium, or low.";
  }
  if (typeof result.notes !== "string") {
    return "notes must be a string.";
  }
  return null;
}
