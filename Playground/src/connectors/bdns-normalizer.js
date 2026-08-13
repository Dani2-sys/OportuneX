import { currentYmd, parseSpanishDate, SPANISH_TIME_ZONE } from "../domain/deadline.js";
import { createMoney, createMoneyFromText } from "../domain/money.js";

export const BDNS_API_BASE = "https://www.infosubvenciones.es/bdnstrans/api";
export const BDNS_ALLOWED_HOSTS = new Set([
  "www.infosubvenciones.es",
  "www.infosubvenciones.gob.es",
  "www.pap.hacienda.gob.es",
  "www.subvenciones.gob.es"
]);
export const BDNS_SOURCE_TYPE = "official_snpsap_api";
export const BDNS_SOURCE_ORGANISATION = "Intervencion General de la Administracion del Estado";
export const BDNS_SOURCE_PORTAL = "Sistema Nacional de Publicidad de Subvenciones y Ayudas Publicas";
export const BDNS_DATA_ATTRIBUTION =
  "Origen de los datos: Intervencion General de la Administracion del Estado";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizeText(value, fallback = "") {
  if (value == null) return fallback;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (isPlainObject(value)) {
    const directText = value["#text"] ?? value.texto ?? value.text ?? null;
    if (directText != null) return normalizeText(directText, fallback);
  }
  return fallback;
}

function firstText(record, keys = [], fallback = "") {
  for (const key of keys) {
    const text = normalizeText(record?.[key], "");
    if (text) return text;
  }
  return fallback;
}

function compactRecord(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value == null) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (isPlainObject(value)) return Object.keys(value).length > 0;
      return value !== "";
    })
  );
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce((record, key) => {
      const nextValue = sortValue(value[key]);
      if (nextValue !== undefined) record[key] = nextValue;
      return record;
    }, {});
}

function stableSerialize(value) {
  return JSON.stringify(sortValue(value));
}

