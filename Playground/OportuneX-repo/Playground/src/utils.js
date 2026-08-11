export function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

export function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function weightedAverage(entries) {
  const filtered = entries.filter(({ value, weight }) => Number.isFinite(value) && weight > 0);
  if (!filtered.length) return 0;
  const weightSum = filtered.reduce((sum, entry) => sum + entry.weight, 0);
  const total = filtered.reduce((sum, entry) => sum + entry.value * entry.weight, 0);
  return total / weightSum;
}

export function normalizeText(value = "") {
  return value
    .toString()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSlug(value = "") {
  return normalizeText(value)
    .replace(/[\/\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function uid(prefix = "id") {
  const suffix =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${suffix}`;
}

export function escapeHtml(value = "") {
  return value
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatNumber(value, options = {}) {
  return new Intl.NumberFormat("en-GB", options).format(value);
}

export function formatDate(value, options = {}) {
  if (!value) return "Not set";
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    ...(options.includeTime ? { timeStyle: "short" } : {})
  }).format(date);
}

export function formatIsoDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

export function pluralize(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function clone(value) {
  return structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function compareDesc(left, right) {
  return right - left;
}

export function compareAsc(left, right) {
  return left - right;
}

export function unique(values) {
  return [...new Set(values)];
}
