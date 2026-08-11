import { clamp, formatNumber } from "../utils.js";
import { getCompanyFact, getEmployeeRange, getFactValue, getProfileMode, getRangeValue, getTurnoverRange } from "./company-profile.js";

export function createMoney({
  major = 0,
  currency = "EUR",
  vatStatus = "unknown",
  amountType = "generic",
  source = "manual",
  label = ""
} = {}) {
  const minor = Math.round(Number(major || 0) * 100);
  return {
    amountMinor: minor,
    currency,
    vatStatus,
    amountType,
    source,
    label,
    original: major.toString()
  };
}

export function parseMoneyInput(raw, options = {}) {
  if (raw == null || raw === "") return null;
  const cleaned = raw
    .toString()
    .trim()
    .replace(/[€\s]/g, "")
    .replace(/\.(?=\d{3}(?:[.,]|$))/g, "")
    .replace(",", ".");
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return createMoney({ major: value, ...options });
}

export function moneyToMajor(money) {
  if (!money) return null;
  return money.amountMinor / 100;
}

export function formatMoney(money, fallback = "Not determined") {
  if (!money) return fallback;
  const amount = money.amountMinor / 100;
  const formatted = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: money.currency || "EUR",
    maximumFractionDigits: 0
  }).format(amount);
  if (money.vatStatus === "excluding") return `${formatted} excl. VAT`;
  if (money.vatStatus === "including") return `${formatted} incl. VAT`;
  return formatted;
}

export function withinRange(amount, min, max) {
  if (amount == null) return false;
  const value = moneyToMajor(amount);
  return value >= min && value <= max;
}

export function compareMoney(left, right) {
  return (left?.amountMinor ?? 0) - (right?.amountMinor ?? 0);
}

export function bandToRange(label) {
  const mapping = {
    "under-250k": [0, 250000],
    "250k-500k": [250000, 500000],
    "500k-1m": [500000, 1000000],
    "1m-2m": [1000000, 2000000],
    "2m-5m": [2000000, 5000000],
    "5m+": [5000000, 999999999]
  };
  return mapping[label] ?? [0, 999999999];
}

function scoreFromExplicitPreferences(target, min, ideal, max) {
  if (max == null) return null;
  if (target > max * 1.5) return 12;
  if (target > max) return clamp(32 - ((target - max) / Math.max(max, 1)) * 18, 8, 32);
  if (ideal != null && min != null && target >= min && target <= max) {
    const distance = Math.abs(target - ideal);
    const spread = Math.max(ideal - min, max - ideal, 1);
    return clamp(96 - (distance / spread) * 22, 70, 98);
  }
  if (target < min) {
    const ratio = target / Math.max(min, 1);
    return clamp(45 + ratio * 20, 25, 65);
  }
  return clamp(84 - Math.abs(target - (ideal ?? max)) / Math.max(max, 1) * 18, 50, 90);
}

function publicScaleSignal(company) {
  const observedProjectValue = getFactValue(getCompanyFact(company, "maximumProjectValue"));
  const turnoverRange = getRangeValue(getTurnoverRange(company));
  const employeeRange = getRangeValue(getEmployeeRange(company));
  const employeeCeiling = employeeRange?.max ?? employeeRange?.min ?? null;

  return {
    observedProjectValue,
    turnoverRange,
    employeeRange,
    ceiling: Math.max(
      observedProjectValue ?? 0,
      turnoverRange?.max != null ? turnoverRange.max * 0.35 : 0,
      employeeCeiling != null ? employeeCeiling * 25000 : 0
    )
  };
}

export function assessScaleFit(company, targetMoney) {
  if (!targetMoney) {
    return {
      score: 45,
      basis: "opportunity_value_unknown",
      note: "The published opportunity value is not clear enough to judge scale fit."
    };
  }

  const target = moneyToMajor(targetMoney);
  const min = getFactValue(getCompanyFact(company, "minimumAttractiveProjectValue"));
  const ideal = getFactValue(getCompanyFact(company, "idealProjectValue"));
  const max = getFactValue(getCompanyFact(company, "maximumRealisticProjectValue"));

  const explicitScore = scoreFromExplicitPreferences(target, min ?? 0, ideal ?? max ?? min ?? target, max);
  if (explicitScore != null) {
    return {
      score: Math.round(explicitScore),
      basis: "company_preference",
      note:
        explicitScore >= 70
          ? "The opportunity value sits inside the current company-confirmed project range."
          : explicitScore <= 35
            ? "The opportunity value sits above the current company-confirmed project range."
            : "The opportunity value is workable but not especially well aligned with the current company-confirmed project range."
    };
  }

  const signal = publicScaleSignal(company);
  if (!signal.ceiling) {
    return {
      score: 50,
      basis: "unknown",
      note: "Current project-size preferences are unknown, so scale fit remains only lightly assessed."
    };
  }

  if (target > signal.ceiling * 4) {
    return {
      score: 18,
      basis: getProfileMode(company) === "prospect" ? "public_scale_signal" : "observed_scale_signal",
      note:
        "Scale appears materially larger than the publicly observed company profile; suitability as a sole contractor is doubtful, but exact company capacity is unconfirmed."
    };
  }

  if (target > signal.ceiling * 2) {
    return {
      score: 32,
      basis: getProfileMode(company) === "prospect" ? "public_scale_signal" : "observed_scale_signal",
      note:
        "The opportunity looks materially larger than the observed company scale, so it should not be prioritised as a straightforward sole-bid opportunity without stronger capacity evidence."
    };
  }

  if (target > signal.ceiling) {
    return {
      score: 48,
      basis: getProfileMode(company) === "prospect" ? "public_scale_signal" : "observed_scale_signal",
      note:
        "The opportunity value looks somewhat above the observed company scale, but the exact current delivery ceiling is not confirmed."
    };
  }

  return {
    score: 74,
    basis: getProfileMode(company) === "prospect" ? "public_scale_signal" : "observed_scale_signal",
    note:
      "The opportunity value looks broadly compatible with the publicly observed company scale, although the current ceiling is not company-confirmed."
  };
}

export function scoreScaleFit(company, targetMoney) {
  return assessScaleFit(company, targetMoney).score;
}

export function formatPercent(value) {
  return `${formatNumber(Math.round(value))}%`;
}
