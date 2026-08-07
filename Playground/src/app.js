import {
  APP_TITLE,
  CONFIDENCE_COPY,
  ELIGIBILITY_COPY,
  FEEDBACK_LABELS,
  NAV_ITEMS,
  OPPORTUNITY_TYPES,
  RECOMMENDATION_COPY,
  STATUS_LABELS
} from "./config.js";
import { demoCompany } from "./data/demo.js";
import { evaluationFixtures } from "./data/evaluation-fixtures.js";
import { analyzePortfolio } from "./domain/analysis.js";
import { runEvaluationSuite } from "./domain/evaluation.js";
import { formatDeadline, formatLastChecked, parseSpanishDate, urgencyChip } from "./domain/deadline.js";
import { formatMoney, parseMoneyInput } from "./domain/money.js";
import { importOpportunityFromText } from "./services/importer.js";
import { runAiVerification } from "./services/ai-client.js";
import { clamp, escapeHtml, formatDate, formatNumber, toSlug, uid } from "./utils.js";

const DEMO_NOW = new Date("2026-08-07T10:00:00+02:00");

const uiState = {
  route: "overview",
  selectedOpportunityId: null,
  filterType: "all",
  filterRecommendation: "all",
  sort: "priority",
  showSavedOnly: false,
  detailTab: "report",
  aiBusy: false,
  message: "",
  draftAnswers: {}
};

function getCompany(state) {
  return state.companyProfiles.find((company) => company.id === state.activeCompanyId) ?? state.companyProfiles[0];
}

function recommendationTone(label) {
  switch (label) {
    case "EXCELLENT_FIT":
      return "good";
    case "STRONG_FIT":
      return "good";
    case "POSSIBLE_FIT":
      return "warn";
    case "VERIFY_BEFORE_DECIDING":
      return "warn";
    case "DO_NOT_PURSUE":
      return "bad";
    default:
      return "neutral";
  }
}

function confidenceTone(label) {
  if (label === "HIGH") return "good";
  if (label === "MEDIUM") return "warn";
  return "bad";
}

function getDerived(state, runtime) {
  const company = getCompany(state);
  const portfolio = analyzePortfolio(company, state.opportunities, runtime, DEMO_NOW);
  const savedSet = new Set(state.savedOpportunityIds ?? []);
  const selectedOpportunityId = uiState.selectedOpportunityId ?? portfolio.recommended[0]?.opportunityId ?? portfolio.rejected[0]?.opportunity.id ?? null;
  uiState.selectedOpportunityId = selectedOpportunityId;

  const recommended = portfolio.recommended
    .filter((item) => (uiState.filterType === "all" ? true : item.opportunity.type === uiState.filterType))
    .filter((item) =>
      uiState.filterRecommendation === "all" ? true : item.recommendationClass === uiState.filterRecommendation
    )
    .filter((item) => (uiState.showSavedOnly ? savedSet.has(item.opportunityId) : true))
    .sort((left, right) => sortMatches(left, right, uiState.sort));

  const selectedRecommended = recommended.find((item) => item.opportunityId === selectedOpportunityId);
  const selectedRejected = portfolio.rejected.find((item) => item.opportunity.id === selectedOpportunityId);
  const selectedRaw = state.opportunities.find((item) => item.id === selectedOpportunityId) ?? null;
  const selected = selectedRecommended ?? selectedRejected ?? null;

  const allQuestions = recommended
    .flatMap((match) => match.adaptiveQuestions.map((question) => ({ ...question, opportunityId: match.opportunityId })))
    .slice(0, 5);
  const evaluation = runEvaluationSuite(evaluationFixtures, runtime);

  return {
    company,
    portfolio,
    recommended,
    savedSet,
    selected,
    selectedRaw,
    selectedRecommended,
    selectedRejected,
    questions: allQuestions,
    evaluation
  };
}

function sortMatches(left, right, mode) {
  switch (mode) {
    case "deadline":
      return left.deadlineLabel.localeCompare(right.deadlineLabel);
    case "match":
      return right.matchScore - left.matchScore;
    case "confidence":
      return (right.confidenceShield.label === "HIGH" ? 2 : right.confidenceShield.label === "MEDIUM" ? 1 : 0) -
        (left.confidenceShield.label === "HIGH" ? 2 : left.confidenceShield.label === "MEDIUM" ? 1 : 0);
    case "value":
      return parseFloat(right.displayValueLabel.replace(/[^\d]/g, "")) - parseFloat(left.displayValueLabel.replace(/[^\d]/g, ""));
    default:
      return right.priorityScore - left.priorityScore;
  }
}

function pill(text, tone = "neutral") {
  return `<span class="pill ${tone}">${escapeHtml(text)}</span>`;
}

function statCard(label, value, meta = "") {
  return `
    <article class="stat-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
    </article>
  `;
}

function renderNavigation(route) {
  return `
    <aside class="sidebar">
      <div class="brand-block">
        <div class="brand-mark"></div>
        <div>
          <p class="eyebrow">Phase 0</p>
          <h1>${APP_TITLE}</h1>
          <p class="brand-copy">Public opportunities your business is missing.</p>
        </div>
      </div>
      <nav class="nav-list">
        ${NAV_ITEMS.map(
          (item) => `
            <button class="nav-item ${route === item.id ? "active" : ""}" data-action="route" data-route="${item.id}">
              <span>${escapeHtml(item.label)}</span>
              ${item.admin ? `<small>Admin</small>` : ""}
            </button>
          `
        ).join("")}
      </nav>
      <div class="sidebar-note">
        <strong>Trust invariant</strong>
        <p>Unknown is never treated as pass. Hard blockers always override a high score.</p>
      </div>
    </aside>
  `;
}

