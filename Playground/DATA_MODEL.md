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
- reportMarkdown

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