function hash64(input) {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  const mask = 18446744073709551615n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function uniqueSortedStrings(values = []) {
  return [...new Set(values.map((value) => normalizeText(value, "")).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  const text = normalizeText(value, "").toLowerCase();
  if (!text) return null;
  if (["true", "1", "si", "s", "yes", "y"].includes(text)) return true;
  if (["false", "0", "no", "n"].includes(text)) return false;
  return null;
}

function normalizeDateOnly(value) {
  const text = normalizeText(value, "");
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
    const parsed = parseSpanishDate(text);
    return parsed?.date ?? null;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function displayDate(date) {
  if (!date) return "";
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return date;
  return `${day}/${month}/${year}`;
}

function createDateOnlyDeadline(date, sourceText = "") {
  if (!date) return null;
  return {
    sourceText: sourceText || displayDate(date),
    date,
    time: null,
    timezone: SPANISH_TIME_ZONE,
    sourceTimezone: SPANISH_TIME_ZONE,
    utcEquivalent: null
  };
}

function normalizeDeadlineLike(primaryValue, descriptiveValue = "") {
  const exactDate = normalizeDateOnly(primaryValue);
  if (exactDate) return createDateOnlyDeadline(exactDate, descriptiveValue || displayDate(exactDate));

  const descriptiveText = normalizeText(descriptiveValue, "");
  if (!descriptiveText) return null;
  const parsed = parseSpanishDate(descriptiveText);
  if (!parsed?.date) return null;
  return {
    ...parsed,
    time: null,
    utcEquivalent: null
  };
}

function normalizeMoney(value, amountType) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return createMoney({
      major: value,
      currency: "EUR",
      vatStatus: "unknown",
      amountType,
      source: BDNS_SOURCE_TYPE
    });
  }

  const raw = normalizeText(value, "");
  if (!raw) return null;
  return createMoneyFromText(raw, {
    currency: "EUR",
    vatStatus: "unknown",
    amountType,
    source: BDNS_SOURCE_TYPE
  });
}

function normalizeAuthority(detail) {
  const organo = isPlainObject(detail?.organo) ? detail.organo : {};
  const levels = [
    firstText(organo, ["nivel1"]),
    firstText(organo, ["nivel2"]),
    firstText(organo, ["nivel3"])
  ].filter(Boolean);
  const issuingOrganisation = levels[levels.length - 1] ?? "";
  const contractingAuthority = levels.join(" / ") || issuingOrganisation;
  return {
    issuingOrganisation,
    contractingAuthority,
    levels
  };
}

function normalizeCollectionItem(item, { codeKeys = [], labelKeys = [] } = {}) {
  if (typeof item === "string" || typeof item === "number") {
    const text = normalizeText(item, "");
    return text
      ? {
          code: "",
          label: text
        }
      : null;
  }

  if (!isPlainObject(item)) return null;

  const code = firstText(item, codeKeys);
  const label = firstText(item, labelKeys, firstText(item, Object.keys(item)));
  if (!code && !label) return null;
  return {
    code,
    label: label || code
  };
}

function normalizeLabelledCollection(values, options) {
  return toArray(values)
    .map((item) => normalizeCollectionItem(item, options))
    .filter(Boolean)
    .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
}

function humanLabels(records = []) {
  return uniqueSortedStrings(records.map((item) => item.label || item.code));
}

function firstAnnouncementUrl(announcements = []) {
  return announcements.find((item) => item.url)?.url ?? "";
}

function defaultNoticeUrl(code) {
  return `https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/${encodeURIComponent(code)}`;
}

function normalizeAnnouncements(values) {
  return toArray(values)
    .map((item) => {
      if (!isPlainObject(item)) return null;
      const record = {
        numAnuncio: firstText(item, ["numAnuncio", "numero", "id"]),
        titulo: firstText(item, ["titulo", "descripcion", "title"]),
        tituloLeng: firstText(item, ["tituloLeng"]),
        url: firstText(item, ["url"]),
        cve: firstText(item, ["cve"]),
        desDiarioOficial: firstText(item, ["desDiarioOficial", "diarioOficial"]),
        datPublicacion: normalizeDateOnly(firstText(item, ["datPublicacion", "fechaPublicacion"]))
      };
      return compactRecord(record);
    })
    .filter(Boolean)
    .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
}

function normalizeDocuments(values) {
  return toArray(values)
    .map((item) => {
      if (!isPlainObject(item)) return null;
      const record = {
        id: firstText(item, ["id", "idDocumento"]),
        nombreFic: firstText(item, ["nombreFic", "nombre", "titulo"]),
        descripcion: firstText(item, ["descripcion", "title"]),
        long: normalizeText(item.long, ""),
        datMod: normalizeDateOnly(firstText(item, ["datMod", "fechaModificacion"])),
        datPublicacion: normalizeDateOnly(firstText(item, ["datPublicacion", "fechaPublicacion"]))
      };
      return compactRecord(record);
    })
    .filter(Boolean)
    .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
}

function normalizeBeneficiaryTypes(values) {
  return normalizeLabelledCollection(values, {
    codeKeys: ["codigo", "id", "clave"],
    labelKeys: ["descripcion", "title", "nombre", "texto"]
  });
}

function normalizeSectors(values) {
  return normalizeLabelledCollection(values, {
    codeKeys: ["codigo", "code", "id"],
    labelKeys: ["descripcion", "title", "nombre"]
  });
}

function normalizeRegions(values) {
  return normalizeLabelledCollection(values, {
    codeKeys: ["codigo", "code", "id"],
    labelKeys: ["descripcion", "title", "nombre"]
  });
}

function normalizeStringList(values) {
  return uniqueSortedStrings(
    toArray(values)
      .map((value) => {
        if (isPlainObject(value)) {
          return firstText(value, ["descripcion", "title", "nombre", "texto", "#text", "url", "codigo"]);
        }
        return value;
      })
      .filter(Boolean)
  );
}

function normalizeOfficialUrl(value) {
  const raw = normalizeText(value, "");
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^www\./i.test(raw)) return `https://${raw}`;
  return "";
}

function evidenceId(code, fieldKey, excerpt) {
  return `bdns-evidence-${hash64(`${code}:${fieldKey}:${excerpt}`)}`;
}

function buildEvidence(code, fieldKey, excerpt, sourceId, confidence = 0.99) {
  const text = normalizeText(excerpt, "");
  if (!text) return null;
  return {
    id: evidenceId(code, fieldKey, text),
    fieldKey,
    excerpt: text,
    sourceId,
    sourceType: BDNS_SOURCE_TYPE,
    confidence
  };
}

function cancellationMeta(title) {
  const normalizedTitle = normalizeText(title, "");
  if (/^\s*ANULAD[AO]\b/i.test(normalizedTitle)) {
    return {
      status: "cancelled",
      noticeType: "cancellation",
      cancellationStatus: "anulada"
    };
  }

  return {
    status: null,
    noticeType: "grant_call",
    cancellationStatus: null
  };
}

function buildBeneficiaryRequirements(code, beneficiaryLabels, evidenceIds) {
  if (!beneficiaryLabels.length) return [];
  const joined = beneficiaryLabels.join("; ");
  const hasSme = beneficiaryLabels.some((label) => /\b(pyme|pymes|sme|small and medium)\b/i.test(label));

  if (beneficiaryLabels.length === 1 && hasSme) {
    return [
      {
        id: `bdns-beneficiary-${hash64(joined)}`,
        kind: "beneficiary",
        label: "Confirmed SME status",
        requiredValue: "SME",
        mandatory: true,
        gating: "hard",
        evidenceIds,
        question: "Please confirm whether the company qualifies as an SME for this grant call."
      }
    ];
  }

  return [
    {
      id: `bdns-beneficiary-${hash64(joined)}`,
      kind: "custom",
      label: "Eligible beneficiary type requires verification",
      mandatory: true,
      gating: "hard",
      evidenceIds,
      question: `Please verify whether the company fits at least one of the official beneficiary categories: ${joined}.`,
      defaultStatus: "needs_verification"
    }
  ];
}

function buildAvailabilityWarnings({
  code,
  textFin,
  parsedDeadline,
  applicationUrl,
  mandatoryRequirementsPresent
}) {
  const warnings = [];
  const descriptiveClose = normalizeText(textFin, "");

  if (descriptiveClose && !parsedDeadline?.date) {
    warnings.push({
      id: `bdns-warning-${hash64(`${code}:textFin`)}`,
      title: "Application closing text needs interpretation",
      detail: `The official API only provides descriptive closing text: ${descriptiveClose}.`,
      severity: "medium"
    });
  }

  if (!applicationUrl) {
    warnings.push({
      id: `bdns-warning-${hash64(`${code}:application`)}`,
      title: "Application route not yet published",
      detail: "The official API record does not currently provide an electronic application URL.",
      severity: "medium"
    });
  }

  if (!mandatoryRequirementsPresent) {
    warnings.push({
      id: `bdns-warning-${hash64(`${code}:requirements`)}`,
      title: "Qualification requirements not fully structured",
      detail:
        "The official BDNS record preserves source-backed eligibility context, but not every mandatory qualification condition is available as deterministic structured data.",
      severity: "medium"
    });
  }

  return warnings;
}

function buildSourceConflicts(code, { fechaFinSolicitud, textFin }) {
  const exactDate = normalizeDateOnly(fechaFinSolicitud);
  const parsedText = normalizeDeadlineLike(null, textFin);
  if (!exactDate || !parsedText?.date || exactDate === parsedText.date) return [];

  return [
    {
      field: "deadline",
      left: `fechaFinSolicitud=${exactDate}`,
      right: `textFin=${parsedText.date}`,
      sourceIds: [`bdns-source-${hash64(code)}`]
    }
  ];
}

function currentStatusFromWindow({ title, abierto, startDate, deadline, now = new Date() }) {
  const explicitCancellation = cancellationMeta(title);
  if (explicitCancellation.status) return explicitCancellation;
  if (abierto === true) {
    return {
      status: "open",
      noticeType: "grant_call",
      cancellationStatus: null
    };
  }

  const today = currentYmd(now);
  if (deadline?.date) {
    if (deadline.date < today) {
      return {
        status: "closed",
        noticeType: "grant_call",
        cancellationStatus: null
      };
    }
    if (startDate?.date && startDate.date > today) {
      return {
        status: "upcoming",
        noticeType: "grant_call",
        cancellationStatus: null
      };
    }
    return {
      status: "open",
      noticeType: "grant_call",
      cancellationStatus: null
    };
  }

  if (startDate?.date && startDate.date > today) {
    return {
      status: "upcoming",
      noticeType: "grant_call",
      cancellationStatus: null
    };
  }

  return {
    status: "unknown",
    noticeType: "grant_call",
    cancellationStatus: null
  };
}

export function extractBdnsCode(record = {}) {
  return firstText(record, ["codigoBDNS", "numeroConvocatoria", "numConv", "codigo"]);
}

function semanticPayload(detail) {
  const code = extractBdnsCode(detail);
  const authority = normalizeAuthority(detail);
  const beneficiaries = humanLabels(normalizeBeneficiaryTypes(detail?.tiposBeneficiarios));
  const sectors = normalizeSectors(detail?.sectores).map((item) => compactRecord(item));
  const regions = normalizeRegions(detail?.regiones).map((item) => compactRecord(item));
  const documents = normalizeDocuments(detail?.documentos);
  const announcements = normalizeAnnouncements(detail?.anuncios);
  const deadline = normalizeDeadlineLike(detail?.fechaFinSolicitud, detail?.textFin);
  const startDate = normalizeDeadlineLike(detail?.fechaInicioSolicitud, detail?.textInicio);

  return compactRecord({
    codigoBDNS: code,
    authority: compactRecord({
      issuingOrganisation: authority.issuingOrganisation,
      contractingAuthority: authority.contractingAuthority,
      levels: authority.levels
    }),
    registrationDate: normalizeDateOnly(detail?.fechaRecepcion),
    applicationUrl: normalizeOfficialUrl(firstText(detail, ["sedeElectronica"])),
    callType: firstText(detail, ["tipoConvocatoria"]),
    mrr: normalizeBoolean(detail?.mrr),
    title: firstText(detail, ["descripcion"]),
    titleCoofficial: firstText(detail, ["descripcionLeng"]),
    beneficiaryTypes: beneficiaries,
    sectors,
    regions,
    purpose: firstText(detail, ["descripcionFinalidad"]),
    regulatoryBasis: compactRecord({
      description: firstText(detail, ["descripcionBasesReguladoras"]),
      url: normalizeOfficialUrl(firstText(detail, ["urlBasesReguladoras"]))
    }),
    applicationWindow: compactRecord({
      abierto: normalizeBoolean(detail?.abierto),
      startDate: startDate?.date ?? null,
      endDate: deadline?.date ?? null,
      textInicio: firstText(detail, ["textInicio"]),
      textFin: firstText(detail, ["textFin"])
    }),
    stateAid: compactRecord({
      description: firstText(detail, ["ayudaEstado"]),
      url: normalizeOfficialUrl(firstText(detail, ["urlAyudaEstado"]))
    }),
    euFunds: normalizeStringList(detail?.fondos),
    regulation: normalizeStringList(detail?.reglamento),
    objectives: normalizeStringList(detail?.objetivos),
    productSectors: normalizeStringList(detail?.sectoresProductos),
    programmeBudgetMinor: normalizeMoney(detail?.presupuestoTotal, "programme_budget")?.amountMinor ?? null,
    documents,
    announcements
  });
}

export function buildBdnsSemanticVersion(detail) {
  return `bdns-version:${hash64(stableSerialize(semanticPayload(detail)))}`;
}

export function deterministicBdnsOpportunityId(code) {
  return `bdns:${hash64(normalizeText(code, ""))}`;
}

export function normalizeBdnsOpportunity(detail, { fetchedAt = new Date().toISOString(), now = new Date() } = {}) {
  const code = extractBdnsCode(detail);
  if (!code) {
    throw new Error("BDNS detail record is missing codigoBDNS / numeroConvocatoria.");
  }

  const authority = normalizeAuthority(detail);
  const beneficiaries = normalizeBeneficiaryTypes(detail?.tiposBeneficiarios);
  const beneficiaryLabels = humanLabels(beneficiaries);
  const sectors = normalizeSectors(detail?.sectores);
  const sectorLabels = humanLabels(sectors);
  const regions = normalizeRegions(detail?.regiones);
  const regionLabels = humanLabels(regions);
  const documentsMetadata = normalizeDocuments(detail?.documentos);
  const announcementsMetadata = normalizeAnnouncements(detail?.anuncios);
  const programmeBudget = normalizeMoney(detail?.presupuestoTotal, "programme_budget");
  const applicationUrl = normalizeOfficialUrl(firstText(detail, ["sedeElectronica"]));
  const title = firstText(detail, ["descripcion"], `Convocatoria BDNS ${code}`);
  const titleCoofficial = firstText(detail, ["descripcionLeng"]);
  const purpose = firstText(detail, ["descripcionFinalidad"]);
  const regulatoryBasisDescription = firstText(detail, ["descripcionBasesReguladoras"]);
  const regulatoryBasisUrl = normalizeOfficialUrl(firstText(detail, ["urlBasesReguladoras"]));
  const stateAid = firstText(detail, ["ayudaEstado"]);
  const stateAidUrl = normalizeOfficialUrl(firstText(detail, ["urlAyudaEstado"]));
  const euFunds = normalizeStringList(detail?.fondos);
  const regulation = normalizeStringList(detail?.reglamento);
  const objectives = normalizeStringList(detail?.objetivos);
  const callType = firstText(detail, ["tipoConvocatoria"]);
  const registrationDate = normalizeDateOnly(detail?.fechaRecepcion);
  const startDate = normalizeDeadlineLike(detail?.fechaInicioSolicitud, detail?.textInicio);
  const deadline = normalizeDeadlineLike(detail?.fechaFinSolicitud, detail?.textFin);
  const abierto = normalizeBoolean(detail?.abierto);
  const statusMeta = currentStatusFromWindow({
    title,
    abierto,
    startDate,
    deadline,
    now
  });
  const sourceId = `bdns-source-${hash64(code)}`;
  const detailsUrl = `${BDNS_API_BASE}/convocatorias?numConv=${encodeURIComponent(code)}&vpd=GE`;
  const noticeUrl = firstAnnouncementUrl(announcementsMetadata) || defaultNoticeUrl(code);
  const evidence = [
    buildEvidence(code, "reference_number", code, sourceId),
    buildEvidence(code, "title", title, sourceId),
    buildEvidence(code, "authority", authority.contractingAuthority || authority.issuingOrganisation, sourceId),
    buildEvidence(code, "programme_budget", programmeBudget ? `${programmeBudget.amountMinor / 100} EUR` : "", sourceId),
    buildEvidence(
      code,
      "application_period",
      firstText(detail, ["fechaFinSolicitud"]) || firstText(detail, ["textFin"]) || firstText(detail, ["abierto"]),
      sourceId
    ),
    buildEvidence(code, "submission_route", applicationUrl, sourceId),
    buildEvidence(code, "beneficiary_types", beneficiaryLabels.join("; "), sourceId),
    buildEvidence(code, "sectors", sectorLabels.join("; "), sourceId),
    buildEvidence(code, "regions", regionLabels.join("; "), sourceId),
    buildEvidence(code, "purpose", purpose, sourceId),
    buildEvidence(code, "regulatory_basis", regulatoryBasisDescription || regulatoryBasisUrl, sourceId),
    buildEvidence(code, "state_aid", stateAid || stateAidUrl, sourceId),
    buildEvidence(
      code,
      "announcements",
      announcementsMetadata
        .map((item) => item.titulo || item.numAnuncio || item.url || "")
        .filter(Boolean)
        .join("; "),
      sourceId
    ),
    buildEvidence(
      code,
      "documents",
      documentsMetadata
        .map((item) => item.descripcion || item.nombreFic || item.id || "")
        .filter(Boolean)
        .join("; "),
      sourceId
    )
  ].filter(Boolean);
  const beneficiaryEvidenceIds = evidence
    .filter((item) => item.fieldKey === "beneficiary_types")
    .map((item) => item.id);
  const requirements = buildBeneficiaryRequirements(code, beneficiaryLabels, beneficiaryEvidenceIds);
  const sourceConflicts = buildSourceConflicts(code, {
    fechaFinSolicitud: detail?.fechaFinSolicitud,
    textFin: detail?.textFin
  });
  const availabilityWarnings = buildAvailabilityWarnings({
    code,
    textFin: detail?.textFin,
    parsedDeadline: deadline,
    applicationUrl,
    mandatoryRequirementsPresent: requirements.length > 0
  });
  const humanLocation = regionLabels.join("; ");
  const descriptionParts = [title, titleCoofficial && titleCoofficial !== title ? titleCoofficial : "", purpose]
    .filter(Boolean)
    .join("\n\n");

  return {
    id: deterministicBdnsOpportunityId(code),
    canonicalId: deterministicBdnsOpportunityId(code),
    sourceConnector: "bdns",
    sourceOpportunityId: code,
    sourceNoticeVersionId: buildBdnsSemanticVersion(detail),
    type: "grant",
    noticeType: statusMeta.noticeType,
    status: statusMeta.status,
    title,
    description: descriptionParts || title,
    issuingOrganisation: authority.issuingOrganisation,
    contractingAuthority: authority.contractingAuthority,
    publicationDate: registrationDate,
    modificationDate: null,
    startDate,
    deadline,
    location: {
      municipality: "",
      province: "",
      autonomousCommunity: regionLabels.length === 1 ? regionLabels[0] : "",
      display: humanLocation || "Impact region not stated"
    },
    cpvCodes: [],
    keywords: uniqueSortedStrings([
      callType,
      purpose,
      ...beneficiaryLabels,
      ...sectorLabels,
      ...regionLabels,
      ...objectives,
      ...euFunds,
      ...regulation
    ]),
    procedureType: callType,
    estimatedValue: null,
    awardValue: null,
    baseBudget: null,
    relevantValue: null,
    wholeProcedureValue: null,
    annualValue: null,
    multiYearValue: null,
    maximumAidPerBeneficiary: null,
    programmeBudget,
    eligibleProjectCost: null,
    aidIntensity: "",
    duration: "",
    guarantees: "",
    submissionMechanism: applicationUrl ? "Official electronic application site" : "",
    applicationUrl,
    noticeUrl,
    referenceNumber: code,
    requiredDocuments: [],
    documents: documentsMetadata.map((item) => item.descripcion || item.nombreFic || item.id).filter(Boolean),
    lastChecked: fetchedAt,
    contacts: [],
    sources: [
      {
        id: sourceId,
        organisation: BDNS_SOURCE_ORGANISATION,
        title: `${BDNS_SOURCE_PORTAL} API`,
        url: detailsUrl,
        official: true,
        publishedAt: registrationDate || "",
        lastChecked: fetchedAt,
        metadata: compactRecord({
          sourceType: BDNS_SOURCE_TYPE,
          portal: BDNS_SOURCE_PORTAL,
          attribution: BDNS_DATA_ATTRIBUTION,
          code,
          detailsUrl,
          noticeSearchUrl: defaultNoticeUrl(code),
          titleCoofficial,
          applicationWindow: compactRecord({
            abierto,
            fechaInicioSolicitud: normalizeDateOnly(detail?.fechaInicioSolicitud),
            fechaFinSolicitud: normalizeDateOnly(detail?.fechaFinSolicitud),
            textInicio: firstText(detail, ["textInicio"]),
            textFin: firstText(detail, ["textFin"])
          }),
          callType,
          mrr: normalizeBoolean(detail?.mrr),
          beneficiaryTypes: beneficiaryLabels,
          sectors: sectors.map((item) => compactRecord(item)),
          regions: regions.map((item) => compactRecord(item)),
          purpose,
          regulatoryBasis: compactRecord({
            description: regulatoryBasisDescription,
            url: regulatoryBasisUrl
          }),
          stateAid: compactRecord({
            description: stateAid,
            url: stateAidUrl
          }),
          euFunds,
          regulation,
          objectives,
          documents: documentsMetadata,
          announcements: announcementsMetadata
        })
      }
    ],
    evidence,
    availabilityWarnings,
    sourceConflicts,
    requirements,
    lots: [],
    cancellationStatus: statusMeta.cancellationStatus
  };
}

export function normalizeBdnsDataset({ details = [], fetchedAt = new Date().toISOString(), now = new Date() } = {}) {
  const records = new Map();
  toArray(details).forEach((detail) => {
    const opportunity = normalizeBdnsOpportunity(detail, { fetchedAt, now });
    const current = records.get(opportunity.id);
    if (!current || current.sourceNoticeVersionId !== opportunity.sourceNoticeVersionId) {
      records.set(opportunity.id, opportunity);
    }
  });

  return {
    opportunities: [...records.values()],
    stats: {
      uniqueEntries: records.size
    }
  };
}
