const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createSolanaPublicReportDemoServer } = require("../dist/dev/solanaPublicReportDemoServer.js");

const DEMO_ROOT = path.join(process.cwd(), "src/dev/public-report-demo");

async function withServer(callback, options) {
  const server = createSolanaPublicReportDemoServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("local demo server serves only the sanitized public report and prototype assets", async () => {
  await withServer(async (baseUrl) => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.match(page.headers.get("content-security-policy"), /form-action 'none'/);
    const html = await page.text();
    assert.match(html, /Token Qualification Engine/);
    assert.match(html, /Synthetic demonstration/);
    assert.match(html, /Load synthetic demonstration/);
    assert.match(html, /Generate evidence report/);

    for (const file of ["/styles.css", "/app.js"]) {
      const response = await fetch(`${baseUrl}${file}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }

    const sampleResponse = await fetch(`${baseUrl}/public-report.json`);
    assert.equal(sampleResponse.status, 200);
    const report = await sampleResponse.json();
    assert.equal(report.schemaVersion, "token-public-report-v1");
    assert.equal(report.token.chain, "solana");
    assert.equal(report.token.assetId, "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR");
    assert.equal(report.summary.some((field) => ["market.market_cap", "market.fdv"].includes(field.id)), false);
    assert.deepEqual(report.technicalDetails.filter((field) => ["market.market_cap", "market.fdv"].includes(field.id))
      .map((field) => field.visibility), ["technical_details", "technical_details"]);
    const serialized = JSON.stringify(report);
    for (const forbidden of ["numeratorRaw", "denominatorRaw", "ownerAddress", "rawOwnerAuthorities", "operationalTelemetry", "requestObservations", "Bearer ", "dataBase64"]) {
      assert.equal(serialized.includes(forbidden), false, `sanitized public report excludes ${forbidden}`);
    }
  });
});

test("server rejects unlisted paths and non-read methods without exposing filesystem details", async () => {
  await withServer(async (baseUrl) => {
    const unknown = await fetch(`${baseUrl}/.env`);
    assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), "");
    const traversal = await fetch(`${baseUrl}/%2e%2e/.env`);
    assert.equal(traversal.status, 404);
    const post = await fetch(`${baseUrl}/public-report.json`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.match(post.headers.get("allow"), /POST/);
    assert.equal(await post.text(), "");
  });
});

test("same-origin live route returns only the injected sanitized report and rejects extra request fields", async () => {
  const sample = JSON.parse(fs.readFileSync(path.join(DEMO_ROOT, "public-report.json"), "utf8"));
  const received = [];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/report`, { method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ chain: "solana", assetAddress: sample.token.assetId }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), sample);
    assert.deepEqual(received[0], { chain: "solana", assetAddress: sample.token.assetId });
    const extra = await fetch(`${baseUrl}/api/report`, { method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ chain: "solana", assetAddress: sample.token.assetId, budget: 999 }) });
    assert.equal(extra.status, 400);
  }, { generateLiveReport: async (input, signal) => { received.push(input); assert.equal(signal.aborted, false); return { valid: true, report: sample }; } });
});

