import { clamp, normalizeText, unique } from "../utils.js";
import { getCompanyCapabilities } from "./company-profile.js";

export const SERVICE_TAXONOMY = [
  {
    id: "electrical_installation",
    label: "Electrical installation",
    cpvPrefixes: ["4531", "45311", "45315300"],
    aliases: [
      "electrical installation",
      "electrical installations",
      "instalaciones electricas",
      "instalacion electrica",
      "instalacions electriques",
      "instal lacio electrica",
      "instalacion de baja tension"
    ]
  },
  {
    id: "electrical_maintenance",
    label: "Electrical maintenance",
    cpvPrefixes: ["50711000", "5000"],
    aliases: [
      "electrical maintenance",
      "mantenimiento electrico",
      "manteniment electric",
      "preventive electrical maintenance",
      "corrective electrical maintenance"
    ]
  },
  {
    id: "electrical_repair",
    label: "Electrical repair",
    cpvPrefixes: ["50711000"],
    aliases: [
      "electrical repair",
      "electrical repairs",
      "reparacion electrica",
      "reparaciones electricas",
      "reparacio electrica",
      "avarias electricas"
    ]
  },
  {
    id: "low_voltage",
    label: "Low voltage",
    cpvPrefixes: ["45315300"],
    aliases: [
      "low voltage",
      "low-voltage",
      "baja tension",
      "baixa tensio",
      "instalaciones de baja tension",
      "instalacions de baixa tensio"
    ]
  },
  {
    id: "industrial_electrical",
    label: "Industrial electrical work",
    cpvPrefixes: ["45315", "5111"],
    aliases: [
      "industrial electrical",
      "industrial electrical work",
      "electrical systems",
      "cuadros electricos",
      "instalaciones industriales",
      "quadres electrics"
    ]
  },
  {
    id: "hvac",
    label: "HVAC and climate systems",
    cpvPrefixes: ["4251", "45331", "5073"],
    aliases: [
      "hvac",
      "climatizacion",
      "climate systems",
      "instalaciones termicas",
      "sistemas de climatitzacio",
      "aire acondicionado"
    ]
  },
  {
    id: "solar_pv",
    label: "Solar PV",
    cpvPrefixes: ["0933", "45261", "45315"],
    aliases: ["solar", "pv", "fotovoltaica", "fotovoltaic", "panels solares"]
  },
  {
    id: "plumbing",
    label: "Plumbing",
    cpvPrefixes: ["4533", "45332"],
    aliases: ["fontaneria", "plumbing", "instalaciones hidraulicas", "lampisteria"]
  },
  {
    id: "maintenance",
    label: "Building and industrial maintenance",
    cpvPrefixes: ["5000", "5071", "5080"],
    aliases: ["maintenance", "mantenimiento", "facility maintenance", "industrial maintenance", "manteniment"]
  },
  {
    id: "energy_efficiency",
    label: "Energy efficiency projects",
    cpvPrefixes: ["7131", "0933"],
    aliases: ["energy efficiency", "eficiencia energetica", "efficiency retrofit", "estalvi energetic"]
  }
];

function normalizeCodes(values = []) {
  return values
    .map((value) => value?.toString?.().replace(/\D/g, "") ?? "")
    .filter(Boolean);
}

function cpvMatches(codes = [], prefixes = []) {
  return codes.some((code) =>
    prefixes.some((prefix) => code.startsWith(prefix) || prefix.startsWith(code))
  );
}

function matchesAlias(text, alias) {
  const normalizedAlias = normalizeText(alias);
  return normalizedAlias && text.includes(normalizedAlias);
}

function taxonomyHitsFromTextAndCpv(text, cpvCodes = []) {
  const normalizedCodes = normalizeCodes(cpvCodes);
  return SERVICE_TAXONOMY.filter(
    (entry) =>
      entry.aliases.some((alias) => matchesAlias(text, alias)) ||
      cpvMatches(normalizedCodes, entry.cpvPrefixes)
  );
}

