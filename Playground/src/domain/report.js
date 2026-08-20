import { RECOMMENDATION_COPY, ELIGIBILITY_COPY, OPPORTUNITY_TYPES } from "../config.js";
import { isNonActionableDerivedStatus, daysRemaining, formatDeadline } from "./deadline.js";
import { describeEvidenceBackedText } from "./evidence.js";
import { hasSelectedExplicitLot } from "./opportunity-scope.js";

function actionSentence(analysis) {
  const code = analysis.decision?.recommendedAction?.code;
  if (code === "DO_NOT_PURSUE") return "Do not pursue it under the current evidence set.";
  if (code === "VERIFY_BEFORE_DECIDING") return "Verify the unresolved requirements and source gaps before deciding whether to pursue it.";
  return "Investigate it now through the official route and confirm any remaining business assumptions.";
}

function isArchivalNotice(opportunity) {
  return isNonActionableDerivedStatus(opportunity.derivedStatus ?? opportunity.status);
}

function capabilityLead(company, analysis) {
  const baseCapabilityFit = analysis.dimensions?.baseCapabilityFit ?? analysis.dimensions?.capabilityFit ?? 0;
  const specialistScopeConfidence = analysis.dimensions?.specialistScopeConfidence ?? 0;

  if (baseCapabilityFit >= 80 && specialistScopeConfidence >= 70) {
    return `Capability evidence looks strong for ${company.legalName} on this scope.`;
  }
  if (baseCapabilityFit >= 60 && specialistScopeConfidence >= 55) {
    return `Capability evidence looks workable for ${company.legalName}, although not fully proven across every specialist detail.`;
  }
  if (baseCapabilityFit >= 40) {
    return `There is only partial technical overlap for ${company.legalName}, and specialist delivery scope is not yet strongly evidenced.`;
  }
  if (baseCapabilityFit >= 18) {
    return `Only limited technical overlap is currently evidenced for ${company.legalName}.`;
  }
  return `Current evidence shows little relevant technical overlap for ${company.legalName}.`;
}

function scaleLead(analysis) {
  const financialScaleFit = analysis.dimensions?.financialScaleFit ?? 0;
  if (financialScaleFit >= 75) return "Commercial scale looks broadly compatible with the company's evidenced range.";
  if (financialScaleFit >= 50) return "Commercial scale looks potentially workable, but not especially well aligned.";
  if (financialScaleFit >= 35) return "Commercial scale may stretch the company's evidenced range.";
  return "Commercial scale currently looks larger than the company's evidenced range.";
}

function qualificationLead(analysis) {
  if (analysis.blockers[0]) {
    return `Confirmed blocker: ${analysis.blockers[0].title}.`;
  }
  if (analysis.potentialHardBlockers?.[0]) {
    return `Potential hard blocker: ${analysis.potentialHardBlockers[0].title} is not yet verified.`;
  }

  const qualificationReadiness = analysis.dimensions?.qualificationReadiness ?? 0;
  if (qualificationReadiness >= 75) return "Known qualification evidence is currently strong.";
  if (qualificationReadiness >= 45) return "Qualification evidence is mixed and still needs confirmation.";
  if (qualificationReadiness > 0) return "Qualification evidence is weak and incomplete.";
  return "Qualification readiness is currently unproven under the reviewed evidence.";
}

function potentialHardBlockerSummary(analysis) {
  if (analysis.potentialHardBlockers?.length) {
    return analysis.potentialHardBlockers.map((item) => item.title).join("; ");
  }
  if (analysis.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED") {
    return "Not yet assessable - qualification requirements have not been retrieved.";
  }
  return "None recorded";
}

export function executiveVerdict(company, opportunity, analysis) {
  const openIssue =
    analysis.potentialHardBlockers?.[0] ??
    analysis.unknowns[0] ??
    analysis.risks.find((risk) => risk.requiresVerification) ??
    null;
  const openIssueSentence = openIssue
    ? `Open issue: ${openIssue.detail}`
    : analysis.eligibilityStatus === "CONFIRMED_ELIGIBLE"
      ? "All currently identified mandatory conditions are confirmed."
      : analysis.eligibilityStatus === "ELIGIBILITY_NOT_ASSESSED"
        ? "The reviewed sources do not yet establish the mandatory qualification conditions."
        : "No additional unresolved issue is currently recorded beyond the scored decision state.";

  return `${capabilityLead(company, analysis)} ${scaleLead(analysis)} ${qualificationLead(analysis)} ${openIssueSentence} ${actionSentence(analysis)}`;
}

