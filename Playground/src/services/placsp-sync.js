export async function runPlacspSync({ maxPages = 1, fetchImpl = fetch } = {}) {
  const response = await fetchImpl("/api/connectors/placsp/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ maxPages })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? "PLACSP sync failed.");
    error.code = payload?.error?.code ?? "placsp_sync_failed";
    error.adminMessage = payload?.error?.adminMessage ?? error.message;
    throw error;
  }

  return payload;
}
