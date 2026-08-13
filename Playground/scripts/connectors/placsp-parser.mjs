import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  textNodeName: "#text"
});

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

function normalizeLink(value) {
  return {
    href: attributeOf(value, "href") ?? textOf(value) ?? "",
    rel: attributeOf(value, "rel") ?? "alternate",
    type: attributeOf(value, "type"),
    title: attributeOf(value, "title")
  };
}

function indexLinks(links) {
  return links.reduce((record, link) => {
    if (link.rel && !record[link.rel]) record[link.rel] = link.href;
    if (!record.alternate && link.href) record.alternate = link.href;
    return record;
  }, {});
}

function parseEntry(entry, index) {
  const atomId = textOf(entry.id);
  const contractFolderStatus = entry["cac-place-ext:ContractFolderStatus"] ?? null;
  if (!atomId) {
    return {
      ok: false,
      error: {
        code: "PLACSP_ENTRY_MISSING_ID",
        message: `Entry ${index + 1} is missing Atom id.`
      }
    };
  }
  if (!contractFolderStatus) {
    return {
      ok: false,
      error: {
        code: "PLACSP_ENTRY_MISSING_CONTRACT_FOLDER_STATUS",
        message: `Entry ${atomId} is missing cac-place-ext:ContractFolderStatus.`
      }
    };
  }

  const links = toArray(entry.link).map(normalizeLink).filter((link) => link.href);
  return {
    ok: true,
    value: {
      atomId,
      title: textOf(entry.title),
      summary: textOf(entry.summary),
      updated: textOf(entry.updated) || null,
      links,
      linkUrl: links[0]?.href ?? "",
      contractFolderStatus,
      rawEntry: entry
    }
  };
}

function parseDeletedEntry(entry, index) {
  const ref = attributeOf(entry, "ref");
  if (!ref) {
    return {
      ok: false,
      error: {
        code: "PLACSP_TOMBSTONE_MISSING_REF",
        message: `Deleted entry ${index + 1} is missing ref.`
      }
    };
  }

  return {
    ok: true,
    value: {
      ref,
      when: attributeOf(entry, "when"),
      commentType: (attributeOf(entry["at:comment"], "type") ?? textOf(entry["at:comment"])) || null,
      rawDeletedEntry: entry
    }
  };
}

export function parsePlacspAtom(xmlText, { sourceUrl = "" } = {}) {
  let parsed;
  try {
    parsed = xmlParser.parse(xmlText);
  } catch (error) {
    throw new Error(`PLACSP XML could not be parsed: ${error.message}`);
  }

  const feed = parsed?.feed;
  if (!isPlainObject(feed)) {
    throw new Error("PLACSP XML did not contain an Atom feed root.");
  }

  const links = toArray(feed.link).map(normalizeLink).filter((link) => link.href);
  const indexedLinks = indexLinks(links);
  const entries = [];
  const deletedEntries = [];
  const entryErrors = [];

  toArray(feed.entry).forEach((entry, index) => {
    const result = parseEntry(entry, index);
    if (result.ok) entries.push(result.value);
    else entryErrors.push(result.error);
  });

  toArray(feed["at:deleted-entry"]).forEach((entry, index) => {
    const result = parseDeletedEntry(entry, index);
    if (result.ok) deletedEntries.push(result.value);
    else entryErrors.push(result.error);
  });

  return {
    feed: {
      id: textOf(feed.id) || null,
      updated: textOf(feed.updated) || null,
      sourceUrl,
      links,
      selfUrl: indexedLinks.self ?? null,
      nextUrl: indexedLinks.next ?? null,
      firstUrl: indexedLinks.first ?? null,
      lastUrl: indexedLinks.last ?? null,
      previousUrl: indexedLinks.previous ?? indexedLinks.prev ?? null
    },
    entries,
    deletedEntries,
    entryErrors,
    stats: {
      entriesSeen: toArray(feed.entry).length,
      entriesParsed: entries.length,
      deletedEntriesSeen: toArray(feed["at:deleted-entry"]).length,
      entryErrors: entryErrors.length
    }
  };
}
