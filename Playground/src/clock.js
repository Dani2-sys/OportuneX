export const APPLICATION_TIME_ZONE = "Europe/Madrid";
export const EVALUATION_NOW_ISO = "2026-08-07T10:00:00+02:00";

export function getApplicationNow() {
  return new Date();
}

export function getEvaluationNow() {
  return new Date(EVALUATION_NOW_ISO);
}

export function formatApplicationDate(now = getApplicationNow(), locale = "en-GB") {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: APPLICATION_TIME_ZONE
  }).format(now);
}
