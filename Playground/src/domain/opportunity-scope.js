export function hasMeaningfulLocation(location) {
  return Boolean(
    location &&
      typeof location === "object" &&
      (
        location.display ||
        location.municipality ||
        location.province ||
        location.autonomousCommunity ||
        location.country ||
        location.postalCode
      )
  );
}

function normalizeLotIdentity(value, fallback = null) {
  if (value == null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

export function resolveLotOrOpportunityLocation(lot, opportunity) {
  return hasMeaningfulLocation(lot?.location) ? lot.location : opportunity?.location ?? {};
}

export function countExplicitPublishedLots(opportunity) {
  return Array.isArray(opportunity?.lots)
    ? opportunity.lots.filter((lot) => lot && !lot.synthetic).length
    : 0;
}

export function getSelectedExplicitLotId(analysis = {}) {
  const selectedLotId = normalizeLotIdentity(analysis?.selectedLotId ?? analysis?.lotId, null);
  return analysis?.hasPublishedLot && selectedLotId ? selectedLotId : null;
}

export function getSelectedExplicitLotLabel(analysis = {}) {
  const selectedLotId = getSelectedExplicitLotId(analysis);
  if (!selectedLotId) return null;
  return normalizeLotIdentity(analysis?.selectedLotLabel ?? analysis?.lotLabel, selectedLotId);
}

export function hasSelectedExplicitLot(analysis = {}) {
  return Boolean(getSelectedExplicitLotId(analysis));
}

export function getAnalysisScopeType(analysis = {}) {
  return hasSelectedExplicitLot(analysis) ? "explicit_published_lot" : "whole_opportunity";
}

export function getAnalysisScopeLabel(analysis = {}) {
  return getSelectedExplicitLotLabel(analysis) ?? "Whole opportunity";
}

export function isSelectedExplicitLot(analysis = {}, lotOrLotId = null) {
  const selectedLotId = getSelectedExplicitLotId(analysis);
  const lotId = normalizeLotIdentity(
    typeof lotOrLotId === "string"
      ? lotOrLotId
      : lotOrLotId?.lotId ?? lotOrLotId?.id,
    null
  );
  return Boolean(selectedLotId && lotId && selectedLotId === lotId);
}
