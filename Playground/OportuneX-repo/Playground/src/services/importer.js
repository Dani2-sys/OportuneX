import { normalizeText, uid } from "../utils.js";
import { createMoney, parseMoneyInput } from "../domain/money.js";
import { parseSpanishDate } from "../domain/deadline.js";

function matchFirst(pattern, text) {
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function firstMeaningfulLine(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 6) ?? "";
}

function inspectImportText(text = "") {
  const normalized = normalizeText(text);
  const firstLine = firstMeaningfulLine(text);
  const wordCount = normalized ? normalized.split(" ").filter(Boolean).length : 0;
  return {
    firstLine,
    wordCount,
    hasAmount: /€\s?[\d\.\,]+/.test(text),
    hasDeadline: /\d{2}\/\d{2}\/\d{4}(?:\s*(?:at|a las)?\s*\d{1,2}:\d{2})?/i.test(text),
    hasLocation: /(tarragona|barcelona|girona|lleida|catalonia|cataluna|catalunya)/i.test(text),
    mentionsOpportunityType: /(contract|grant|subsid|ayuda|subvencion|licitacion|tender)/i.test(text)
  };
}

export function validateOpportunityImport({
  sourceText = "",
  title = "",
  type = "",
  location = "",
  valueText = "",
  deadlineText = "",
  noticeUrl = ""
} = {}) {
  const sourceSignals = inspectImportText(sourceText);
  const meaningfulTitle = title.trim().length >= 6;
  const structuredDetailCount = [location.trim(), valueText.trim(), deadlineText.trim(), noticeUrl.trim()].filter(Boolean).length;
  const hasUsefulSourceText =
    Boolean(sourceSignals.firstLine) &&
    sourceSignals.wordCount >= 8 &&
    (sourceSignals.hasAmount || sourceSignals.hasDeadline || sourceSignals.hasLocation || sourceSignals.mentionsOpportunityType);
  const hasMeaningfulManualEntry = meaningfulTitle && Boolean(type) && structuredDetailCount >= 1;

  if (hasUsefulSourceText || hasMeaningfulManualEntry) {
    return {
      ok: true
    };
  }

  return {
    ok: false,
    message:
      "Add useful source text, or provide a meaningful title plus the opportunity type and at least one substantive detail such as value, deadline, location, or notice URL."
  };
}

export function importOpportunityFromText(text) {
  const lower = text.toLowerCase();
  const amountMatch = text.match(/€\s?([\d\.\,]+)/);
  const deadlineMatch = text.match(/\d{2}\/\d{2}\/\d{4}(?:\s*(?:at|a las)?\s*\d{1,2}:\d{2})?/i);
  const title = matchFirst(/title:\s*(.+)/i, text) || firstMeaningfulLine(text).slice(0, 120) || "Manual opportunity";
  const type = /subsid|grant|ayuda|subvencion/i.test(lower) ? "grant" : "contract";
  const deadline = deadlineMatch ? parseSpanishDate(deadlineMatch[0]) : null;
  const amount = amountMatch ? parseMoneyInput(amountMatch[1], { amountType: type === "grant" ? "maximum_grant" : "estimated_value" }) : null;
  const certificationRequired = /iso\s*9001/i.test(lower);
  const location =
    /tarragona/i.test(lower)
      ? { municipality: "Tarragona", province: "Tarragona", autonomousCommunity: "Catalonia", display: "Tarragona" }
      : /barcelona/i.test(lower)
        ? { municipality: "Barcelona", province: "Barcelona", autonomousCommunity: "Catalonia", display: "Barcelona" }
        : { display: "Needs review" };

  const evidence = [];
  if (amount) {
    evidence.push({
      id: uid("ev"),
      fieldKey: type === "grant" ? "lot_value" : "lot_value",
      excerpt: amountMatch[0],
      sourceType: "pasted_text",
      confidence: 0.84
    });
  }
  if (deadline) {
    evidence.push({
      id: uid("ev"),
      fieldKey: "deadline",
      excerpt: deadlineMatch[0],
      sourceType: "pasted_text",
      confidence: 0.88
    });
  }
  if (location.display !== "Needs review") {
    evidence.push({
      id: uid("ev"),
      fieldKey: "location",
      excerpt: location.display,
      sourceType: "pasted_text",
      confidence: 0.75
    });
  }

  return {
    id: uid("opp"),
    sourceOpportunityId: uid("src"),
    sourceNoticeVersionId: uid("ver"),
    type,
    noticeType: type === "grant" ? "grant_call" : "active_contract_notice",
    status: "open",
    title,
    description: text,
    location,
    cpvCodes: [],
    estimatedValue: type === "contract" ? amount : null,
    maximumAidPerBeneficiary: type === "grant" ? amount : null,
    relevantValue: type === "contract" ? amount : null,
    deadline,
    lastChecked: new Date().toISOString(),
    referenceNumber: uid("ref"),
    sources: [
      {
        id: uid("source"),
        organisation: "Manual import",
        title: "Pasted source text",
        url: "",
        official: false,
        publishedAt: new Date().toISOString().slice(0, 10),
        lastChecked: new Date().toISOString()
      }
    ],
    evidence,
    requirements: certificationRequired
      ? [
          {
            id: uid("req"),
            kind: "certification",
            label: "Valid ISO 9001 certification",
            requiredValue: "ISO 9001",
            mandatory: true,
            gating: "hard",
            evidenceIds: evidence.map((item) => item.id),
            question: "This opportunity requires ISO 9001. Does your company currently hold a valid ISO 9001 certification?"
          }
        ]
      : [],
    documents: [],
    contacts: [],
    lots: []
  };
}
