# Scoring

## Principles

- Hard blockers override scores.
- Unknown mandatory conditions never count as pass.
- Relevant lot values outrank whole-procedure totals.
- Money, deadlines and status are handled deterministically.

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

## Recommendation classes

- `EXCELLENT_FIT`
- `STRONG_FIT`
- `POSSIBLE_FIT`
- `LOW_PRIORITY`
- `VERIFY_BEFORE_DECIDING`
- `DO_NOT_PURSUE`

## Centralized weights

Weights live in [`src/config.js`](/Users/dani/Documents/Playground/src/config.js) so they can be tuned without rewriting UI code.
