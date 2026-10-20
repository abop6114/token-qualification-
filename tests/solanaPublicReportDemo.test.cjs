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

test("browser sends a live address to the local route and keeps the synthetic mode separately labeled", async () => {
  const report = JSON.parse(fs.readFileSync(path.join(DEMO_ROOT, "public-report.json"), "utf8"));
  const ids = ["address-form", "asset-address", "address-status", "load-demo", "report-status", "report-root", "demo-banner"];
  const elements = new Map(ids.map((id) => [id, mockNode(id)]));
  const document = { getElementById: (id) => elements.get(id), createElement: (tagName) => mockNode(tagName) };
  let localSampleRequests = 0;
  let liveRequests = 0;
  let releaseLiveRequest;
  const liveResponse = new Promise((resolve) => { releaseLiveRequest = resolve; });
  const context = vm.createContext({
    document,
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
      assert.deepEqual(JSON.parse(options.body), { chain: "solana", assetAddress: "user-entered-address" });
      assert.equal(elements.get("address-form").querySelector("button[type='submit']").disabled, true,
        "duplicate submission remains disabled while the request is pending");
      assert.equal(elements.get("load-demo").disabled, true);
      assert.equal(elements.get("asset-address").disabled, true);
      liveRequests += 1;
      return await liveResponse;
    },
  });
  vm.runInContext(fs.readFileSync(path.join(DEMO_ROOT, "app.js"), "utf8"), context);

  elements.get("asset-address").value = "user-entered-address";
  let defaultPrevented = false;
  const firstSubmission = elements.get("address-form").listeners.submit({ preventDefault() { defaultPrevented = true; } });
  await elements.get("address-form").listeners.submit({ preventDefault() {} });
  assert.equal(liveRequests, 1, "a second submit is ignored while the first request is active");
  releaseLiveRequest({ ok: true, json: async () => report });
  await firstSubmission;
  assert.equal(defaultPrevented, true);
  assert.match(elements.get("address-status").textContent, /Live evidence report prepared/);
  assert.equal(liveRequests, 1);
  assert.equal(localSampleRequests, 0);
  assert.equal(elements.get("demo-banner").hidden, false);
  assert.match(descendantText(elements.get("demo-banner")), /Live evidence/);
  assert.match(descendantText(elements.get("report-root")), /Live evidence subject/);

  await elements.get("load-demo").listeners.click();
  assert.equal(localSampleRequests, 1);
  assert.equal(elements.get("demo-banner").hidden, false);
  assert.match(descendantText(elements.get("report-root")), /Synthetic report subject/);
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
