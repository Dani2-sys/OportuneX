import { normalizeAiVerificationResponse } from "../domain/ai-verification-response.js";

export class AiVerificationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AiVerificationError";
    this.code = options.code ?? "ai_verification_failed";
    this.status = options.status ?? 500;
    this.adminMessage = options.adminMessage ?? message;
    this.aiRuntime = options.aiRuntime ?? null;
  }
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function runAiVerification(payload) {
  let response;
  try {
    response = await fetch("/api/ai/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw new AiVerificationError("AI verification could not be completed. Please try again.", {
      code: "network_failure",
      status: 0,
      adminMessage:
        error instanceof Error
          ? error.message
          : "The verification request failed before the server returned a response."
    });
  }

  const data = await parseJson(response);
  if (!response.ok) {
    const error = data?.error ?? {};
    const defaultMessage =
      response.status === 504
        ? "AI verification took too long to complete. Please try again."
        : `AI verification failed: ${response.status}`;
    throw new AiVerificationError(error.message ?? defaultMessage, {
      code: error.code ?? (response.status === 504 ? "timeout" : undefined),
      status: response.status,
      adminMessage: error.adminMessage,
      aiRuntime: data?.aiRuntime ?? null
    });
  }

  try {
    return normalizeAiVerificationResponse(data);
  } catch (error) {
    throw new AiVerificationError("AI verification returned an invalid result and was not saved.", {
      code: "invalid_verification_response",
      status: response.status,
      adminMessage: error instanceof Error ? error.message : "Invalid AI verification success response.",
      aiRuntime: data?.aiRuntime ?? data?.result?.aiRuntime ?? null
    });
  }
}