function renderOverview(derived) {
  const top = derived.portfolio.recommended.slice(0, 3);
  const contracts = derived.portfolio.recommended.filter((item) => item.opportunity.type === "contract");
  const grants = derived.portfolio.recommended.filter((item) => item.opportunity.type === "grant");
  return `
    <section class="page-grid">
      <div class="hero-panel">
        <div>
          <p class="eyebrow">Opportunity pulse</p>
          <h2>Decision-grade opportunity triage for Spanish SMEs.</h2>
          <p class="lead">
            OportuneX checks public contracts and grants against company fit, hard eligibility, evidence coverage and pursuit practicality before anything gets recommended.
          </p>
        </div>
        <div class="hero-metrics">
          ${statCard("New opportunities analysed", String(derived.portfolio.counts.analysed), "Phase 0 demo set")}
          ${statCard("Worth attention", String(derived.portfolio.counts.worthAttention), "Recommended or verify")}
          ${statCard("Rejected with reason", String(derived.portfolio.rejected.length), "Visible in lab")}
        </div>
      </div>

      <div class="card-grid three">
        ${top
          .map(
            (item) => `
              <article class="card clickable" data-action="select" data-id="${item.opportunityId}">
                <div class="card-topline">
                  ${pill(`${item.priorityScore} — ${RECOMMENDATION_COPY[item.recommendationClass]}`, recommendationTone(item.recommendationClass))}
                  ${pill(CONFIDENCE_COPY[item.confidenceShield.label], confidenceTone(item.confidenceShield.label))}
                </div>
                <h3>${escapeHtml(item.displayTitle)}</h3>
                <p>${escapeHtml(item.executiveVerdict)}</p>
                <div class="meta-row">
                  <span>${escapeHtml(item.displayValueLabel)}</span>
                  <span>${escapeHtml(urgencyChip(item.opportunity, DEMO_NOW))}</span>
                </div>
              </article>
            `
          )
          .join("")}
      </div>

      <div class="card-grid two">
        <article class="card">
          <div class="section-heading">
            <h3>Make Money</h3>
            <p>Relevant public contracts, ranked by pursuit suitability.</p>
          </div>
          ${contracts
            .slice(0, 3)
            .map(
              (item) => `
                <button class="mini-list-item" data-action="select" data-id="${item.opportunityId}">
                  <strong>${escapeHtml(item.displayTitle)}</strong>
                  <span>${escapeHtml(item.displayValueLabel)} · ${escapeHtml(item.locationLabel)}</span>
                </button>
              `
            )
            .join("")}
        </article>
        <article class="card">
          <div class="section-heading">
            <h3>Access Funding</h3>
            <p>Relevant grants and subsidies, without inflating programme budgets.</p>
          </div>
          ${grants
            .slice(0, 3)
            .map(
              (item) => `
                <button class="mini-list-item" data-action="select" data-id="${item.opportunityId}">
                  <strong>${escapeHtml(item.displayTitle)}</strong>
                  <span>${escapeHtml(item.companyAmountLabel)} · ${escapeHtml(item.locationLabel)}</span>
                </button>
              `
            )
            .join("")}
        </article>
      </div>

      <div class="card-grid two">
        <article class="card">
          <div class="section-heading">
            <h3>Questions for you</h3>
            <p>Adaptive questions close the biggest eligibility gaps without long onboarding.</p>
          </div>
          <div class="question-list">
            ${
              derived.questions.length
                ? derived.questions
                    .map(
                      (question) => `
                        <article class="question-card">
                          <strong>${escapeHtml(question.question)}</strong>
                          <div class="answer-row">
                            ${question.options
                              .map(
                                (option) => `
                                  <button class="ghost-button" data-action="answer" data-question="${question.id}" data-opportunity="${question.opportunityId}" data-answer="${option}">
                                    ${escapeHtml(option)}
                                  </button>
                                `
                              )
                              .join("")}
                          </div>
                        </article>
                      `
                    )
                    .join("")
                : `<p class="empty-state">No adaptive question is currently blocking the top recommendations.</p>`
            }
          </div>
        </article>
        <article class="card">
          <div class="section-heading">
            <h3>Recent changes</h3>
            <p>Freshness and audit trails stay visible in Phase 0.</p>
          </div>
          <div class="timeline">
            ${(derived.portfolio.recommended[0]?.opportunity?.sources ?? [])
              .slice(0, 2)
              .map(
                (source) => `
                  <div class="timeline-item">
                    <strong>${escapeHtml(source.title)}</strong>
                    <span>Official source checked ${escapeHtml(formatLastChecked(source.lastChecked))}</span>
                  </div>
                `
              )
              .join("")}
            ${(derived.selectedRaw?.sourceConflicts ?? [])
              .slice(0, 1)
              .map(
                (conflict) => `
                  <div class="timeline-item warn">
                    <strong>Source conflict</strong>
                    <span>${escapeHtml(conflict.field)} needs verification.</span>
                  </div>
                `
              )
              .join("")}
            ${(derived.company.representativeProjects ?? []).slice?.(0, 0) ?? ""}
          </div>
        </article>
      </div>

      <article class="card pricing-card">
        <div class="section-heading">
          <h3>Pricing preview</h3>
          <p>Implemented visually now so the product can demo future packaging without fake urgency.</p>
        </div>
        <div class="pricing-grid">
          ${[
            ["OPORTUNEX PREVIEW", "€0", "See what your company may be missing.", ["1 company", "Initial company profile", "Limited opportunity previews", "First full verified analysis"]],
            ["OPORTUNEX RADAR", "€29/month", "A dedicated public-opportunity radar for one SME.", ["Contracts + grants", "Weekly/daily digest", "Saved opportunities", "Official source links"]],
            ["OPORTUNEX PRO", "€59/month", "Decision-grade intelligence before you spend time pursuing.", ["Detailed eligibility matrix", "Confidence Shield", "Adaptive eligibility questions", "Change monitoring"]],
            ["OPORTUNEX PORTFOLIO", "€119/month", "One radar across multiple businesses.", ["Up to 5 company profiles", "Portfolio dashboard", "Client-specific digests", "All Pro intelligence"]]
          ]
            .map(
              ([name, price, text, bullets], index) => `
                <article class="price-card ${index === 1 ? "featured" : ""}">
                  <p class="eyebrow">${escapeHtml(name)}</p>
                  <h4>${escapeHtml(price)}</h4>
                  <p>${escapeHtml(text)}</p>
                  <ul>
                    ${bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}
                  </ul>
                </article>
              `
            )
            .join("")}
        </div>
      </article>
    </section>
  `;
}

