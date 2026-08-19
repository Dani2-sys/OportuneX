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

export function resolveLotOrOpportunityLocation(lot, opportunity) {
  return hasMeaningfulLocation(lot?.location) ? lot.location : opportunity?.location ?? {};
}

export function countExplicitPublishedLots(opportunity) {
  return Array.isArray(opportunity?.lots)
    ? opportunity.lots.filter((lot) => lot && !lot.synthetic).length
    : 0;
}
