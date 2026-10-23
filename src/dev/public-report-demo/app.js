(() => {
  "use strict";

  const form = document.getElementById("address-form");
  const addressInput = document.getElementById("asset-address");
  const addressStatus = document.getElementById("address-status");
  const loadButton = document.getElementById("load-demo");
  const submitButton = form?.querySelector("button[type='submit']");
  const reportStatus = document.getElementById("report-status");
  const reportRoot = document.getElementById("report-root");
  const demoBanner = document.getElementById("demo-banner");
  let requestActive = false;
  const cancelButton = document.getElementById("cancel-report");
  let activeLookup = null;
  // Allow the service's existing 60-second deadline to return its safe error.
  const LOOKUP_WAIT_MS = 65000;
  const lookupErrors = {
    invalid_request: "Enter a valid Solana token address, then submit again.",
    admission_rejected: "Analysis is busy or temporarily unavailable. Try again later.",
    budget_exhausted: "The analysis allowance is exhausted. Try again when service is available.",
    deadline_exceeded: "The request timed out. No completed report was returned. You can try again.",
    cancelled: "The request was cancelled. You can submit an address again.",
    evidence_unavailable: "This address could not be verified as a Solana token mint. Check the address.",
    report_unavailable: "A report could not be prepared from the available evidence. Try again later.",
  };

  function finishLookup(lookup) {
    if (activeLookup !== lookup) return;
    clearTimeout(lookup.timer);
    activeLookup = null;
    requestActive = false;
    submitButton.disabled = false;
    loadButton.disabled = false;
    addressInput.disabled = false;
    if (cancelButton) cancelButton.hidden = true;
    form.setAttribute?.("aria-busy", "false");
  }

  function stopLookup(reason) {
    const lookup = activeLookup;
    if (!lookup) return;
    finishLookup(lookup);
    lookup.controller.abort();
    addressStatus.textContent = reason === "cancelled" ? "Request cancelled." : "Request timed out.";
    reportStatus.textContent = lookupErrors[reason];
    addressInput.focus?.();
  }
  cancelButton?.addEventListener("click", () => stopLookup("cancelled"));

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
    if (field.id === "holders.observed_balance_distribution" && value === "A distribution summary is available for the retrieved records.") return "This older report does not include a numeric balance-distribution breakdown.";
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
    const explanation = metricExplanation(field);
    if (explanation) wrapper.append(node("p", options.card ? "card-note" : "data-item-note", explanation));
    addObservation(wrapper, field);
    return wrapper;
  }

  function metricExplanation(field) {
    if (field?.id !== "market.price") return field?.explanation;
    if (field.explanation === "The selected pool orientation does not support a token-oriented value.") {
      return "The selected pool lists the token as the quote asset, so its reported price cannot be treated as this token’s price.";
    }
    if (field.visibility === "withheld" && field.evidenceState === "partial") {
      return "The price is not shown because the available evidence did not meet the claim requirements.";
    }
    if (field.evidenceState === "unavailable") {
      return "A price could not be established from the available market evidence. The report does not establish whether no eligible pool was available or a price was not reported.";
    }
    if (field.evidenceState === "unknown") {
      return "The available evidence does not establish a price or why one could not be shown.";
    }
    if (field.evidenceState === "conflicting") {
      return "The available price evidence conflicts, so no single value is shown.";
    }
    if (field.evidenceState === "not_requested") return "Price information was not requested for this report.";
    return field.explanation;
  }

  function abbreviatedAddress(address) {
    return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
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
    const relevantSections = report.sections.filter((section) => section.evidenceState !== "not_requested");
    const sectionCodes = relevantSections.flatMap((section) => section.limitationCodes || []);
    const fieldCodes = relevantSections.flatMap((section) => section.fields.flatMap((field) => field.limitationCodes || []));
    const gapCodes = (report.evidenceGaps || []).map((gap) => gap.code);
    const messages = [...new Set([...sectionCodes, ...fieldCodes])].map((code) => limitationCopy[code]).filter(Boolean);
    for (const code of gapCodes) if (gapCopy[code] && !["partial_coverage", "claim_withheld", "source_not_requested"].includes(code)) messages.push(gapCopy[code]);
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
    const shownIds = new Set(report.sections.filter(section => section.id !== "identity").flatMap(section => section.fields)
      .filter(field => field.visibility === "summary").map(field => field.id));
    for (const field of report.technicalDetails.filter((item) => item.visibility === "technical_details" && !shownIds.has(item.id))) {
      const row = node("div", "details-row");
      const label = node("div", "data-item-label", field.label || "Technical detail");
      if (field.id === "market.market_cap" || field.id === "market.fdv") label.append(node("span", "technical-badge", "Provider reported"));
      row.append(label);
      const valueColumn = node("div");
      valueColumn.append(node("div", "data-item-value", field.id.startsWith("token_controls.") ? valueCopy(field) : formatValue(field)));
      if (field.explanation && !["market.market_cap", "market.fdv"].includes(field.id)) valueColumn.append(node("p", "data-item-note", field.explanation));
      if (field.id === "market.market_cap" || field.id === "market.fdv") {
        valueColumn.append(node("p", "data-item-note", "This is a provider-reported current valuation, not a forecast. Its denominator and scope are not established; it cannot establish future market cap or upside."));
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

  function renderReport(report, mode) {
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
    headingText.append(node("p", "section-kicker", mode === "live" ? "Live evidence subject" : "Synthetic report subject"));
    const tokenName = typeof report.token.name === "string" && report.token.name.trim() ? report.token.name.trim() : null;
    const tokenSymbol = typeof report.token.symbol === "string" && report.token.symbol.trim() ? report.token.symbol.trim() : null;
    headingText.append(node("h2", "", tokenName || "Token analysis"));
    if (tokenSymbol) headingText.append(node("p", "muted", `Symbol: ${tokenSymbol}`));
    if (!tokenName && !tokenSymbol) headingText.append(node("p", "muted", "Token name and symbol have not been verified."));
    heading.append(headingText);
    const addressDetails = node("details", "token-address");
    addressDetails.append(node("summary", "", `Solana address ${abbreviatedAddress(report.token.assetId)}`));
    addressDetails.append(node("code", "", report.token.assetId));
    heading.append(addressDetails);
    reportRoot.append(heading);

    const overview = appendSection(reportRoot, "At a glance", "A short summary of the available token evidence.");
    const grid = node("div", "summary-grid");
    for (const id of ["market.liquidity", "market.volume", "holders.observed_address_count"]) {
      const field = allFields.get(id);
      if (field) grid.append(renderMetric(field, { card: true }));
    }
    overview.append(grid);
    if (holders) overview.append(node("p", "coverage-note", holderCompleteness(holders)));
    overview.append(node("p", "data-item-note", "Decision context: liquidity describes the selected pool, volume describes reported activity, and holder concentration is shown only when supported. This snapshot does not establish token quality, growth, market share or future valuation."));

    const marketBlock = appendSection(reportRoot, "Market information", "Reported figures describe the selected pool and observation, not the token’s entire market.");
    const marketGrid = node("div", "data-list");
    for (const id of ["market.price", "market.liquidity", "market.volume"]) {
      const field = allFields.get(id);
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
      if (field && (id === "holders.observed_address_count" || valueOf(field) !== null)) holderGrid.append(renderMetric(field));
    }
    holderBlock.append(holderGrid);
    const distribution = allFields.get("holders.observed_balance_distribution");
    if (distribution && valueOf(distribution) !== null) holderBlock.append(renderMetric(distribution));
    const missingShares = ["holders.concentration_top1", "holders.concentration_top5", "holders.concentration_top10", "holders.concentration_top20"]
      .filter((id) => !allFields.has(id) || valueOf(allFields.get(id)) === null);
    if (missingShares.length) holderBlock.append(node("p", "coverage-note", `Concentration not established for: ${missingShares.map((id) => id.split("_").pop().replace("top", "top ")).join(", ")}. Missing values are not zero and do not establish dispersed ownership.`));
    const coverage = holders?.holderCoverage;
    const reasons = { provider_terminated: "The provider returned its final page.", page_cap: "Collection stopped at the configured page limit.", request_timeout: "Collection stopped after a provider request timed out.", provider_error: "Collection stopped after a provider failure.", http_error: "Collection stopped after an unsuccessful provider response.", malformed_response: "Collection stopped because a provider response could not be validated.", configuration_error: "Collection could not continue because provider configuration was unavailable." };
    holderBlock.append(node("p", "data-item-note", coverage && Object.hasOwn(reasons, coverage.stopReason) ? reasons[coverage.stopReason] : "The collection stop reason is not available in this report."));
    if (Number.isSafeInteger(coverage?.pagesRetrieved) && coverage.pagesRetrieved >= 0) holderBlock.append(node("p", "data-item-note", `Pages retrieved: ${coverage.pagesRetrieved}. Page count is not a percentage of total holders.`));

    const controlBlock = appendSection(reportRoot, "Token settings", "These observed settings describe administrative controls, not whether anyone has used them or whether a token is safe.");
    const controlGrid = node("div", "data-list");
    for (const id of ["token_controls.token_program", "token_controls.mint_authority_state", "token_controls.freeze_authority_state", "token_controls.extension_inventory_summary"]) {
      const field = summary.get(id) || allFields.get(id);
      if (field) controlGrid.append(renderControl(field));
    }
    controlBlock.append(controlGrid);
    controlBlock.append(node("p", "data-item-note", "Why these controls matter: mint authority governs additional issuance through the base token program; freeze authority governs freezing token accounts. Their absence does not establish liquidity safety, fair ownership, demand or future price."));

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
    demoBanner.querySelector("strong").textContent = mode === "live" ? "Live evidence" : "Synthetic demonstration";
    demoBanner.querySelector("span").textContent = mode === "live"
      ? "This report uses a bounded provider evidence request; observations may be partial and are not a qualification verdict."
      : "This is test data, not a real token analysis.";
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (requestActive) return;
    const submitted = addressInput.value.trim();
    reportRoot.replaceChildren();
    demoBanner.hidden = true;
    reportStatus.textContent = "";
    addressInput.setAttribute?.("aria-invalid", "false");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(submitted)) {
      addressStatus.textContent = "Enter a Solana token address (32–44 base58 characters), or load the synthetic demonstration below. The server verifies the address.";
      addressInput.setAttribute?.("aria-invalid", "true");
      addressInput.focus?.();
      return;
    }
    submitButton.disabled = true;
    loadButton.disabled = true;
    addressInput.disabled = true;
    requestActive = true;
    const lookup = { controller: new AbortController(), timer: null };
    activeLookup = lookup;
    lookup.timer = setTimeout(() => { if (activeLookup === lookup) stopLookup("deadline_exceeded"); }, LOOKUP_WAIT_MS);
    if (cancelButton) cancelButton.hidden = false;
    form.setAttribute?.("aria-busy", "true");
    addressStatus.textContent = `Preparing a report for ${submitted}. This can take up to about a minute. You can cancel this request.`;
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ chain: "solana", assetAddress: submitted }),
        cache: "no-store",
        signal: lookup.controller.signal,
      });
      const payload = await response.json();
      if (activeLookup !== lookup) return;
      if (!response.ok) throw new Error(Object.hasOwn(lookupErrors, payload?.error?.code) ? lookupErrors[payload.error.code] : "The request could not be completed. Try again later.");
      if (payload?.token?.chain !== "solana" || payload.token.assetId !== submitted) throw new Error("The returned report did not match the submitted address. No report is shown.");
      renderReport(payload, "live");
      addressStatus.textContent = "Live evidence report prepared. Review the listed limits and evidence gaps.";
    } catch (error) {
      if (activeLookup !== lookup) return;
      reportRoot.replaceChildren();
      demoBanner.hidden = true;
      addressStatus.textContent = "The live report could not be prepared.";
      const safeMessages = [...Object.values(lookupErrors), "The request could not be completed. Try again later.", "The returned report did not match the submitted address. No report is shown."];
      reportStatus.textContent = error instanceof Error && safeMessages.includes(error.message) ? error.message : "The request could not be completed. Check your connection and try again.";
    } finally {
      finishLookup(lookup);
    }
  });

  loadButton.addEventListener("click", async () => {
    if (requestActive) return;
    requestActive = true;
    loadButton.disabled = true;
    if (submitButton) submitButton.disabled = true;
    if (addressInput) addressInput.disabled = true;
    reportRoot.replaceChildren();
    demoBanner.hidden = true;
    addressStatus.textContent = "Loading the synthetic demonstration…";
    reportStatus.textContent = "";
    try {
      const response = await fetch("/public-report.json", { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error("local_sample_unavailable");
      renderReport(await response.json(), "synthetic");
      addressStatus.textContent = form
        ? "The report shown is the fixed synthetic example. It does not describe an address entered above."
        : "The report shown is the fixed synthetic example, not a real token analysis.";
    } catch {
      reportRoot.replaceChildren();
      demoBanner.hidden = true;
      addressStatus.textContent = "";
      reportStatus.textContent = "The synthetic demonstration could not be loaded. Try again.";
    } finally {
      requestActive = false;
      loadButton.disabled = false;
      if (submitButton) submitButton.disabled = false;
      if (addressInput) addressInput.disabled = false;
    }
  });
})();
