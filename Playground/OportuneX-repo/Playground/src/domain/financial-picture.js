import { formatMoney } from "./money.js";

function buildMoneyLine(id, label, money, { primary = false, note = "" } = {}) {
  if (!money) return null;
  return {
    id,
    label,
    money,
    displayValue: formatMoney(money),
    amountType: money.amountType ?? "generic",
    vatStatus: money.vatStatus ?? "unknown",
    primary,
    note
  };
}

function buildTextLine(id, label, text, { primary = false, note = "" } = {}) {
  if (text == null || text === "") return null;
  return {
    id,
    label,
    text,
    displayValue: String(text),
    amountType: "text",
    vatStatus: "n/a",
    primary,
    note
  };
}

function compact(lines) {
  return lines.filter(Boolean);
}

export function buildFinancialPicture(opportunity, lot = null) {
  if (opportunity.type === "grant") {
    const lines = compact([
      buildMoneyLine("maximum_aid_per_beneficiary", "Maximum aid per beneficiary", opportunity.maximumAidPerBeneficiary, {
        primary: Boolean(opportunity.maximumAidPerBeneficiary),
        note: opportunity.maximumAidPerBeneficiary ? "Primary value used for OportuneX assessment." : ""
      }),
      buildMoneyLine("programme_budget", "Programme budget", opportunity.programmeBudget),
      buildMoneyLine("eligible_project_cost", "Eligible project cost", opportunity.eligibleProjectCost),
      buildTextLine("aid_intensity", "Aid intensity", opportunity.aidIntensity)
    ]);

    return {
      kind: "grant",
      primaryLine: lines.find((line) => line.primary) ?? lines[0] ?? null,
      lines
    };
  }

  const publishedLot = lot?.synthetic ? null : lot;
  const primarySource = publishedLot?.value
    ? "published_lot"
    : opportunity.relevantValue
      ? "relevant_value"
      : opportunity.estimatedValue
        ? "estimated_value"
        : opportunity.baseBudget
          ? "base_budget"
          : null;
  const hasLotSpecificPrimary = Boolean(publishedLot?.value || opportunity.relevantValue);
  const primaryLabel = primarySource === "published_lot"
    ? `Relevant ${publishedLot.title}`
    : primarySource === "relevant_value"
      ? "Relevant lot value"
      : primarySource === "estimated_value"
        ? "Estimated contract value"
        : "Base / tender budget";

  const lines = compact([
    buildMoneyLine(
      "primary_contract_value",
      primaryLabel,
      publishedLot?.value ?? opportunity.relevantValue ?? opportunity.estimatedValue ?? opportunity.baseBudget,
      {
        primary: true,
        note: "Primary value used for OportuneX assessment."
      }
    ),
    buildMoneyLine(
      "base_budget",
      hasLotSpecificPrimary ? "Whole procedure base budget" : "Base / tender budget",
      primarySource === "base_budget" ? null : opportunity.baseBudget
    ),
    buildMoneyLine(
      "estimated_value",
      hasLotSpecificPrimary ? "Estimated total contract value" : "Estimated contract value",
      primarySource === "estimated_value" ? null : opportunity.estimatedValue
    ),
    buildMoneyLine("whole_procedure_value", "Whole procedure value", opportunity.wholeProcedureValue),
    buildMoneyLine("annual_value", "Annual value", opportunity.annualValue),
    buildMoneyLine("multi_year_value", "Multi-year value", opportunity.multiYearValue)
  ]);

  return {
    kind: "contract",
    primaryLine: lines[0] ?? null,
    lines
  };
}
