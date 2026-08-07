import { RECOMMENDATION_COPY, ELIGIBILITY_COPY, OPPORTUNITY_TYPES } from "../config.js";
import { formatDeadline, urgencyChip } from "./deadline.js";
import { formatMoney } from "./money.js";

export function executiveVerdict(company, opportunity, analysis) {
  const bestCapability = analysis.positives[0]?.title ?? "the capability fit";
  const mainQuestion = analysis.unknowns[0]?.title ?? analysis.blockers[0]?.title ?? "published eligibility details";
  const action =
    analysis.recommendationClass === "DO_NOT_PURSUE"
      ? "Do not invest pursuit time unless the blocking facts change."
      : analysis.recommendationClass === "VERIFY_BEFORE_DECIDING"
        ? "Verify the missing mandatory facts before deciding whether to pursue it."
        : "Review the official route and decide whether to pursue it this week.";

  return `${analysis.displayTitle} is worth attention because ${bestCapability.toLowerCase()} aligns well with ${company.legalName}. The current opportunity shape looks realistic on scope, geography and timing, but ${mainQuestion.toLowerCase()} remains the main issue. ${action}`;
}

export function buildPreparationChecklist(opportunity, analysis) {
  const explicit = [
    ...analysis.requirementRows.filter((row) => row.mandatory).map((row) => row.label),
    ...(opportunity.requiredDocuments ?? [])
  ];
  const likely = [
    "Internal go / no-go review",
    "Commercial and technical lead assignment",
    analysis.unknowns.length ? "Evidence for unanswered eligibility questions" : null
  ].filter(Boolean);
  return { explicit, likely };
}

export function generateReportMarkdown(company, opportunity, analysis) {
  const checklist = buildPreparationChecklist(opportunity, analysis);
  const rows = analysis.requirementRows
    .map((row) => `| ${row.label} | ${row.status} | ${row.evidenceIds.join(", ") || "Not linked"} |`)
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
**Type:** ${OPPORTUNITY_TYPES[opportunity.type]}  
**Relevant lot:** ${analysis.lotLabel}  
**Published value:** ${analysis.displayValueLabel}  
**Location:** ${analysis.locationLabel}  
**Deadline:** ${formatDeadline(opportunity.deadline)}  
**Days remaining:** ${urgencyChip(opportunity)}

### Executive Verdict

${analysis.executiveVerdict}

### Why OportuneX Selected It

${analysis.positives.map((item) => `- ${item.title}: ${item.detail}`).join("\n")}

### Eligibility Check

| Requirement | Status | Evidence |
| --- | --- | --- |
${rows}

### Financial Picture

- Primary value used for analysis: ${analysis.displayValueLabel}
- Duration: ${opportunity.duration ?? "Not stated"}
- Guarantees: ${opportunity.guarantees ?? "Not stated"}
- Potential company funding: ${analysis.companyAmountLabel}

### Requirements

${analysis.requirementRows.map((row) => `- ${row.label}`).join("\n")}

### Documents / Preparation

Explicitly required by source:
${checklist.explicit.map((item) => `- ${item}`).join("\n")}

Likely preparation items:
${checklist.likely.map((item) => `- ${item}`).join("\n")}

### Risks & Blockers

${analysis.blockers.map((item) => `- ${item.severity.toUpperCase()} — ${item.title}: ${item.detail}`).join("\n") || "- No confirmed blocker recorded"}

### Pre-Mortem

${analysis.preMortem.map((item) => `- ${item}`).join("\n")}

### What OportuneX Still Needs From You

${analysis.adaptiveQuestions.map((item) => `- ${item.question}`).join("\n") || "- No open question."}

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
- Critical fields verified: ${analysis.confidenceShield.criticalFieldsVerified}/${analysis.confidenceShield.totalCriticalFields}
- Data confidence: ${analysis.confidenceShield.dataConfidence}
- Eligibility confidence: ${analysis.confidenceShield.eligibilityConfidence}
- Conflicting sources: ${analysis.confidenceShield.conflictingSources ? "Yes" : "No"}
- Outstanding critical questions: ${analysis.confidenceShield.outstandingQuestions}
`;
}
