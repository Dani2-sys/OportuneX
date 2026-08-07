import { clamp, formatNumber } from "../utils.js";

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

export function scoreScaleFit(company, targetMoney) {
  if (!targetMoney) return 45;
  const target = moneyToMajor(targetMoney);
  const min = company.preferences?.minimumAttractiveProjectValue ?? 0;
  const ideal = company.preferences?.idealProjectValue ?? min;
  const max = company.preferences?.maximumRealisticProjectValue ?? (ideal ? ideal * 2 : 1000000);
  if (target > max * 1.5) return 0;
  if (target > max) return clamp(35 - ((target - max) / max) * 25);
  if (target >= min && target <= max) {
    const distance = Math.abs(target - ideal);
    const spread = Math.max(ideal - min, max - ideal, 1);
    return clamp(96 - (distance / spread) * 22, 70, 98);
  }
  if (target < min) {
    const ratio = target / Math.max(min, 1);
    return clamp(45 + ratio * 20, 25, 65);
  }
  return 55;
}

export function formatPercent(value) {
  return `${formatNumber(Math.round(value))}%`;
}
