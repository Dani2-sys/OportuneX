import { SPANISH_TIME_ZONE, toUtcIso } from "../domain/deadline.js";
import { createMoneyFromText } from "../domain/money.js";

export const PLACSP_FEED_URL =
  "https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom";

export const PLACSP_ALLOWED_HOSTS = new Set([
  "contrataciondelsectorpublico.gob.es",
  "contrataciondelestado.es"
]);

const STATUS_MAP = {
  PRE: {
    status: "upcoming",
    noticeType: "prior_information",
    label: "Anuncio Previo"
  },
  PUB: {
    status: "open",
    noticeType: "active_contract_notice",
    label: "EN PLAZO"
  },
  EV: {
    status: "closed",
    noticeType: "active_contract_notice",
    label: "Pendiente de adjudicacion"
  },
  ADJ: {
    status: "awarded",
    noticeType: "award_notice",
    label: "Adjudicada"
  },
  RES: {
    status: "awarded",
    noticeType: "award_notice",
    label: "Resuelta"
  },
  ANUL: {
    status: "cancelled",
    noticeType: "cancellation",
    label: "Anulada"
  }
};

const TOMBSTONE_REASON_MAP = {
  ANULADA: {
    status: "cancelled",
    noticeType: "cancellation",
    cancellationStatus: "anulada"
  },
  CERRADA: {
    status: "closed",
    noticeType: "active_contract_notice",
    cancellationStatus: "cerrada"
  },
  ARCHIVADA: {
    status: "closed",
    noticeType: "active_contract_notice",
    cancellationStatus: "archivada"
  }
};

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (isPlainObject(value) && value["#text"] != null) {
    return String(value["#text"]).trim();
  }
  return "";
}

