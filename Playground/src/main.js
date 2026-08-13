import { getRuntimeConfig } from "./config.js";
import { createStore } from "./state/store.js";
import { startApp } from "./app.js";
import { createSourceOpportunityCache } from "./services/source-opportunity-cache.js";

export function bootApp(root) {
  const runtime = getRuntimeConfig();
  const store = createStore();
  const sourceCache = createSourceOpportunityCache();
  return startApp(root, { runtime, store, services: { sourceCache } });
}