export function buildPreparationChecklist(opportunity, analysis) {
  const eligibilityRequirements = analysis.requirementRows.filter((row) => row.mandatory).map((row) => row.label);
  const requiredDocuments = opportunity.requiredDocuments ?? [];
  if (isArchivalNotice(opportunity)) {
    return {
      eligibilityRequirements,
      requiredDocuments,
      preparationItems: ["Archival review only. This notice is not open for a live submission."]
    };
  }
  const preparationItems = [
    "Internal go / no-go review",
    "Commercial and technical lead assignment",
    analysis.potentialHardBlockers?.length || analysis.unknowns.length || analysis.risks.some((risk) => risk.requiresVerification)
      ? "Gather evidence for unresolved qualification, eligibility, or source-verification conditions"
      : null
  ].filter(Boolean);
  return { eligibilityRequirements, requiredDocuments, preparationItems };
}

function formatRequirementStatus(row) {
  if (row.status === "needs_verification" && row.mandatory) return "Needs verification - mandatory";
  if (row.status === "failed" && row.mandatory) return "Failed - mandatory";
  if (row.status === "confirmed" && row.mandatory) return "Confirmed - mandatory";
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

function submissionRouteLabel(opportunity) {
  if (isArchivalNotice(opportunity)) return "No live submission route applies because this notice is not open.";
  return opportunity.applicationUrl || "Submission route not yet verified";
}

function noticeLabel(opportunity) {
  return opportunity.noticeUrl || "Official notice / dossier not yet verified";
}

function contactLabel(opportunity, analysis) {
  if (isArchivalNotice(opportunity) && !analysis.primaryContact?.name) {
    return "No live submission contact is required for this archived notice.";
  }
  return analysis.primaryContact?.name
    ? `${analysis.primaryContact.name}${analysis.primaryContact.email ? ` (${analysis.primaryContact.email})` : ""}`
    : "Contact not found in reviewed/imported sources";
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
        `- ${source.organisation} · ${source.title} · ${source.url || "No URL provided"} · Published ${source.publishedAt || "date unknown"} · Last checked ${source.lastChecked || "unknown"}`
    )
    .join("\n");

  return `## ${analysis.rankLabel} PRIORITY OPPORTUNITY

### ${analysis.displayTitle}

**OportuneX Match:** ${analysis.matchScore}/100<br>
**Fit band:** ${RECOMMENDATION_COPY[analysis.fitBand ?? analysis.recommendationClass]}<br>
**Recommended action:** ${analysis.decision.recommendedAction.label}<br>
**Eligibility:** ${ELIGIBILITY_COPY[analysis.eligibilityStatus]}<br>
**Decision confidence:** ${analysis.confidenceShield.label}<br>
**Company profile basis:** ${company.profileMode === "prospect" ? "Prospect profile built from public information" : "Company-confirmed profile"}<br>
**Type:** ${OPPORTUNITY_TYPES[opportunity.type]}<br>
${hasSelectedExplicitLot(analysis) ? `**Relevant lot:** ${analysis.lotLabel}<br>` : `**Scope:** Whole opportunity<br>`}
**Published value:** ${analysis.displayValueLabel}<br>
**Location:** ${analysis.locationLabel}  
**Deadline:** ${formatDeadline(opportunity.deadline)}  
**Calendar days remaining:** ${remainingDays ?? "Not determined"}

### Executive Verdict

${analysis.executiveVerdict}

### Canonical Decision

- Match band: ${RECOMMENDATION_COPY[analysis.fitBand ?? analysis.recommendationClass]}
- Recommended action: ${analysis.decision.recommendedAction.label}
- Main reason: ${analysis.decision.mainReason}
- Main question: ${analysis.decision.mainQuestion}
- Potential hard blockers: ${potentialHardBlockerSummary(analysis)}
- Base capability fit: ${analysis.dimensions.baseCapabilityFit}/100
- Specialist scope confidence: ${analysis.dimensions.specialistScopeConfidence}/100
- Qualification readiness: ${analysis.dimensions.qualificationReadiness}/100

### Why OportuneX Selected It

${analysis.positives.map((item) => `- ${item.title}: ${item.detail}`).join("\n") || "- No positive signal recorded."}

### Eligibility Check

| Requirement | Status | Evidence | Why It Matters |
| --- | --- | --- | --- |
${rows || "| None identified | Eligibility not assessed | Not linked | The reviewed/imported sources do not yet establish mandatory requirements. |"}

### Financial Picture

- Primary customer-facing amount: ${analysis.displayValueLabel}
- Duration: ${opportunity.duration ?? "Not stated"}
- Guarantees: ${describeEvidenceBackedText(opportunity, "guarantees", opportunity.guarantees, {
  fallback: "Not stated"
})}
- ${analysis.companyAmountLabel}
${formatFinancialPicture(analysis)}

### Eligibility / Qualification Requirements

${checklist.eligibilityRequirements.map((row) => `- ${row}`).join("\n") || "- Mandatory qualification requirements not yet verified from reviewed sources."}

### Submission Documents

${checklist.requiredDocuments.map((item) => `- ${item}`).join("\n") || "- Submission document list not yet verified from reviewed sources."}

### Preparation Items

${checklist.preparationItems.map((item) => `- ${item}`).join("\n")}

### Risks & Blockers

${analysis.blockers.map((item) => `- ${item.severity.toUpperCase()} - ${item.title}: ${item.detail}`).join("\n") || (analysis.potentialHardBlockers?.length ? "- No confirmed blocker recorded, but potential hard blockers remain." : "- No confirmed blocker recorded")}
${analysis.potentialHardBlockers?.map((item) => `- POTENTIAL HARD BLOCKER - ${item.title}: ${item.detail}`).join("\n") || ""}
${analysis.unknowns.map((item) => `- ${item.severity.toUpperCase()} - ${item.title}: ${item.detail}`).join("\n")}
${analysis.risks.map((item) => `- ${item.severity.toUpperCase()} - ${item.title}: ${item.detail}`).join("\n")}

### Pre-Mortem

${analysis.preMortem.map((item) => `- ${item}`).join("\n")}

### What OportuneX Still Needs From You

${analysis.adaptiveQuestions.map((item) => `- ${item.question} ${item.why ? `(${item.why})` : ""}`).join("\n") || "- No open question."}

### How To Pursue

- Official application: ${submissionRouteLabel(opportunity)}
- Official notice: ${noticeLabel(opportunity)}
- Authority contact: ${contactLabel(opportunity, analysis)}
- Reference: ${opportunity.referenceNumber ?? opportunity.id}
- Submission deadline: ${formatDeadline(opportunity.deadline)}

### Sources

${sources || "- No reviewed/imported source metadata is stored yet."}

### OportuneX Confidence Shield

- Official source verified: ${analysis.confidenceShield.officialSourceVerified ? "Yes" : "No"}
- Last checked: ${opportunity.lastChecked ?? "Never"}
- Source fields evidenced: ${analysis.confidenceShield.sourceFieldsEvidenced}/${analysis.confidenceShield.totalSourceFields}
- Critical field summary: ${analysis.confidenceShield.criticalFieldSummary}
- Mandatory conditions: ${analysis.confidenceShield.mandatoryConfirmed} confirmed, ${analysis.confidenceShield.mandatoryNeedsVerification} need verification, ${analysis.confidenceShield.mandatoryFailed} failed
- Company confirmations needed: ${analysis.confidenceShield.companyConfirmationsNeeded}
- Data confidence: ${analysis.confidenceShield.dataConfidence}
- Eligibility confidence: ${analysis.confidenceShield.eligibilityConfidence}
- Company-fact confidence: ${analysis.confidenceShield.companyFactConfidence}
- Decision confidence: ${analysis.confidenceShield.decisionConfidence}
- Source conflicts: ${analysis.confidenceShield.sourceConflictsCount}
`;
}