test("live route rejects cross-origin, incorrect content type, and oversized bodies without calling service", async () => {
  let calls = 0;
  await withServer(async (baseUrl) => {
    const wrongOrigin = await fetch(`${baseUrl}/api/report`, { method: "POST", headers: { Origin: "http://evil.invalid", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(wrongOrigin.status, 403);
    const wrongType = await fetch(`${baseUrl}/api/report`, { method: "POST", headers: { Origin: baseUrl, "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(wrongType.status, 415);
    const tooLarge = await fetch(`${baseUrl}/api/report`, { method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ chain: "solana", assetAddress: "x".repeat(2000) }) });
    assert.equal(tooLarge.status, 413);
  }, { generateLiveReport: async () => { calls += 1; return { valid: false }; } });
  assert.equal(calls, 0);
});

test("live route sanitizes service errors instead of reflecting arbitrary details", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/report`, { method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ chain: "solana", assetAddress: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR" }) });
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.equal(body.includes("Bearer"), false);
    assert.equal(body.includes("sensitive provider detail"), false);
    assert.match(body, /report_unavailable/);
  }, { generateLiveReport: async () => ({ valid: false, error: { code: "unexpected", message: "sensitive provider detail Bearer hidden" } }) });
});

function mockNode(tagName) {
  const selectors = new Map();
  return {
    tagName,
    className: "",
    textContent: "",
    hidden: false,
    children: [],
    listeners: {},
    disabled: false,
    querySelector(selector) { if (!selectors.has(selector)) { const child = mockNode(selector); selectors.set(selector, child); this.children.push(child); } return selectors.get(selector); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    addEventListener(eventName, listener) { this.listeners[eventName] = listener; },
  };
}

function descendantText(element) {
  return `${element.textContent || ""}${(element.children || []).map(descendantText).join("")}`;
}

function descendants(element) {
  return [element, ...(element.children || []).flatMap(descendants)];
}

test("lookup cancellation, timeout, stale responses, and safe recovery", async () => {
  const ids = ["address-form", "asset-address", "address-status", "load-demo", "cancel-report", "report-status", "report-root", "demo-banner"];
  const elements = new Map(ids.map(id => [id, mockNode(id)]));
  const pending = [], timers = new Map(); let timerId = 0;
  const sample = JSON.parse(fs.readFileSync(path.join(DEMO_ROOT, "public-report.json"), "utf8"));
  const address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  sample.token.assetId = address;
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id), createElement: mockNode }, AbortController,
    setTimeout: (fn, ms) => { assert.equal(ms, 65000); timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve })),
  });
  vm.runInContext(fs.readFileSync(path.join(DEMO_ROOT, "app.js"), "utf8"), context);
  const submit = () => elements.get("address-form").listeners.submit({ preventDefault() {} });
  const cancel = () => elements.get("cancel-report").listeners.click();
  elements.get("asset-address").value = "invalid input";
  await submit(); assert.equal(pending.length, 0);
  assert.match(elements.get("address-status").textContent, /32–44/);
  elements.get("asset-address").value = address;
  const old = submit(); cancel();
  assert.equal(pending[0].options.signal.aborted, true);
  assert.equal(elements.get("asset-address").disabled, false);
  const newer = submit();
  pending[0].resolve({ ok: true, json: async () => sample }); await old;
  assert.equal(elements.get("asset-address").disabled, true);
  assert.equal(elements.get("report-root").children.length, 0);
  pending[1].resolve({ ok: true, json: async () => sample }); await newer;
  assert.ok(elements.get("report-root").children.length > 0);
  assert.equal(timers.size, 0);
  const timed = submit(); [...timers.values()][0]();
  assert.equal(pending[2].options.signal.aborted, true);
  assert.match(elements.get("report-status").textContent, /timed out/);
  pending[2].resolve({ ok: true, json: async () => sample }); await timed;
  assert.equal(elements.get("report-root").children.length, 0);
  for (const [code, pattern] of [["admission_rejected", /busy/], ["budget_exhausted", /allowance/], ["evidence_unavailable", /verified/], ["unknown", /could not be completed/]]) {
    const run = submit(); pending.at(-1).resolve({ ok: false, json: async () => ({ error: { code, message: "SECRET_RAW_ERROR" } }) }); await run;
    assert.match(elements.get("report-status").textContent, pattern);
    assert.doesNotMatch(elements.get("report-status").textContent, /SECRET/);
    assert.equal(elements.get("asset-address").disabled, false);
  }
  const mismatch = submit(); pending.at(-1).resolve({ ok: true, json: async () => ({ ...sample, token: { ...sample.token, assetId: "wrong" } }) }); await mismatch;
  assert.match(elements.get("report-status").textContent, /did not match/);
  assert.equal(elements.get("report-root").children.length, 0);
  const recovery = submit(); pending.at(-1).resolve({ ok: true, json: async () => sample }); await recovery;
  assert.ok(elements.get("report-root").children.length > 0);
  assert.equal(timers.size, 0);
});

test("UAT browser renders synthetic data without a live form or submission", async () => {
  const ids = ["address-status", "load-demo", "report-status", "report-root", "demo-banner"];
  const elements = new Map(ids.map(id => [id, mockNode(id)]));
  const report = JSON.parse(fs.readFileSync(path.join(DEMO_ROOT, "public-report.json"), "utf8"));
  report.token.name = "<img src=x onerror=alert(1)>";
  let requests = 0;
  const context = vm.createContext({ document: { getElementById: id => elements.get(id) ?? null, createElement: mockNode },
    fetch: async url => { assert.equal(url, "/public-report.json"); requests++; return { ok: true, json: async () => report }; } });
  vm.runInContext(fs.readFileSync(path.join(DEMO_ROOT, "app.js"), "utf8"), context);
  await elements.get("load-demo").listeners.click();
  assert.equal(requests, 1);
  assert.match(elements.get("address-status").textContent, /not a real token analysis/);
  assert.match(descendantText(elements.get("demo-banner")), /Synthetic demonstration/);
  assert.match(descendantText(elements.get("report-root")), /<img src=x onerror=alert\(1\)>/);
  assert.equal(descendants(elements.get("report-root")).some(node => node.tagName === "img"), false);
  assert.match(descendantText(elements.get("report-root")), /This does not mean activity was zero/);
});

test("synthetic reloads serialize requests, clear stale success, and recover after failure", async () => {
  const ids = ["address-status", "load-demo", "report-status", "report-root", "demo-banner"];
  const elements = new Map(ids.map(id => [id, mockNode(id)]));
  const report = JSON.parse(fs.readFileSync(path.join(DEMO_ROOT, "public-report.json"), "utf8"));
  let pending;
  let requests = 0;
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) ?? null, createElement: mockNode },
    fetch: url => {
      assert.equal(url, "/public-report.json");
      requests++;
      return new Promise(resolve => { pending = resolve; });
    },
  });
  vm.runInContext(fs.readFileSync(path.join(DEMO_ROOT, "app.js"), "utf8"), context);
  const click = elements.get("load-demo").listeners.click;
  const first = click();
  assert.equal(elements.get("load-demo").disabled, true);
  assert.match(elements.get("address-status").textContent, /Loading/);
  await click();
  assert.equal(requests, 1);
  pending({ ok: true, json: async () => report });
  await first;
  assert.equal(elements.get("demo-banner").hidden, false);
  const failedReload = click();
  assert.equal(elements.get("demo-banner").hidden, true);
  assert.equal(elements.get("report-root").children.length, 0);
  pending({ ok: false });
  await failedReload;
  assert.equal(elements.get("address-status").textContent, "");
  assert.match(elements.get("report-status").textContent, /could not be loaded/);
  assert.equal(elements.get("load-demo").disabled, false);
  const recovery = click();
  pending({ ok: true, json: async () => report });
  await recovery;
  assert.equal(requests, 3);
  assert.equal(elements.get("report-status").textContent, "");
  assert.equal(elements.get("demo-banner").hidden, false);
  assert.ok(elements.get("report-root").children.length > 0);
  assert.equal(elements.get("load-demo").disabled, false);
});

test("browser sends a live address to the local route and keeps the synthetic mode separately labeled", async () => {
  const report = JSON.parse(fs.readFileSync(path.join(DEMO_ROOT, "public-report.json"), "utf8"));
  report.token.name = "Synthetic Test Token";
  report.token.symbol = "SYN";
  const liveReport = JSON.parse(JSON.stringify(report));
  liveReport.token.name = null;
  liveReport.token.symbol = null;
  const liveAddress = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  liveReport.token.assetId = liveAddress;
  const livePrice = liveReport.sections.find((section) => section.id === "market").fields.find((field) => field.id === "market.price");
  livePrice.evidenceState = "unavailable";
  livePrice.explanationCode = "source_unavailable";
  livePrice.explanation = "The evidence is unavailable or was not sufficient for this claim.";
  livePrice.claimOutcome = "withheld_insufficient";
  livePrice.visibility = "withheld";
  delete livePrice.value;
  liveReport.summary = liveReport.summary.filter((field) => field.id !== "market.price");
  const technicalPrice = liveReport.technicalDetails.find((field) => field.id === "market.price");
  technicalPrice.evidenceState = "unavailable";
  technicalPrice.explanationCode = "source_unavailable";
  technicalPrice.explanation = livePrice.explanation;
  technicalPrice.claimOutcome = "withheld_insufficient";
  technicalPrice.visibility = "withheld";
  delete technicalPrice.value;
  const ids = ["address-form", "asset-address", "address-status", "load-demo", "report-status", "report-root", "demo-banner"];
  const elements = new Map(ids.map((id) => [id, mockNode(id)]));
  const document = { getElementById: (id) => elements.get(id), createElement: (tagName) => mockNode(tagName) };
  let localSampleRequests = 0;
  let liveRequests = 0;
  let releaseLiveRequest;
  const liveResponse = new Promise((resolve) => { releaseLiveRequest = resolve; });
  const context = vm.createContext({
    document,
    AbortController, setTimeout, clearTimeout,
    Intl,
    Date,
    Number,
    Map,
    Set,
    Object,
    fetch: async (url, options = {}) => {
      if (url === "/public-report.json") { localSampleRequests += 1; return { ok: true, json: async () => report }; }
      assert.equal(url, "/api/report");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { chain: "solana", assetAddress: liveAddress });
      assert.equal(elements.get("address-form").querySelector("button[type='submit']").disabled, true,
        "duplicate submission remains disabled while the request is pending");
      assert.equal(elements.get("load-demo").disabled, true);
      assert.equal(elements.get("asset-address").disabled, true);
      liveRequests += 1;
      return await liveResponse;
    },
  });
  vm.runInContext(fs.readFileSync(path.join(DEMO_ROOT, "app.js"), "utf8"), context);

  elements.get("asset-address").value = liveAddress;
  let defaultPrevented = false;
  const firstSubmission = elements.get("address-form").listeners.submit({ preventDefault() { defaultPrevented = true; } });
  await elements.get("address-form").listeners.submit({ preventDefault() {} });
  assert.equal(liveRequests, 1, "a second submit is ignored while the first request is active");
  releaseLiveRequest({ ok: true, json: async () => liveReport });
  await firstSubmission;
  assert.equal(defaultPrevented, true);
  assert.match(elements.get("address-status").textContent, /Live evidence report prepared/);
  assert.equal(liveRequests, 1);
  assert.equal(localSampleRequests, 0);
  assert.equal(elements.get("demo-banner").hidden, false);
  assert.match(descendantText(elements.get("demo-banner")), /Live evidence/);
  let renderedLive = descendantText(elements.get("report-root"));
  assert.match(renderedLive, /Live evidence subject/);
  assert.match(renderedLive, /Token analysis/);
  assert.match(renderedLive, /Token name and symbol have not been verified/);
  assert.match(renderedLive, /Solana address EPjF…Dt1v/);
  const addressDetails = descendants(elements.get("report-root")).find((element) => element.className === "token-address");
  assert.ok(addressDetails);
  assert.equal(addressDetails.children.find((element) => element.tagName === "code").textContent, liveAddress,
    "the complete address remains available in the expandable identity details");
  assert.match(renderedLive, /A price could not be established from the available market evidence/);
  assert.match(renderedLive, /does not establish whether no eligible pool was available or a price was not reported/);
  assert.doesNotMatch(renderedLive, /\$1\.25/);

  livePrice.explanation = "The selected pool orientation does not support a token-oriented value.";
  await elements.get("address-form").listeners.submit({ preventDefault() {} });
  renderedLive = descendantText(elements.get("report-root"));
  assert.match(renderedLive, /selected pool lists the token as the quote asset/);
  assert.doesNotMatch(renderedLive, /\$1\.25/);

  livePrice.evidenceState = "unknown";
  livePrice.explanation = "The evidence is unavailable or was not sufficient for this claim.";
  await elements.get("address-form").listeners.submit({ preventDefault() {} });
  renderedLive = descendantText(elements.get("report-root"));
  assert.match(renderedLive, /does not establish a price or why one could not be shown/);

  livePrice.evidenceState = "conflicting";
  livePrice.explanationCode = "claim_withheld";
  await elements.get("address-form").listeners.submit({ preventDefault() {} });
  renderedLive = descendantText(elements.get("report-root"));
  assert.match(renderedLive, /available price evidence conflicts/);

  await elements.get("load-demo").listeners.click();
  assert.equal(localSampleRequests, 1);
  assert.equal(elements.get("demo-banner").hidden, false);
  assert.match(descendantText(elements.get("report-root")), /Synthetic report subject/);
  assert.match(descendantText(elements.get("report-root")), /Synthetic Test Token/);
  assert.match(descendantText(elements.get("report-root")), /Symbol: SYN/);
  assert.doesNotMatch(descendantText(elements.get("report-root")), /Token name and symbol have not been verified/);
  assert.match(elements.get("address-status").textContent, /does not describe an address entered above/);
  const rendered = descendantText(elements.get("report-root"));
  assert.match(rendered, /\$500,000/);
  assert.match(rendered, /\$75,000/);
  assert.match(rendered, /No minting authority is configured in the observed token settings\./);
  assert.match(rendered, /No freeze authority is configured in the observed token settings\./);
  assert.match(rendered, /This does not mean activity was zero/);
  assert.doesNotMatch(rendered, /selected_pool_only|single_snapshot|owner_authorities_not_people|not_atomic/);

  const valuationRows = descendants(elements.get("report-root")).filter((element) =>
    element.className === "details-row" && /Reported (market capitalization|fully diluted value)/.test(descendantText(element)));
  assert.equal(valuationRows.length, 2);
  for (const row of valuationRows) {
    assert.match(descendantText(row), /Provider reported/);
    assert.match(descendantText(row), /denominator and scope are not established/);
  }
  const details = descendants(elements.get("report-root")).find((element) => element.tagName === "details");
  assert.ok(details, "technical data is placed in a native expandable details element");
  assert.doesNotMatch(JSON.stringify(elements.get("report-root")), /numeratorRaw|denominatorRaw|ownerAddress|requestObservations|Bearer /);
});

test("partial holder report explains coverage without invented concentration or raw reason text", async () => {
  const report = JSON.parse(fs.readFileSync(path.join(DEMO_ROOT, "public-report.json"), "utf8"));
  const holders = report.sections.find(s => s.id === "holders");
  holders.completeness = "partial";
  holders.holderCoverage = { pagesRetrieved: 20, stopReason: "page_cap" };
  for (const f of holders.fields.filter(f => f.id.startsWith("holders.concentration_"))) { f.visibility = "withheld"; delete f.value; }
  const ids = ["address-status", "load-demo", "report-status", "report-root", "demo-banner"];
  const elements = new Map(ids.map(id => [id, mockNode(id)]));
  const context = vm.createContext({ document: { getElementById: id => elements.get(id), createElement: mockNode }, Intl, Date, Number, Map, Set, Object,
    fetch: async url => { assert.equal(url, "/public-report.json"); return { ok: true, json: async () => report }; } });
  vm.runInContext(fs.readFileSync(path.join(DEMO_ROOT, "app.js"), "utf8"), context);
  await elements.get("load-demo").listeners.click();
  const text = descendantText(elements.get("report-root"));
  assert.match(text, /configured page limit/);
  assert.match(text, /Pages retrieved: 20/);
  assert.match(text, /Missing values are not zero/);
  assert.match(text, /does not establish token quality, growth, market share or future valuation/);
  assert.doesNotMatch(text, /Historical evidence covers only the requested sample/);
  holders.holderCoverage.stopReason = "private-provider-error-sentinel";
  await elements.get("load-demo").listeners.click();
  assert.doesNotMatch(descendantText(elements.get("report-root")), /private-provider-error-sentinel/);
  assert.match(descendantText(elements.get("report-root")), /stop reason is not available/);
});
