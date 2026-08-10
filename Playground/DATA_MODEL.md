# Data Model

## Phase 0 runtime model

The working app persists these concepts in the local store:

- organisations
- companyProfiles
- opportunities
- savedOpportunityIds
- pursuitStatuses
- feedback
- aiRuns
- manualOverrides
- auditEvents
- sourceSyncRuns

## Opportunity structure

Each opportunity keeps:

- source identity
- type and notice type
- status
- title and description
- location
- CPV codes and keywords
- typed money fields
- deadline object
- sources
- evidence
- requirements
- contacts
- documents
- lots

## Match output

The analysis result stores:

- matchScore
- priorityScore
- recommendationClass
- eligibilityStatus
- dimensions
- blockers
- unknowns
- adaptiveQuestions
- claims
- confidenceShield
- financialPicture
- analysisNow
- reportMarkdown

## Representative projects

Company experience can include `representativeProjects` with structured comparable-project evidence:

- `name`
- `publicProject`
- `customer` and `customerType`
- `scopeCapabilities`
- `cpvPrefixes`
- `projectValue`
- `completionDate` or `completionYear`
- `status`, `confidence`, `sourceIds`

Strings are allowed as a lightweight fallback, but they are treated as incomplete evidence and cannot confirm comparable-scope eligibility on their own.

## Confidence shield semantics

The confidence shield now keeps source coverage separate from eligibility certainty:

- `sourceFieldsEvidenced` and `totalSourceFields`
- `mandatoryConfirmed`
- `mandatoryNeedsVerification`
- `mandatoryFailed`
- `hardMandatoryConfirmed`
- `hardMandatoryNeedsVerification`
- `hardMandatoryFailed`
- `companyConfirmationsNeeded`
- `dataConfidence`
- `eligibilityConfidence`
- `sourceConflictsCount`

## Financial picture

`financialPicture` preserves published monetary categories instead of collapsing them:

- contracts: relevant lot value, base budget, estimated total contract value, whole-procedure value, annual value, multi-year value
- grants: maximum aid per beneficiary, programme budget, eligible project cost, aid intensity

## SQL scaffold

The normalized relational scaffold lives in [database/schema.sql](/Users/dani/Documents/Playground/database/schema.sql) and includes:

- users
- organisations
- organisation_members
- company_profiles
- company_capabilities
- company_certifications
- company_preferences
- company_feedback
- opportunities
- opportunity_lots
- opportunity_sources
- opportunity_documents
- opportunity_contacts
- opportunity_requirements
- opportunity_amounts
- opportunity_deadlines
- opportunity_evidence
- matches
- match_dimensions
- eligibility_checks
- adaptive_questions
- saved_opportunities
- pursuit_statuses
- source_sync_runs
- source_errors
- ai_runs
- ai_cost_usage
- audit_events
