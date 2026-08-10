# OportuneX Phase 0.3

OportuneX is a decision-grade public-opportunity intelligence workspace for Spanish SMEs.

This Phase 0 build focuses on the **Intelligence Lab**:

- create and edit a company profile;
- create or import opportunities manually;
- attach source links and evidence excerpts;
- run deterministic opportunity analysis;
- inspect scoring, blockers, unknowns and claims;
- apply manual overrides;
- generate a professional report;
- review rejected opportunities and evaluation fixtures.

The current build uses a **browser-local Phase 0 persistence adapter** for fast manual validation, while also shipping a normalized PostgreSQL schema scaffold in [`database/schema.sql`](/Users/dani/Documents/Playground/database/schema.sql).

Phase 0.3 is the correctness-hardening pass. It strengthens comparable-experience checks, keeps evidence coverage separate from eligibility confidence, preserves monetary categories, and normalizes deadline handling to `Europe/Madrid`.

## Stack

- Static HTML + CSS + browser ESM modules
- Dependency-light domain engine in `src/`
- Local server in [`scripts/dev-server.mjs`](/Users/dani/Documents/Playground/scripts/dev-server.mjs)
- Node built-in tests in [`tests/`](/Users/dani/Documents/Playground/tests)
- Server-side AI verification scaffold using the OpenAI Responses API

## Run locally

Bundled Node is available at:

`/Users/dani/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`

Start the app:

```bash
/Users/dani/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/dev-server.mjs
```

Then open:

`http://localhost:4173`

## Validation

Run the project checks:

```bash
/Users/dani/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check.mjs
/Users/dani/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test tests/*.test.mjs
```

## Environment variables

Copy [`.env.example`](/Users/dani/Documents/Playground/.env.example) to [`.env.local`](/Users/dani/Documents/Playground/.env.local) when you want live AI verification. The server reads `.env.local`; the browser bundle never receives the raw API key.

## Project docs

- [ARCHITECTURE.md](/Users/dani/Documents/Playground/ARCHITECTURE.md)
- [DATA_MODEL.md](/Users/dani/Documents/Playground/DATA_MODEL.md)
- [SCORING.md](/Users/dani/Documents/Playground/SCORING.md)
- [AI_SYSTEM.md](/Users/dani/Documents/Playground/AI_SYSTEM.md)
- [SOURCE_CONNECTORS.md](/Users/dani/Documents/Playground/SOURCE_CONNECTORS.md)
- [SECURITY.md](/Users/dani/Documents/Playground/SECURITY.md)
- [EVALUATION.md](/Users/dani/Documents/Playground/EVALUATION.md)
- [ROADMAP.md](/Users/dani/Documents/Playground/ROADMAP.md)
- [AGENTS.md](/Users/dani/Documents/Playground/AGENTS.md)
