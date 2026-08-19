import test from "node:test";
import assert from "node:assert/strict";

import { getEvaluationNow } from "../src/clock.js";
import { DEFAULT_RUNTIME } from "../src/config.js";
import { createDemoState } from "../src/data/demo.js";
import { analyzePortfolio } from "../src/domain/analysis.js";
import {
  buildCustomerReportExport,
  buildRequirementPresentationRows,
  getCustomerAiReviewLabel,
  presentCustomerGuaranteeText,
  resolveOfficialNoticeAccess
} from "../src/domain/customer-presentation.js";

function createAnalysisFixture(opportunityId = "opp-efficiency-grant") {
  const state = createDemoState();
  const company = structuredClone(state.companyProfiles[0]);
  const opportunities = structuredClone(state.opportunities);
  const portfolio = analyzePortfolio(company, opportunities, DEFAULT_RUNTIME, getEvaluationNow());
  const opportunity = opportunities.find((item) => item.id === opportunityId);
  const analysis = portfolio.analysed.find((item) => item.opportunityId === opportunityId);

  assert.ok(company);
  assert.ok(opportunity);
  assert.ok(analysis);

  return { company, opportunity, analysis };
}

test("customer AI labels map the internal review-status enums to clear customer wording", () => {
  assert.equal(getCustomerAiReviewLabel("accepted"), "Assessment confirmed");
  assert.equal(getCustomerAiReviewLabel("needs_review"), "Follow-up required");
  assert.equal(getCustomerAiReviewLabel("rejected"), "Assessment challenged");
});

