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

function labelForAmountType(amountType, fallback, { explicitLotEvidence = false } = {}) {
  switch (amountType) {
    case "relevant_lot_value":
      return explicitLotEvidence ? "Relevant lot value" : fallback;
    case "estimated_value":
      return "Estimated contract value";
    case "award_value":
      return "Awarded contract value";
    case "base_budget":
      return "Base / tender budget";
    case "whole_procedure_value":
      return "Whole procedure value";
    case "annual_value":
      return "Annual value";
    case "multi_year_value":
      return "Multi-year value";
    default:
      return fallback;
  }
}

function labelForPublishedLotMoney(lot, money) {
  switch (money?.amountType) {
    case "relevant_lot_value":
      return `Relevant ${lot.title}`;
    case "estimated_value":
      return `${lot.title} estimated contract value`;
    case "base_budget":
      return `${lot.title} base / tender budget`;
    case "whole_procedure_value":
      return `${lot.title} procedure value`;
    case "award_value":
      return `${lot.title} awarded value`;
    default:
      return lot.title;
  }
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
  const explicitLotEvidence = Boolean(publishedLot?.value);
  const primarySource = publishedLot?.value
    ? "published_lot"
    : opportunity.relevantValue
      ? "relevant_value"
      : opportunity.estimatedValue
        ? "estimated_value"
        : opportunity.baseBudget
          ? "base_budget"
          : opportunity.wholeProcedureValue
            ? "whole_procedure_value"
            : opportunity.awardValue
              ? "award_value"
              : opportunity.annualValue
                ? "annual_value"
                : opportunity.multiYearValue
                  ? "multi_year_value"
                  : null;
  const primaryMoney =
    publishedLot?.value ??
    opportunity.relevantValue ??
    opportunity.estimatedValue ??
    opportunity.baseBudget ??
    opportunity.wholeProcedureValue ??
    opportunity.awardValue ??
    opportunity.annualValue ??
    opportunity.multiYearValue ??
    null;
  const hasLotSpecificPrimary = explicitLotEvidence;
  const primaryLabel = primarySource === "published_lot"
    ? labelForPublishedLotMoney(publishedLot, primaryMoney)
    : primarySource === "relevant_value"
      ? (explicitLotEvidence ? "Relevant lot value" : "Published contract value")
      : labelForAmountType(primaryMoney?.amountType, "Published contract value", { explicitLotEvidence });

  const lines = compact([
    buildMoneyLine(
      "primary_contract_value",
      primaryLabel,
      primaryMoney,
      {
        primary: Boolean(primaryMoney),
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
    buildMoneyLine("award_value", "Awarded contract value", primarySource === "award_value" ? null : opportunity.awardValue),
    buildMoneyLine(
      "whole_procedure_value",
      "Whole procedure value",
      primarySource === "whole_procedure_value" ? null : opportunity.wholeProcedureValue
    ),
    buildMoneyLine("annual_value", "Annual value", primarySource === "annual_value" ? null : opportunity.annualValue),
    buildMoneyLine("multi_year_value", "Multi-year value", primarySource === "multi_year_value" ? null : opportunity.multiYearValue)
  ]);

  return {
    kind: "contract",
    primaryLine: lines[0] ?? null,
    lines
  };
}
