import { getRuntimeConfig } from "./config.js";
import { createStore } from "./state/store.js";
import { startApp } from "./app.js";

export function bootApp(root) {
  const runtime = getRuntimeConfig();
  const store = createStore();
  startApp(root, { runtime, store });
}
