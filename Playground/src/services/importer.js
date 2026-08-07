import { uid } from "../utils.js";
import { createMoney, parseMoneyInput } from "../domain/money.js";
import { parseSpanishDate } from "../domain/deadline.js";

function matchFirst(pattern, text) {
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

export function importOpportunityFromText(text) {
  const lower = text.toLowerCase();
  const amountMatch = text.match(/€\s?([\d\.\,]+)/);
  const deadlineMatch = text.match(/\d{2}\/\d{2}\/\d{4}(?:\s*(?:at|a las)?\s*\d{1,2}:\d{2})?/i);
  const title = matchFirst(/title:\s*(.+)/i, text) || text.split("\n")[0].slice(0, 120) || "Imported opportunity";
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
