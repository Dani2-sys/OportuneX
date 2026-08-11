import { clone } from "../utils.js";
import { createDemoState } from "../data/demo.js";

const STORAGE_KEY = "oportunex.phase0.store.v1";

export function createStore() {
  let state = loadState();
  const listeners = new Set();

  function notify() {
    listeners.forEach((listener) => listener(state));
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(mutator, auditEvent = null) {
      const next = clone(state);
      mutator(next);
      if (auditEvent) {
        next.auditEvents = [auditEvent, ...(next.auditEvents ?? [])].slice(0, 50);
      }
      state = next;
      saveState(state);
      notify();
    },
    replace(nextState) {
      state = clone(nextState);
      saveState(state);
      notify();
    },
    reset() {
      state = createDemoState();
      saveState(state);
      notify();
    }
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDemoState();
    const parsed = JSON.parse(raw);
    return parsed?.companyProfiles?.length ? parsed : createDemoState();
  } catch {
    return createDemoState();
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