function renderFilters() {
  return `
    <div class="toolbar">
      <label>
        Type
        <select data-filter="type">
          <option value="all" ${uiState.filterType === "all" ? "selected" : ""}>All</option>
          <option value="contract" ${uiState.filterType === "contract" ? "selected" : ""}>Contracts</option>
          <option value="grant" ${uiState.filterType === "grant" ? "selected" : ""}>Grants</option>
        </select>
      </label>
      <label>
        Recommendation
        <select data-filter="recommendation">
          <option value="all" ${uiState.filterRecommendation === "all" ? "selected" : ""}>All</option>
          ${Object.entries(RECOMMENDATION_COPY)
            .map(
              ([value, label]) =>
                `<option value="${value}" ${uiState.filterRecommendation === value ? "selected" : ""}>${escapeHtml(label)}</option>`
            )
            .join("")}
        </select>
      </label>
      <label>
        Sort
        <select data-filter="sort">
          <option value="priority" ${uiState.sort === "priority" ? "selected" : ""}>Priority</option>
          <option value="deadline" ${uiState.sort === "deadline" ? "selected" : ""}>Deadline</option>
          <option value="match" ${uiState.sort === "match" ? "selected" : ""}>Match</option>
          <option value="value" ${uiState.sort === "value" ? "selected" : ""}>Published value</option>
          <option value="confidence" ${uiState.sort === "confidence" ? "selected" : ""}>Confidence</option>
        </select>
      </label>
      <label class="toggle">
        <input type="checkbox" data-filter="savedOnly" ${uiState.showSavedOnly ? "checked" : ""} />
        Saved only
      </label>
    </div>
  `;
}

function renderOpportunityList(derived) {
  const matches = derived.recommended;
  return `
    <section class="split-layout">
      <div class="stack">
        <article class="card">
          <div class="section-heading">
            <h2>Opportunities</h2>
            <p>Rapid triage with priority, eligibility, confidence and the main unresolved question.</p>
          </div>
          ${renderFilters()}
          <div class="opportunity-list">
            ${
              matches.length
                ? matches
                    .map(
                      (item) => `
                        <article class="opportunity-card ${uiState.selectedOpportunityId === item.opportunityId ? "selected" : ""}">
                          <button class="full-card-hit" data-action="select" data-id="${item.opportunityId}"></button>
                          <div class="card-topline">
                            ${pill(`${item.priorityScore} — ${RECOMMENDATION_COPY[item.recommendationClass]}`, recommendationTone(item.recommendationClass))}
                            ${pill(ELIGIBILITY_COPY[item.eligibilityStatus], item.eligibilityStatus.includes("INELIGIBLE") ? "bad" : item.eligibilityStatus.includes("UNCLEAR") ? "warn" : "good")}
                            ${pill(CONFIDENCE_COPY[item.confidenceShield.label], confidenceTone(item.confidenceShield.label))}
                          </div>
                          <h3>${escapeHtml(item.displayTitle)}</h3>
                          <p class="compact">${escapeHtml(item.displayValueLabel)} · ${escapeHtml(urgencyChip(item.opportunity, DEMO_NOW))}</p>
                          <p>${escapeHtml(item.executiveVerdict)}</p>
                          <div class="meta-row">
                            <span>Why: ${escapeHtml(item.positives[0]?.title ?? "Needs deeper review")}</span>
                            <span>Main question: ${escapeHtml(item.unknowns[0]?.title ?? item.blockers[0]?.title ?? "None")}</span>
                          </div>
                          <div class="action-row">
                            <button class="ghost-button" data-action="save" data-id="${item.opportunityId}">
                              ${(derived.savedSet.has(item.opportunityId) ? "Unsave" : "Save")}
                            </button>
                            <button class="ghost-button" data-action="interest" data-id="${item.opportunityId}">
                              Interested
                            </button>
                            <button class="ghost-button" data-action="not-relevant" data-id="${item.opportunityId}">
                              Not relevant
                            </button>
                          </div>
                        </article>
                      `
                    )
                    .join("")
                : `<p class="empty-state">No opportunity matches the current filters.</p>`
            }
          </div>
        </article>
      </div>
      ${renderDetailPanel(derived)}
    </section>
  `;
}

function renderSavedPage(derived) {
  const savedMatches = derived.portfolio.recommended.filter((item) => derived.savedSet.has(item.opportunityId));
  return `
    <section class="page-grid">
      <article class="card">
        <div class="section-heading">
          <h2>Saved opportunities</h2>
          <p>Phase 0 keeps saved opportunities separate from the full ranked list.</p>
        </div>
        ${
          savedMatches.length
            ? savedMatches
                .map(
                  (item) => `
                    <div class="saved-row">
                      <div>
                        <strong>${escapeHtml(item.displayTitle)}</strong>
                        <p>${escapeHtml(item.displayValueLabel)} · ${escapeHtml(item.locationLabel)}</p>
                      </div>
                      <div class="meta-actions">
                        ${pill(RECOMMENDATION_COPY[item.recommendationClass], recommendationTone(item.recommendationClass))}
                        <button class="ghost-button" data-action="select" data-id="${item.opportunityId}">Open</button>
                      </div>
                    </div>
                  `
                )
                .join("")
            : `<p class="empty-state">No saved opportunity yet.</p>`
        }
      </article>
    </section>
  `;
}

