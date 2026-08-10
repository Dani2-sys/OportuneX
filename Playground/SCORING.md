# Scoring

## Principles

- Hard blockers override scores.
- Unknown mandatory conditions never count as pass.
- Hard mandatory unknowns force `VERIFY_BEFORE_DECIDING`.
- Hard mandatory failures force `DO_NOT_PURSUE`.
- Relevant lot values outrank whole-procedure totals.
- Base budgets, estimated totals and beneficiary aid ceilings stay separate.
- Money, deadlines and status are handled deterministically.
- Source evidence coverage does not imply eligibility confirmation.

## Dimensions

The engine computes:

- capabilityFit
- financialScaleFit
- geographicFit
- strategicFit
- qualificationReadiness
- deadlineFeasibility
- applicationEffort
- evidenceQuality

## Outputs

- Match Score 0–100
- Priority Score 0–100
- Eligibility Status
- Confidence Shield
- Recommendation Class

## Confidence semantics

- `dataConfidence` reflects source-field coverage, freshness and source conflicts.
- `eligibilityConfidence` reflects confirmed, failed and unknown mandatory conditions.
- A `HIGH` overall confidence shield requires both high data confidence and high eligibility confidence, with no hard mandatory unknowns or failures.

## Recommendation classes

- `EXCELLENT_FIT`
- `STRONG_FIT`
- `POSSIBLE_FIT`
- `LOW_PRIORITY`
- `VERIFY_BEFORE_DECIDING`
- `DO_NOT_PURSUE`

## Centralized weights

Weights live in [`src/config.js`](/Users/dani/Documents/Playground/src/config.js) so they can be tuned without rewriting UI code.