function canonicalCapabilityIds(capability) {
  const combinedText = normalizeText(
    [capability.id, capability.label, ...(capability.aliases ?? [])].join(" ")
  );
  const taxonomyHits = taxonomyHitsFromTextAndCpv(combinedText, capability.cpvPrefixes ?? []);
  return unique(taxonomyHits.map((entry) => entry.id));
}

function canonicalSubjectIds(subject) {
  const combinedText = normalizeText(
    [subject.title, subject.description, ...(subject.keywords ?? []), ...(subject.sectorTerms ?? [])].join(" ")
  );
  const taxonomyHits = taxonomyHitsFromTextAndCpv(combinedText, subject.cpvCodes ?? []);
  return unique(taxonomyHits.map((entry) => entry.id));
}

function capabilityTextHits(companyCapabilities, subjectText) {
  return companyCapabilities.flatMap((capability) => {
    const normalizedTerms = [capability.label, ...(capability.aliases ?? [])].map(normalizeText).filter(Boolean);
    const matches = normalizedTerms.filter((term) => subjectText.includes(term));
    return matches.length ? [{ capability, matches }] : [];
  });
}

function capabilityCpvHits(companyCapabilities, subjectCpvCodes = []) {
  const normalizedCodes = normalizeCodes(subjectCpvCodes);
  return companyCapabilities.flatMap((capability) => {
    const capabilityPrefixes = normalizeCodes(capability.cpvPrefixes ?? []);
    const matches = normalizedCodes.filter((code) => cpvMatches([code], capabilityPrefixes));
    return matches.length ? [{ capability, matches }] : [];
  });
}

export function scoreCapabilityFit(company, subject) {
  const capabilities = getCompanyCapabilities(company);
  const subjectText = normalizeText(
    [subject.title, subject.description, ...(subject.keywords ?? []), ...(subject.sectorTerms ?? [])].join(" ")
  );
  const subjectCanonicalIds = new Set(canonicalSubjectIds(subject));
  const directTextHits = capabilityTextHits(capabilities, subjectText);
  const directCpvHits = capabilityCpvHits(capabilities, subject.cpvCodes ?? []);

  const matchedCapabilities = capabilities.filter((capability) => {
    const capabilityCanonicalIdsSet = canonicalCapabilityIds(capability);
    if (capabilityCanonicalIdsSet.some((id) => subjectCanonicalIds.has(id))) return true;
    if (directTextHits.some((hit) => hit.capability.id === capability.id)) return true;
    return directCpvHits.some((hit) => hit.capability.id === capability.id);
  });

  let score = 0;
  matchedCapabilities.forEach((capability) => {
    const levelMultiplier = capability.level === "high" ? 1 : capability.level === "medium" ? 0.7 : 0.45;
    const statusMultiplier =
      capability.status === "company_confirmed"
        ? 1
        : capability.status === "public_verified"
          ? 0.96
          : capability.status === "public_reported"
            ? 0.84
            : capability.status === "inferred"
              ? 0.68
              : capability.status === "conflicted"
                ? 0.5
                : 0.25;
    const cpvBoost = directCpvHits.some((hit) => hit.capability.id === capability.id) ? 28 : 0;
    const textBoost = directTextHits.some((hit) => hit.capability.id === capability.id) ? 18 : 0;
    const taxonomyBoost = canonicalCapabilityIds(capability).some((id) => subjectCanonicalIds.has(id)) ? 24 : 0;
    score += (cpvBoost + textBoost + taxonomyBoost + 8) * levelMultiplier * statusMultiplier;
  });

  return {
    score: clamp(score, 0, 100),
    matchedCapabilities,
    matchedTerms: unique([
      ...directTextHits.flatMap((hit) => hit.matches),
      ...directCpvHits.flatMap((hit) => hit.matches),
      ...[...subjectCanonicalIds]
        .map((id) => SERVICE_TAXONOMY.find((entry) => entry.id === id)?.label)
        .filter(Boolean)
    ])
  };
}