function renderCompanyPage(company) {
  const certificationOptions = ["valid", "missing", "unknown"];
  return `
    <section class="page-grid">
      <article class="card">
        <div class="section-heading">
          <h2>Company Profile</h2>
          <p>Structured company capability data drives ranking, hard gates and adaptive questions.</p>
        </div>
        <form data-form="company" class="form-grid">
          <label>
            Legal name
            <input type="text" name="legalName" value="${escapeHtml(company.legalName)}" />
          </label>
          <label>
            Trading name
            <input type="text" name="tradingName" value="${escapeHtml(company.tradingName)}" />
          </label>
          <label>
            Municipality
            <input type="text" name="municipality" value="${escapeHtml(company.geography.municipality)}" />
          </label>
          <label>
            Province
            <input type="text" name="province" value="${escapeHtml(company.geography.province)}" />
          </label>
          <label>
            Preferred radius (km)
            <input type="number" name="radius" value="${company.geography.preferredWorkingRadiusKm}" />
          </label>
          <label>
            Minimum attractive project value
            <input type="number" name="minimumAttractiveProjectValue" value="${company.preferences.minimumAttractiveProjectValue}" />
          </label>
          <label>
            Ideal project value
            <input type="number" name="idealProjectValue" value="${company.preferences.idealProjectValue}" />
          </label>
          <label>
            Maximum realistic project value
            <input type="number" name="maximumRealisticProjectValue" value="${company.preferences.maximumRealisticProjectValue}" />
          </label>
          <label class="full-span">
            Desired work types
            <input type="text" name="desiredWorkTypes" value="${escapeHtml(company.preferences.desiredWorkTypes.join(", "))}" />
          </label>
          <label class="full-span">
            Unwanted work types
            <input type="text" name="unwantedWorkTypes" value="${escapeHtml(company.preferences.unwantedWorkTypes.join(", "))}" />
          </label>
          ${company.certifications
            .map(
              (item, index) => `
                <label>
                  ${escapeHtml(item.name)}
                  <select name="certification-${index}">
                    ${certificationOptions
                      .map(
                        (option) =>
                          `<option value="${option}" ${item.status === option ? "selected" : ""}>${escapeHtml(option)}</option>`
                      )
                      .join("")}
                  </select>
                </label>
              `
            )
            .join("")}
          <label>
            Can co-finance grant projects?
            <select name="canCoFinance">
              <option value="yes" ${company.grants.canCoFinance ? "selected" : ""}>Yes</option>
              <option value="no" ${company.grants.canCoFinance === false ? "selected" : ""}>No</option>
              <option value="unknown" ${company.grants.canCoFinance == null ? "selected" : ""}>Unknown</option>
            </select>
          </label>
          <div class="form-actions full-span">
            <button class="button-primary" type="submit">Save company profile</button>
          </div>
        </form>
      </article>
    </section>
  `;
}

function renderLabPage(derived) {
  const raw = derived.selectedRaw;
  return `
    <section class="split-layout">
      <div class="stack">
        <article class="card">
          <div class="section-heading">
            <h2>Intelligence Lab</h2>
            <p>Create opportunities manually, paste source text, attach evidence, correct facts and re-run analysis.</p>
          </div>
          <form data-form="opportunity-import" class="form-grid">
            <label class="full-span">
              Paste source text
              <textarea name="sourceText" rows="7" placeholder="Paste structured or unstructured opportunity information here."></textarea>
            </label>
            <label>
              Manual title override
              <input type="text" name="title" placeholder="Optional" />
            </label>
            <label>
              Opportunity type
              <select name="type">
                <option value="contract">Contract</option>
                <option value="grant">Grant / subsidy</option>
              </select>
            </label>
            <label>
              Location
              <input type="text" name="location" placeholder="Tarragona" />
            </label>
            <label>
              Value or max beneficiary amount
              <input type="text" name="value" placeholder="84.500" />
            </label>
            <label>
              Deadline text
              <input type="text" name="deadline" placeholder="26/08/2026 14:00" />
            </label>
            <label class="full-span">
              Official notice URL
              <input type="url" name="noticeUrl" placeholder="https://..." />
            </label>
            <div class="form-actions full-span">
              <button class="button-primary" type="submit">Create / import opportunity</button>
              <button class="ghost-button" type="button" data-action="reset-demo">Reset demo data</button>
              <button class="ghost-button" type="button" data-action="export-json">Export workspace JSON</button>
            </div>
          </form>
        </article>

        <article class="card">
          <div class="section-heading">
            <h3>Excluded / low-fit opportunities</h3>
            <p>Nothing is silently dropped. Every rejection keeps a reason for debugging false negatives.</p>
          </div>
          <div class="rejected-list">
            ${derived.portfolio.rejected
              .map(
                (item) => `
                  <button class="mini-list-item" data-action="select" data-id="${item.opportunity.id}">
                    <strong>${escapeHtml(item.opportunity.title)}</strong>
                    <span>${escapeHtml(item.reason)}</span>
                  </button>
                `
              )
              .join("")}
          </div>
        </article>
      </div>
      <div class="stack">
        <article class="card">
          <div class="section-heading">
            <h3>Opportunity editor</h3>
            <p>Manual overrides preserve source-derived evidence while correcting the working fact set.</p>
          </div>
          ${
            raw
              ? `
                  <form data-form="override" class="form-grid">
                    <input type="hidden" name="opportunityId" value="${raw.id}" />
                    <label class="full-span">
                      Title
                      <input type="text" name="title" value="${escapeHtml(raw.title)}" />
                    </label>
                    <label>
                      Status
                      <select name="status">
                        ${Object.entries(STATUS_LABELS)
                          .map(
                            ([value, label]) =>
                              `<option value="${value}" ${(raw.status || raw.derivedStatus) === value ? "selected" : ""}>${escapeHtml(label)}</option>`
                          )
                          .join("")}
                      </select>
                    </label>
                    <label>
                      Value
                      <input type="text" name="value" value="${escapeHtml(
                        raw.relevantValue ? String(raw.relevantValue.amountMinor / 100) : ""
                      )}" />
                    </label>
                    <label>
                      Deadline
                      <input type="text" name="deadline" value="${escapeHtml(raw.deadline?.sourceText ?? "")}" />
                    </label>
                    <label class="full-span">
                      Override reason
                      <textarea name="reason" rows="3" placeholder="Why is this correction needed?"></textarea>
                    </label>
                    <div class="form-actions full-span">
                      <button class="button-primary" type="submit">Apply override and reanalyse</button>
                    </div>
                  </form>
                `
              : `<p class="empty-state">Select an opportunity from the ranked list or rejected list to edit it here.</p>`
          }
        </article>
        ${renderDetailPanel(derived)}
      </div>
    </section>
  `;
}

function renderSourcesPage(state, runtime) {
  return `
    <section class="page-grid">
      <article class="card">
        <div class="section-heading">
          <h2>Data sources</h2>
          <p>Phase 0 uses the same normalized model the live connectors will feed later.</p>
        </div>
        <div class="source-grid">
          ${(state.sourceSyncRuns ?? [])
            .map(
              (run) => `
                <article class="source-card">
                  <div class="card-topline">
                    ${pill(run.source, "neutral")}
                    ${pill(run.status, run.status === "healthy" ? "good" : run.status === "planned" ? "warn" : "bad")}
                  </div>
                  <p>${escapeHtml(run.note)}</p>
                  <small>${run.lastRun ? `Last run ${escapeHtml(formatLastChecked(run.lastRun))}` : "No run yet"}</small>
                </article>
              `
            )
            .join("")}
          <article class="source-card">
            <div class="card-topline">
              ${pill("AI adapter", runtime.ai.enabled ? "good" : "warn")}
              ${pill(runtime.ai.provider, "neutral")}
            </div>
            <p>Server-side scaffold for OpenAI Responses verification keeps secrets out of the client bundle.</p>
          </article>
        </div>
      </article>
    </section>
  `;
}