test("requirement presentation strips PLACSP boilerplate while preserving human-readable titles and raw labels", () => {
  const rows = buildRequirementPresentationRows([
    {
      id: "req-technical",
      label: "Technical qualification: TechnicalCapabilityTypeCode: See section 17.A.4 of the PCAP.&#xD;",
      mandatory: true,
      status: "needs_verification",
      evidenceIds: [],
      why: "Verify the published technical qualification section."
    },
    {
      id: "req-capacity",
      label:
        "Specific tenderer requirement: 1: http://contrataciondelestado.es/codice/PlaceTendererQualification/CapacidadDeObrar: Capacidad de obrar",
      mandatory: true,
      status: "needs_verification",
      evidenceIds: []
    },
    {
      id: "req-financial",
      label:
        "Financial qualification: ZZZ: http://contrataciondelestado.es/codice/cl/2.0/FinancialCapabilityTypeCode-2.0.gc: De acuerdo a lo establecido en el punto 8.2.1 del PCAP",
      mandatory: true,
      status: "needs_verification",
      evidenceIds: [],
      why: "Verify the published financial qualification section."
    }
  ]);

  assert.equal(rows[0].title, "Technical qualification");
  assert.equal(rows[0].detail, "See section 17.A.4 of the PCAP.");
  assert.equal(rows[0].statusLabel, "Needs verification — mandatory");
  assert.doesNotMatch(rows[0].implication, /TechnicalCapabilityTypeCode|&#xD;/);

  assert.equal(rows[1].title, "Capacidad de obrar");
  assert.match(rows[1].rawLabel, /contrataciondelestado\.es\/codice/i);
  assert.doesNotMatch(rows[1].title, /contrataciondelestado\.es\/codice/i);

  assert.equal(rows[2].title, "Financial qualification");
  assert.equal(rows[2].detail, "See section 8.2.1 of the PCAP.");
  assert.doesNotMatch(rows[2].detail, /FinancialCapabilityTypeCode|ZZZ|2\.0\.gc/i);
});

test("customer guarantee presentation hides technical source noise without inventing guarantee semantics", () => {
  const ambiguous = presentCustomerGuaranteeText(
    "GuaranteeTypeCode-2.08.gc: ZZZ: Tal y como se detalla en el apartado 8.2.1 del PCAP",
    { evidenced: false }
  );
  const humanReadable = presentCustomerGuaranteeText("Definitive guarantee 5%", {
    evidenced: false
  });

  assert.equal(ambiguous, "Published guarantee information requires source verification.");
  assert.equal(humanReadable, "Definitive guarantee 5% (published value still needs source verification)");
});

test("PLACSP official notice access preserves the direct link, upgrades official http to https, and exposes the search fallback", () => {
  const access = resolveOfficialNoticeAccess({
    sourceConnector: "placsp",
    referenceNumber: "62/2026",
    noticeUrl: "nota-url-invalida",
    sources: [
      {
        metadata: {
          sourceType: "official_open_data_atom",
          entryLinkUrl: "http://contrataciondelestado.es/wps/poc?uri=deeplink-token"
        }
      }
    ]
  });

  assert.equal(access.primaryUrl, "https://contrataciondelestado.es/wps/poc?uri=deeplink-token");
  assert.equal(access.preservedDirectUrl, "http://contrataciondelestado.es/wps/poc?uri=deeplink-token");
  assert.match(access.searchUrl, /contrataciondelestado\.es\/wps\/portal\/plataforma\/buscador/i);
  assert.equal(
    access.helpNote,
    "Find on PLACSP copies the tender reference and opens the official search page. Paste the reference into the Expediente field."
  );
  assert.equal(access.searchInstruction, "Search PLACSP using the official reference above.");
  assert.equal(access.platformLabel, "Plataforma de Contratación del Sector Público");
  assert.equal(access.copyReferenceValue, "62/2026");
});

test("official notice access leaves non-PLACSP urls untouched and rejects malformed links", () => {
  const bdnsAccess = resolveOfficialNoticeAccess({
    sourceConnector: "bdns",
    referenceNumber: "700007",
    noticeUrl: "http://example.com/official-notice"
  });
  const malformedAccess = resolveOfficialNoticeAccess({
    sourceConnector: "bdns",
    referenceNumber: "700008",
    noticeUrl: "javascript:alert(1)"
  });

  assert.equal(bdnsAccess.primaryUrl, "http://example.com/official-notice");
  assert.equal(bdnsAccess.searchUrl, null);
  assert.equal(malformedAccess.primaryUrl, null);
  assert.equal(malformedAccess.copyReferenceValue, "700008");
});

test("PLACSP official notice access keeps search available when no reliable official reference exists", () => {
  const access = resolveOfficialNoticeAccess({
    sourceConnector: "placsp",
    referenceNumber: "",
    noticeUrl: "http://contrataciondelestado.es/wps/poc?uri=deeplink-token"
  });

  assert.equal(access.primaryUrl, "https://contrataciondelestado.es/wps/poc?uri=deeplink-token");
  assert.equal(access.preservedDirectUrl, "http://contrataciondelestado.es/wps/poc?uri=deeplink-token");
  assert.equal(access.copyReferenceValue, null);
  assert.equal(access.helpNote, "Open PLACSP search and use the buyer/title details shown in OportuneX.");
  assert.equal(access.searchInstruction, "Search PLACSP using the buyer/title details shown above.");
});

test("customer report export uses escaped self-contained HTML and includes only current AI reviews", () => {
  const { company, opportunity, analysis } = createAnalysisFixture("opp-electrical-maintenance");
  const exported = buildCustomerReportExport({
    company,
    opportunity: {
      ...opportunity,
      title: 'Catalonia grant <script>alert("x")</script>'
    },
    analysis: {
      ...analysis,
      displayTitle: 'Catalonia grant <script>alert("x")</script>'
    },
    aiReviewState: {
      status: "current",
      review: {
        result: {
          review_status: "needs_review",
          confidence: "high",
          warnings: [
            "Verify the specialist classification before relying on the grant fit.",
            "Check the updated insurance evidence before acting.",
            "Confirm the current comparable public reference.",
            "Review the submission route in the official portal.",
            "Validate the lead contractor role requirement."
          ],
          disagreements: ["The public-reference depth looks weaker than the deterministic summary implies."],
          corrected_action: null,
          corrected_fit_band: null,
          notes: "For Instalaciones Demo Tarragona, specialist qualification evidence still needs review. The current submission route still needs confirmation. Commercial assumptions also need checking."
        }
      }
    }
  });

  assert.match(exported.filename, /\.html$/);
  assert.equal(exported.mimeType, "text/html;charset=utf-8");
  assert.match(exported.html, /Follow-up required/);
  assert.match(exported.html, /What this means for Instalaciones Demo Tarragona/);
  assert.match(exported.html, /Verify the specialist classification before relying on the grant fit\./);
  assert.match(exported.html, /\+ 1 more in Detailed AI reasoning\./);
  assert.match(exported.html, /Detailed AI reasoning/);
  assert.match(exported.html, /Deadline note:/);
  assert.match(exported.html, /interpreted by OportuneX as Europe\/Madrid/i);
  assert.match(exported.html, /Reference:/);
  assert.match(exported.html, /Official notice:/);
  assert.match(exported.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(exported.html, /<script>alert\("x"\)<\/script>/);
});

test("customer report export keeps cleaned requirement copy and omits CODICE noise from the customer layer", () => {
  const { company, opportunity, analysis } = createAnalysisFixture("opp-electrical-maintenance");
  const exported = buildCustomerReportExport({
    company,
    opportunity,
    analysis: {
      ...analysis,
      requirementRows: [
        {
          id: "req-technical-export",
          label:
            "Technical qualification: ZZZ: http://contrataciondelestado.es/codice/cl/2.0/TechnicalCapabilityTypeCode-2.0.gc: Tal y como se detalla en el apartado 17.A.4 del PCAP",
          mandatory: true,
          status: "needs_verification",
          evidenceIds: [],
          why: "Please verify whether the company satisfies the published requirement: Technical qualification."
        }
      ]
    }
  });

  assert.match(exported.html, /Technical qualification/);
  assert.match(exported.html, /See section 17\.A\.4 of the PCAP\./);
  assert.doesNotMatch(exported.html, /contrataciondelestado\.es\/codice|TechnicalCapabilityTypeCode|ZZZ|2\.0\.gc/i);
});

test("PLACSP customer report export uses official reference and PLACSP search instead of the direct deeplink as the main action", () => {
  const { company, analysis } = createAnalysisFixture("opp-electrical-maintenance");
  const exported = buildCustomerReportExport({
    company,
    opportunity: {
      id: "placsp-export-test",
      type: "contract",
      title: "PLACSP export test opportunity",
      referenceNumber: "2094/2026",
      sourceConnector: "placsp",
      noticeUrl: "https://contrataciondelestado.es/wps/poc?uri=deeplink-token",
      sources: [
        {
          metadata: {
            sourceType: "official_open_data_atom",
            entryLinkUrl: "http://contrataciondelestado.es/wps/poc?uri=deeplink-token"
          }
        }
      ],
      deadline: {
        date: "2026-09-25",
        time: "14:00",
        timezone: "Europe/Madrid",
        sourceTimezone: null
      }
    },
    analysis: {
      ...analysis,
      displayTitle: "PLACSP export test opportunity"
    }
  });

  assert.match(exported.html, /Official reference: 2094\/2026/);
  assert.match(exported.html, /Official platform: Plataforma de Contratación del Sector Público/);
  assert.match(exported.html, /PLACSP search:/);
  assert.match(exported.html, /Search PLACSP using the official reference above\./);
  assert.match(exported.html, /Source-provided PLACSP URL:/);
  assert.doesNotMatch(exported.html, /Official notice:/);
  assert.doesNotMatch(exported.html, /TLS|certificate|Safari|broken government link/i);
  assert.match(exported.html, /http:\/\/contrataciondelestado\.es\/wps\/poc\?uri=deeplink-token/);
});

test("stale AI review export notes the outdated state without presenting it as current verification", () => {
  const { company, opportunity, analysis } = createAnalysisFixture();
  const exported = buildCustomerReportExport({
    company,
    opportunity,
    analysis,
    aiReviewState: {
      status: "stale",
      review: {
        result: {
          review_status: "accepted",
          confidence: "medium",
          warnings: [],
          disagreements: [],
          corrected_action: null,
          corrected_fit_band: null,
          notes: "Outdated review."
        }
      }
    }
  });

  assert.match(exported.html, /outdated and was not treated as current/i);
  assert.doesNotMatch(exported.html, /Assessment confirmed/);
  assert.doesNotMatch(exported.html, /What this means for Instalaciones Demo Tarragona/);
});
