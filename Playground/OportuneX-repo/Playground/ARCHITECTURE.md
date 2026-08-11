# Architecture

## Phase 0 approach

This build intentionally separates:

- domain logic in `src/domain/`;
- seeded fixtures in `src/data/`;
- local persistence in `src/state/`;
- UI orchestration in `src/app.js`;
- server-side runtime and AI verification in `scripts/dev-server.mjs`.

## Core flow

1. Company profile is loaded from the local Phase 0 store.
2. Opportunities are normalized into the shared opportunity shape.
3. Deterministic analysis runs first:
   - deadline and notice safety
   - lot selection
   - money handling
   - hard eligibility checks
   - score arithmetic
4. Structured evidence and claims are attached to the result.
5. Recommendation class and Confidence Shield are generated.
6. Optional second-pass AI verification can be triggered from the UI.

## Why local persistence first

The product spec prioritises a manual intelligence lab over premature connector automation.

Phase 0 therefore uses:

- browser-local persistence for immediate admin workflows;
- a normalized PostgreSQL schema scaffold for later migration;
- connector status objects to keep ingestion architecture explicit.

## Future extension points

- PLACSP connector: procurement ingestion
- BDNS connector: grants/subsidies ingestion
- auth boundary: organisation/user separation
- jobs boundary: refreshes, reanalysis, digests
- billing boundary: plan entitlements
