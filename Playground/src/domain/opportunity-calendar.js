import { ACTION_COPY, RECOMMENDATION_COPY } from "../config.js";
import { escapeHtml, toSlug } from "../utils.js";
import { SPANISH_TIME_ZONE, toUtcIso } from "./deadline.js";
import { getSelectedExplicitLotLabel, hasSelectedExplicitLot } from "./opportunity-scope.js";
import {
  collapseWhitespace,
  getCompanyDisplayName,
  PLACSP_PLATFORM_LABEL,
  presentCustomerDecisionText,
  resolveOfficialNoticeAccess
} from "./customer-presentation.js";

const DEFAULT_REMINDER_OFFSETS = [7, 1];
const CALENDAR_MIME_TYPE = "text/calendar;charset=utf-8";

function pad(value) {
  return String(value).padStart(2, "0");
}

function compactDate(value) {
  return String(value ?? "").replace(/-/g, "");
}

function compactTime(value) {
  return `${String(value ?? "").replace(":", "")}00`;
}

function addDays(date, days) {
  const [year, month, day] = String(date ?? "").split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  const next = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

function formatUtcStamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate())
  ].join("") + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function sanitizeUidPart(value) {
  return collapseWhitespace(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function shortCalendarTitle(title, lotLabel = "") {
  const base = collapseWhitespace(title || "Opportunity");
  if (!base) return "Opportunity";
  const normalizedLotLabel = collapseWhitespace(lotLabel);
  const suffix =
    normalizedLotLabel && !base.toLowerCase().includes(normalizedLotLabel.toLowerCase())
      ? ` — ${normalizedLotLabel}`
      : "";
  const combined = `${base}${suffix}`;
  return combined.length <= 96 ? combined : `${combined.slice(0, 93).trimEnd()}...`;
}

function escapeIcsText(value = "") {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldIcsLine(line) {
  if (line.length <= 75) return [line];
  const parts = [];
  let remaining = line;
  while (remaining.length > 75) {
    parts.push(remaining.slice(0, 75));
    remaining = ` ${remaining.slice(75)}`;
  }
  parts.push(remaining);
  return parts;
}

function eventStartTimestamp(deadline) {
  if (!deadline?.date) return null;
  if (!deadline.time) return Date.parse(`${deadline.date}T00:00:00Z`);
  const timeZone = deadline.timezone || SPANISH_TIME_ZONE;
  const utcIso = deadline.utcEquivalent ?? toUtcIso(deadline.date, deadline.time, timeZone);
  return utcIso ? Date.parse(utcIso) : null;
}

function reminderDays(deadline, now = new Date()) {
  const startAt = eventStartTimestamp(deadline);
  if (!Number.isFinite(startAt)) return DEFAULT_REMINDER_OFFSETS;
  return DEFAULT_REMINDER_OFFSETS.filter((days) => startAt - days * 86400000 > now.getTime());
}

function deadlineInterpretationNote(deadline) {
  if (!deadline?.date) return "";
  if (!deadline.time) return "Exact submission time has not been verified. Check the official notice.";
  if (!deadline.sourceTimezone && deadline.timezone) {
    return `Deadline time interpreted by OportuneX as ${deadline.timezone} because the official source did not state an explicit timezone. Verify the official notice.`;
  }
  return "";
}

function calendarCustomerNote(deadline) {
  const primary = "Adds the published deadline with reminders 7 days and 1 day before.";
  if (deadline?.time && !deadline.sourceTimezone && deadline.timezone) {
    return `${primary} Calendar time uses OportuneX's ${deadline.timezone} interpretation. Verify the official notice.`;
  }
  return primary;
}

function fitLabel(analysis = {}) {
  const fitBand = analysis.fitBand ?? analysis.recommendationClass ?? null;
  return fitBand ? RECOMMENDATION_COPY[fitBand] ?? fitBand : "Not stated";
}

function actionLabel(analysis = {}) {
  const code = analysis.decision?.recommendedAction?.code ?? null;
  return code ? ACTION_COPY[code] ?? code : analysis.decision?.recommendedAction?.label ?? "Not stated";
}

function primaryIssue(analysis = {}) {
  return analysis.potentialHardBlockers?.[0] ?? analysis.unknowns?.[0] ?? analysis.blockers?.[0] ?? null;
}

function mainQuestion(analysis = {}) {
  const issue = primaryIssue(analysis);
  return presentCustomerDecisionText(
    analysis.decision?.mainQuestion ?? issue?.detail ?? "No blocking question is currently recorded.",
    {
      issueTitle: issue?.title ?? "",
      verificationFallback: true
    }
  );
}

export function buildOpportunityCalendarEvent({
  company,
  opportunity,
  analysis,
  now = new Date()
}) {
  const deadline = opportunity?.deadline ?? null;
  if (!deadline?.date) {
    return {
      available: false,
      reason: "Calendar event unavailable until a reliable deadline is published."
    };
  }

  const companyName = getCompanyDisplayName(company);
  const officialAccess = resolveOfficialNoticeAccess(opportunity);
  const selectedLotLabel = getSelectedExplicitLotLabel(analysis) ?? "";
  const effectiveTitle = shortCalendarTitle(
    analysis?.displayTitle || opportunity?.title || "Opportunity deadline",
    selectedLotLabel
  );
  const title = `OportuneX deadline — ${effectiveTitle}`;
  const reference = officialAccess.referenceNumber || opportunity?.referenceNumber || "Not stated";
  const buyer = opportunity?.contractingAuthority || opportunity?.issuingOrganisation || analysis?.primaryContact?.name || "Not stated";
  const interpretationNote = deadlineInterpretationNote(deadline);
  const descriptionLines = officialAccess.isPlacsp
    ? [
        "OportuneX opportunity deadline",
        "",
        `Company: ${companyName}`,
        `Opportunity: ${collapseWhitespace(opportunity?.title || analysis?.displayTitle || "Opportunity")}`,
        `Buyer / issuer: ${collapseWhitespace(buyer)}`,
        `Official reference: ${collapseWhitespace(reference)}`,
        `Official platform: ${PLACSP_PLATFORM_LABEL}`,
        officialAccess.searchUrl ? `Search: ${officialAccess.searchUrl}` : null,
        `Recommended action: ${actionLabel(analysis)}`,
        `Fit: ${fitLabel(analysis)} · ${analysis?.matchScore ?? analysis?.priorityScore ?? 0}% match`,
        `Before proceeding: ${mainQuestion(analysis)}`,
        officialAccess.preservedDirectUrl ? `Source provenance URL: ${officialAccess.preservedDirectUrl}` : null,
        interpretationNote || null,
        "Verify the deadline, eligibility and submission requirements in the official notice before acting."
      ].filter(Boolean)
    : [
        "OportuneX opportunity deadline",
        "",
        `Company: ${companyName}`,
        `Opportunity: ${collapseWhitespace(opportunity?.title || analysis?.displayTitle || "Opportunity")}`,
        `Buyer / issuer: ${collapseWhitespace(buyer)}`,
        `Reference: ${collapseWhitespace(reference)}`,
        `Recommended action: ${actionLabel(analysis)}`,
        `Fit: ${fitLabel(analysis)} · ${analysis?.matchScore ?? analysis?.priorityScore ?? 0}% match`,
        `Before proceeding: ${mainQuestion(analysis)}`,
        officialAccess.primaryUrl ? `Official notice: ${officialAccess.primaryUrl}` : null,
        interpretationNote || null,
        "Verify the deadline, eligibility and submission requirements in the official notice before acting."
      ].filter(Boolean);

  const uid = [
    sanitizeUidPart(company?.id || companyName),
    sanitizeUidPart(opportunity?.id || analysis?.opportunityId || "opportunity"),
    sanitizeUidPart(hasSelectedExplicitLot(analysis) ? analysis?.lotId || selectedLotLabel : "root"),
    sanitizeUidPart(`${deadline.date}-${deadline.time || "all-day"}`)
  ]
    .filter(Boolean)
    .join("--") + "@oportunex.local";

  const filename = `oportunex-${toSlug(effectiveTitle).slice(0, 64) || "opportunity"}-deadline.ics`;
  const reminderOffsets = reminderDays(deadline, now);

  return {
    available: true,
    uid,
    filename,
    mimeType: CALENDAR_MIME_TYPE,
    title,
    description: descriptionLines.join("\n"),
    url: officialAccess.isPlacsp ? officialAccess.searchUrl || null : officialAccess.primaryUrl || null,
    location: collapseWhitespace(analysis?.locationLabel || opportunity?.location?.display || ""),
    interpretationNote,
    customerNote: calendarCustomerNote(deadline),
    reminders: reminderOffsets,
    startDate: deadline.date,
    allDay: !deadline.time,
    dtstamp: formatUtcStamp(now),
    timeZone: deadline.timezone || SPANISH_TIME_ZONE,
    startDateTime: deadline.time ? `${compactDate(deadline.date)}T${compactTime(deadline.time)}` : null,
    endDate: !deadline.time ? addDays(deadline.date, 1) : null
  };
}

export function serializeIcsEvent(event) {
  if (!event?.available) return "";

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OportuneX//Opportunity Deadline//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${event.dtstamp}`,
    event.allDay
      ? `DTSTART;VALUE=DATE:${compactDate(event.startDate)}`
      : `DTSTART;TZID=${event.timeZone}:${event.startDateTime}`,
    event.allDay && event.endDate ? `DTEND;VALUE=DATE:${compactDate(event.endDate)}` : null,
    `SUMMARY:${escapeIcsText(event.title)}`,
    `DESCRIPTION:${escapeIcsText(event.description)}`,
    event.location ? `LOCATION:${escapeIcsText(event.location)}` : null,
    event.url ? `URL:${event.url}` : null,
    ...event.reminders.flatMap((days) => [
      "BEGIN:VALARM",
      `TRIGGER:-P${days}D`,
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcsText(days === 1 ? "OportuneX opportunity deadline tomorrow" : `OportuneX opportunity deadline in ${days} days`)}`,
      "END:VALARM"
    ]),
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter(Boolean);

  return lines.flatMap((line) => foldIcsLine(line)).join("\r\n") + "\r\n";
}

export function downloadCalendarEvent(options) {
  const event = buildOpportunityCalendarEvent(options);
  if (!event.available) return { ok: false, reason: event.reason };

  const content = serializeIcsEvent(event);
  const blob = new Blob([content], { type: event.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = event.filename;
  anchor.click();
  URL.revokeObjectURL(url);

  return {
    ok: true,
    filename: event.filename,
    mimeType: event.mimeType,
    interpretationNote: event.interpretationNote,
    customerNote: event.customerNote,
    previewTitle: escapeHtml(event.title)
  };
}
