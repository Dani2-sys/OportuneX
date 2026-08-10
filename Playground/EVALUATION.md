# Evaluation

## Harness

The evaluation harness uses stable fixtures in:

- [src/data/evaluation-fixtures.js](src/data/evaluation-fixtures.js)

and scoring logic from:

- [src/domain/evaluation.js](src/domain/evaluation.js)

## Coverage

The fixture suite includes:

- expired notices
- cancelled notices
- award notices
- large procedures with small relevant lots
- unknown certifications
- confirmed hard blockers
- amended deadlines
- conflicting sources
- grants with beneficiary maximums
- grants without beneficiary maximums
- wrong-region grants
- wrong-beneficiary grants
- de minimis uncertainty
- missing application URLs
- contact-role checks
- prompt-injection text
- missing deadline times
- Catalan-language descriptions
- semantic matches without exact keywords
- duplicate-source identity cases

## Metrics tracked

- candidate recall
- recommendation precision
- hard-blocker accuracy
- monetary-field accuracy
- deadline accuracy

## Current check command

Run:

```bash
/Users/dani/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check.mjs
```