function attributeOf(value, name) {
  if (!isPlainObject(value)) return null;
  const attribute = value[name];
  return attribute == null ? null : String(attribute).trim();
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value?.toString?.().trim?.() ?? "").filter(Boolean))];
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item == null) return false;
      if (Array.isArray(item)) return item.length > 0;
      if (isPlainObject(item)) return Object.keys(item).length > 0;
      return item !== "";
    })
  );
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce((record, key) => {
      record[key] = sortValue(value[key]);
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

function isoDateToDisplay(date) {
  if (!date) return "";
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return date;
  return `${day}/${month}/${year}`;
}

function normalizeTime(value) {
  const raw = textOf(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function flattenText(value, fragments = []) {
  if (value == null) return fragments;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    if (text) fragments.push(text);
    return fragments;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => flattenText(item, fragments));
    return fragments;
  }
  if (!isPlainObject(value)) return fragments;

  if (value["#text"] != null) flattenText(value["#text"], fragments);
  Object.entries(value).forEach(([key, child]) => {
    if (key === "#text") return;
    if (/^(href|schemeName|unitCode|currencyID)$/i.test(key)) return;
    flattenText(child, fragments);
  });
  return fragments;
}

function sanitizeRequirementLabel(label) {
  return label.replace(/\s+/g, " ").trim().slice(0, 180);
}

function normalizeRequirementText(label, value, { idPrefix, sourceId, sourcePath, gating = "hard" }) {
  const fragments = flattenText(value);
  if (!fragments.length) return null;
  const text = sanitizeRequirementLabel([label, ...fragments].filter(Boolean).join(": "));
  if (!text) return null;
  const evidenceId = `placsp-evidence-${hash64(`${sourceId}:${sourcePath}:${text}`)}`;
  return {
    requirement: {
      id: `${idPrefix}-${hash64(`${sourcePath}:${text}`)}`,
      kind: "custom",
      label: text,
      mandatory: true,
      gating,
      question: `Please verify whether the company satisfies the published requirement: ${text}.`,
      evidenceIds: [evidenceId],
      defaultStatus: "needs_verification"
    },
    evidence: {
      id: evidenceId,
      fieldKey: "requirements",
      excerpt: text,
      sourceId,
      sourceType: "official_open_data_atom",
      confidence: 0.96,
      sourcePath,
      normalizedValue: text
    }
  };
}

function parseMoneyNode(value, amountType, vatStatus, label = "") {
  const raw = textOf(value);
  if (!raw) return null;
  return createMoneyFromText(raw, {
    currency: attributeOf(value, "currencyID") ?? "EUR",
    vatStatus,
    amountType,
    source: "placsp_atom",
    label
  });
}

function extractBudgetAmounts(budgetAmount, prefix = "cac:BudgetAmount") {
  if (!isPlainObject(budgetAmount)) {
    return {
      estimatedValue: null,
      baseBudget: null,
      totalAmountIncludingVat: null
    };
  }

  return {
    estimatedValue: parseMoneyNode(
      budgetAmount["cbc:EstimatedOverallContractAmount"],
      "estimated_value",
      "excluding",
      "Estimated contract value"
    ),
    baseBudget: parseMoneyNode(
      budgetAmount["cbc:TaxExclusiveAmount"],
      "base_budget",
      "excluding",
      "Base / tender budget"
    ),
    totalAmountIncludingVat: parseMoneyNode(
      budgetAmount["cbc:TotalAmount"],
      "base_budget",
      "including",
      "Base / tender budget incl. VAT"
    ),
    evidencePaths: {
      estimatedValue: `${prefix}/cbc:EstimatedOverallContractAmount`,
      baseBudget: `${prefix}/cbc:TaxExclusiveAmount`,
      totalAmountIncludingVat: `${prefix}/cbc:TotalAmount`
    }
  };
}

function extractCpvCodes(project) {
  return uniqueStrings(
    toArray(project?.["cac:RequiredCommodityClassification"])
      .map((item) => textOf(item?.["cbc:ItemClassificationCode"]))
  );
}

function extractLocation(project) {
  const realizedLocation = project?.["cac:RealizedLocation"] ?? {};
  const address = realizedLocation?.["cac:Address"] ?? {};
  const municipality = textOf(address?.["cbc:CityName"]) || textOf(realizedLocation?.["cbc:CityName"]);
  const autonomousCommunity = textOf(realizedLocation?.["cbc:CountrySubentity"]);
  const nuts = textOf(realizedLocation?.["cbc:CountrySubentityCode"]);
  const display = [municipality, autonomousCommunity || nuts].filter(Boolean).join(", ");
  return compact({
    municipality,
    province: "",
    autonomousCommunity,
    display
  });
}

function extractDuration(project) {
  const plannedPeriod = project?.["cac:PlannedPeriod"] ?? {};
  const duration = plannedPeriod?.["cbc:DurationMeasure"];
  const rawValue = textOf(duration);
  const unitCode = attributeOf(duration, "unitCode");
  if (!rawValue) return "";
  return unitCode ? `${rawValue} ${unitCode}` : rawValue;
}

function extractDocuments(contractFolderStatus) {
  const documentRefs = [
    ...toArray(contractFolderStatus?.["cac:LegalDocumentReference"]),
    ...toArray(contractFolderStatus?.["cac:TechnicalDocumentReference"]),
    ...toArray(contractFolderStatus?.["cac:AdditionalDocumentReference"])
  ];

  const documents = documentRefs
    .map((reference) => {
      const uri =
        textOf(reference?.["cac:Attachment"]?.["cbc:URI"]) ||
        textOf(reference?.["cbc:URI"]);
      const label =
        textOf(reference?.["cbc:DocumentType"]) ||
        textOf(reference?.["cbc:ID"]) ||
        textOf(reference?.["cbc:DocumentDescription"]) ||
        uri;
      return {
        uri,
        label
      };
    })
    .filter((item) => item.uri || item.label);

  return {
    requiredDocuments: uniqueStrings(documents.map((item) => item.label)),
    documents: uniqueStrings(documents.map((item) => item.uri).filter(Boolean))
  };
}

function extractPartyIdentifiers(party) {
  return toArray(party?.["cac:PartyIdentification"]).reduce((record, identifier) => {
    const schemeName = attributeOf(identifier?.["cbc:ID"], "schemeName") ?? "UNKNOWN";
    const value = textOf(identifier?.["cbc:ID"]);
    if (schemeName && value) record[schemeName] = value;
    return record;
  }, {});
}

function extractContact(party, role) {
  if (!isPlainObject(party)) return null;
  const contact = party?.["cac:Contact"] ?? {};
  const name = textOf(contact?.["cbc:Name"]) || textOf(party?.["cac:PartyName"]?.["cbc:Name"]);
  const email = textOf(contact?.["cbc:ElectronicMail"]);
  const phone = textOf(contact?.["cbc:Telephone"]);
  if (!name && !email && !phone) return null;
  return compact({
    role,
    name,
    email,
    phone
  });
}

function extractAuthority(contractFolderStatus) {
  const locatedParty = contractFolderStatus?.["cac-place-ext:LocatedContractingParty"] ?? {};
  const party = locatedParty?.["cac:Party"] ?? {};
  const identifiers = extractPartyIdentifiers(party);
  return {
    name: textOf(party?.["cac:PartyName"]?.["cbc:Name"]),
    buyerProfileUrl: textOf(locatedParty?.["cbc:BuyerProfileURIID"]),
    websiteUrl: textOf(party?.["cbc:WebsiteURI"]),
    identifiers,
    authorityContact: extractContact(party, "authority")
  };
}

function extractSubmissionContact(contractFolderStatus) {
  const party = contractFolderStatus?.["cac:TenderRecipientParty"] ?? {};
  return extractContact(party, "submission");
}

function extractSubmissionDeadline(contractFolderStatus) {
  const period = contractFolderStatus?.["cac:TenderingProcess"]?.["cac:TenderSubmissionDeadlinePeriod"] ?? {};
  const date = textOf(period?.["cbc:EndDate"]);
  const time = normalizeTime(period?.["cbc:EndTime"]);
  const description = textOf(period?.["cbc:Description"]);

  if (!date && !description) return null;

  return {
    sourceText:
      description ||
      (time ? `${isoDateToDisplay(date)} ${time}` : isoDateToDisplay(date)),
    date: date || null,
    time,
    timezone: SPANISH_TIME_ZONE,
    sourceTimezone: SPANISH_TIME_ZONE,
    utcEquivalent: date && time ? toUtcIso(date, time, SPANISH_TIME_ZONE) : null,
    description: description || null
  };
}

function extractRequirementBlocks(container, sourceId, idPrefix, basePath) {
  const request = container?.["cac:TenderingTerms"]?.["cac:TendererQualificationRequest"] ?? {};
  const blocks = [
    normalizeRequirementText(
      "Qualification requirement",
      request?.["cbc:Description"],
      {
        idPrefix,
        sourceId,
        sourcePath: `${basePath}/cac:TenderingTerms/cac:TendererQualificationRequest/cbc:Description`,
        gating: "hard"
      }
    ),
    normalizeRequirementText(
      "Technical qualification",
      request?.["cac:TechnicalEvaluationCriteria"],
      {
        idPrefix,
        sourceId,
        sourcePath: `${basePath}/cac:TenderingTerms/cac:TendererQualificationRequest/cac:TechnicalEvaluationCriteria`,
        gating: "soft"
      }
    ),
    normalizeRequirementText(
      "Financial qualification",
      request?.["cac:FinancialEvaluationCriteria"],
      {
        idPrefix,
        sourceId,
        sourcePath: `${basePath}/cac:TenderingTerms/cac:TendererQualificationRequest/cac:FinancialEvaluationCriteria`,
        gating: "soft"
      }
    ),
    ...toArray(request?.["cac:SpecificTendererRequirement"]).map((item, index) =>
      normalizeRequirementText(
        "Specific tenderer requirement",
        item,
        {
          idPrefix,
          sourceId,
          sourcePath: `${basePath}/cac:TenderingTerms/cac:TendererQualificationRequest/cac:SpecificTendererRequirement[${index + 1}]`,
          gating: "hard"
        }
      )
    )
  ].filter(Boolean);

  return {
    requirements: blocks.map((block) => block.requirement),
    evidence: blocks.map((block) => block.evidence)
  };
}

function extractGuarantees(contractFolderStatus) {
  return sanitizeRequirementLabel(
    flattenText(contractFolderStatus?.["cac:TenderingTerms"]?.["cac:RequiredFinancialGuarantee"]).join(" ")
  );
}

function extractStatus(contractFolderStatus) {
  const rawCode = textOf(contractFolderStatus?.["cbc-place-ext:ContractFolderStatusCode"]);
  const mapped = STATUS_MAP[rawCode] ?? {
    status: "unknown",
    noticeType: "active_contract_notice",
    label: rawCode || "Unknown"
  };
  return {
    rawCode,
    ...mapped
  };
}

function latestMap(items, keySelector, timestampSelector) {
  const resolved = new Map();
  items.forEach((item) => {
    const key = keySelector(item);
    if (!key) return;
    const current = resolved.get(key);
    if (!current) {
      resolved.set(key, item);
      return;
    }

    const currentTs = Date.parse(timestampSelector(current) ?? "");
    const nextTs = Date.parse(timestampSelector(item) ?? "");

    if (Number.isFinite(nextTs) && (!Number.isFinite(currentTs) || nextTs > currentTs)) {
      resolved.set(key, item);
      return;
    }
    if (Number.isFinite(nextTs) && Number.isFinite(currentTs) && nextTs < currentTs) {
      return;
    }

    const currentSerialized = stableSerialize(current);
    const nextSerialized = stableSerialize(item);
    if (nextSerialized.localeCompare(currentSerialized) > 0) {
      resolved.set(key, item);
    }
  });
  return resolved;
}

function sourceIdFor(atomId) {
  return `placsp-source-${hash64(atomId)}`;
}

function evidenceRecord({ fieldKey, excerpt, sourceId, sourcePath, normalizedValue, confidence = 0.99 }) {
  return compact({
    id: `placsp-evidence-${hash64(`${sourceId}:${fieldKey}:${sourcePath}:${excerpt}`)}`,
    fieldKey,
    excerpt,
    sourceId,
    sourceType: "official_open_data_atom",
    confidence,
    sourcePath,
    normalizedValue
  });
}

function buildVersionPayload(payload) {
  return `placsp-version:${hash64(stableSerialize(payload))}`;
}

function deterministicPlacspOpportunityId(atomId) {
  return `placsp:${hash64(atomId)}`;
}

function applyTombstone(opportunity, tombstone, fetchedAt, feed) {
  const rawReason = (tombstone.commentType || "").toUpperCase();
  const mapped = TOMBSTONE_REASON_MAP[rawReason] ?? {
    status: "closed",
    noticeType: opportunity.noticeType ?? "active_contract_notice",
    cancellationStatus: rawReason ? rawReason.toLowerCase() : "tombstoned"
  };

  const source = opportunity.sources?.[0] ?? {
    id: sourceIdFor(opportunity.sourceOpportunityId),
    organisation: "Plataforma de Contratacion del Sector Publico",
    title: "Official PLACSP ATOM feed",
    url: feed?.selfUrl ?? feed?.sourceUrl ?? PLACSP_FEED_URL,
    official: true,
    publishedAt: opportunity.modificationDate ?? null,
    lastChecked: fetchedAt
  };

  const tombstoneEvidence = evidenceRecord({
    fieldKey: "status",
    excerpt: rawReason || "Tombstoned in official feed",
    sourceId: source.id,
    sourcePath: "at:deleted-entry",
    normalizedValue: mapped.status,
    confidence: 0.99
  });

  const versionPayload = {
    atomId: opportunity.sourceOpportunityId,
    tombstoneWhen: tombstone.when ?? null,
    tombstoneReason: rawReason,
    status: mapped.status,
    priorVersion: opportunity.sourceNoticeVersionId
  };

  return {
    ...opportunity,
    status: mapped.status,
    noticeType: mapped.noticeType,
    cancellationStatus: mapped.cancellationStatus,
    sourceNoticeVersionId: buildVersionPayload(versionPayload),
    lastChecked: fetchedAt,
    sources: [
      {
        ...source,
        lastChecked: fetchedAt,
        metadata: compact({
          ...(source.metadata ?? {}),
          tombstoneReason: rawReason || null,
          tombstoneWhen: tombstone.when ?? null
        })
      }
    ],
    evidence: [...(opportunity.evidence ?? []), tombstoneEvidence]
  };
}

function normalizeLot(lot, opportunityTitle, sourceId, index) {
  const project = lot?.["cac:ProcurementProject"] ?? {};
  const budgetAmounts = extractBudgetAmounts(project?.["cac:BudgetAmount"], `cac:ProcurementProjectLot[${index + 1}]/cac:ProcurementProject/cac:BudgetAmount`);
  const requirementBlocks = extractRequirementBlocks(
    lot,
    sourceId,
    `placsp-lot-requirement-${index + 1}`,
    `cac:ProcurementProjectLot[${index + 1}]`
  );

  const lotValue =
    budgetAmounts.baseBudget ??
    budgetAmounts.estimatedValue ??
    budgetAmounts.totalAmountIncludingVat ??
    null;

  return {
    lot: compact({
      id: textOf(lot?.["cbc:ID"]) || `placsp-lot-${index + 1}`,
      title: textOf(project?.["cbc:Name"]) || opportunityTitle,
      description: textOf(project?.["cbc:Name"]) || opportunityTitle,
      cpvCodes: extractCpvCodes(project),
      keywords: [],
      value: lotValue,
      location: extractLocation(project),
      requirements: requirementBlocks.requirements,
      documents: [],
      contacts: []
    }),
    evidence: [
      ...requirementBlocks.evidence,
      ...(budgetAmounts.totalAmountIncludingVat
        ? [
            evidenceRecord({
              fieldKey: "lots",
              excerpt: `${textOf(lot?.["cbc:ID"]) || `Lot ${index + 1}`} incl. VAT amount ${budgetAmounts.totalAmountIncludingVat.original}`,
              sourceId,
              sourcePath: budgetAmounts.evidencePaths.totalAmountIncludingVat,
              normalizedValue: budgetAmounts.totalAmountIncludingVat.amountMinor,
              confidence: 0.99
            })
          ]
        : [])
    ]
  };
}

export function normalizePlacspEntry(entry, { fetchedAt, feed }) {
  const contractFolderStatus = entry.contractFolderStatus;
  const atomId = entry.atomId;
  const sourceId = sourceIdFor(atomId);
  const status = extractStatus(contractFolderStatus);
  const project = contractFolderStatus?.["cac:ProcurementProject"] ?? {};
  const budgetAmounts = extractBudgetAmounts(project?.["cac:BudgetAmount"]);
  const authority = extractAuthority(contractFolderStatus);
  const documents = extractDocuments(contractFolderStatus);
  const deadline = extractSubmissionDeadline(contractFolderStatus);
  const submissionMethodCode = textOf(contractFolderStatus?.["cac:TenderingProcess"]?.["cbc:SubmissionMethodCode"]);
  const procedureCode = textOf(contractFolderStatus?.["cac:TenderingProcess"]?.["cbc:ProcedureCode"]);
  const contractTypeCode = textOf(project?.["cbc:TypeCode"]);
  const contractSubTypeCode = textOf(project?.["cbc:SubTypeCode"]);
  const referenceNumber = textOf(contractFolderStatus?.["cbc:ContractFolderID"]) || atomId;
  const opportunityTitle = textOf(project?.["cbc:Name"]) || entry.title || referenceNumber;
  const description = entry.summary || opportunityTitle;
  const modificationDate = entry.updated ? entry.updated.slice(0, 10) : null;
  const requirementBlocks = extractRequirementBlocks(
    contractFolderStatus,
    sourceId,
    "placsp-requirement",
    "cac-place-ext:ContractFolderStatus"
  );
  const lotRecords = toArray(contractFolderStatus?.["cac:ProcurementProjectLot"]).map((lot, index) =>
    normalizeLot(lot, opportunityTitle, sourceId, index)
  );

  const lots = lotRecords.map((item) => item.lot);
  const source = compact({
    id: sourceId,
    organisation: "Plataforma de Contratacion del Sector Publico",
    title: "Official PLACSP ATOM feed",
    url: feed?.selfUrl ?? feed?.sourceUrl ?? PLACSP_FEED_URL,
    official: true,
    publishedAt: modificationDate,
    lastChecked: fetchedAt,
    metadata: compact({
      publisher: "Ministerio de Hacienda / Direccion General del Patrimonio del Estado",
      sourceType: "official_open_data_atom",
      atomId,
      atomUpdated: entry.updated ?? null,
      entryLinkUrl: entry.linkUrl || null,
      feedId: feed?.id ?? null,
      feedUpdated: feed?.updated ?? null,
      feedUrl: feed?.selfUrl ?? feed?.sourceUrl ?? PLACSP_FEED_URL,
      statusCode: status.rawCode || null,
      statusLabel: status.label,
      procedureCode: procedureCode || null,
      contractTypeCode: contractTypeCode || null,
      contractSubTypeCode: contractSubTypeCode || null,
      authorityIds: authority.identifiers
    })
  });

  const evidence = [
    evidenceRecord({
      fieldKey: "status",
      excerpt: status.label,
      sourceId,
      sourcePath: "cac-place-ext:ContractFolderStatus/cbc-place-ext:ContractFolderStatusCode",
      normalizedValue: status.status
    }),
    evidenceRecord({
      fieldKey: "reference_number",
      excerpt: referenceNumber,
      sourceId,
      sourcePath: "cac-place-ext:ContractFolderStatus/cbc:ContractFolderID",
      normalizedValue: referenceNumber
    }),
    evidenceRecord({
      fieldKey: "title",
      excerpt: opportunityTitle,
      sourceId,
      sourcePath: "cac-place-ext:ContractFolderStatus/cac:ProcurementProject/cbc:Name",
      normalizedValue: opportunityTitle
    }),
    authority.name
      ? evidenceRecord({
          fieldKey: "authority",
          excerpt: authority.name,
          sourceId,
          sourcePath: "cac-place-ext:ContractFolderStatus/cac-place-ext:LocatedContractingParty/cac:Party/cac:PartyName/cbc:Name",
          normalizedValue: authority.name
        })
      : null,
    deadline
      ? evidenceRecord({
          fieldKey: "deadline",
          excerpt: deadline.sourceText,
          sourceId,
          sourcePath: "cac-place-ext:ContractFolderStatus/cac:TenderingProcess/cac:TenderSubmissionDeadlinePeriod",
          normalizedValue: compact({
            date: deadline.date,
            time: deadline.time,
            description: deadline.description
          })
        })
      : null,
    budgetAmounts.estimatedValue
      ? evidenceRecord({
          fieldKey: "estimated_value",
          excerpt: budgetAmounts.estimatedValue.original,
          sourceId,
          sourcePath: budgetAmounts.evidencePaths.estimatedValue,
          normalizedValue: budgetAmounts.estimatedValue.amountMinor
        })
      : null,
    budgetAmounts.baseBudget
      ? evidenceRecord({
          fieldKey: "base_budget",
          excerpt: budgetAmounts.baseBudget.original,
          sourceId,
          sourcePath: budgetAmounts.evidencePaths.baseBudget,
          normalizedValue: budgetAmounts.baseBudget.amountMinor
        })
      : null,
    budgetAmounts.totalAmountIncludingVat
      ? evidenceRecord({
          fieldKey: "base_budget_including_vat",
          excerpt: budgetAmounts.totalAmountIncludingVat.original,
          sourceId,
          sourcePath: budgetAmounts.evidencePaths.totalAmountIncludingVat,
          normalizedValue: budgetAmounts.totalAmountIncludingVat.amountMinor
        })
      : null,
    extractCpvCodes(project).length
      ? evidenceRecord({
          fieldKey: "cpv",
          excerpt: extractCpvCodes(project).join(", "),
          sourceId,
          sourcePath: "cac-place-ext:ContractFolderStatus/cac:ProcurementProject/cac:RequiredCommodityClassification",
          normalizedValue: extractCpvCodes(project)
        })
      : null,
    documents.documents.length
      ? evidenceRecord({
          fieldKey: "documents",
          excerpt: documents.documents[0],
          sourceId,
          sourcePath: "cac-place-ext:ContractFolderStatus/*DocumentReference",
          normalizedValue: documents.documents
        })
      : null,
    ...requirementBlocks.evidence,
    ...lotRecords.flatMap((item) => item.evidence)
  ].filter(Boolean);

  const contacts = [authority.authorityContact, extractSubmissionContact(contractFolderStatus)].filter(Boolean);
  const topLevelLocation = extractLocation(project);
  const guarantees = extractGuarantees(contractFolderStatus);
  const noticeUrl = entry.linkUrl || authority.buyerProfileUrl || authority.websiteUrl || "";
  const semanticPayload = compact({
    atomId,
    atomUpdated: entry.updated ?? null,
    status: compact(status),
    referenceNumber,
    title: opportunityTitle,
    description,
    authority: compact({
      name: authority.name,
      buyerProfileUrl: authority.buyerProfileUrl,
      websiteUrl: authority.websiteUrl,
      identifiers: authority.identifiers
    }),
    procedureCode: procedureCode || null,
    contractTypeCode: contractTypeCode || null,
    contractSubTypeCode: contractSubTypeCode || null,
    location: topLevelLocation,
    cpvCodes: extractCpvCodes(project).slice().sort((left, right) => left.localeCompare(right)),
    deadline: deadline
      ? compact({
          date: deadline.date,
          time: deadline.time,
          description: deadline.description
        })
      : null,
    budget: compact({
      estimatedValue: budgetAmounts.estimatedValue
        ? compact({
            amountMinor: budgetAmounts.estimatedValue.amountMinor,
            currency: budgetAmounts.estimatedValue.currency
          })
        : null,
      baseBudget: budgetAmounts.baseBudget
        ? compact({
            amountMinor: budgetAmounts.baseBudget.amountMinor,
            currency: budgetAmounts.baseBudget.currency
          })
        : null,
      totalAmountIncludingVat: budgetAmounts.totalAmountIncludingVat
        ? compact({
            amountMinor: budgetAmounts.totalAmountIncludingVat.amountMinor,
            currency: budgetAmounts.totalAmountIncludingVat.currency
          })
        : null
    }),
    lots: lots
      .map((lot) =>
        compact({
          id: lot.id,
          title: lot.title,
          cpvCodes: (lot.cpvCodes ?? []).slice().sort((left, right) => left.localeCompare(right)),
          value: lot.value
            ? compact({
                amountMinor: lot.value.amountMinor,
                amountType: lot.value.amountType,
                currency: lot.value.currency,
                vatStatus: lot.value.vatStatus
              })
            : null,
          requirements: (lot.requirements ?? [])
            .map((requirement) => requirement.label)
            .slice()
            .sort((left, right) => left.localeCompare(right))
        })
      )
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id)),
    requirements: requirementBlocks.requirements
      .map((requirement) => requirement.label)
      .slice()
      .sort((left, right) => left.localeCompare(right)),
    documents: documents.documents.slice().sort((left, right) => left.localeCompare(right)),
    noticeUrl
  });

  return compact({
    id: deterministicPlacspOpportunityId(atomId),
    sourceConnector: "placsp",
    canonicalId: deterministicPlacspOpportunityId(atomId),
    sourceOpportunityId: atomId,
    sourceNoticeVersionId: buildVersionPayload(semanticPayload),
    type: "contract",
    noticeType: status.noticeType,
    status: status.status,
    title: opportunityTitle,
    description,
    issuingOrganisation: authority.name || "Plataforma de Contratacion del Sector Publico",
    contractingAuthority: authority.name || "",
    publicationDate: null,
    modificationDate,
    startDate: null,
    deadline,
    location: topLevelLocation,
    cpvCodes: extractCpvCodes(project),
    keywords: [],
    procedureType: procedureCode || "",
    estimatedValue: budgetAmounts.estimatedValue,
    awardValue: null,
    baseBudget: budgetAmounts.baseBudget,
    relevantValue: null,
    wholeProcedureValue: null,
    annualValue: null,
    multiYearValue: null,
    aidIntensity: "",
    duration: extractDuration(project),
    guarantees,
    submissionMechanism: submissionMethodCode || "",
    applicationUrl: "",
    noticeUrl,
    referenceNumber,
    requiredDocuments: documents.requiredDocuments,
    documents: documents.documents,
    lastChecked: fetchedAt,
    contacts,
    sources: [source],
    evidence,
    requirements: requirementBlocks.requirements,
    lots,
    sourceConflicts: [],
    availabilityWarnings: [],
    cancellationStatus: null
  });
}

