export async function runAiVerification(payload) {
  const response = await fetch("/api/ai/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`AI verification failed: ${response.status}`);
  }
  return response.json();
}
