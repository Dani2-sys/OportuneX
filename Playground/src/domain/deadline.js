import { clamp, formatDate, formatIsoDate } from "../utils.js";

export const SPANISH_TIME_ZONE = "Europe/Madrid";
export const NON_ACTIONABLE_DERIVED_STATUSES = new Set(["closed", "cancelled", "awarded", "suspended"]);

function pad(value) {
  return String(value).padStart(2, "0");
}

function zonedDateTimeParts(now = new Date(), timeZone = SPANISH_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  return Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function getTimeZoneOffsetMilliseconds(now, timeZone = SPANISH_TIME_ZONE) {
  const parts = zonedDateTimeParts(now, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - now.getTime();
}

export function parseSpanishDate(text = "") {
  const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s*(?:at|a las)?\s*(\d{1,2}):(\d{2}))?/i);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  return {
    sourceText: text.trim(),
    date: `${year}-${month}-${day}`,
    time: hour != null ? `${hour.padStart(2, "0")}:${minute}` : null,
    timezone: SPANISH_TIME_ZONE,
    // The source text provides a local date/time but not an explicit zone.
    sourceTimezone: null,
    utcEquivalent: hour != null ? toUtcIso(`${year}-${month}-${day}`, `${hour.padStart(2, "0")}:${minute}`) : null
  };
}

export function toUtcIso(date, time, timeZone = SPANISH_TIME_ZONE) {
  if (!date || !time) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if ([year, month, day, hour, minute].some((value) => !Number.isFinite(value))) return null;

  const localUtcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let timestamp = localUtcGuess;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = getTimeZoneOffsetMilliseconds(new Date(timestamp), timeZone);
    const corrected = localUtcGuess - offset;
    if (corrected === timestamp) break;
    timestamp = corrected;
  }

  const resolved = new Date(timestamp);
  const resolvedParts = zonedDateTimeParts(resolved, timeZone);
  if (
    resolvedParts.year !== year ||
    resolvedParts.month !== month ||
    resolvedParts.day !== day ||
    resolvedParts.hour !== hour ||
    resolvedParts.minute !== minute
  ) {
    return null;
  }

  return resolved.toISOString();
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
  const parts = zonedDateTimeParts(now, SPANISH_TIME_ZONE);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
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

export function isNonActionableDerivedStatus(status) {
  return NON_ACTIONABLE_DERIVED_STATUSES.has(status);
}

export function isActiveDerivedStatus(status) {
  return !isNonActionableDerivedStatus(status);
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
  if (remaining <= 3) return `${remaining} calendar days left`;
  return `${remaining} calendar days remaining`;
}

export function scoreFreshness(lastChecked, now = new Date()) {
  if (!lastChecked) return 25;
  const hours = (now - new Date(lastChecked)) / 3600000;
  if (hours <= 24) return 94;
  if (hours <= 72) return 78;
  if (hours <= 168) return 58;
  return clamp(42 - (hours - 168) / 24, 22, 42);
}
