(() => {
  "use strict";

  const form = document.getElementById("address-form");
  const addressInput = document.getElementById("asset-address");
  const addressStatus = document.getElementById("address-status");
  const loadButton = document.getElementById("load-demo");
  const reportStatus = document.getElementById("report-status");
  const reportRoot = document.getElementById("report-root");
  const demoBanner = document.getElementById("demo-banner");

  const limitationCopy = {
    selected_pool_only: "These market figures describe one selected pool, not all markets for the token.",
    single_snapshot: "This is one observation. It does not show whether these conditions persist over time.",
    partial_enumeration: "Only part of the holder data was retrieved. Full-population concentration is not established.",
    partial_amount_coverage: "Some holder amounts could not be confirmed.",
    not_atomic: "The evidence may have been collected at different moments; it is not one guaranteed synchronized snapshot.",
    owner_authorities_not_people: "An owner-authority address is not necessarily one person or economic owner.",
    base_authority_fields_only: "These are base token settings, not a complete security assessment.",
    extension_inventory_only: "Feature presence does not establish how it behaves or whether it is unsafe.",
    sampled_authorities_only: "Historical evidence covers only the requested sample and account scope.",
    provider_valuation_scope_unverified: "Market capitalization and fully diluted value have no established denominator or scope here.",
  };

  const gapCopy = {
    source_unavailable: "Some requested information was unavailable.",
    source_not_requested: "Historical transaction evidence was not requested. This does not mean activity was zero.",
    partial_coverage: "Some evidence covers only part of the requested data.",
    completeness_not_established: "The completeness of some evidence could not be established.",
    observation_not_atomic: "The observations are not guaranteed to represent one synchronized moment.",
    claim_withheld: "Some details are unavailable or withheld under the evidence rules.",
    analyst_restriction: "Some provider-reported values have additional interpretation limits.",
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function stateCopy(state) {
    return ({
      available: "Available in this evidence",
      partial: "Partial evidence",
      unavailable: "Unavailable",
      not_requested: "Not requested",
      conflicting: "Conflicting evidence",
      unknown: "Not established",
    })[state] || "Not established";
  }

  function valueOf(field) {
    return field && field.visibility !== "withheld" && Object.hasOwn(field, "value") ? field.value : null;
  }

  function formatValue(field, value = valueOf(field)) {
    if (value === null || value === undefined) return stateCopy(field?.evidenceState);
    if (field.unit === "USD") {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? new Intl.NumberFormat(undefined, {
        style: "currency", currency: "USD", maximumFractionDigits: 6,
      }).format(numeric) : "Unavailable";
    }
    if (field.unit === "percent") {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(numeric)}%` : "Unavailable";
    }
    if (field.unit === "addresses" && typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat().format(value);
    if (typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat().format(value);
    return typeof value === "string" ? value : "Unavailable";
  }

  function formatTime(value) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
    return `${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value))} UTC`;
  }

  function fieldMap(report) {
    return new Map(report.sections.flatMap((section) => section.fields).map((field) => [field.id, field]));
  }

  function summaryMap(report) {
    return new Map(report.summary.filter((field) => field.visibility === "summary").map((field) => [field.id, field]));
  }

  function addObservation(parent, field) {
    const stamp = formatTime(field?.provenance?.observedAt);
    if (!stamp) return;
    const sourceNames = { helius: "Helius", dexscreener: "DEX Screener", on_chain: "On-chain evidence", normalized_report: "Normalized evidence", unknown: "Recorded source" };
    const source = sourceNames[field.provenance.source] || "Recorded source";
    parent.append(node("span", "data-item-time", `Source: ${source} · Observed ${stamp}`));
  }

  function renderMetric(field, options = {}) {
    const wrapper = node("article", options.card ? "summary-card" : "data-item");
    wrapper.append(node("div", options.card ? "card-label" : "data-item-label", field.label || "Evidence field"));
    wrapper.append(node("div", options.card ? "card-value" : "data-item-value", formatValue(field)));
    if (field.explanation) wrapper.append(node("p", options.card ? "card-note" : "data-item-note", field.explanation));
    addObservation(wrapper, field);
    return wrapper;
  }

  function appendSection(parent, title, intro) {
    const section = node("section", "report-section");
    section.append(node("p", "section-kicker", "Evidence report"));
    section.append(node("h2", "", title));
    if (intro) section.append(node("p", "section-intro", intro));
    parent.append(section);
    return section;
  }

  function valueCopy(field) {
    const value = valueOf(field);
    if (field.id === "token_controls.mint_authority_state") {
      if (field.evidenceState !== "available") return "This setting could not be determined from the available evidence.";
      if (value === "unset") return "No minting authority is configured in the observed token settings.";
      if (value === "set") return "An authorized account is configured with the ability to create additional tokens.";
    }
    if (field.id === "token_controls.freeze_authority_state") {
      if (field.evidenceState !== "available") return "This setting could not be determined from the available evidence.";
      if (value === "unset") return "No freeze authority is configured in the observed token settings.";
      if (value === "set") return "An authorized account is configured with the ability to freeze certain token accounts.";
    }
    if (field.id === "token_controls.token_program") {
      if (value === "spl-token") return "Classic SPL Token";
      if (value === "token-2022") return "Token-2022";
    }
    return formatValue(field);
  }

  function renderControl(field) {
    const wrapper = node("article", "data-item");
    wrapper.append(node("div", "data-item-label", field.label || "Token setting"));
    wrapper.append(node("div", "data-item-value", valueCopy(field)));
    if (field.explanation) wrapper.append(node("p", "data-item-note", field.explanation));
    addObservation(wrapper, field);
    return wrapper;
  }

  function holderCompleteness(section) {
    if (section.completeness === "complete") return "Holder records were fully retrieved from the provider for this request. This does not guarantee a single synchronized snapshot.";
    if (section.completeness === "partial") return "Only part of the holder data was retrieved. The full holder population and its concentration are not established.";
    if (section.evidenceState === "unavailable") return "Holder data was unavailable.";
    return "Holder-data completeness could not be established.";
  }

  function appendLimitations(parent, report) {
    const sectionCodes = report.sections.flatMap((section) => section.limitationCodes || []);
    const fieldCodes = report.sections.flatMap((section) => section.fields.flatMap((field) => field.limitationCodes || []));
    const gapCodes = (report.evidenceGaps || []).map((gap) => gap.code);
    const messages = [...new Set([...sectionCodes, ...fieldCodes])].map((code) => limitationCopy[code]).filter(Boolean);
    for (const code of gapCodes) if (gapCopy[code]) messages.push(gapCopy[code]);
    const section = appendSection(parent, "What this report cannot establish", "These limits describe the evidence; they are not a token safety verdict.");
    if (messages.length === 0) {
      section.append(node("p", "section-intro", "No additional limitations were recorded in this report."));
      return;
    }
    const list = node("ul", "limitation-list");
    [...new Set(messages)].forEach((message) => list.append(node("li", "", message)));
    section.append(list);
  }

  function renderTechnicalDetails(parent, report) {
    const details = node("details", "details-panel");
    details.append(node("summary", "", "Technical details, including provider-reported valuation figures"));
    const body = node("div", "details-body");
    for (const field of report.technicalDetails.filter((item) => item.visibility === "technical_details")) {
      const row = node("div", "details-row");
      const label = node("div", "data-item-label", field.label || "Technical detail");
      if (field.id === "market.market_cap" || field.id === "market.fdv") label.append(node("span", "technical-badge", "Provider reported"));
      row.append(label);
      const valueColumn = node("div");
      valueColumn.append(node("div", "data-item-value", formatValue(field)));
      if (field.explanation) valueColumn.append(node("p", "data-item-note", field.explanation));
      if (field.id === "market.market_cap" || field.id === "market.fdv") {
        valueColumn.append(node("p", "data-item-note", "This figure is not reconciled valuation ground truth; its denominator and scope are not established."));
      }
      addObservation(valueColumn, field);
      row.append(valueColumn);
      body.append(row);
    }
    details.append(body);
    parent.append(details);
  }

  function validateReport(report) {
    return report && report.schemaVersion === "token-public-report-v1"
      && report.token && report.token.chain === "solana" && typeof report.token.assetId === "string"
      && Array.isArray(report.summary) && Array.isArray(report.sections)
      && Array.isArray(report.technicalDetails) && Array.isArray(report.evidenceGaps);
  }

  function renderReport(report) {
    if (!validateReport(report)) throw new Error("invalid_public_report");
    const allFields = fieldMap(report);
    const summary = summaryMap(report);
    const market = report.sections.find((section) => section.id === "market");
    const holders = report.sections.find((section) => section.id === "holders");
    const controls = report.sections.find((section) => section.id === "token_controls");
    const history = report.sections.find((section) => section.id === "historical");
    reportRoot.replaceChildren();

    const heading = node("div", "token-heading");
    const headingText = node("div");
    headingText.append(node("p", "section-kicker", "Synthetic report subject"));
    headingText.append(node("h2", "", report.token.name || "Unnamed token"));
    heading.append(headingText);
    heading.append(node("div", "token-address", report.token.assetId));
    reportRoot.append(heading);

    const overview = appendSection(reportRoot, "At a glance", "A short summary of the available token evidence.");
    const grid = node("div", "summary-grid");
    for (const id of ["market.liquidity", "market.volume", "holders.observed_address_count"]) {
      const field = summary.get(id);
      if (field) grid.append(renderMetric(field, { card: true }));
    }
    overview.append(grid);

    const marketBlock = appendSection(reportRoot, "Market information", "Reported figures describe the selected pool and observation, not the token’s entire market.");
    const marketGrid = node("div", "data-list");
    for (const id of ["market.price", "market.liquidity", "market.volume"]) {
      const field = summary.get(id);
      if (field) marketGrid.append(renderMetric(field));
    }
    if (market) {
      const marketCodes = market.limitationCodes || [];
      const marketNotes = [...new Set(marketCodes.map((code) => limitationCopy[code]).filter(Boolean))];
      if (marketNotes.length) {
        const limits = node("article", "data-item");
        limits.append(node("div", "data-item-label", "Market limits"));
        const list = node("ul", "limitation-list");
        marketNotes.forEach((message) => list.append(node("li", "", message)));
        limits.append(list);
        marketGrid.append(limits);
      }
    }
    marketBlock.append(marketGrid);

    const holderBlock = appendSection(reportRoot, "Holder distribution", holderCompleteness(holders || { completeness: null, evidenceState: "unknown" }));
    const holderGrid = node("div", "data-list");
    for (const id of ["holders.observed_address_count", "holders.concentration_top1", "holders.concentration_top5", "holders.concentration_top10", "holders.concentration_top20"]) {
      const field = allFields.get(id);
      if (field) holderGrid.append(renderMetric(field));
    }
    holderBlock.append(holderGrid);

    const controlBlock = appendSection(reportRoot, "Token settings", "These observed settings describe administrative controls, not whether anyone has used them or whether a token is safe.");
    const controlGrid = node("div", "data-list");
    for (const id of ["token_controls.token_program", "token_controls.mint_authority_state", "token_controls.freeze_authority_state", "token_controls.extension_inventory_summary"]) {
      const field = summary.get(id) || allFields.get(id);
      if (field) controlGrid.append(renderControl(field));
    }
    controlBlock.append(controlGrid);

    const historyBlock = appendSection(reportRoot, "Historical activity", "A missing historical sample is not evidence of zero activity.");
    const historyFields = history ? history.fields : [];
    const historyRequested = history?.evidenceState !== "not_requested"
      && !historyFields.some((field) => field.evidenceState === "not_requested");
    if (!historyRequested) historyBlock.append(node("p", "data-item-note", "Historical transaction evidence was not requested. This does not mean activity was zero."));
    else for (const field of historyFields) historyBlock.append(renderMetric(field));

    appendLimitations(reportRoot, report);
    renderTechnicalDetails(reportRoot, report);
    const generatedAt = formatTime(report.generatedAt);
    if (generatedAt) {
      const timestamp = node("p", "muted", `Report generated ${generatedAt}.`);
      reportRoot.append(timestamp);
    }
    demoBanner.hidden = false;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitted = addressInput.value.trim();
    addressStatus.textContent = submitted
      ? "Live analysis is not available. This address was not analyzed. Load the synthetic demonstration to view example data."
      : "Enter an address, or load the synthetic demonstration below.";
  });

  loadButton.addEventListener("click", async () => {
    reportStatus.textContent = "";
    try {
      const response = await fetch("/public-report.json", { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error("local_sample_unavailable");
      renderReport(await response.json());
      addressStatus.textContent = "The report shown is the fixed synthetic example. It does not describe an address entered above.";
    } catch {
      reportRoot.replaceChildren();
      reportStatus.textContent = "The local synthetic demonstration could not be loaded.";
    }
  });
})();
