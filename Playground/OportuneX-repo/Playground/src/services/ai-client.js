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
  const response = await fetch("/api/ai/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await parseJson(response);
  if (!response.ok) {
    const error = data?.error ?? {};
    throw new AiVerificationError(error.message ?? `AI verification failed: ${response.status}`, {
      code: error.code,
      status: response.status,
      adminMessage: error.adminMessage,
      aiRuntime: data?.aiRuntime ?? null
    });
  }

  return data;
}
