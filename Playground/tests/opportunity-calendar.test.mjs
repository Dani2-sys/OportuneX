import test from "node:test";
import assert from "node:assert/strict";

import { parseSpanishDate } from "../src/domain/deadline.js";
import {
  buildOpportunityCalendarEvent,
  serializeIcsEvent
} from "../src/domain/opportunity-calendar.js";

function unfoldIcs(value) {
  return String(value ?? "").replace(/\r\n /g, "");
}

function baseCompany() {
  return {
    id: "company-demo",
    legalName: "Instalaciones Demo Tarragona"
  };
}

function baseAnalysis(overrides = {}) {
  return {
    opportunityId: "opp-calendar-test",
    displayTitle: "Municipal electrical maintenance contract",
    fitBand: "STRONG_FIT",
    matchScore: 86,
    lotId: "opp-calendar-test-root",
    lotLabel: null,
    hasPublishedLot: false,
    locationLabel: "Tarragona",
    primaryContact: {
      name: "Ajuntament de Tarragona"
    },
    decision: {
      recommendedAction: {
        code: "VERIFY_BEFORE_DECIDING",
        label: "Verify Before Deciding"
      },
      mainQuestion: "Required classification still needs verification."
    },
    potentialHardBlockers: [
      {
        title: "Required classification",
        detail: "Required classification still needs verification."
      }
    ],
    unknowns: [],
    blockers: [],
    ...overrides
  };
}

function baseOpportunity(overrides = {}) {
  return {
    id: "opp-calendar-test",
    type: "contract",
    title: "Municipal electrical maintenance contract",
    contractingAuthority: "Ajuntament de Tarragona",
    noticeUrl: "https://contrataciondelestado.es/wps/poc?uri=deeplink-token",
    referenceNumber: "2094/2026",
    deadline: parseSpanishDate("25/09/2026 14:00"),
    location: {
      display: "Tarragona"
    },
    ...overrides
  };
}

test("timed opportunity calendar events use Europe/Madrid DTSTART and preserve the interpretation warning when the source timezone is absent", () => {
  const event = buildOpportunityCalendarEvent({
    company: baseCompany(),
    opportunity: baseOpportunity(),
    analysis: baseAnalysis(),
    now: new Date("2026-08-18T10:00:00.000Z")
  });
  const ics = serializeIcsEvent(event);
  const unfolded = unfoldIcs(ics);

  assert.equal(event.available, true);
  assert.match(unfolded, /DTSTART;TZID=Europe\/Madrid:20260925T140000/);
  assert.match(unfolded, /Deadline time interpreted by OportuneX as Europe\/Madrid because the official source did not state an explicit timezone\./);
  assert.match(unfolded, /Company: Instalaciones Demo Tarragona/);
  assert.match(unfolded, /Opportunity: Municipal electrical maintenance contract/);
  assert.match(unfolded, /Buyer \/ issuer: Ajuntament de Tarragona/);
  assert.match(unfolded, /Reference: 2094\/2026/);
  assert.match(unfolded, /Recommended action: Verify Before Deciding/);
  assert.match(unfolded, /Fit: Strong Fit · 86% match/);
  assert.match(unfolded, /Official notice: https:\/\/contrataciondelestado\.es\/wps\/poc\?uri=deeplink-token/);
  assert.match(unfolded, /TRIGGER:-P7D/);
  assert.match(unfolded, /TRIGGER:-P1D/);
  assert.doesNotMatch(unfolded, /source explicitly stated Europe\/Madrid/i);
});

test("PLACSP calendar events prefer the official reference and search page over the direct deeplink", () => {
  const event = buildOpportunityCalendarEvent({
    company: baseCompany(),
    opportunity: baseOpportunity({
      sourceConnector: "placsp",
      sources: [
        {
          metadata: {
            sourceType: "official_open_data_atom",
            entryLinkUrl: "http://contrataciondelestado.es/wps/poc?uri=deeplink-token"
          }
        }
      ]
    }),
    analysis: baseAnalysis(),
    now: new Date("2026-08-18T10:00:00.000Z")
  });
  const ics = serializeIcsEvent(event);
  const unfolded = unfoldIcs(ics);

  assert.equal(event.available, true);
  assert.equal(event.url, "https://contrataciondelestado.es/wps/portal/plataforma/buscador/");
  assert.match(unfolded, /Official reference: 2094\/2026/);
  assert.match(unfolded, /Official platform: Plataforma de Contratación del Sector Público/);
  assert.match(unfolded, /Search: https:\/\/contrataciondelestado\.es\/wps\/portal\/plataforma\/buscador\//);
  assert.match(unfolded, /Source provenance URL: http:\/\/contrataciondelestado\.es\/wps\/poc\?uri=deeplink-token/);
  assert.doesNotMatch(unfolded, /Official notice:/);
});

test("date-only opportunity calendar events stay all-day and do not invent a submission time", () => {
  const event = buildOpportunityCalendarEvent({
    company: baseCompany(),
    opportunity: baseOpportunity({
      deadline: parseSpanishDate("25/09/2026")
    }),
    analysis: baseAnalysis(),
    now: new Date("2026-08-18T10:00:00.000Z")
  });
  const ics = serializeIcsEvent(event);
  const unfolded = unfoldIcs(ics);

  assert.equal(event.available, true);
  assert.match(unfolded, /DTSTART;VALUE=DATE:20260925/);
  assert.match(unfolded, /DTEND;VALUE=DATE:20260926/);
  assert.match(unfolded, /Exact submission time has not been verified\. Check the official notice\./);
  assert.doesNotMatch(unfolded, /T235900|T140000|TZID=/);
});

test("calendar events remain unavailable until a reliable deadline exists", () => {
  const event = buildOpportunityCalendarEvent({
    company: baseCompany(),
    opportunity: baseOpportunity({
      deadline: null
    }),
    analysis: baseAnalysis(),
    now: new Date("2026-08-18T10:00:00.000Z")
  });

  assert.deepEqual(event, {
    available: false,
    reason: "Calendar event unavailable until a reliable deadline is published."
  });
});

test("ICS serialization escapes commas, semicolons, backslashes and new lines", () => {
  const event = buildOpportunityCalendarEvent({
    company: {
      id: "company-escaping",
      legalName: "Instalaciones,\nDemo; \\ Tarragona"
    },
    opportunity: baseOpportunity({
      title: "Contract, phase; 1 \\ rollout"
    }),
    analysis: baseAnalysis({
      displayTitle: "Contract, phase; 1 \\ rollout",
      decision: {
        recommendedAction: {
          code: "VERIFY_BEFORE_DECIDING",
          label: "Verify Before Deciding"
        },
        mainQuestion: "Check dossier,\ninsurance; and \\ references."
      }
    }),
    now: new Date("2026-08-18T10:00:00.000Z")
  });
  const ics = serializeIcsEvent(event);
  const unfolded = unfoldIcs(ics);

  assert.match(unfolded, /SUMMARY:OportuneX deadline — Contract\\, phase\\; 1 \\\\ rollout/);
  assert.match(unfolded, /Company: Instalaciones\\, Demo\\; \\\\ Tarragona/);
  assert.match(unfolded, /Before proceeding: Check dossier\\, insurance\\; and \\\\ references\./);
});
