# Security

## Current controls

- no secrets in the client bundle
- AI verification runs server-side only
- official-source links are rendered as explicit external destinations
- source text is treated as untrusted evidence
- manual overrides are logged in `manualOverrides` and `auditEvents`

## Trust-critical invariants

- facts require provenance
- unknown is never equivalent to pass
- deadlines are never fabricated
- grant programme budgets are never shown as beneficiary amounts
- lot-level value outranks whole-procedure value where relevant
- contact roles stay explicit

## Future hardening

- organisation-level auth
- row-level data protections
- secret vault integration
- webhook verification
- rate limiting
- export/deletion workflows
