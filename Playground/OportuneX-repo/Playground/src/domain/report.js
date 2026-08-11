import { RECOMMENDATION_COPY, ELIGIBILITY_COPY, OPPORTUNITY_TYPES } from "../config.js";
import { daysRemaining, formatDeadline } from "./deadline.js";

export function executiveVerdict(company, opportunity, analysis) {
  const positiveSignals = analysis.positives
    .filter((item) => item.title !== "Deadline window")
    .slice(0, 2)
    .map((item) => item.title.toLowerCase());
  const interestLead = positiveSignals.length
    ? `${positiveSignals.join(" and ")} are currently strong.`
    : `${analysis.displayTitle} is technically related to ${company.legalName}.`;
  const gatingItem = analysis.blockers[0] ?? analysis.unknowns[0] ?? null;
  const gatingSentence = gatingItem
    ? `However, ${gatingItem.title.toLowerCase()} remains unresolved: ${gatingItem.detail}`
    : analysis.eligibilityStatus === "CONFIRMED_ELIGIBLE"
      ? "All mandatory eligibility conditions are currently confirmed."
      : "No unresolved gating issue is currently recorded, but the final bid decision still needs business judgement.";
  const actionSentence =
    analysis.recommendationClass === "DO_NOT_PURSUE"
      ? "Do not pursue it under the current evidence set."
      : analysis.recommendationClass === "VERIFY_BEFORE_DECIDING"
        ? "Verify these conditions before deciding whether to bid."
        : "Investigate it now through the official route and confirm any remaining business assumptions.";

  return `${interestLead} ${gatingSentence} ${actionSentence}`;
}

export function buildPreparationChecklist(opportunity, analysis) {
  const eligibilityRequirements = analysis.requirementRows.filter((row) => row.mandatory).map((row) => row.label);
  const requiredDocuments = opportunity.requiredDocuments ?? [];
  const preparationItems = [
    "Internal go / no-go review",
    "Commercial and technical lead assignment",
    analysis.unknowns.length ? "Gather evidence for unresolved qualification or eligibility conditions" : null
  ].filter(Boolean);
  return { eligibilityRequirements, requiredDocuments, preparationItems };
}

function formatRequirementStatus(row) {
  if (row.status === "needs_verification" && row.mandatory) {
    return "Needs verification — mandatory";
  }
  if (row.status === "failed" && row.mandatory) {
    return "Failed — mandatory";
  }
  if (row.status === "confirmed" && row.mandatory) {
    return "Confirmed — mandatory";
  }
  if (row.status === "needs_verification") return "Needs verification";
  if (row.status === "failed") return "Failed";
  if (row.status === "confirmed") return "Confirmed";
  return row.status ?? "Unknown";
}

function formatFinancialPicture(analysis) {
  if (!analysis.financialPicture?.lines?.length) return "- No reliable financial amount is currently available.";
  return analysis.financialPicture.lines
    .map((line) => {
      const suffix = line.note ? ` (${line.note})` : "";
      return `- ${line.label}: ${line.displayValue}${suffix}`;
    })
    .join("\n");
}

export function generateReportMarkdown(company, opportunity, analysis, now = new Date()) {
  const checklist = buildPreparationChecklist(opportunity, analysis);
  const remainingDays = daysRemaining(opportunity.deadline, now);
  const rows = analysis.requirementRows
    .map(
      (row) =>
        `| ${row.label} | ${formatRequirementStatus(row)} | ${row.evidenceIds.join(", ") || "Not linked"} | ${row.why ?? "Not provided"} |`
    )
    .join("\n");
  const sources = (opportunity.sources ?? [])
    .map(
      (source) =>
        `- ${source.organisation} · ${source.title} · ${source.url} · Published ${source.publishedAt} · Last checked ${source.lastChecked}`
    )
    .join("\n");

  return `## ${analysis.rankLabel} PRIORITY OPPORTUNITY

### ${analysis.displayTitle}

**OportuneX Match:** ${analysis.matchScore}/100  
**Priority:** ${RECOMMENDATION_COPY[analysis.recommendationClass]}  
**Eligibility:** ${ELIGIBILITY_COPY[analysis.eligibilityStatus]}  
**Confidence:** ${analysis.confidenceShield.label}  
**Company profile basis:** ${company.profileMode === "prospect" ? "Prospect profile built from public information" : "Company-confirmed profile"}  
**Type:** ${OPPORTUNITY_TYPES[opportunity.type]}  
**Relevant lot:** ${analysis.lotLabel}  
**Published value:** ${analysis.displayValueLabel}  
**Location:** ${analysis.locationLabel}  
**Deadline:** ${formatDeadline(opportunity.deadline)}  
**Calendar days remaining:** ${remainingDays ?? "Not determined"}

### Executive Verdict

${analysis.executiveVerdict}

### Why OportuneX Selected It

${analysis.positives.map((item) => `- ${item.title}: ${item.detail}`).join("\n")}

### Eligibility Check

| Requirement | Status | Evidence | Why It Matters |
| --- | --- | --- | --- |
${rows}

### Financial Picture

- Primary customer-facing amount: ${analysis.displayValueLabel}
- Duration: ${opportunity.duration ?? "Not stated"}
- Guarantees: ${opportunity.guarantees ?? "Not stated"}
- Potential company funding: ${analysis.companyAmountLabel}
${formatFinancialPicture(analysis)}

### Eligibility / Qualification Requirements

${checklist.eligibilityRequirements.map((row) => `- ${row}`).join("\n") || "- None published."}

### Submission Documents

${checklist.requiredDocuments.map((item) => `- ${item}`).join("\n") || "- No submission document has been explicitly listed by the source."}

### Preparation Items

${checklist.preparationItems.map((item) => `- ${item}`).join("\n")}

### Risks & Blockers

${analysis.blockers.map((item) => `- ${item.severity.toUpperCase()} — ${item.title}: ${item.detail}`).join("\n") || "- No confirmed blocker recorded"}

### Pre-Mortem

${analysis.preMortem.map((item) => `- ${item}`).join("\n")}

### What OportuneX Still Needs From You

${analysis.adaptiveQuestions.map((item) => `- ${item.question} ${item.why ? `(${item.why})` : ""}`).join("\n") || "- No open question."}

### How To Pursue

- Official application: ${opportunity.applicationUrl ?? "Not published"}
- Official notice: ${opportunity.noticeUrl ?? "Not published"}
- Authority contact: ${analysis.primaryContact?.name ?? "Not published"} (${analysis.primaryContact?.email ?? "No email"})
- Reference: ${opportunity.referenceNumber ?? opportunity.id}
- Submission deadline: ${formatDeadline(opportunity.deadline)}

### Sources

${sources}

### OportuneX Confidence Shield

- Official source verified: ${analysis.confidenceShield.officialSourceVerified ? "Yes" : "No"}
- Last checked: ${opportunity.lastChecked ?? "Never"}
- Source fields evidenced: ${analysis.confidenceShield.sourceFieldsEvidenced}/${analysis.confidenceShield.totalSourceFields}
- Mandatory conditions: ${analysis.confidenceShield.mandatoryConfirmed} confirmed, ${analysis.confidenceShield.mandatoryNeedsVerification} need verification, ${analysis.confidenceShield.mandatoryFailed} failed
- Company confirmations needed: ${analysis.confidenceShield.companyConfirmationsNeeded}
- Data confidence: ${analysis.confidenceShield.dataConfidence}
- Eligibility confidence: ${analysis.confidenceShield.eligibilityConfidence}
- Source conflicts: ${analysis.confidenceShield.sourceConflictsCount}
`;
}
