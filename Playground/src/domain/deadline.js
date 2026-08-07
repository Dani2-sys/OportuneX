import { clamp, formatDate, formatIsoDate } from "../utils.js";

export function parseSpanishDate(text = "") {
  const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s*(?:at|a las)?\s*(\d{1,2}):(\d{2}))?/i);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  return {
    sourceText: text.trim(),
    date: `${year}-${month}-${day}`,
    time: hour != null ? `${hour.padStart(2, "0")}:${minute}` : null,
    timezone: "Europe/Madrid",
    sourceTimezone: "Europe/Madrid",
    utcEquivalent: hour != null ? toUtcIso(`${year}-${month}-${day}`, `${hour.padStart(2, "0")}:${minute}`) : null
  };
}

export function toUtcIso(date, time) {
  if (!date || !time) return null;
  const local = new Date(`${date}T${time}:00`);
  return Number.isNaN(local.getTime()) ? null : local.toISOString();
}

function ymdToDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export function calendarDayDiff(from, to) {
  const fromDate = ymdToDate(from);
  const toDate = ymdToDate(to);
  return Math.round((toDate - fromDate) / 86400000);
}

export function currentYmd(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function daysRemaining(deadline, now = new Date()) {
  if (!deadline?.date) return null;
  return calendarDayDiff(currentYmd(now), deadline.date);
}

export function deriveStatus(opportunity, now = new Date()) {
  if (opportunity.cancellationStatus || opportunity.status === "cancelled") return "cancelled";
  if (opportunity.status === "suspended") return "suspended";
  if (opportunity.noticeType === "award_notice" || opportunity.status === "awarded") return "awarded";
  if (!opportunity.deadline?.date) return opportunity.status || "unknown";

  const remaining = daysRemaining(opportunity.deadline, now);
  if (remaining < 0) return "closed";
  if (remaining === 0 || remaining <= 3) return "closing_soon";

  const startDate = opportunity.startDate?.date ?? opportunity.startDate;
  if (startDate && calendarDayDiff(currentYmd(now), startDate) > 0) return "upcoming";

  return "open";
}

export function deadlineFeasibilityScore(opportunity, now = new Date()) {
  const remaining = daysRemaining(opportunity.deadline, now);
  if (remaining == null) return 40;
  if (remaining < 0) return 0;
  if (remaining <= 2) return 18;
  if (remaining <= 5) return 38;
  if (remaining <= 9) return 56;
  if (remaining <= 21) return 76;
  return 92;
}

export function formatDeadline(deadline) {
  if (!deadline?.date) return "Not published";
  const dateText = formatIsoDate(deadline.date);
  if (!deadline.time) return dateText;
  return `${dateText} at ${deadline.time}`;
}

export function formatLastChecked(timestamp) {
  return timestamp ? formatDate(timestamp, { includeTime: true }) : "Never";
}

export function freshnessLabel(lastChecked, now = new Date()) {
  if (!lastChecked) return "Never verified";
  const hours = Math.round((now - new Date(lastChecked)) / 3600000);
  if (hours <= 6) return "Checked today";
  if (hours <= 24) return "Checked in the last 24h";
  if (hours <= 72) return "Checked in the last 72h";
  return `Last checked ${formatDate(lastChecked, { includeTime: true })}`;
}

export function urgencyChip(opportunity, now = new Date()) {
  const remaining = daysRemaining(opportunity.deadline, now);
  if (remaining == null) return "Deadline not stated";
  if (remaining < 0) return "Expired";
  if (remaining === 0) return "Closes today";
  if (remaining <= 3) return `${remaining} days left`;
  return `${remaining} days remaining`;
}

export function scoreFreshness(lastChecked, now = new Date()) {
  if (!lastChecked) return 25;
  const hours = (now - new Date(lastChecked)) / 3600000;
  if (hours <= 24) return 94;
  if (hours <= 72) return 78;
  if (hours <= 168) return 58;
  return clamp(42 - (hours - 168) / 24, 22, 42);
}
