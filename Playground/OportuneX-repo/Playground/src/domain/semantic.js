import { clamp, normalizeText, unique } from "../utils.js";
import { getCompanyCapabilities } from "./company-profile.js";

export const SERVICE_TAXONOMY = [
  {
    id: "electrical-installation",
    label: "Electrical installation",
    cpvPrefixes: ["4531", "45311", "45315"],
    aliases: ["instalaciones electricas", "electrical installation", "electricidad", "instal·lacions electriques"]
  },
  {
    id: "industrial-electrical",
    label: "Industrial electrical work",
    cpvPrefixes: ["45315", "5111"],
    aliases: ["industrial electrical", "electrical systems", "cuadros electricos", "instalaciones industriales"]
  },
  {
    id: "hvac",
    label: "HVAC and climate systems",
    cpvPrefixes: ["4251", "45331", "5073"],
    aliases: ["hvac", "climatizacion", "climate systems", "instalaciones termicas", "sistemas de climatitzacio", "aire acondicionado"]
  },
  {
    id: "solar-pv",
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
    id: "energy-efficiency",
    label: "Energy efficiency projects",
    cpvPrefixes: ["7131", "0933"],
    aliases: ["energy efficiency", "eficiencia energetica", "efficiency retrofit", "estalvi energetic"]
  }
];

function cpvMatches(capabilities, cpvCodes = []) {
  const normalizedCodes = cpvCodes.map((code) => code.replace(/\D/g, ""));
  return capabilities.flatMap((capability) => {
    const matches = normalizedCodes.filter((code) =>
      capability.cpvPrefixes.some((prefix) => code.startsWith(prefix))
    );
    return matches.length ? [{ capability, matches }] : [];
  });
}

function textHits(capabilities, text) {
  return capabilities.flatMap((capability) => {
    const matches = capability.aliases.filter((alias) => text.includes(normalizeText(alias)));
    return matches.length ? [{ capability, matches }] : [];
  });
}

export function scoreCapabilityFit(company, subject) {
  const capabilities = getCompanyCapabilities(company);
  const text = normalizeText(
    [subject.title, subject.description, ...(subject.keywords ?? []), ...(subject.sectorTerms ?? [])].join(" ")
  );
  const cpvHits = cpvMatches(capabilities, subject.cpvCodes ?? []);
  const keywordHits = textHits(capabilities, text);
  const matchedIds = unique([
    ...cpvHits.map(({ capability }) => capability.id),
    ...keywordHits.map(({ capability }) => capability.id)
  ]);

  let score = 0;
  const matchedCapabilities = matchedIds.map((id) => capabilities.find((capability) => capability.id === id));
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
    const cpvBoost = cpvHits.some((hit) => hit.capability.id === capability.id) ? 28 : 0;
    const textBoost = keywordHits.some((hit) => hit.capability.id === capability.id) ? 18 : 0;
    score += (cpvBoost + textBoost + 10) * levelMultiplier * statusMultiplier;
  });

  if (!matchedCapabilities.length && text.includes("instalaciones")) score += 12;
  if (!matchedCapabilities.length && text.includes("subvencion")) score += 8;

  return {
    score: clamp(score, 0, 100),
    matchedCapabilities,
    matchedTerms: unique([
      ...keywordHits.flatMap((hit) => hit.matches),
      ...cpvHits.flatMap((hit) => hit.matches)
    ])
  };
}
