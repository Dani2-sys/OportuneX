export async function runBdnsSync(
  {
    mode = "manual",
    pages = 1,
    pageSize = 20,
    fetchImpl = fetch
  } = {}
) {
  const response = await fetchImpl("/api/connectors/bdns/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ mode, pages, pageSize })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? "BDNS sync failed.");
    error.code = payload?.error?.code ?? "bdns_sync_failed";
    error.adminMessage = payload?.error?.adminMessage ?? error.message;
    throw error;
  }

  return payload;
}