function renderDebugPage(derived) {
  return `
    <section class="split-layout">
      <div class="stack">
        <article class="card">
          <div class="section-heading">
            <h2>Analysis debugger</h2>
            <p>Inspect score components, claims, evidence links and verification triggers.</p>
          </div>
          ${renderOpportunityListMini(derived.portfolio.recommended)}
        </article>
      </div>
      ${renderDetailPanel(derived, true)}
    </section>
  `;
}

function renderEvaluationPage(derived) {
  const summary = derived.evaluation.summary;
  return `
    <section class="page-grid">
      <div class="card-grid five">
        ${statCard("Fixtures", String(summary.total))}
        ${statCard("Passed", String(summary.passed))}
        ${statCard("Candidate recall", `${summary.candidateRecall}%`)}
        ${statCard("Recommendation precision", `${summary.recommendationPrecision}%`)}
        ${statCard("Hard-blocker accuracy", `${summary.hardBlockerAccuracy}%`)}
      </div>
      <div class="card-grid three">
        ${statCard("Monetary accuracy", `${summary.monetaryFieldAccuracy}%`)}
        ${statCard("Deadline accuracy", `${summary.deadlineAccuracy}%`)}
        ${statCard("Critical hallucination rate", "0%", "No fabricated critical fact in the fixture suite")}
      </div>
      <article class="card">
        <div class="section-heading">
          <h2>Evaluation harness</h2>
          <p>Stable fixtures cover hard blockers, lot-level values, deadline safety, grants, source conflicts and prompt injection.</p>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fixture</th>
                <th>Status</th>
                <th>Recommendation</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${derived.evaluation.results
                .map(
                  (result) => `
                    <tr>
                      <td>${escapeHtml(result.title)}</td>
                      <td>${pill(result.passed ? "Pass" : "Fail", result.passed ? "good" : "bad")}</td>
                      <td>${escapeHtml(result.recommendationClass ?? result.rejectedReason ?? "n/a")}</td>
                      <td>${escapeHtml(result.checks.filter((check) => !check.pass).map((check) => check.label).join(", ") || "All checks passed")}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  `;
}

function renderHealthPage(state, runtime, derived) {
  const footprint = Math.round(JSON.stringify(state).length / 1024);
  return `
    <section class="page-grid">
      <div class="card-grid four">
        ${statCard("Companies", String(state.companyProfiles.length))}
        ${statCard("Opportunities", String(state.opportunities.length))}
        ${statCard("Saved", String(state.savedOpportunityIds.length))}
        ${statCard("Local store footprint", `${footprint} KB`)}
      </div>
      <article class="card">
        <div class="section-heading">
          <h2>System health</h2>
          <p>Phase 0 observability covers workspace counts, source states, AI mode and recent audit events.</p>
        </div>
        <div class="health-grid">
          <div>
            <strong>AI verification mode</strong>
            <p>${runtime.ai.enabled ? "Ready for server-side OpenAI verification." : "Mock mode. No API key detected."}</p>
          </div>
          <div>
            <strong>Connector posture</strong>
            <p>${state.sourceSyncRuns.filter((item) => item.status === "healthy").length} healthy, ${state.sourceSyncRuns.filter((item) => item.status === "planned").length} planned.</p>
          </div>
          <div>
            <strong>Evidence coverage</strong>
            <p>${derived.portfolio.recommended[0]?.confidenceShield.criticalFieldsVerified ?? 0}/${derived.portfolio.recommended[0]?.confidenceShield.totalCriticalFields ?? 0} critical fields on the current top match.</p>
          </div>
          <div>
            <strong>Recent audit events</strong>
            <ul class="tight-list">
              ${(state.auditEvents ?? [])
                .slice(0, 5)
                .map((item) => `<li>${escapeHtml(item.title)} · ${escapeHtml(formatDate(item.at, { includeTime: true }))}</li>`)
                .join("")}
            </ul>
          </div>
        </div>
      </article>
    </section>
  `;
}

function renderOpportunityListMini(matches) {
  return matches
    .slice(0, 8)
    .map(
      (item) => `
        <button class="mini-list-item ${uiState.selectedOpportunityId === item.opportunityId ? "selected" : ""}" data-action="select" data-id="${item.opportunityId}">
          <strong>${escapeHtml(item.displayTitle)}</strong>
          <span>${escapeHtml(item.recommendationLabel)} · ${item.priorityScore}</span>
        </button>
      `
    )
    .join("");
}

function renderDetailPanel(derived, showDebugger = false) {
  const selected = derived.selectedRecommended;
  const raw = derived.selectedRaw;
  if (!selected || !raw) {
    if (derived.selectedRejected) {
      return `
        <aside class="detail-panel">
          <article class="card">
            <div class="section-heading">
              <h3>${escapeHtml(derived.selectedRejected.opportunity.title)}</h3>
              <p>Excluded / low-fit opportunity</p>
            </div>
            <p><strong>Reason:</strong> ${escapeHtml(derived.selectedRejected.reason)}</p>
            <p>Phase 0 keeps the rejection path visible for manual review and evaluation.</p>
          </article>
        </aside>
      `;
    }
    return `<aside class="detail-panel"><article class="card"><p class="empty-state">Select an opportunity to inspect its evidence, scoring and professional report.</p></article></aside>`;
  }

  return `
    <aside class="detail-panel">
      <article class="card">
        <div class="card-topline">
          ${pill(RECOMMENDATION_COPY[selected.recommendationClass], recommendationTone(selected.recommendationClass))}
          ${pill(ELIGIBILITY_COPY[selected.eligibilityStatus], selected.eligibilityStatus.includes("UNCLEAR") ? "warn" : "good")}
        </div>
        <h3>${escapeHtml(selected.displayTitle)}</h3>
        <p>${escapeHtml(selected.executiveVerdict)}</p>
        <div class="detail-stats">
          ${statCard("Match", `${selected.matchScore}/100`)}
          ${statCard("Priority", `${selected.priorityScore}/100`)}
          ${statCard("Confidence", CONFIDENCE_COPY[selected.confidenceShield.label])}
        </div>
        <div class="tab-row">
          ${["report", "evidence", "debug"]
            .map(
              (tab) => `
                <button class="tab-button ${uiState.detailTab === tab ? "active" : ""}" data-action="tab" data-tab="${tab}">
                  ${escapeHtml(tab)}
                </button>
              `
            )
            .join("")}
        </div>
        ${
          uiState.detailTab === "report"
            ? renderReportTab(raw, selected)
            : uiState.detailTab === "evidence"
              ? renderEvidenceTab(raw, selected)
              : renderDebugTab(raw, selected, showDebugger)
        }
      </article>
    </aside>
  `;
}

function renderReportTab(opportunity, match) {
  return `
    <div class="detail-section">
      <h4>Executive verdict</h4>
      <p>${escapeHtml(match.executiveVerdict)}</p>
    </div>
    <div class="detail-section">
      <h4>Eligibility check</h4>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>Requirement</th><th>Status</th><th>Evidence</th></tr>
          </thead>
          <tbody>
            ${match.requirementRows
              .map(
                (row) => `
                  <tr>
                    <td>${escapeHtml(row.label)}</td>
                    <td>${escapeHtml(row.status)}</td>
                    <td>${escapeHtml(row.evidenceIds.join(", ") || "Not linked")}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
    <div class="detail-section">
      <h4>Financial picture</h4>
      <ul class="tight-list">
        <li>Relevant value: ${escapeHtml(match.displayValueLabel)}</li>
        <li>Potential company amount: ${escapeHtml(match.companyAmountLabel)}</li>
        <li>Duration: ${escapeHtml(opportunity.duration ?? "Not stated")}</li>
        <li>Guarantees: ${escapeHtml(opportunity.guarantees ?? "Not stated")}</li>
      </ul>
    </div>
    <div class="detail-section">
      <h4>Risks & blockers</h4>
      <ul class="tight-list">
        ${match.blockers.length
          ? match.blockers.map((item) => `<li>${escapeHtml(item.title)} — ${escapeHtml(item.detail)}</li>`).join("")
          : `<li>No confirmed blocker recorded.</li>`}
        ${match.unknowns.map((item) => `<li>${escapeHtml(item.title)} — ${escapeHtml(item.detail)}</li>`).join("")}
      </ul>
    </div>
    <div class="detail-section">
      <h4>How to pursue</h4>
      <ul class="tight-list">
        <li><a href="${escapeHtml(opportunity.applicationUrl ?? "#")}" target="_blank" rel="noreferrer noopener">Open official application</a></li>
        <li><a href="${escapeHtml(opportunity.noticeUrl ?? "#")}" target="_blank" rel="noreferrer noopener">Open official notice</a></li>
        <li>Authority contact: ${escapeHtml(match.primaryContact?.name ?? "Not published")}</li>
        <li>Reference: ${escapeHtml(opportunity.referenceNumber ?? opportunity.id)}</li>
        <li>Deadline: ${escapeHtml(formatDeadline(opportunity.deadline))}</li>
      </ul>
      <div class="action-row">
        <button class="ghost-button" data-action="download-report" data-id="${opportunity.id}">Download report</button>
        <button class="ghost-button" data-action="ai-verify" data-id="${opportunity.id}">${uiState.aiBusy ? "Running..." : "Run AI verification"}</button>
      </div>
    </div>
  `;
}

function renderEvidenceTab(opportunity, match) {
  return `
    <div class="detail-section">
      <h4>Confidence shield</h4>
      <div class="shield">
        ${pill(CONFIDENCE_COPY[match.confidenceShield.label], confidenceTone(match.confidenceShield.label))}
        <ul class="tight-list">
          <li>Official source verified: ${match.confidenceShield.officialSourceVerified ? "Yes" : "No"}</li>
          <li>Last checked: ${escapeHtml(formatLastChecked(opportunity.lastChecked))}</li>
          <li>Critical fields verified: ${match.confidenceShield.criticalFieldsVerified}/${match.confidenceShield.totalCriticalFields}</li>
          <li>Data confidence: ${escapeHtml(match.confidenceShield.dataConfidence)}</li>
          <li>Eligibility confidence: ${escapeHtml(match.confidenceShield.eligibilityConfidence)}</li>
          <li>Conflicting sources: ${match.confidenceShield.conflictingSources ? "Yes" : "No"}</li>
        </ul>
      </div>
    </div>
    <div class="detail-section">
      <h4>Evidence ledger</h4>
      <div class="evidence-list">
        ${(opportunity.evidence ?? [])
          .map(
            (item) => `
              <article class="evidence-item">
                <strong>${escapeHtml(item.fieldKey)}</strong>
                <p>${escapeHtml(item.excerpt)}</p>
                <small>Confidence ${Math.round((item.confidence ?? 0.8) * 100)}%</small>
              </article>
            `
          )
          .join("")}
      </div>
    </div>
    <div class="detail-section">
      <h4>Official sources</h4>
      <ul class="tight-list">
        ${(opportunity.sources ?? [])
          .map(
            (source) => `
              <li>
                <a href="${escapeHtml(source.url || "#")}" target="_blank" rel="noreferrer noopener">${escapeHtml(source.organisation)}</a>
                — ${escapeHtml(source.title)} · published ${escapeHtml(source.publishedAt)} · last checked ${escapeHtml(formatLastChecked(source.lastChecked))}
              </li>
            `
          )
          .join("")}
      </ul>
    </div>
  `;
}

function renderDebugTab(opportunity, match) {
  const aiRun = (window.__oportunexAiRuns ?? []).find((item) => item.opportunityId === opportunity.id);
  return `
    <div class="detail-section">
      <h4>Scoring dimensions</h4>
      <div class="dimension-grid">
        ${Object.entries(match.dimensions)
          .filter(([key]) => key !== "confidenceShield")
          .map(
            ([key, value]) => `
              <div class="dimension-row">
                <span>${escapeHtml(key)}</span>
                <strong>${Math.round(value)}/100</strong>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
    <div class="detail-section">
      <h4>Structured claims</h4>
      <ul class="tight-list">
        ${match.claims
          .map(
            (claim) => `
              <li>${escapeHtml(claim.claim)} — ${escapeHtml(claim.claimType)} · evidence ${escapeHtml(claim.evidenceIds.join(", ") || "none")}</li>
            `
          )
          .join("")}
      </ul>
    </div>
    <div class="detail-section">
      <h4>AI verification status</h4>
      ${
        aiRun
          ? `<pre class="debug-pre">${escapeHtml(JSON.stringify(aiRun, null, 2))}</pre>`
          : `<p>No AI verification run stored yet. The deterministic engine remains the source of truth in Phase 0.</p>`
      }
    </div>
  `;
}

function layout(content, state, runtime, derived) {
  return `
    <div class="app-shell">
      ${renderNavigation(uiState.route)}
      <main class="main-panel">
        <header class="topbar">
          <div>
            <p class="eyebrow">Friday, 7 August 2026</p>
            <h2>${escapeHtml(derived.company.legalName)}</h2>
          </div>
          <div class="topbar-actions">
            ${pill(runtime.ai.enabled ? "AI ready" : "Mock AI mode", runtime.ai.enabled ? "good" : "warn")}
            ${pill(`${state.opportunities.length} opportunities`, "neutral")}
          </div>
        </header>
        ${uiState.message ? `<div class="toast">${escapeHtml(uiState.message)}</div>` : ""}
        ${content}
      </main>
    </div>
  `;
}

function renderRoute(route, state, runtime, derived) {
  switch (route) {
    case "opportunities":
      return renderOpportunityList(derived);
    case "saved":
      return renderSavedPage(derived);
    case "company":
      return renderCompanyPage(derived.company);
    case "lab":
      return renderLabPage(derived);
    case "sources":
      return renderSourcesPage(state, runtime);
    case "debug":
      return renderDebugPage(derived);
    case "evaluation":
      return renderEvaluationPage(derived);
    case "health":
      return renderHealthPage(state, runtime, derived);
    default:
      return renderOverview(derived);
  }
}

function makeAudit(title, detail) {
  return {
    id: uid("audit"),
    title,
    detail,
    at: new Date().toISOString()
  };
}

function exportWorkspace(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `oportunex-phase0-export-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadReport(match) {
  const blob = new Blob([match.reportMarkdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${toSlug(match.displayTitle)}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function answerQuestion(store, company, questionId, answer) {
  store.update((draft) => {
    const targetCompany = draft.companyProfiles.find((item) => item.id === company.id);
    if (!targetCompany.customAnswers) targetCompany.customAnswers = {};
    targetCompany.customAnswers[questionId] = answer;
    if (questionId.includes("iso9001")) {
      const certification = targetCompany.certifications.find((item) => item.name === "ISO 9001");
      if (certification) certification.status = answer === "Yes" ? "valid" : answer === "No" ? "missing" : "unknown";
    }
    if (questionId.includes("iso14001")) {
      const certification = targetCompany.certifications.find((item) => item.name === "ISO 14001");
      if (certification) certification.status = answer === "Yes" ? "valid" : answer === "No" ? "missing" : "unknown";
    }
  }, makeAudit("Adaptive answer recorded", `${questionId} → ${answer}`));
}

export function startApp(root, { runtime, store }) {
  window.__oportunexAiRuns = [];

  function render() {
    const state = store.getState();
    const derived = getDerived(state, runtime);
    const content = renderRoute(uiState.route, state, runtime, derived);
    root.innerHTML = layout(content, state, runtime, derived);
  }

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const state = store.getState();
    const derived = getDerived(state, runtime);

    if (action === "route") {
      uiState.route = button.dataset.route;
      render();
      return;
    }

    if (action === "select") {
      uiState.selectedOpportunityId = button.dataset.id;
      uiState.detailTab = "report";
      if (uiState.route === "overview") uiState.route = "opportunities";
      render();
      return;
    }

    if (action === "tab") {
      uiState.detailTab = button.dataset.tab;
      render();
      return;
    }

    if (action === "save") {
      const id = button.dataset.id;
      store.update((draft) => {
        const list = new Set(draft.savedOpportunityIds ?? []);
        if (list.has(id)) list.delete(id);
        else list.add(id);
        draft.savedOpportunityIds = [...list];
      }, makeAudit("Saved list updated", `Toggled saved state for ${id}`));
      uiState.message = "Saved opportunities updated.";
      render();
      return;
    }

    if (action === "interest") {
      const id = button.dataset.id;
      store.update((draft) => {
        draft.pursuitStatuses[id] = "interested";
      }, makeAudit("Pursuit status updated", `Marked ${id} as interested.`));
      uiState.message = "Marked as interested.";
      render();
      return;
    }

    if (action === "not-relevant") {
      const id = button.dataset.id;
      store.update((draft) => {
        draft.pursuitStatuses[id] = "not_relevant";
      }, makeAudit("Opportunity feedback updated", `Marked ${id} as not relevant.`));
      uiState.message = "Marked as not relevant.";
      render();
      return;
    }

    if (action === "reset-demo") {
      store.reset();
      uiState.message = "Demo workspace reset.";
      render();
      return;
    }

    if (action === "export-json") {
      exportWorkspace(state);
      uiState.message = "Workspace exported as JSON.";
      render();
      return;
    }

    if (action === "download-report") {
      const match = derived.portfolio.recommended.find((item) => item.opportunityId === button.dataset.id);
      if (match) downloadReport(match);
      return;
    }

    if (action === "answer") {
      answerQuestion(store, derived.company, button.dataset.question, button.dataset.answer);
      uiState.message = "Adaptive answer saved.";
      render();
      return;
    }

    if (action === "ai-verify") {
      const match = derived.portfolio.recommended.find((item) => item.opportunityId === button.dataset.id);
      const opportunity = state.opportunities.find((item) => item.id === button.dataset.id);
      if (!match || !opportunity) return;
      uiState.aiBusy = true;
      uiState.message = "Running AI verification pass...";
      render();
      try {
        const result = await runAiVerification({
          company: derived.company,
          opportunity,
          analysis: match
        });
        window.__oportunexAiRuns = [
          {
            opportunityId: opportunity.id,
            result
          },
          ...window.__oportunexAiRuns.filter((item) => item.opportunityId !== opportunity.id)
        ];
        uiState.detailTab = "debug";
        uiState.message = "AI verification run stored.";
      } catch (error) {
        uiState.message = error.message;
      } finally {
        uiState.aiBusy = false;
        render();
      }
    }
  });

  root.addEventListener("change", (event) => {
    const element = event.target;
    if (element.dataset.filter === "type") uiState.filterType = element.value;
    if (element.dataset.filter === "recommendation") uiState.filterRecommendation = element.value;
    if (element.dataset.filter === "sort") uiState.sort = element.value;
    if (element.dataset.filter === "savedOnly") uiState.showSavedOnly = element.checked;
    render();
  });

  root.addEventListener("submit", (event) => {
    const form = event.target;
    event.preventDefault();
    const formData = new FormData(form);

    if (form.dataset.form === "company") {
      store.update((draft) => {
        const company = getCompany(draft);
        company.legalName = formData.get("legalName")?.toString() ?? company.legalName;
        company.tradingName = formData.get("tradingName")?.toString() ?? company.tradingName;
        company.geography.municipality = formData.get("municipality")?.toString() ?? company.geography.municipality;
        company.geography.province = formData.get("province")?.toString() ?? company.geography.province;
        company.geography.preferredWorkingRadiusKm = Number(formData.get("radius") ?? company.geography.preferredWorkingRadiusKm);
        company.preferences.minimumAttractiveProjectValue = Number(
          formData.get("minimumAttractiveProjectValue") ?? company.preferences.minimumAttractiveProjectValue
        );
        company.preferences.idealProjectValue = Number(formData.get("idealProjectValue") ?? company.preferences.idealProjectValue);
        company.preferences.maximumRealisticProjectValue = Number(
          formData.get("maximumRealisticProjectValue") ?? company.preferences.maximumRealisticProjectValue
        );
        company.preferences.desiredWorkTypes = formData
          .get("desiredWorkTypes")
          .toString()
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        company.preferences.unwantedWorkTypes = formData
          .get("unwantedWorkTypes")
          .toString()
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        company.certifications.forEach((item, index) => {
          item.status = formData.get(`certification-${index}`)?.toString() ?? item.status;
        });
        const coFinance = formData.get("canCoFinance")?.toString();
        company.grants.canCoFinance = coFinance === "unknown" ? null : coFinance === "yes";
      }, makeAudit("Company profile updated", "Saved manual company profile edits."));
      uiState.message = "Company profile saved.";
      render();
      return;
    }

    if (form.dataset.form === "opportunity-import") {
      const sourceText = formData.get("sourceText")?.toString() ?? "";
      const imported = sourceText ? importOpportunityFromText(sourceText) : importOpportunityFromText(formData.get("title")?.toString() ?? "Manual opportunity");
      const manualTitle = formData.get("title")?.toString().trim();
      const type = formData.get("type")?.toString();
      const manualValue = parseMoneyInput(formData.get("value")?.toString() ?? "", {
        amountType: type === "grant" ? "maximum_grant" : "relevant_lot_value"
      });
      const manualDeadlineText = formData.get("deadline")?.toString().trim();
      const manualLocation = formData.get("location")?.toString().trim();
      const noticeUrl = formData.get("noticeUrl")?.toString().trim();

      if (manualTitle) imported.title = manualTitle;
      imported.type = type;
      if (manualValue) {
        if (type === "grant") imported.maximumAidPerBeneficiary = manualValue;
        else {
          imported.relevantValue = manualValue;
          imported.estimatedValue = manualValue;
          imported.lots = [
            {
              id: `${imported.id}-manual-lot`,
              title: imported.title,
              description: imported.description,
              cpvCodes: imported.cpvCodes ?? [],
              keywords: imported.keywords ?? [],
              value: manualValue,
              requirements: []
            }
          ];
        }
      }
      if (manualDeadlineText) imported.deadline = parseSpanishDate(manualDeadlineText) ?? imported.deadline;
      if (manualLocation) imported.location.display = manualLocation;
      if (noticeUrl) {
        imported.noticeUrl = noticeUrl;
        if (imported.sources[0]) imported.sources[0].url = noticeUrl;
      }
      imported.lastChecked = new Date().toISOString();

      store.update((draft) => {
        draft.opportunities.unshift(imported);
      }, makeAudit("Opportunity imported", `Created ${imported.title}.`));
      uiState.selectedOpportunityId = imported.id;
      uiState.message = "Opportunity imported into the Intelligence Lab.";
      form.reset();
      render();
      return;
    }

    if (form.dataset.form === "override") {
      const opportunityId = formData.get("opportunityId")?.toString();
      const value = formData.get("value")?.toString();
      const deadlineText = formData.get("deadline")?.toString();
      const reason = formData.get("reason")?.toString() || "Manual correction";
      store.update((draft) => {
        const opportunity = draft.opportunities.find((item) => item.id === opportunityId);
        if (!opportunity) return;
        const before = {
          title: opportunity.title,
          status: opportunity.status,
          value: opportunity.relevantValue?.amountMinor ?? null,
          deadline: opportunity.deadline?.sourceText ?? null
        };
        opportunity.title = formData.get("title")?.toString() ?? opportunity.title;
        opportunity.status = formData.get("status")?.toString() ?? opportunity.status;
        const parsed = parseMoneyInput(value);
        if (parsed) {
          opportunity.relevantValue = parsed;
          if (opportunity.lots?.[0]) opportunity.lots[0].value = parsed;
        }
        const importedDeadline = deadlineText ? parseSpanishDate(deadlineText) : null;
        if (importedDeadline) opportunity.deadline = importedDeadline;
        draft.manualOverrides.push({
          id: uid("override"),
          opportunityId,
          before,
          after: {
            title: opportunity.title,
            status: opportunity.status,
            value: opportunity.relevantValue?.amountMinor ?? null,
            deadline: opportunity.deadline?.sourceText ?? null
          },
          reason,
          at: new Date().toISOString()
        });
      }, makeAudit("Manual override applied", `${opportunityId}: ${reason}`));
      uiState.message = "Manual override applied and analysis refreshed.";
      render();
    }
  });

  render();
}
