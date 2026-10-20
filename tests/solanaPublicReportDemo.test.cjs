const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createSolanaPublicReportDemoServer } = require("../dist/dev/solanaPublicReportDemoServer.js");

const DEMO_ROOT = path.join(process.cwd(), "src/dev/public-report-demo");

async function withServer(callback) {
  const server = createSolanaPublicReportDemoServer();
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
    assert.match(html, /Check availability/);

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
    assert.equal(post.headers.get("allow"), "GET, HEAD");
    assert.equal(await post.text(), "");
  });
});

function mockNode(tagName) {
  return {
    tagName,
    className: "",
    textContent: "",
    hidden: false,
    children: [],
    listeners: {},
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

test("browser rendering respects visibility, explains controls, and never analyzes entered addresses", async () => {
  const report = JSON.parse(fs.readFileSync(path.join(DEMO_ROOT, "public-report.json"), "utf8"));
  const ids = ["address-form", "asset-address", "address-status", "load-demo", "report-status", "report-root", "demo-banner"];
  const elements = new Map(ids.map((id) => [id, mockNode(id)]));
  const document = { getElementById: (id) => elements.get(id), createElement: (tagName) => mockNode(tagName) };
  let localSampleRequests = 0;
  const context = vm.createContext({
    document,
    Intl,
    Date,
    Number,
    Map,
    Set,
    Object,
    fetch: async (url) => {
      assert.equal(url, "/public-report.json", "the only fetch is the local sanitized sample");
      localSampleRequests += 1;
      return { ok: true, json: async () => report };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(DEMO_ROOT, "app.js"), "utf8"), context);

  elements.get("asset-address").value = "user-entered-address";
  let defaultPrevented = false;
  elements.get("address-form").listeners.submit({ preventDefault() { defaultPrevented = true; } });
  assert.equal(defaultPrevented, true);
  assert.match(elements.get("address-status").textContent, /was not analyzed/);
  assert.equal(localSampleRequests, 0, "address submission performs no acquisition request");

  await elements.get("load-demo").listeners.click();
  assert.equal(localSampleRequests, 1);
  assert.equal(elements.get("demo-banner").hidden, false);
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