function tombstoneOverridesEntry(entry, tombstone) {
  if (!entry) return true;
  const tombstoneTimestamp = Date.parse(tombstone.when ?? "");
  const entryTimestamp = Date.parse(entry.updated ?? "");
  if (!Number.isFinite(tombstoneTimestamp)) return true;
  if (!Number.isFinite(entryTimestamp)) return true;
  return tombstoneTimestamp >= entryTimestamp;
}

export function normalizePlacspTombstonePatch(tombstone, { fetchedAt, feed }) {
  const rawReason = (tombstone.commentType || "").toUpperCase();
  const mapped = TOMBSTONE_REASON_MAP[rawReason] ?? {
    status: "closed",
    noticeType: "active_contract_notice",
    cancellationStatus: rawReason ? rawReason.toLowerCase() : "tombstoned"
  };

  const versionPayload = {
    atomId: tombstone.ref,
    tombstoneWhen: tombstone.when ?? null,
    tombstoneReason: rawReason,
    status: mapped.status
  };

  return compact({
    id: deterministicPlacspOpportunityId(tombstone.ref),
    sourceOpportunityId: tombstone.ref,
    sourceNoticeVersionId: buildVersionPayload(versionPayload),
    status: mapped.status,
    noticeType: mapped.noticeType,
    cancellationStatus: mapped.cancellationStatus,
    lastChecked: fetchedAt,
    tombstoneReason: rawReason || null,
    sources: [
      compact({
        id: sourceIdFor(tombstone.ref),
        organisation: "Plataforma de Contratacion del Sector Publico",
        title: "Official PLACSP ATOM feed",
        url: feed?.selfUrl ?? feed?.sourceUrl ?? PLACSP_FEED_URL,
        official: true,
        publishedAt: tombstone.when ? tombstone.when.slice(0, 10) : null,
        lastChecked: fetchedAt,
        metadata: compact({
          publisher: "Ministerio de Hacienda / Direccion General del Patrimonio del Estado",
          sourceType: "official_open_data_atom",
          tombstoneWhen: tombstone.when ?? null,
          tombstoneReason: rawReason || null
        })
      })
    ],
    evidence: [
      evidenceRecord({
        fieldKey: "status",
        excerpt: rawReason || "Tombstoned in official feed",
        sourceId: sourceIdFor(tombstone.ref),
        sourcePath: "at:deleted-entry",
        normalizedValue: mapped.status,
        confidence: 0.99
      })
    ]
  });
}

export function normalizePlacspDataset({ feed, entries = [], deletedEntries = [], fetchedAt }) {
  const latestEntries = latestMap(entries, (item) => item.atomId, (item) => item.updated);
  const latestTombstones = latestMap(deletedEntries, (item) => item.ref, (item) => item.when);
  const opportunities = [];
  const tombstones = [];

  latestEntries.forEach((entry, atomId) => {
    const normalized = normalizePlacspEntry(entry, { fetchedAt, feed });
    const tombstone = latestTombstones.get(atomId);
    if (tombstone && tombstoneOverridesEntry(entry, tombstone)) {
      opportunities.push(applyTombstone(normalized, tombstone, fetchedAt, feed));
      return;
    }
    opportunities.push(normalized);
  });

  latestTombstones.forEach((tombstone, atomId) => {
    if (latestEntries.has(atomId) && tombstoneOverridesEntry(latestEntries.get(atomId), tombstone)) return;
    tombstones.push(normalizePlacspTombstonePatch(tombstone, { fetchedAt, feed }));
  });

  return {
    opportunities,
    tombstones,
    stats: {
      uniqueEntries: latestEntries.size,
      uniqueTombstones: latestTombstones.size
    }
  };
}

export { deterministicPlacspOpportunityId };
